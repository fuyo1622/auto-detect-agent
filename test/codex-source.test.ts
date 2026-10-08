import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { deriveHealth } from '../src/health.ts';
import { buildSnapshot } from '../src/proc/helper.ts';
import { CodexSource, daemonProcesses, findCodexDesktop, subagentActivity } from '../src/sources/codex.ts';
import { tempDir } from './helpers.ts';

// A fake ~/.codex shaped like the real one (session_meta fields and source values seen on this PC).
const root = tempDir(undefined);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cfg = loadConfig(path.join(root, 'no-config.json'));
cfg.paths.codexHome = path.join(root, '.codex');
const day = path.join(cfg.paths.codexHome, 'sessions', '2026', '10', '01');
const work = path.join(root, 'work');
const other = path.join(root, 'other');
for (const d of [day, work, other]) fs.mkdirSync(d, { recursive: true });

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ft = (ms: number) => String(BigInt(Math.round(ms) + 11644473600000) * 10000n);
const ID = {
  desk: '019f0000-0000-7000-8000-000000000001',
  deskOld: '019f0000-0000-7000-8000-000000000002',
  guardian: '019f0000-0000-7000-8000-000000000003',
  spawn: '019f0000-0000-7000-8000-000000000004',
  spawnChild: '019f0000-0000-7000-8000-000000000005',
  cli: '019f0000-0000-7000-8000-000000000006',
  cliHelper: '019f0000-0000-7000-8000-000000000007',
  closed: '019f0000-0000-7000-8000-000000000008',
  crashed: '019f0000-0000-7000-8000-000000000009',
  exec: '019f0000-0000-7000-8000-00000000000a',
  resumed: '019f0000-0000-7000-8000-00000000000b',
};

