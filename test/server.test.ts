import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import webpush from 'web-push';
import type { ActionRequest } from '../src/actions.ts';
import { loadConfig } from '../src/config.ts';
import { Notifier } from '../src/notify.ts';
import { Pairing } from '../src/pairing.ts';
import { Servers, type ServerDeps } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { baseView, freePort, memoryLog, request, tempDir } from './helpers.ts';

// The two HTTP servers with real pairing, storage and push code; the monitor and actions are stand-ins.
const dir = tempDir(undefined);
after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })));

const cfg = loadConfig(path.join(dir, 'no-config.json'));
const log = memoryLog();
const store = new Store(path.join(dir, 'state.json'), cfg.defaults);
const notifier = new Notifier(cfg, store, log);
notifier.init();
const pairing = new Pairing(store);

const pushed: { endpoint: string; payload: any }[] = [];
webpush.sendNotification = (async (sub: webpush.PushSubscription, payload?: string | Buffer | null) => {
  pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(String(payload)) });
  return { statusCode: 201, body: '', headers: {} };
}) as typeof webpush.sendNotification;

const calls: { kind: string; args: unknown[]; req: ActionRequest }[] = [];
const view = baseView({ key: 'claude:abc', title: 'Fix login' });
let shutdownCalled = false;
let tailscaleUrl: string | undefined;

const deps: ServerDeps = {
  cfg,
  log,
  store,
  notifier,
  pairing,
  monitor: { sessions: [view], apps: [], lastWakeAt: undefined, refreshSoon() {} } as any,
  actions: {
    history: [],
    async session(key: string, action: string, req: ActionRequest) {
      calls.push({ kind: 'session', args: [key, action], req });
      return { ok: true, message: 'done' };
    },
    async app(id: string, action: string, req: ActionRequest) {
      calls.push({ kind: 'app', args: [id, action], req });
      return { ok: true, message: 'done' };
    },
  } as any,
  tailscale: {
    get status() {
      return { installed: !!tailscaleUrl, running: !!tailscaleUrl, serving: !!tailscaleUrl, url: tailscaleUrl, checkedAt: Date.now() };
    },
    async refresh() {
      return this.status;
    },
    async enableServe() {
      return { ok: false, message: 'Tailscale is not installed on this PC.' };
    },
  } as any,
  awake: { active: false, async update() {} } as any,
  version: '9.9.9',
  startedAt: Date.now(),
  helperMode: () => 'ok',
  shutdown: () => {
    shutdownCalled = true;
  },
};

let servers: Servers;
let ADMIN: number;
let PHONE: number;
const H = { 'X-Agent-Client': 'test' };

before(async () => {
  cfg.adminPort = ADMIN = await freePort();
  cfg.phonePort = PHONE = await freePort();
  servers = new Servers(deps);
  await servers.listen();
});
after(() => servers.close());

