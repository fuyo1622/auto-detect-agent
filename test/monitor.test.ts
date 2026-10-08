import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { actionsFor, Monitor, type Transition } from '../src/monitor.ts';
import { buildSnapshot, type Snapshot } from '../src/proc/helper.ts';
import { Store } from '../src/store.ts';
import type { SessionView } from '../src/types.ts';
import { memoryLog, tempDir } from './helpers.ts';

// The scan loop end to end, with a fake process list and a fake ~/.claude: how a session's
// status changes from scan to scan, and which changes are reported as transitions.
const root = tempDir(undefined);
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cfg = loadConfig(path.join(root, 'no-config.json'));
cfg.paths.claudeHome = path.join(root, '.claude');
cfg.paths.claudeAppData = path.join(root, 'Claude');
cfg.paths.codexHome = path.join(root, '.codex');
cfg.codexCommand = path.join(root, 'no-codex-here.exe');
cfg.pollIntervalMs = 3600_000; // scans are driven by the test
const sessionsDir = path.join(cfg.paths.claudeHome, 'sessions');
const work = path.join(root, 'work');
const projectDir = path.join(cfg.paths.claudeHome, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
for (const d of [sessionsDir, projectDir, work]) fs.mkdirSync(d, { recursive: true });

const NOW = Date.now();
const ft = (ms: number) => String(BigInt(Math.round(ms) + 11644473600000) * 10000n);
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const S3 = 'cccccccc-3333-4333-8333-333333333333';
const S4 = 'dddddddd-4444-4444-8444-444444444444';
const CLI = 'C:\\fake\\claude.exe';
const DESKTOP = 'C:\\Program Files\\WindowsApps\\Claude_9.9_x64__abc\\app\\Claude.exe';

function writeRegistry(pid: number, startMs: number, extra: object) {
  fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, procStart: ft(startMs), startedAt: startMs + 800, cwd: work, kind: 'interactive', entrypoint: 'cli', updatedAt: Date.now(), ...extra }),
  );
}
const removeRegistry = (pid: number) => fs.rmSync(path.join(sessionsDir, `${pid}.json`), { force: true });

function writeTranscript(id: string, lines: object[], mtimeMsAgo?: number) {
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMsAgo !== undefined) {
    const t = new Date(Date.now() - mtimeMsAgo);
    fs.utimesSync(file, t, t);
  }
}

const proc = (pid: number, startMs: number, cmd: string, extra: object = {}) => ({
  pid,
  ppid: 1,
  name: 'claude.exe',
  root: true,
  startFt: ft(startMs),
  cpuMs: 1000,
  exe: CLI,
  cwd: work,
  cmd: `"${CLI}" ${cmd}`,
  ...extra,
});

let procs: any[] = [];
const helper = { mode: 'ok', snapshot: async (): Promise<Snapshot> => buildSnapshot(Date.now(), procs) };
const store = new Store(path.join(root, 'state.json'), cfg.defaults);
const monitor = new Monitor(cfg, store, helper as any, memoryLog());
monitor.appIds = { claude: 'Claude_abc!Claude', codex: 'OpenAI.Codex_xyz!App' };
after(() => monitor.stop());

const transitions: Transition[] = [];
const wakes: number[] = [];
monitor.on('transition', (t) => transitions.push(t));
monitor.on('wake', (ms) => wakes.push(ms));

async function scan(): Promise<SessionView[]> {
  await monitor.refresh();
  return monitor.sessions;
}
const find = (key: string) => monitor.sessions.find((s) => s.key === key);

const START = NOW - 3600_000;
const answer = { type: 'assistant', timestamp: new Date(NOW - 60_000).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } };

test('a terminal session with Remote Control on is "waiting"', async () => {
  writeRegistry(100, START, { sessionId: S1, status: 'idle', name: 'Fix login', nameSource: 'user', bridgeSessionId: 'cse_01AAA' });
  writeTranscript(S1, [answer]);
  procs = [proc(100, START, '--remote-control')];
  await scan();
  const s = find(`claude:${S1}`)!;
  assert.equal(s.health, 'waiting');
  assert.equal(s.title, 'Fix login');
  assert.equal(s.rc.state, 'on');
  assert.equal(s.rc.url, 'https://claude.ai/code/session_01AAA');
  assert.deepEqual(s.actions, ['reconnect', 'stop']);
  assert.equal(transitions.at(-1)?.to, 'waiting');
  assert.equal(transitions.at(-1)?.from, undefined);
});

