import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { AutoReconnect } from '../src/auto.ts';
import { KeepAwake } from '../src/awake.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { baseView, memoryLog, tempDir } from './helpers.ts';

const cfg = loadConfig(path.join(tempDir(undefined), 'no-config.json'));
const MIN = 60_000;

function autoSetup(t: any, enabled = true) {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const store = new Store(path.join(tempDir(t), 's.json'), cfg.defaults);
  store.data.settings.autoReconnect = enabled;
  const calls: string[] = [];
  const pushes: string[] = [];
  const actions = { session: async (key: string, action: string) => (calls.push(`${action} ${key}`), { ok: true, message: 'ok' }) };
  const notifier = { send: async (_c: string, p: { body: string }) => (pushes.push(p.body), { sent: 1, failed: 0 }) };
  const auto = new AutoReconnect(store, actions as any, notifier as any, memoryLog());
  const lost = (over = {}) => baseView({ key: 'claude:x', health: 'rc-lost', healthSince: Date.now() - 3 * MIN, actions: ['reconnect', 'stop'], ...over });
  return { auto, calls, pushes, lost, store };
}

const flush = () => new Promise((r) => setImmediate(r));

test('auto-reconnect is off by default', () => {
  assert.equal(cfg.defaults.autoReconnect, false);
});

test('auto-reconnect: an idle terminal session that lost Remote Control 2+ minutes ago is reopened', async (t) => {
  const { auto, calls, pushes, lost } = autoSetup(t);
  auto.onUpdate([lost({ healthSince: Date.now() - 1 * MIN })]);
  assert.deepEqual(calls, [], 'waits 2 minutes first');
  auto.onUpdate([lost()]);
  await flush();
  assert.deepEqual(calls, ['reconnect claude:x']);
  assert.match(pushes[0], /reopened in Windows Terminal/);
});

test('auto-reconnect leaves alone: working, app, Codex, closed, other problems, and when off', async (t) => {
  const { auto, calls, lost, store } = autoSetup(t);
  auto.onUpdate([
    lost({ key: 'a', busy: true }),
    lost({ key: 'b', host: 'desktop' }),
    lost({ key: 'c', tool: 'codex' }),
    lost({ key: 'd', alive: false }),
    lost({ key: 'e', health: 'stuck' }),
    lost({ key: 'f', actions: ['stop'] }),
  ]);
  store.data.settings.autoReconnect = false;
  auto.onUpdate([lost()]);
  await flush();
  assert.deepEqual(calls, []);
});

test('auto-reconnect: at most once per 15 minutes and 3 times per hour per session', async (t) => {
  const { auto, calls, lost } = autoSetup(t);
  const tryNow = () => auto.onUpdate([lost()]);
  tryNow();
  tryNow();
  assert.equal(calls.length, 1, 'not again right away');
  mock.timers.tick(15 * MIN);
  tryNow();
  mock.timers.tick(15 * MIN);
  tryNow();
  assert.equal(calls.length, 3);
  mock.timers.tick(15 * MIN);
  tryNow();
  assert.equal(calls.length, 3, 'a 4th try within the hour is skipped');
  mock.timers.tick(16 * MIN);
  tryNow();
  assert.equal(calls.length, 4, 'allowed again once the first try is an hour old');
});

test('auto-reconnect failures are reported to the phone', async (t) => {
  const { auto, pushes, lost } = autoSetup(t);
  (auto as any).actions = { session: async () => ({ ok: false, message: 'Folder not found: D:\\gone' }) };
  auto.onUpdate([lost()]);
  await flush();
  await flush();
  assert.match(pushes[0], /Auto-reconnect failed: Folder not found/);
});

function awakeSetup(t: any, mode: 'off' | 'while-working' | 'always', helperOk = true) {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const store = new Store(path.join(tempDir(t), 's.json'), cfg.defaults);
  store.data.settings.keepAwake = mode;
  const calls: boolean[] = [];
  const helper = { setAwake: async (on: boolean) => (calls.push(on), helperOk) };
  return { awake: new KeepAwake(helper as any, store, memoryLog()), calls, store };
}

const working = [baseView({ busy: true, health: 'working' })];
const idle = [baseView({ busy: false })];

test('keep awake "off" never holds the PC', async (t) => {
  const { awake, calls } = awakeSetup(t, 'off');
  await awake.update(working);
  assert.deepEqual(calls, []);
  assert.equal(awake.active, false);
});

test('keep awake "always" holds it once, and lets go on release', async (t) => {
  const { awake, calls } = awakeSetup(t, 'always');
  await awake.update(idle);
  await awake.update(idle);
  assert.deepEqual(calls, [true]);
  assert.equal(awake.active, true);
  await awake.release();
  assert.deepEqual(calls, [true, false]);
});

test('keep awake "while working" holds while busy plus 2 minutes', async (t) => {
  const { awake, calls } = awakeSetup(t, 'while-working');
  await awake.update(idle);
  assert.deepEqual(calls, []);
  await awake.update(working);
  assert.deepEqual(calls, [true]);
  mock.timers.tick(MIN);
  await awake.update(idle);
  assert.equal(awake.active, true, 'still within the 2-minute hold');
  mock.timers.tick(MIN + 1);
  await awake.update(idle);
  assert.deepEqual(calls, [true, false]);
});

test('keep awake reports honestly when the helper cannot hold the PC', async (t) => {
  const { awake } = awakeSetup(t, 'always', false);
  await awake.update(idle);
  assert.equal(awake.active, false);
});

test('settings saved by an older version get new defaults', (t) => {
  const file = path.join(tempDir(t), 'old.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [], settings: { keepAwake: 'always' } }));
  const store = new Store(file, cfg.defaults);
  assert.deepEqual(store.data.settings, { keepAwake: 'always', stuckMinutes: 15, autoReconnect: false });
  assert.deepEqual(store.data.dismissed, {});
});

test('a broken state file does not stop the agent', (t) => {
  const file = path.join(tempDir(t), 'broken.json');
  fs.writeFileSync(file, '{ not json');
  const store = new Store(file, cfg.defaults);
  assert.deepEqual(store.data.devices, []);
  store.saveNow();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'rewritten cleanly');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
});

test('config.json values override the defaults; paths can be overridden one by one', (t) => {
  const file = path.join(tempDir(t), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ phonePort: 9000, defaults: { stuckMinutes: 30 }, paths: { codexHome: 'X:\\codex' } }));
  const c = loadConfig(file);
  assert.equal(c.phonePort, 9000);
  assert.equal(c.adminPort, 7421);
  assert.deepEqual(c.defaults, { keepAwake: 'off', stuckMinutes: 30, autoReconnect: false });
  assert.equal(c.paths.codexHome, 'X:\\codex');
  assert.ok(c.paths.claudeHome.endsWith('.claude') || !!process.env.CLAUDE_CONFIG_DIR);
});

test('AGENT_MONITOR_CONFIG points the agent at another config file', (t) => {
  const file = path.join(tempDir(t), 'test-config.json');
  fs.writeFileSync(file, JSON.stringify({ adminPort: 17421 }));
  const before = process.env.AGENT_MONITOR_CONFIG;
  process.env.AGENT_MONITOR_CONFIG = file;
  try {
    assert.equal(loadConfig().adminPort, 17421);
  } finally {
    if (before === undefined) delete process.env.AGENT_MONITOR_CONFIG;
    else process.env.AGENT_MONITOR_CONFIG = before;
  }
});