async function pairPhone(name = 'Test iPhone'): Promise<string> {
  const p = await request(ADMIN, 'POST', '/api/admin/pairing', { headers: H });
  assert.equal(p.status, 200);
  const r = await request(PHONE, 'POST', '/api/pair', { body: { code: p.json.code, name } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

// ---------------------------------------------------------------- PC-only port

test('PC port: answers for 127.0.0.1 and localhost', async () => {
  const a = await request(ADMIN, 'GET', '/api/whoami');
  assert.equal(a.status, 200);
  assert.equal(a.json.admin, true);
  assert.equal(a.json.version, '9.9.9');
  const b = await request(ADMIN, 'GET', '/api/whoami', { headers: { Host: `localhost:${ADMIN}` } });
  assert.equal(b.status, 200);
});

test('PC port: other Host headers are refused (DNS rebinding)', async () => {
  for (const host of ['evil.example', `evil.example:${ADMIN}`, `127.0.0.1:${ADMIN + 1}`, '']) {
    const r = await request(ADMIN, 'GET', '/api/state', { headers: { Host: host } });
    assert.equal(r.status, 403, `Host "${host}"`);
  }
});

test('PC port: cross-site requests and changes without the client header are refused', async () => {
  const cross = await request(ADMIN, 'GET', '/api/state', { headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const sameOrigin = await request(ADMIN, 'GET', '/api/state', { headers: { Origin: `http://127.0.0.1:${ADMIN}` } });
  assert.equal(sameOrigin.status, 200);
  const noHeader = await request(ADMIN, 'POST', '/api/admin/shutdown');
  assert.equal(noHeader.status, 403);
  const crossPost = await request(ADMIN, 'POST', '/api/admin/shutdown', { headers: { ...H, Origin: 'null' } });
  assert.equal(crossPost.status, 403);
  assert.equal(shutdownCalled, false);
});

test('PC port: pairing info has a 6-digit code, and a QR link once there is a phone address', async () => {
  tailscaleUrl = undefined;
  const a = await request(ADMIN, 'GET', '/api/admin/pairing');
  assert.equal(a.status, 200);
  assert.match(a.json.code, /^\d{6}$/);
  assert.equal(a.json.link, undefined, 'no phone address yet, so no link');
  const again = await request(ADMIN, 'GET', '/api/admin/pairing');
  assert.equal(again.json.code, a.json.code, 'GET keeps the current code');

  tailscaleUrl = 'https://my-pc.tail1234.ts.net';
  const b = await request(ADMIN, 'POST', '/api/admin/pairing', { headers: H });
  assert.equal(b.json.url, tailscaleUrl);
  assert.equal(b.json.link, `${tailscaleUrl}/#pair=${b.json.code}`);
  assert.match(b.json.qrSvg, /^<svg/);
  tailscaleUrl = undefined;
});

test('PC port: pairing is only done from the phone', async () => {
  const r = await request(ADMIN, 'POST', '/api/pair', { headers: H, body: { code: '123456' } });
  assert.equal(r.status, 400);
});

test('PC port: settings are validated and saved', async () => {
  const bad = await request(ADMIN, 'PATCH', '/api/settings', { headers: H, body: { keepAwake: 'forever' } });
  assert.equal(bad.status, 400);
  const ok = await request(ADMIN, 'PATCH', '/api/settings', { headers: H, body: { keepAwake: 'while-working', autoReconnect: 1, stuckMinutes: 30 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { keepAwake: 'while-working', autoReconnect: true }, 'unknown settings are ignored');
  const saved = new Store(path.join(dir, 'state.json'), cfg.defaults);
  assert.equal(saved.data.settings.autoReconnect, true, 'written to disk');
  const off = await request(ADMIN, 'PATCH', '/api/settings', { headers: H, body: { autoReconnect: false } });
  assert.equal(off.json.autoReconnect, false, 'auto-reconnect can be switched off again');
});

test('PC port: shutdown is a POST with the client header', async () => {
  const r = await request(ADMIN, 'POST', '/api/admin/shutdown', { headers: H });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(shutdownCalled, true);
});

// ---------------------------------------------------------------- phone port

test('phone port: everything except pairing needs a paired token', async () => {
  for (const [method, p] of [['GET', '/api/state'], ['GET', '/api/events'], ['GET', '/api/whoami'], ['POST', '/api/sessions/claude:abc/stop']]) {
    const r = await request(PHONE, method, p, { body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  const wrong = await request(PHONE, 'GET', '/api/state', { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(wrong.status, 401);
});

test('phone port: a code works once; wrong codes are refused', async () => {
  const p = await request(ADMIN, 'POST', '/api/admin/pairing', { headers: H });
  const wrongCode = String((Number(p.json.code) + 1) % 1_000_000).padStart(6, '0');
  const wrong = await request(PHONE, 'POST', '/api/pair', { body: { code: wrongCode, name: 'x' } });
  assert.equal(wrong.status, 403);
  const ok = await request(PHONE, 'POST', '/api/pair', { body: { code: `${p.json.code.slice(0, 3)} ${p.json.code.slice(3)}`, name: 'Spaced' } });
  assert.equal(ok.status, 200, 'the code may be typed with a space');
  assert.equal(ok.json.device.name, 'Spaced');
  assert.equal(typeof ok.json.token, 'string');
  const reuse = await request(PHONE, 'POST', '/api/pair', { body: { code: p.json.code, name: 'Second phone' } });
  assert.equal(reuse.status, 403, 'one phone per code');
  const stored = store.data.devices.find((d) => d.name === 'Spaced')!;
  assert.notEqual(stored.tokenHash, ok.json.token, 'only a hash of the token is stored');
});

test('phone port: a paired phone sees the state and can run actions as itself', async () => {
  const token = await pairPhone('Work iPhone');
  const auth = { Authorization: `Bearer ${token}` };
  const who = await request(PHONE, 'GET', '/api/whoami', { headers: auth });
  assert.equal(who.json.admin, false);
  assert.equal(who.json.device.name, 'Work iPhone');
  const st = await request(PHONE, 'GET', '/api/state', { headers: auth });
  assert.equal(st.status, 200);
  assert.equal(st.json.sessions[0].key, 'claude:abc');
  assert.equal(st.json.agent.version, '9.9.9');

  calls.length = 0;
  const act = await request(PHONE, 'POST', `/api/sessions/${encodeURIComponent('claude:abc')}/reconnect`, { headers: auth, body: { force: true } });
  assert.equal(act.status, 200);
  assert.deepEqual(calls[0].args, ['claude:abc', 'reconnect']);
  assert.equal(calls[0].req.by, 'Work iPhone');
  assert.equal(calls[0].req.force, true);
  const app = await request(PHONE, 'POST', '/api/apps/claude-desktop/restart', { headers: auth, body: {} });
  assert.equal(app.status, 200);
  assert.deepEqual(calls[1].args, ['claude-desktop', 'restart']);

  for (const p of ['/api/sessions/claude:abc/format-disk', '/api/sessions/claude:abc/stop', '/api/apps/explorer/restart', '/api/apps/codex-daemon/start', '/api/apps/claude-desktop/stop']) {
    const r = await request(PHONE, 'POST', p, { headers: auth, body: {} });
    assert.equal(r.status, 400, p);
  }
  assert.equal(calls.length, 2, 'nothing else reached the actions');
});

test('phone port: PC-only routes do not exist for the phone', async () => {
  const token = await pairPhone();
  const auth = { Authorization: `Bearer ${token}` };
  for (const [method, p] of [['GET', '/api/admin/devices'], ['GET', '/api/admin/pairing'], ['POST', '/api/admin/shutdown'], ['POST', '/api/admin/tailscale/serve'], ['GET', '/api/summary']]) {
    const r = await request(PHONE, method, p, { headers: auth, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
});

test('phone port: push subscription, preferences, test push and unsubscribe', async () => {
  const token = await pairPhone('Push phone');
  const auth = { Authorization: `Bearer ${token}` };
  const key = await request(PHONE, 'GET', '/api/push/key', { headers: auth });
  assert.equal(key.json.publicKey, store.data.vapid!.publicKey);

  const notHttps = await request(PHONE, 'POST', '/api/push/subscribe', {
    headers: auth,
    body: { subscription: { endpoint: 'http://evil.example/x', keys: { p256dh: 'a', auth: 'b' } } },
  });
  assert.equal(notHttps.status, 400);
  const noKeys = await request(PHONE, 'POST', '/api/push/subscribe', { headers: auth, body: { subscription: { endpoint: 'https://web.push.apple.com/x' } } });
  assert.equal(noKeys.status, 400);

  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } };
  const ok = await request(PHONE, 'POST', '/api/push/subscribe', { headers: auth, body: { subscription: sub } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.push, true);
  assert.deepEqual(ok.json.prefs, { problems: true, system: true });

  const prefs = await request(PHONE, 'PATCH', '/api/push/prefs', { headers: auth, body: { prefs: { system: false, problems: 'yes', bogus: true } } });
  assert.equal(prefs.json.prefs.system, false);
  assert.equal(prefs.json.prefs.problems, true, 'non-boolean values are ignored');
  assert.equal('bogus' in prefs.json.prefs, false);

  pushed.length = 0;
  const t = await request(PHONE, 'POST', '/api/push/test', { headers: auth, body: {} });
  assert.equal(t.status, 200);
  assert.equal(t.json.sent, 1);
  assert.equal(pushed.length, 1, 'only this phone gets its own test');
  assert.equal(pushed[0].endpoint, sub.endpoint);
  assert.match(pushed[0].payload.body, /Test notification/);
  assert.equal(pushed[0].payload.url, '/#s=claude%3Aabc', 'tapping the test opens a real session');
  assert.match(pushed[0].payload.body, /Tap it to open “Fix login”/);

  const off = await request(PHONE, 'POST', '/api/push/unsubscribe', { headers: auth, body: {} });
  assert.equal(off.json.push, false);
  const t2 = await request(PHONE, 'POST', '/api/push/test', { headers: auth, body: {} });
  assert.equal(t2.status, 400);
});

test('phone port: unpairing from the phone or removing it on the PC ends its access', async () => {
  const a = await pairPhone('Phone A');
  const self = await request(PHONE, 'POST', '/api/device/unpair', { headers: { Authorization: `Bearer ${a}` }, body: {} });
  assert.equal(self.status, 200);
  assert.equal((await request(PHONE, 'GET', '/api/state', { headers: { Authorization: `Bearer ${a}` } })).status, 401);

  const b = await pairPhone('Phone B');
  const list = await request(ADMIN, 'GET', '/api/admin/devices');
  const dev = list.json.find((d: any) => d.name === 'Phone B');
  assert.equal('tokenHash' in dev, false, 'the device list never includes token hashes');
  const del = await request(ADMIN, 'DELETE', `/api/admin/devices/${dev.id}`, { headers: H });
  assert.equal(del.status, 200);
  assert.equal((await request(PHONE, 'GET', '/api/state', { headers: { Authorization: `Bearer ${b}` } })).status, 401);
  const again = await request(ADMIN, 'DELETE', `/api/admin/devices/${dev.id}`, { headers: H });
  assert.equal(again.status, 404);
});

test('phone port: bad bodies are rejected', async () => {
  const token = await pairPhone();
  const auth = { Authorization: `Bearer ${token}` };
  const badJson = await request(PHONE, 'PATCH', '/api/settings', { headers: auth, raw: '{nope' });
  assert.equal(badJson.status, 400);
  const huge = 'x'.repeat(70 * 1024);
  const tooBig = await request(PHONE, 'PATCH', '/api/settings', { headers: auth, body: { pad: huge } }).catch((e) => ({ status: -1, error: e }));
  assert.ok(tooBig.status === 413 || tooBig.status === -1, `got ${tooBig.status}`);
});

// ---------------------------------------------------------------- static files and streams

test('static files: the app is served with security headers', async () => {
  const r = await request(PHONE, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /text\/html/);
  assert.match(r.text, /<title>Agent Monitor<\/title>/);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const js = await request(PHONE, 'GET', '/app.js');
  assert.match(String(js.headers['content-type']), /text\/javascript/);
  const manifest = await request(PHONE, 'GET', '/manifest.webmanifest');
  assert.match(String(manifest.headers['content-type']), /application\/manifest\+json/);
  const icon = await request(PHONE, 'GET', '/icons/icon-192.png');
  assert.equal(icon.headers['content-type'], 'image/png');
});

test('static files: nothing outside the web folder can be read', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5csrc%5cconfig.ts', '/icons/..%5c..%5cpackage.json', '/..%5c..%5c..%5cWindows%5cwin.ini', '/C:%5cWindows%5cwin.ini']) {
    const r = await request(PHONE, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /"name": "auto-detect-agent"|\[fonts\]/, p);
  }
  const post = await request(PHONE, 'POST', '/index.html', { body: {} });
  assert.equal(post.status, 405);
});

test('malformed URLs are a client error, not a server error', async () => {
  const r = await request(PHONE, 'GET', '/%E0%A4%A');
  assert.equal(r.status, 400);
  const api = await request(ADMIN, 'POST', '/api/sessions/%E0%A4%A/stop', { headers: H, body: {} });
  assert.equal(api.status, 400);
  assert.equal(log.lines.filter((l) => l.startsWith('ERROR')).length, 0, log.lines.join('\n'));
});

test('event stream: sends the state at once and again on every broadcast', async () => {
  const token = await pairPhone('Stream phone');
  const events: string[] = [];
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PHONE, path: '/api/events', headers: { Authorization: `Bearer ${token}` } }, resolve);
    req.on('error', reject);
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      events.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  });
  const states = () => events.filter((e) => e.includes('event: state'));
  for (let i = 0; i < 50 && states().length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  // At least one: a broadcast still pending from an earlier test may arrive right after the first state.
  assert.ok(states().length >= 1, 'the state is sent at once');
  const first = JSON.parse(states()[0].split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  assert.equal(first.sessions[0].title, 'Fix login');

  const before = states().length;
  servers.broadcast();
  for (let i = 0; i < 100 && states().length <= before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(states().length > before, 'a broadcast reaches open streams');
  res.destroy();
});