test('Remote Control dropping turns it into "rc-lost", reported once', async () => {
  writeRegistry(100, START, { sessionId: S1, status: 'idle', name: 'Fix login', nameSource: 'user', bridgeSessionId: null });
  const before = transitions.length;
  await scan();
  const s = find(`claude:${S1}`)!;
  assert.equal(s.health, 'rc-lost');
  assert.equal(s.activity, 'waiting');
  assert.equal(s.notify, true);
  assert.equal(transitions.length, before + 1);
  assert.deepEqual([transitions.at(-1)!.from, transitions.at(-1)!.to], ['waiting', 'rc-lost']);
  const since = s.healthSince;
  await scan();
  assert.equal(find(`claude:${S1}`)!.healthSince, since, 'healthSince stays put while nothing changes');
  assert.equal(transitions.length, before + 1, 'no new transition');
});

test('a process that dies while working, leaving its registry behind, is "dead"', async () => {
  writeRegistry(100, START, { sessionId: S1, status: 'busy', name: 'Fix login', nameSource: 'user', bridgeSessionId: null });
  procs = [];
  await scan();
  const s = find(`claude:${S1}`)!;
  assert.equal(s.health, 'dead');
  assert.equal(s.alive, false);
  assert.equal(s.detail, 'Stopped while it was working');
  assert.deepEqual(s.actions, ['resume', 'dismiss']);
  assert.equal(transitions.at(-1)!.to, 'dead');
});

test('a dismissed session stays hidden until it runs again', async () => {
  store.data.dismissed[`claude:${S1}`] = Date.now();
  await scan();
  assert.equal(find(`claude:${S1}`), undefined);
  await scan();
  assert.equal(find(`claude:${S1}`), undefined, 'still hidden on the next scan');

  // Resumed: a new process for the same conversation.
  removeRegistry(100);
  writeRegistry(101, NOW - 5000, { sessionId: S1, status: 'idle', bridgeSessionId: 'cse_01AAB' });
  procs = [proc(101, NOW - 5000, `--remote-control --resume ${S1}`)];
  await scan();
  const s = find(`claude:${S1}`)!;
  assert.equal(s.health, 'waiting');
  assert.equal(s.pid, 101);
  assert.equal(store.data.dismissed[`claude:${S1}`], undefined, 'the dismissal is forgotten');
});

test('a session that closes normally (process and record gone) is "ended", then expires', async () => {
  removeRegistry(101);
  procs = [];
  await scan();
  const s = find(`claude:${S1}`)!;
  assert.equal(s.health, 'ended');
  assert.equal(s.detail, 'Closed');
  assert.deepEqual(s.actions, ['resume', 'dismiss']);
  assert.equal(transitions.at(-1)!.to, 'ended');
  await scan();
  assert.equal(find(`claude:${S1}`)?.health, 'ended', 'kept for endedRetentionMinutes');
  (monitor as any).tracked.get(`claude:${S1}`).expiresAt = Date.now() - 1;
  await scan();
  assert.equal(find(`claude:${S1}`), undefined);
});

test('busy with no transcript writes is "stuck" unless it (or a tool it runs) uses CPU', async () => {
  writeRegistry(200, START, { sessionId: S2, status: 'busy', statusUpdatedAt: NOW - 20 * 60_000, bridgeSessionId: 'cse_01BBB' });
  writeTranscript(S2, [{ type: 'user', timestamp: new Date(NOW - 20 * 60_000).toISOString(), message: { content: 'long job' } }], 20 * 60_000);
  const shell = { pid: 201, ppid: 200, name: 'pwsh.exe', root: false, startFt: ft(NOW - 19 * 60_000), cpuMs: 500 };
  procs = [proc(200, START, '--remote-control', { cpuMs: 1000 }), shell];
  await scan();
  assert.equal(find(`claude:${S2}`)!.health, 'stuck');
  assert.match(find(`claude:${S2}`)!.detail, /No progress for 20 min/);

  await new Promise((r) => setTimeout(r, 20));
  procs = [proc(200, START, '--remote-control', { cpuMs: 1000 }), { ...shell, cpuMs: 5000 }];
  await scan();
  assert.equal(find(`claude:${S2}`)!.health, 'working', 'its shell burned CPU, so it is working');
  await scan();
  assert.equal(find(`claude:${S2}`)!.health, 'working', 'recent CPU use keeps it working');
});

