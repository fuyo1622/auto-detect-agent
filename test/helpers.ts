// Shared bits for the tests (not a test file itself).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../src/log.ts';
import type { SessionFacts, SessionView } from '../src/types.ts';

export function tempDir(t: { after?: (fn: () => void) => void } | undefined, prefix = 'agent-monitor-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A logger that remembers what was logged, so tests can check for errors. */
export function memoryLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (...a: unknown[]) => void lines.push(`${level} ${a.map(String).join(' ')}`);
  return { lines, debug: add('DEBUG'), info: add('INFO'), warn: add('WARN'), error: add('ERROR') };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

/** Plain HTTP request with full control over headers (Host, Origin, ...). */
export function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    const headers: Record<string, string | number> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (payload !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function baseFacts(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    key: 'claude:test',
    host: 'cli',
    title: 'Test session',
    alive: true,
    phase: 'idle',
    registered: true,
    staleRecord: false,
    lastKnownBusy: false,
    rcExpected: true,
    rcState: 'on',
    ...over,
  };
}

export function baseView(over: Partial<SessionView> = {}): SessionView {
  return {
    key: 'claude:test',
    host: 'cli',
    title: 'Test session',
    alive: true,
    busy: false,
    idle: true,
    health: 'waiting',
    detail: 'Waiting for your next message',
    healthSince: Date.now(),
    notify: false,
    rc: { expected: true, state: 'on' },
    actions: ['reconnect'],
    ...over,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compiles a small C# program into dir/name with the compiler that ships with Windows (used for fake CLIs). */
export function compileFake(dir: string, name: string, source: string): string {
  const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${name}.cs`);
  const out = path.join(dir, name);
  fs.writeFileSync(src, source);
  const r = spawnSync(csc, ['-nologo', '-target:exe', `-out:${out}`, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`csc failed: ${r.stdout}${r.stderr}`);
  return out;
}

/** Polls until fn returns a truthy value or the time is up. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10000, stepMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(stepMs);
  }
}
