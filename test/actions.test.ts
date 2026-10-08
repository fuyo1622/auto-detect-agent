import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Actions, errorLine } from '../src/actions.ts';
import { loadConfig } from '../src/config.ts';
import { isAlive } from '../src/launch.ts';
import { createLogger } from '../src/log.ts';
import type { Monitor } from '../src/monitor.ts';
import { Store } from '../src/store.ts';
import type { SessionFacts, SessionView } from '../src/types.ts';

const cfg = loadConfig(path.join(os.tmpdir(), 'no-config.json'));
const log = createLogger(undefined, false);
const store = new Store(path.join(os.tmpdir(), `agent-monitor-test-${process.pid}.json`), cfg.defaults);

const stopped: string[] = [];

function session(over: Partial<SessionFacts>, actions: SessionView['actions']) {
  const facts: SessionFacts = {
    key: 'claude:test',
    tool: 'claude',
    host: 'cli',
    title: 'Test session',
    alive: true,
    phase: 'idle',
    registered: true,
    staleRecord: false,
    lastKnownBusy: false,
    rcExpected: true,
    rcState: 'off',
    approvalsDisabled: false,
    children: [],
    resume: { cwd: os.tmpdir(), title: 'Test session', command: ['claude', '--remote-control', '--resume', 'abc'] },
    ...over,
  };
  const view = { key: facts.key, title: facts.title, tool: facts.tool, host: facts.host, alive: facts.alive, busy: facts.phase === 'busy', actions } as SessionView;
  const monitor = {
    facts: (k: string) => (k === facts.key ? facts : undefined),
    view: (k: string) => (k === facts.key ? view : undefined),
    sessions: [view],
    appIds: {},
    desktopProcess: () => undefined,
    refreshSoon: () => {},
    recheckDaemon: () => {},
    markStopped: (k: string) => stopped.push(k),
  } as unknown as Monitor;
  return new Actions(cfg, monitor, store, log);
}

test('reconnecting a working session asks for confirmation first', async () => {
  const actions = session({ phase: 'busy', pid: 999999 }, ['reconnect', 'stop']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
});

test('reconnect closes the process, then opens Windows Terminal with Remote Control', async () => {
  const actions = session({ phase: 'busy', pid: 999999 }, ['reconnect', 'stop']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.plan?.length, 2);
  assert.match(r.plan![0], /Close process 999999/);
  assert.match(r.plan![1], /claude --remote-control --resume abc/);
});

test('actions that are not offered for a session are refused', async () => {
  const actions = session({}, ['stop']);
  const r = await actions.session('claude:test', 'reconnect', { by: 'test', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /not available/);
});

test('resume refuses to start a second copy of a running session', async () => {
  const actions = session({}, ['resume']);
  const r = await actions.session('claude:test', 'resume', { by: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.message, /still running/);
});

test('resume reports a missing folder instead of launching', async () => {
  const actions = session(
    { alive: false, resume: { cwd: path.join(os.tmpdir(), 'definitely-missing-folder-xyz'), title: 't', command: ['claude'] } },
    ['resume', 'dismiss'],
  );
  const r = await actions.session('claude:test', 'resume', { by: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.message, /not reachable/);
});

test('stop really ends the process tree', async () => {
  const dummy = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => dummy.once('spawn', r));
  assert.equal(isAlive(dummy.pid!), true);
  const actions = session({ pid: dummy.pid }, ['reconnect', 'stop']);
  const r = await actions.session('claude:test', 'stop', { by: 'test' });
  assert.equal(r.ok, true, r.message);
  assert.equal(isAlive(dummy.pid!), false);
  assert.equal(actions.history[0]?.ok, true);
  assert.deepEqual(stopped, ['claude:test'], 'remembered as stopped on purpose, not a crash');
});

test('reconnect checks the folder before closing anything', async () => {
  const dummy = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => dummy.once('spawn', r));
  try {
    const missing = path.join(os.tmpdir(), 'definitely-missing-folder-xyz');
    const actions = session({ pid: dummy.pid, resume: { cwd: missing, title: 't', command: ['claude'] } }, ['reconnect', 'stop']);
    const r = await actions.session('claude:test', 'reconnect', { by: 'test' });
    assert.equal(r.ok, false);
    assert.match(r.message, /Nothing was closed/);
    assert.equal(isAlive(dummy.pid!), true, 'the session keeps running');
  } finally {
    dummy.kill();
  }
});

test('a failed Codex command reports its error line, not its progress line', () => {
  const out = 'Starting app-server daemon with remote control enabled...\r\nError: host Job Object prevents daemon detachment; start from a host that allows breakaway\r\n';
  assert.equal(errorLine(out), 'Error: host Job Object prevents daemon detachment; start from a host that allows breakaway');
  assert.equal(errorLine('step 1\nstep 2 failed\n'), 'step 2 failed');
  assert.equal(errorLine(''), '');
});