test('a Claude app session whose Remote Control was switched on in the app but is not connected', async () => {
  const metaDir = path.join(cfg.paths.claudeAppData, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, 'local_abc.json'),
    JSON.stringify({ sessionId: 'local_abc', cliSessionId: S3, title: 'App session', cwd: work, remoteControlUserEnabled: true, bridgeSessionIds: ['cse_01CCC'] }),
  );
  (monitor as any).claude.desktopMetaAt = 0; // re-read the app's records now
  writeRegistry(600, NOW - 600_000, { sessionId: S3, status: 'idle', entrypoint: 'claude-desktop', hostSessionId: 'local_abc', bridgeSessionId: null });
  writeTranscript(S3, [answer]);
  procs = [
    { pid: 900, ppid: 1, name: 'Claude.exe', root: true, startFt: ft(NOW - 9_000_000), exe: DESKTOP, cmd: `"${DESKTOP}"` },
    { pid: 901, ppid: 900, name: 'Claude.exe', root: true, startFt: ft(NOW - 9_000_000), exe: DESKTOP, cmd: `"${DESKTOP}" --type=renderer` },
    proc(600, NOW - 600_000, '--output-format stream-json --input-format stream-json', { ppid: 900 }),
  ];
  await scan();
  const s = find(`claude:${S3}`)!;
  assert.equal(s.host, 'desktop');
  assert.equal(s.title, 'App session');
  assert.equal(s.health, 'rc-lost');
  assert.equal(s.rc.url, 'https://claude.ai/code/session_01CCC');
  assert.deepEqual(s.actions, ['restart-app'], 'the app reopens its sessions itself, so no terminal copy');
  const app = monitor.apps.find((a) => a.id === 'claude-desktop')!;
  assert.equal(app.running, true);
  assert.equal(app.pid, 900, 'the main window process, not a renderer');
  assert.deepEqual(app.actions, ['restart', 'stop']);
  assert.deepEqual(monitor.apps.find((a) => a.id === 'codex-desktop')!.actions, ['start']);
});

test('worst problems are listed first', async () => {
  writeRegistry(700, NOW - 60_000, { sessionId: S4, status: 'idle', bridgeSessionId: 'cse_01DDD' });
  procs.push(proc(700, NOW - 60_000, '--remote-control'));
  await scan();
  const order = monitor.sessions.map((s) => s.health);
  const rank = ['dead', 'rc-lost', 'stuck', 'approval', 'working', 'waiting', 'ended'];
  assert.deepEqual([...order].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)), order);
  // S2's process vanished in the previous step while busy (its record is still there): dead, listed first.
  assert.equal(monitor.sessions[0].key, `claude:${S2}`);
  assert.equal(order[0], 'dead');
  assert.ok(order.includes('rc-lost') && order.includes('waiting'));
});

test('two processes on one conversation get separate keys', async () => {
  procs.push(proc(801, NOW - 30_000, `--resume ${S4}`), proc(802, NOW - 20_000, `--resume ${S4}`));
  await scan();
  const keys = monitor.sessions.filter((s) => s.sessionId === S4).map((s) => s.key);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3);
});

test('a long gap between scans means the PC was asleep', async () => {
  // A gap counts as sleep when it is well past the poll interval (3 intervals + 30 s).
  const gap = cfg.pollIntervalMs * 3 + 30_000 + 10 * 60_000;
  (monitor as any).lastTickAt = Date.now() - gap;
  await scan();
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0] >= gap && wakes[0] < gap + 60_000);
  assert.ok(monitor.lastWakeAt);
  await scan();
  assert.equal(wakes.length, 1, 'normal scans are not wake-ups');
});

const S5 = 'eeeeeeee-5555-4555-8555-555555555555';
const S6 = 'ffffffff-6666-4666-8666-666666666666';
const S7 = '77777777-7777-4777-8777-777777777777';

