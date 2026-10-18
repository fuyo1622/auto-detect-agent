// Minimal Chrome DevTools Protocol client for headless Edge (Node 22+ has WebSocket built in).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const DEBUG_PORT = 17497;
const STATE = path.join(os.tmpdir(), 'agent-monitor-e2e-edge.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ends every headless test Edge (all its processes), matched by its temporary profile folder. Never the user's Edge. */
export function killTestEdges(match = 'edge-pwa-test-') {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${match}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

export async function startEdge() {
  killTestEdges(); // a test browser left over from an interrupted run would answer on our port instead
  for (let i = 0; i < 25 && !(await portFree(DEBUG_PORT)); i++) await sleep(200);
  if (!(await portFree(DEBUG_PORT))) throw new Error(`port ${DEBUG_PORT} is still in use`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pwa-test-'));
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], {
    stdio: 'ignore',
    detached: true,
  });
  edge.unref();
  fs.writeFileSync(STATE, JSON.stringify({ pid: edge.pid, profile }));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('Edge did not start');
}

export function edgeState() {
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}

export async function connectBrowser() {
  const v = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}, sessionId) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject }));
  };
  return { send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn), close: () => ws.close() };
}

/** Attaches to the first page target (creating one if needed) and returns helpers for it. */
export async function openPage(browser, url) {
  const { targetInfos } = await browser.send('Target.getTargets');
  let target = targetInfos.find((t) => t.type === 'page');
  if (!target) target = { targetId: (await browser.send('Target.createTarget', { url: 'about:blank' })).targetId };
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = (method, params) => browser.send(method, params, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');
  const consoleErrors = [];
  browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const evaluate = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, timeoutMs = 15000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {}
      if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
      await sleep(200);
    }
  };
  const navigate = async (to) => {
    await page('Page.navigate', { url: to });
    await waitFor(`document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(to.split('#')[0])})`);
  };
  const reload = async () => {
    await page('Page.reload', { ignoreCache: false });
    await sleep(500);
    await waitFor(`document.readyState === 'complete'`);
  };
  if (url) await navigate(url);
  return { page, evaluate, waitFor, navigate, reload, consoleErrors, sessionId, targetId: target.targetId };
}

export async function stopEdge() {
  try {
    const { profile } = edgeState();
    killTestEdges(path.basename(profile)); // msedge.exe hands off to other processes, so its first pid is not enough
    await sleep(1500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    fs.rmSync(STATE, { force: true });
  } catch {}
}
