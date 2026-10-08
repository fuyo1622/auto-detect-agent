import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import type { PushSubscription } from 'web-push';
import type { Actions, ActionResult } from './actions.ts';
import type { KeepAwake } from './awake.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import type { Monitor } from './monitor.ts';
import type { Notifier } from './notify.ts';
import type { Pairing } from './pairing.ts';
import type { Device, Store } from './store.ts';
import type { Tailscale } from './tailscale.ts';
import { PROBLEM_HEALTHS, type AppAction, type AppId, type KeepAwake as KeepAwakeMode, type PublicState, type SessionAction } from './types.ts';

export interface ServerDeps {
  cfg: Config;
  log: Logger;
  store: Store;
  monitor: Monitor;
  actions: Actions;
  notifier: Notifier;
  pairing: Pairing;
  tailscale: Tailscale;
  awake: KeepAwake;
  version: string;
  startedAt: number;
  helperMode: () => 'ok' | 'fallback' | 'down';
  shutdown: () => void;
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  admin: boolean;
  device?: Device;
  params: string[];
  body: any;
  who: string;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;
interface Route {
  method: string;
  pattern: RegExp;
  scope: 'any' | 'admin' | 'device' | 'public';
  handler: Handler;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SESSION_ACTIONS = new Set<SessionAction>(['reconnect', 'resume', 'stop', 'open-terminal', 'restart-app', 'start-app', 'dismiss']);
const APP_IDS = new Set<AppId>(['claude-desktop', 'codex-desktop', 'codex-daemon']);
const APP_ACTIONS = new Set<AppAction>(['restart', 'start', 'stop']);
const KEEP_AWAKE = new Set<KeepAwakeMode>(['off', 'while-working', 'always']);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export class Servers {
  private readonly d: ServerDeps;
  private readonly phone: http.Server;
  private readonly admin: http.Server;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;
  private broadcastTimer: NodeJS.Timeout | undefined;
  private lastBroadcast = 0;
  private readonly routes: Route[];

  constructor(d: ServerDeps) {
    this.d = d;
    this.routes = this.buildRoutes();
    this.phone = http.createServer((req, res) => void this.handle(req, res, false));
    this.admin = http.createServer((req, res) => void this.handle(req, res, true));
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(`: ping ${Date.now()}\n\n`);
    }, 15000);
  }

  async listen(): Promise<void> {
    const { cfg } = this.d;
    await listenOn(this.admin, cfg.adminPort, '127.0.0.1');
    await listenOn(this.phone, cfg.phonePort, cfg.listenHost);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.phone.close();
    this.admin.close();
  }