function rollout(id: string, meta: object, lines: object[], mtimeMsAgo: number) {
  const file = path.join(day, `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  const first = { timestamp: iso(mtimeMsAgo + 60_000), type: 'session_meta', payload: { session_id: id, id, timestamp: iso(mtimeMsAgo + 60_000), cli_version: '0.157.0', ...meta } };
  fs.writeFileSync(file, [first, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(NOW - mtimeMsAgo);
  fs.utimesSync(file, t, t);
}
const ev = (msAgo: number, payload: object) => ({ timestamp: iso(msAgo), type: 'event_msg', payload });
const userMsg = (msAgo: number, text: string) => ({ timestamp: iso(msAgo), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const desktopMeta = { cwd: work, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' };
const cliMeta = { cwd: work, originator: 'codex-tui', source: 'cli', thread_source: 'user' };

// A Codex app thread, busy, whose own file is quiet for 20 min while its helpers keep working.
rollout(ID.desk, desktopMeta, [ev(21 * 60_000, { type: 'task_started' }), userMsg(21 * 60_000, 'Refactor the parser')], 20 * 60_000);
rollout(ID.guardian, { ...desktopMeta, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: ID.desk, session_id: ID.desk }, [ev(60_000, { type: 'task_started' })], 60_000);
rollout(ID.spawn, { ...desktopMeta, source: { subagent: { thread_spawn: { parent_thread_id: ID.desk, depth: 1, agent_nickname: 'Euler' } } }, thread_source: 'subagent', parent_thread_id: ID.desk }, [], 5 * 60_000);
rollout(ID.spawnChild, { ...desktopMeta, source: { subagent: { thread_spawn: { parent_thread_id: ID.spawn, depth: 2 } } }, thread_source: 'subagent', parent_thread_id: ID.spawn }, [], 30_000);
// An app thread last touched yesterday.
rollout(ID.deskOld, desktopMeta, [ev(20 * 3600_000, { type: 'task_complete' })], 20 * 3600_000);
// A terminal session, and a helper thread it started in the same folder (newer file).
rollout(ID.cli, cliMeta, [ev(9 * 60_000, { type: 'task_started' }), ev(8 * 60_000, { type: 'exec_approval_request', command: ['git', 'push'] })], 8 * 60_000);
rollout(ID.cliHelper, { ...cliMeta, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: ID.cli }, [], 10_000);
// Terminal sessions whose process is gone: one finished normally, one died mid-task.
rollout(ID.closed, { ...cliMeta, cwd: other }, [ev(6 * 60_000, { type: 'task_started' }), ev(5 * 60_000, { type: 'task_complete', last_agent_message: 'Done.' })], 5 * 60_000);
rollout(ID.crashed, { ...cliMeta, cwd: other }, [ev(3 * 3600_000, { type: 'task_started' })], 3 * 3600_000);
// `codex exec` runs are not sessions.
rollout(ID.exec, { ...cliMeta, cwd: other, source: 'exec' }, [ev(60_000, { type: 'task_started' })], 60_000);
// An old conversation reopened with `codex resume <id>`.
rollout(ID.resumed, { ...cliMeta, cwd: other }, [], 30 * 3600_000 - 1);

fs.writeFileSync(
  path.join(cfg.paths.codexHome, 'session_index.jsonl'),
  [{ id: ID.desk, thread_name: 'Parser refactor', updated_at: iso(0) }, { id: ID.cli, thread_name: 'Release prep', updated_at: iso(0) }].map((l) => JSON.stringify(l)).join('\n') + '\n',
);

const APP = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const CODEX = 'C:\\fake\\codex.exe';
const snap = buildSnapshot(NOW, [
  { pid: 50, ppid: 1, name: 'ChatGPT.exe', root: true, exe: APP, cmd: `"${APP}"`, startFt: ft(NOW - 9e6) },
  { pid: 51, ppid: 50, name: 'ChatGPT.exe', root: true, exe: APP, cmd: `"${APP}" --type=gpu-process`, startFt: ft(NOW - 9e6) },
  { pid: 52, ppid: 50, name: 'codex.exe', root: true, exe: CODEX, cmd: `"${CODEX}" app-server --analytics-default-enabled`, startFt: ft(NOW - 9e6) },
  { pid: 60, ppid: 1, name: 'codex.exe', root: true, exe: CODEX, cwd: work, cmd: `"${CODEX}"`, startFt: ft(NOW - 10 * 60_000), cpuMs: 10 },
  { pid: 61, ppid: 60, name: 'codex.exe', root: true, exe: CODEX, cwd: work, cmd: `"${CODEX}" --sandbox-runner`, startFt: ft(NOW - 9 * 60_000) },
  { pid: 70, ppid: 1, name: 'codex.exe', root: true, exe: CODEX, cwd: other, cmd: `"${CODEX}" resume ${ID.resumed}`, startFt: ft(NOW - 60_000) },
  { pid: 80, ppid: 1, name: 'codex.exe', root: true, exe: CODEX, cmd: `"${CODEX}" app-server daemon run`, startFt: ft(NOW - 9e6) },
]);

const desktop = findCodexDesktop(snap);
const source = new CodexSource(cfg);
const facts = source.collect(snap, NOW, desktop);
const byId = new Map(facts.map((f) => [f.sessionId, f]));
const health = (id: string) => deriveHealth(byId.get(id)!, { now: NOW, stuckMs: 15 * 60_000, approvalMs: 60_000 }).health;

test('the Codex app is its main window process; the daemon is the one outside the app', () => {
  assert.equal(desktop?.pid, 50);
  assert.deepEqual(daemonProcesses(snap, desktop).map((p) => p.pid), [80]);
});

test('helper threads (approval reviewer, spawned agents) are not listed as sessions', () => {
  for (const id of [ID.guardian, ID.spawn, ID.spawnChild, ID.cliHelper]) assert.equal(byId.has(id), false, id);
});

test('an app thread whose helpers are still working is not "stuck"', () => {
  const f = byId.get(ID.desk)!;
  assert.equal(f.host, 'desktop');
  assert.equal(f.alive, true);
  assert.equal(f.title, 'Parser refactor');
  assert.equal(f.phase, 'busy');
  assert.ok(f.lastActivityAt! >= NOW - 30_000 - 1000, 'the newest helper write (2 levels down) counts');
  assert.equal(health(ID.desk), 'working');
});

test('app threads older than recentHours are not listed', () => {
  assert.equal(byId.has(ID.deskOld), false);
});

test('a terminal codex process is matched to its own file, not a helper file in the same folder', () => {
  const f = byId.get(ID.cli)!;
  assert.equal(f.pid, 60);
  assert.equal(f.host, 'cli');
  assert.equal(f.title, 'Release prep');
  assert.equal(f.pendingApproval, 'git push');
  assert.equal(health(ID.cli), 'approval');
  assert.deepEqual(f.resume?.command, [CODEX, 'resume', ID.cli].map((x) => (x === CODEX ? cfg.codexCommand : x)));
});

test('`codex resume <id>` is matched by id even when the file is old', () => {
  const f = byId.get(ID.resumed)!;
  assert.equal(f.pid, 70);
  assert.equal(f.alive, true);
});

test('gone terminal sessions: finished recently = ended, died mid-task = dead', () => {
  assert.equal(byId.get(ID.closed)?.alive, false);
  assert.equal(health(ID.closed), 'ended');
  assert.equal(byId.get(ID.closed)?.lastMessage?.text, 'Done.');
  assert.equal(health(ID.crashed), 'dead');
});

test('exec runs, sandbox runners, the app server and the daemon are not sessions', () => {
  assert.equal(byId.has(ID.exec), false);
  const pids = facts.map((f) => f.pid).filter(Boolean).sort();
  assert.deepEqual(pids, [60, 70]);
});

test('subagentActivity walks up nested helpers to the thread you started', () => {
  const meta = (id: string, parentId?: string) => ({ id, subagent: !!parentId, parentId });
  const m = subagentActivity([
    { mtimeMs: 1, meta: meta('root') },
    { mtimeMs: 5, meta: meta('a', 'root') },
    { mtimeMs: 9, meta: meta('b', 'a') },
    { mtimeMs: 7, meta: meta('orphan', 'missing-parent') },
  ]);
  assert.equal(m.get('root'), 9);
  assert.equal(m.get('a'), undefined, 'helpers are not keys');
  assert.equal(m.get('missing-parent'), 7);
});
