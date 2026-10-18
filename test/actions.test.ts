import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Actions, type Launcher } from '../src/actions.ts';
import { loadConfig } from '../src/config.ts';
import { isAlive } from '../src/launch.ts';
import { createLogger } from '../src/log.ts';
import type { Monitor } from '../src/monitor.ts';
import { Store } from '../src/store.ts';
import type { ResumeSpec, SessionFacts, SessionView } from '../src/types.ts';

const cfg = loadConfig(path.join(os.tmpdir(), 'no-config.json'));
const log = createLogger(undefined, false);
const store = new Store(path.join(os.tmpdir(), `agent-monitor-test-${process.pid}.json`), cfg.defaults);

/** Records what would have been opened instead of opening windows. */
function fakeLauncher() {
  const opened: { terminal: ResumeSpec[]; apps: string[] } = { terminal: [], apps: [] };
  const launcher: Launcher = {
    inTerminal: async (spec) => void opened.terminal.push(spec),
    packagedApp: async (aumid) => void opened.apps.push(aumid),
  };
  return { opened, launcher };
}

function setup(over: Partial<SessionFacts>, actions: SessionView['actions'], extra: Partial<Monitor> = {}) {
  const facts: SessionFacts = {
    key: 'claude:test',
    host: 'cli',
    title: 'Test session',
    alive: true,
    phase: 'idle',
    registered: true,
    staleRecord: false,
    lastKnownBusy: false,
    rcExpected: true,
    rcState: 'off',
    resume: { cwd: os.tmpdir(), title: 'Test session', command: ['claude', '--remote-control', '--resume', 'abc'] },
    ...over,
  };
  const view = { key: facts.key, title: facts.title, host: facts.host, alive: facts.alive, busy: facts.phase === 'busy', actions } as SessionView;
  const stopped: string[] = [];
  const monitor = {
    facts: (k: string) => (k === facts.key ? facts : undefined),
    view: (k: string) => (k === facts.key ? view : undefined),
    sessions: [view],
    appId: undefined,
    appProcess: () => undefined,
    refreshSoon: () => {},
    markStopped: (k: string) => stopped.push(k),
    ...extra,
  } as unknown as Monitor;
  const { opened, launcher } = fakeLauncher();
  return { actions: new Actions(cfg, monitor, store, log, launcher), opened, stopped };
}

async function dummyProcess() {
  const p = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => p.once('spawn', r));
  return p;
}

test('reconnecting a working session asks for confirmation first', async () => {
  const { actions } = setup({ phase: 'busy', pid: 999999 }, ['reconnect']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
});

test('reconnect plans: close the process, then open Windows Terminal with Remote Control', async () => {
  const { actions } = setup({ phase: 'busy', pid: 999999 }, ['reconnect']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.plan?.length, 2);
  assert.match(r.plan![0], /Close process 999999/);
  assert.match(r.plan![1], /claude --remote-control --resume abc/);
});

test('actions that are not offered for a session are refused', async () => {
  const { actions } = setup({}, ['dismiss']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /not available/);
});

test('resume refuses to start a second copy of a running session', async () => {
  const { actions, opened } = setup({}, ['resume']);
  const r = await actions.session('claude:test', 'resume', { by: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.message, /still running/);
  assert.equal(opened.terminal.length, 0);
});

test('resume reports a missing folder instead of launching', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-missing-folder-xyz');
  const { actions, opened } = setup({ alive: false, resume: { cwd: missing, title: 't', command: ['claude'] } }, ['resume', 'dismiss']);
  const r = await actions.session('claude:test', 'resume', { by: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.message, /not reachable/);
  assert.equal(opened.terminal.length, 0);
});

test('reconnect checks the folder before closing anything', async () => {
  const p = await dummyProcess();
  try {
    const missing = path.join(os.tmpdir(), 'definitely-missing-folder-xyz');
    const { actions } = setup({ pid: p.pid, resume: { cwd: missing, title: 't', command: ['claude'] } }, ['reconnect']);
    const r = await actions.session('claude:test', 'reconnect', { by: 'test' });
    assert.equal(r.ok, false);
    assert.match(r.message, /Nothing was closed/);
    assert.equal(isAlive(p.pid!), true, 'the session keeps running');
  } finally {
    p.kill();
  }
});

test('reconnect really closes the process and reopens the conversation with Remote Control', async () => {
  const p = await dummyProcess();
  const { actions, opened, stopped } = setup({ pid: p.pid }, ['reconnect']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test' });
  assert.equal(r.ok, true, r.message);
  assert.equal(isAlive(p.pid!), false);
  assert.deepEqual(stopped, ['claude:test'], 'remembered as closed on purpose, not a crash');
  assert.deepEqual(opened.terminal[0].command, ['claude', '--remote-control', '--resume', 'abc']);
  assert.equal(actions.history[0]?.ok, true);
});

test('restarting the Claude app marks its sessions as stopped on purpose, closes it and starts it again', async () => {
  const app = await dummyProcess();
  const view = (key: string, host: string, busy = false) => ({ key, host, alive: true, busy }) as SessionView;
  const { actions, opened, stopped } = setup({}, ['restart-app'], {
    sessions: [view('claude:app-1', 'desktop'), view('claude:cli-1', 'cli')],
    appId: 'Claude_x!Claude',
    appProcess: () => ({ pid: app.pid }) as any,
  } as Partial<Monitor>);
  try {
    const r = await actions.app('claude-desktop', 'restart', { by: 'test' });
    assert.equal(r.ok, true, r.message);
    assert.equal(isAlive(app.pid!), false);
    assert.deepEqual(stopped, ['claude:app-1'], 'only the app sessions, not terminal ones');
    assert.deepEqual(opened.apps, ['Claude_x!Claude']);
  } finally {
    app.kill();
  }
});

test('restarting the Claude app while its sessions work asks first', async () => {
  const { actions } = setup({}, ['restart-app'], {
    sessions: [{ key: 'claude:app-1', host: 'desktop', alive: true, busy: true } as SessionView],
    appId: 'Claude_x!Claude',
    appProcess: () => ({ pid: 999999 }) as any,
  } as Partial<Monitor>);
  const r = await actions.app('claude-desktop', 'restart', { by: 'test' });
  assert.equal(r.needsConfirm, true);
  assert.match(r.message, /1 Claude app session is still working/);
});

test('starting the Claude app: refused when it runs already or is not installed', async () => {
  const running = setup({}, [], { appId: 'Claude_x!Claude', appProcess: () => ({ pid: 1 }) as any } as Partial<Monitor>);
  assert.match((await running.actions.app('claude-desktop', 'start', { by: 'test' })).message, /already running/);
  const missing = setup({}, [], { appId: undefined } as Partial<Monitor>);
  assert.match((await missing.actions.app('claude-desktop', 'start', { by: 'test' })).message, /not installed/);
  const closed = setup({}, [], { appId: 'Claude_x!Claude' } as Partial<Monitor>);
  assert.equal((await closed.actions.app('claude-desktop', 'start', { by: 'test' })).ok, true);
  assert.deepEqual(closed.opened.apps, ['Claude_x!Claude']);
});