  /** Push the latest state to every open event stream (at most a few times per second). */
  broadcast(): void {
    if (this.broadcastTimer) return;
    const wait = Math.max(0, 300 - (Date.now() - this.lastBroadcast));
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.lastBroadcast = Date.now();
      if (!this.clients.size) return;
      const data = `event: state\ndata: ${JSON.stringify(this.state())}\n\n`;
      for (const res of this.clients) res.write(data);
    }, wait);
  }

  state(): PublicState {
    const { monitor, store, tailscale, awake, version, startedAt, actions, cfg } = this.d;
    return {
      agent: {
        version,
        host: os.hostname(),
        startedAt,
        now: Date.now(),
        publicUrl: cfg.publicUrl || tailscale.status.url,
        awake: awake.active,
        lastWakeAt: monitor.lastWakeAt,
        helper: this.d.helperMode(),
        settings: store.data.settings,
      },
      apps: monitor.apps,
      sessions: monitor.sessions,
      activity: actions.history.slice(0, 15),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, admin: boolean): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (admin) this.checkAdminRequest(req);
      if (url.pathname.startsWith('/api/')) {
        await this.api(req, res, url, admin);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        this.serveStatic(res, url.pathname);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) this.d.log.error('request failed:', req.method, req.url, e);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the PC.' : (e as Error).message });
      else res.end();
    }
  }

  /** The PC-only port: block other websites and DNS rebinding. */
  private checkAdminRequest(req: http.IncomingMessage): void {
    const port = this.d.cfg.adminPort;
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Wrong host');
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, 'Cross-site request');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['x-agent-client']) throw new HttpError(403, 'Missing client header');
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, admin: boolean): Promise<void> {
    const method = req.method ?? 'GET';
    let route: Route | undefined;
    let params: string[] = [];
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (m) {
        route = r;
        params = m.slice(1).map(decodePart);
        break;
      }
    }
    if (!route) throw new HttpError(404, 'Not found');

    let device: Device | undefined;
    if (!admin && route.scope !== 'public') {
      const auth = String(req.headers.authorization ?? '');
      device = this.d.pairing.authenticate(auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined);
      if (!device) throw new HttpError(401, 'This phone is not paired. Pair it again from the PC.');
    }
    if (route.scope === 'admin' && !admin) throw new HttpError(404, 'Not found');
    if (route.scope === 'device' && !device) throw new HttpError(400, 'Only a paired phone can do this.');

    const body = method === 'GET' || method === 'HEAD' ? undefined : await readJson(req);
    const ctx: Ctx = { req, res, url, admin, device, params, body, who: device?.name ?? 'PC' };
    const out = await route.handler(ctx);
    if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
  }

  private buildRoutes(): Route[] {
    const d = this.d;
    const r = (method: string, pattern: RegExp, scope: Route['scope'], handler: Handler): Route => ({ method, pattern, scope, handler });
    return [
      r('POST', /^\/api\/pair$/, 'public', (c) => {
        if (c.admin) throw new HttpError(400, 'Pair from the phone.');
        const result = d.pairing.redeem(String(c.body?.code ?? ''), String(c.body?.name ?? ''), c.req.headers['user-agent']);
        if ('error' in result) throw new HttpError(403, result.error);
        d.log.info('paired a new device:', result.device.name);
        return { token: result.token, device: publicDevice(result.device) };
      }),
      r('GET', /^\/api\/whoami$/, 'any', (c) => ({
        admin: c.admin,
        device: c.device ? publicDevice(c.device) : undefined,
        host: os.hostname(),
        version: d.version,
      })),
      r('GET', /^\/api\/state$/, 'any', () => this.state()),
      r('GET', /^\/api\/events$/, 'any', (c) => this.openStream(c)),
      r('POST', /^\/api\/sessions\/([^/]+)\/([a-z-]+)$/, 'any', async (c) => {
        const [key, action] = c.params;
        if (!SESSION_ACTIONS.has(action as SessionAction)) throw new HttpError(400, 'Unknown action');
        const result: ActionResult = await d.actions.session(key, action as SessionAction, {
          force: !!c.body?.force,
          dryRun: !!c.body?.dryRun,
          by: c.who,
        });
        this.broadcast();
        return result;
      }),
      r('POST', /^\/api\/apps\/([a-z-]+)\/([a-z]+)$/, 'any', async (c) => {
        const [id, action] = c.params;
        if (!APP_IDS.has(id as AppId) || !APP_ACTIONS.has(action as AppAction)) throw new HttpError(400, 'Unknown app or action');
        const result = await d.actions.app(id as AppId, action as AppAction, { force: !!c.body?.force, dryRun: !!c.body?.dryRun, by: c.who });
        this.broadcast();
        return result;
      }),
      r('PATCH', /^\/api\/settings$/, 'any', async (c) => {
        const s = d.store.data.settings;
        const b = c.body ?? {};
        if (b.keepAwake !== undefined) {
          if (!KEEP_AWAKE.has(b.keepAwake)) throw new HttpError(400, 'keepAwake must be off, while-working or always');
          s.keepAwake = b.keepAwake;
        }
        if (b.stuckMinutes !== undefined) {
          const n = Number(b.stuckMinutes);
          if (!Number.isFinite(n) || n < 3 || n > 240) throw new HttpError(400, 'stuckMinutes must be between 3 and 240');
          s.stuckMinutes = Math.round(n);
        }
        if (b.autoReconnect !== undefined) s.autoReconnect = !!b.autoReconnect;
        d.store.saveNow();
        d.log.info(`[${c.who}] settings:`, s);
        await d.awake.update(d.monitor.sessions);
        d.monitor.refreshSoon(0);
        return s;
      }),
      r('GET', /^\/api\/push\/key$/, 'any', () => ({ publicKey: d.notifier.publicKey })),
      r('POST', /^\/api\/push\/subscribe$/, 'device', (c) => {
        const sub = c.body?.subscription as PushSubscription | undefined;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Bad subscription');
        if (!/^https:\/\//.test(sub.endpoint)) throw new HttpError(400, 'Bad push endpoint');
        d.notifier.subscribe(c.device!, sub, c.body?.prefs);
        return publicDevice(c.device!);
      }),
      r('POST', /^\/api\/push\/unsubscribe$/, 'device', (c) => {
        d.notifier.unsubscribe(c.device!);
        return publicDevice(c.device!);
      }),
      r('PATCH', /^\/api\/push\/prefs$/, 'device', (c) => {
        d.notifier.setPrefs(c.device!, pickPrefs(c.body?.prefs));
        return publicDevice(c.device!);
      }),
      r('POST', /^\/api\/push\/test$/, 'any', async (c) => {
        // Point the test at a real session, so tapping it also checks that alerts open the right session.
        const s = d.monitor.sessions[0];
        const payload = s
          ? { title: 'Agent Monitor', body: `Test notification from ${os.hostname()}. Tap it to open “${s.title}”.`, tag: 'test', url: `/#s=${encodeURIComponent(s.key)}` }
          : { title: 'Agent Monitor', body: `Test notification from ${os.hostname()}.`, tag: 'test', url: '/' };
        const result = c.device ? await d.notifier.send('system', payload, c.device) : await d.notifier.send('system', payload);
        if (!result.sent && !result.failed) throw new HttpError(400, c.device ? 'Notifications are not turned on for this phone.' : 'No phone has notifications turned on.');
        return result;
      }),
      r('POST', /^\/api\/device\/unpair$/, 'device', (c) => {
        d.pairing.revoke(c.device!.id);
        return { ok: true };
      }),
      r('GET', /^\/api\/summary$/, 'admin', () => this.summary()),
      r('GET', /^\/api\/admin\/pairing$/, 'admin', () => this.pairingInfo(false)),
      r('POST', /^\/api\/admin\/pairing$/, 'admin', () => this.pairingInfo(true)),
      r('GET', /^\/api\/admin\/devices$/, 'admin', () => d.store.data.devices.map(publicDevice)),
      r('DELETE', /^\/api\/admin\/devices\/([^/]+)$/, 'admin', (c) => {
        if (!d.pairing.revoke(c.params[0])) throw new HttpError(404, 'No such device');
        return { ok: true };
      }),
      r('POST', /^\/api\/admin\/tailscale\/serve$/, 'admin', async () => {
        const result = await d.tailscale.enableServe();
        this.broadcast();
        return result;
      }),
      r('POST', /^\/api\/admin\/shutdown$/, 'admin', () => {
        setTimeout(() => d.shutdown(), 200);
        return { ok: true };
      }),
    ];
  }

  private openStream(c: Ctx): undefined {
    const { res, req } = c;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\nevent: state\ndata: ${JSON.stringify(this.state())}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    return undefined;
  }

  private summary() {
    const sessions = this.d.monitor.sessions;
    const problems = sessions.filter((s) => PROBLEM_HEALTHS.has(s.health));
    const severe = problems.some((s) => s.health === 'dead' || s.health === 'rc-lost');
    return {
      total: sessions.length,
      live: sessions.filter((s) => s.alive).length,
      working: sessions.filter((s) => s.health === 'working').length,
      waiting: sessions.filter((s) => s.health === 'waiting').length,
      problems: problems.map((s) => ({ key: s.key, title: s.title, health: s.health, detail: s.detail })),
      level: severe ? 'bad' : problems.length ? 'warn' : 'ok',
      awake: this.d.awake.active,
      publicUrl: this.d.cfg.publicUrl || this.d.tailscale.status.url,
    };
  }

  private async pairingInfo(renew: boolean) {
    const { pairing, tailscale, cfg } = this.d;
    await tailscale.refresh(renew);
    const code = renew ? pairing.renew() : pairing.current();
    const base = cfg.publicUrl || tailscale.status.url || (cfg.listenHost !== '127.0.0.1' ? lanUrl(cfg.phonePort) : undefined);
    const link = base ? `${base.replace(/\/$/, '')}/#pair=${code.code}` : undefined;
    const qrSvg = link ? await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : undefined;
    return { code: code.code, expiresAt: code.expiresAt, url: base, link, qrSvg, tailscale: tailscale.status, phonePort: cfg.phonePort };
  }

  private serveStatic(res: http.ServerResponse, pathname: string): void {
    const root = this.d.cfg.paths.web;
    let rel = decodePart(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) throw new HttpError(404, 'Not found');
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(data);
  }
}

/** decodeURIComponent, but a malformed %-sequence is the client's mistake (400), not a server error. */
function decodePart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

function publicDevice(d: Device) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: !!d.push, prefs: d.push?.prefs };
}

function pickPrefs(p: any) {
  const out: Record<string, boolean> = {};
  for (const k of ['problems', 'approval', 'finished', 'system']) if (typeof p?.[k] === 'boolean') out[k] = p[k];
  return out;
}

function lanUrl(port: number): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${port}`;
  }
  return undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function listenOn(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