test('a session seen before Claude registers it does not leave a "Closed" ghost', async () => {
  const fresh = path.join(root, 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  const start = Date.now() - 2000;
  procs = [proc(1000, start, '--remote-control', { cwd: fresh })];
  await scan();
  const early = monitor.sessions.find((s) => s.pid === 1000)!;
  assert.match(early.key, /^claude-pid:/, 'no registry entry yet: known by its process');
  writeRegistry(1000, start, { sessionId: S5, status: 'idle', bridgeSessionId: 'cse_01EEE', cwd: fresh });
  const before = transitions.length;
  await scan();
  assert.equal(find(`claude:${S5}`)?.pid, 1000);
  assert.equal(find(early.key), undefined, 'the old key is dropped, not shown as Closed');
  assert.equal(transitions.slice(before).some((t) => t.to === 'ended'), false);
});

test('a session closed from here shows as "Stopped", not as a crash', async () => {
  const start = NOW - 600_000;
  writeRegistry(1100, start, { sessionId: S6, status: 'busy', bridgeSessionId: 'cse_01FFF' });
  procs = [proc(1100, start, '--remote-control')];
  await scan();
  assert.equal(find(`claude:${S6}`)?.health, 'working');
  monitor.markStopped(`claude:${S6}`);
  procs = []; // killed: taskkill /F leaves Claude's registry file behind
  await scan();
  const s = find(`claude:${S6}`)!;
  assert.deepEqual([s.health, s.detail, s.notify], ['ended', 'Stopped', false]);

  // Running again later (a process started after the stop) forgets the mark, so a real crash after that is reported.
  await new Promise((r) => setTimeout(r, 5));
  const again = Date.now();
  writeRegistry(1101, again, { sessionId: S6, status: 'busy', bridgeSessionId: 'cse_01FFF' });
  procs = [proc(1101, again, `--remote-control --resume ${S6}`)];
  await scan();
  assert.equal(find(`claude:${S6}`)?.alive, true);
  procs = [];
  await scan();
  assert.equal(find(`claude:${S6}`)?.health, 'dead');
});

test('a transcript in a brand-new project folder is found within seconds, not a minute', async () => {
  const brandNew = path.join(root, 'brand-new-project');
  fs.mkdirSync(brandNew, { recursive: true });
  const start = Date.now() - 120_000;
  writeRegistry(1200, start, { sessionId: S7, status: 'idle', bridgeSessionId: 'cse_01GGG', cwd: brandNew });
  procs = [proc(1200, start, '--remote-control', { cwd: brandNew })];
  await scan();
  assert.equal(find(`claude:${S7}`)?.lastMessage, undefined, 'no transcript yet');
  const dir = path.join(cfg.paths.claudeHome, 'projects', brandNew.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${S7}.jsonl`), JSON.stringify(answer) + '\n');
  (monitor as any).claude.projectDirsAt = Date.now() - 6000; // the folder list is 6 s old
  await scan();
  assert.equal(find(`claude:${S7}`)?.lastMessage?.text, 'Done.');
});

const S8 = '88888888-8888-4888-8888-888888888888';

test('a crash record does not come back after the conversation was resumed and then closed normally', async () => {
  const crashedAt = NOW - 900_000;
  writeRegistry(1300, crashedAt, { sessionId: S8, status: 'busy', bridgeSessionId: 'cse_01HHH' });
  procs = [];
  await scan();
  assert.equal(find(`claude:${S8}`)?.health, 'dead', 'the crash is reported');

  const resumedAt = Date.now() - 1000;
  writeRegistry(1301, resumedAt, { sessionId: S8, status: 'idle', bridgeSessionId: 'cse_01HHH' });
  procs = [proc(1301, resumedAt, `--remote-control --resume ${S8}`)];
  await scan();
  assert.equal(find(`claude:${S8}`)?.alive, true);
  assert.ok(Object.keys(store.data.superseded).some((id) => id.startsWith('1300:')), 'the old record is history now, saved to disk');

  removeRegistry(1301); // a normal exit removes the process's own record
  procs = [];
  await scan();
  const s = find(`claude:${S8}`)!;
  assert.equal(s.health, 'ended', `not a crash again (got ${s.health}: ${s.detail})`);
});

test('"Stopped" marks and superseded records survive an agent restart', async () => {
  monitor.markStopped('claude:restart-test');
  store.saveNow();
  const reloaded = new Store(path.join(root, 'state.json'), cfg.defaults);
  assert.ok(reloaded.data.stopped['claude:restart-test'], 'stop mark saved');
  assert.ok(Object.keys(reloaded.data.superseded).some((id) => id.startsWith('1300:')), 'superseded record saved');
  const restarted = new Monitor(cfg, reloaded, helper as any, memoryLog());
  procs = [];
  await restarted.refresh();
  restarted.stop();
  assert.notEqual(restarted.sessions.find((v) => v.key === `claude:${S8}`)?.health, 'dead', 'the old crash record stays history');
});

test('which buttons each kind of session gets', () => {
  const ids = { claude: 'Claude_x!Claude', codex: 'OpenAI.Codex_y!App' };
  const base = { key: 'k', title: 't', phase: 'idle' as const, registered: true, staleRecord: false, lastKnownBusy: false, rcExpected: false, rcState: 'n/a' as const, approvalsDisabled: false, children: [], resume: { cwd: work, title: 't', command: ['x'] } };
  const f = (tool: 'claude' | 'codex', host: 'cli' | 'desktop', alive: boolean, appRunning?: boolean) => actionsFor({ ...base, tool, host, alive, appRunning }, ids);
  assert.deepEqual(f('claude', 'cli', true), ['reconnect', 'stop']);
  assert.deepEqual(f('claude', 'cli', false), ['resume', 'dismiss']);
  assert.deepEqual(f('claude', 'desktop', true), ['restart-app'], 'no Move to terminal: the app would run it too');
  assert.deepEqual(f('claude', 'desktop', false, true), ['dismiss'], 'the running app reopens it itself');
  assert.deepEqual(f('claude', 'desktop', false, false), ['start-app', 'dismiss']);
  assert.deepEqual(f('codex', 'cli', true), ['reconnect', 'stop']);
  assert.deepEqual(f('codex', 'desktop', true), ['open-terminal', 'restart-app']);
});
