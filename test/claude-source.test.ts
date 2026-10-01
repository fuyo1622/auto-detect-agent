import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildSnapshot } from '../src/proc/helper.ts';
import { ClaudeSource } from '../src/sources/claude.ts';

// A fake ~/.claude plus a fake process snapshot covering the cases seen on real machines.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cfg = loadConfig(path.join(root, 'no-config.json'));
cfg.paths.claudeHome = path.join(root, '.claude');
cfg.paths.claudeAppData = path.join(root, 'Claude');
const sessionsDir = path.join(cfg.paths.claudeHome, 'sessions');
const workDir = path.join(root, 'work');
const projectDir = path.join(cfg.paths.claudeHome, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const NOW = Date.now();
const ft = (ms: number) => String(BigInt(ms + 11644473600000) * 10000n);
const ID = {
  registered: '11111111-1111-4111-8111-111111111111',
  stale: '22222222-2222-4222-8222-222222222222',
  unregistered: '33333333-3333-4333-8333-333333333333',
  bare: '44444444-4444-4444-8444-444444444444',
  desktop: '55555555-5555-4555-8555-555555555555',
  forkParent: '66666666-6666-4666-8666-666666666666',
};

function registry(pid: number, startMs: number, extra: object) {
  fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, procStart: ft(startMs), startedAt: startMs + 500, cwd: workDir, kind: 'interactive', updatedAt: NOW - 1000, ...extra }),
  );
}

function transcript(id: string, lines: object[]) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const t = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// 100: healthy terminal session with Remote Control on.
registry(100, NOW - 3600_000, { sessionId: ID.registered, status: 'idle', entrypoint: 'cli', name: 'Fix login', nameSource: 'user', bridgeSessionId: 'session_01AAA' });
transcript(ID.registered, [{ type: 'assistant', timestamp: t(5000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }]);
// 200: registry left behind by a process that no longer exists (it was working).
registry(200, NOW - 7200_000, { sessionId: ID.stale, status: 'busy', entrypoint: 'cli', bridgeSessionId: 'session_01BBB' });
// 300: process alive but Claude's registry lost it; its transcript has a pending Bash call.
transcript(ID.unregistered, [
  { type: 'bridge-session', sessionId: ID.unregistered, bridgeSessionId: 'cse_01CCC' },
  { type: 'custom-title', customTitle: 'E2E run' },
  { type: 'assistant', timestamp: t(120_000), cwd: workDir, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run test:e2e' } }] } },
]);
// 400: bare `claude --remote-control`, no registry: found through its folder's newest transcript.
transcript(ID.bare, [{ type: 'user', timestamp: t(1000), message: { content: 'hello' } }]);
// 600: Claude app session, registered with the desktop entrypoint.
registry(600, NOW - 600_000, { sessionId: ID.desktop, status: 'busy', entrypoint: 'claude-desktop', hostSessionId: 'local_x', name: 'App task' });
// 800: a terminal session started with --fork-session: --resume names the parent, not this conversation.
transcript(ID.forkParent, [{ type: 'user', timestamp: t(9_000_000), message: { content: 'old' } }]);
fs.utimesSync(path.join(projectDir, `${ID.forkParent}.jsonl`), new Date(NOW - 9_000_000), new Date(NOW - 9_000_000));

const DESKTOP_EXE = 'C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\Claude.exe';
const CLI_EXE = 'C:\\nowhere\\claude.exe';
const proc = (pid: number, ppid: number, startMs: number, cmd: string, extra: object = {}) => ({
  pid,
  ppid,
  name: 'claude.exe',
  root: true,
  startFt: ft(startMs),
  cpuMs: 1000,
  exe: CLI_EXE,
  cwd: workDir,
  cmd,
  ...extra,
});

const snap = buildSnapshot(NOW, [
  proc(100, 1, NOW - 3600_000, `"${CLI_EXE}" --remote-control`),
  proc(300, 1, NOW - 1800_000, `"${CLI_EXE}" --remote-control --resume ${ID.unregistered}`),
  proc(400, 1, NOW - 60_000, `"${CLI_EXE}" --remote-control`),
  proc(500, 1, NOW - 60_000, `"${CLI_EXE}" -p "summarize"`),
  proc(800, 1, NOW - 30_000, `"${CLI_EXE}" --resume ${ID.forkParent} --fork-session`),
  { pid: 900, ppid: 1, name: 'Claude.exe', root: true, startFt: ft(NOW - 9_000_000), exe: DESKTOP_EXE, cmd: `"${DESKTOP_EXE}"` },
  proc(600, 900, NOW - 600_000, `"${CLI_EXE}" --output-format stream-json --input-format stream-json`),
  proc(700, 900, NOW - 600_000, `"${CLI_EXE}" --output-format stream-json --input-format stream-json --resume ${ID.desktop}`),
  { pid: 301, ppid: 100, name: 'conhost.exe', root: false, startFt: ft(NOW - 3600_000) },
]);

const source = new ClaudeSource(cfg);
const facts = source.collect(snap, NOW, 900);
const byPid = new Map(facts.map((f) => [f.pid, f]));

test('a registered session is linked to its process', () => {
  const f = byPid.get(100)!;
  assert.equal(f.key, `claude:${ID.registered}`);
  assert.equal(f.registered, true);
  assert.equal(f.rcState, 'on');
  assert.equal(f.rcUrl, 'https://claude.ai/code/session_01AAA');
  assert.equal(f.title, 'Fix login');
  assert.equal(f.lastMessage?.text, 'Done.');
  assert.deepEqual(f.children, [], 'console hosts are not counted as children');
  assert.deepEqual(f.resume?.command, ['claude', '--remote-control', '--resume', ID.registered]);
});

test('a registry entry without a process is a stale (crashed) session', () => {
  const f = facts.find((x) => x.sessionId === ID.stale)!;
  assert.equal(f.alive, false);
  assert.equal(f.staleRecord, true);
  assert.equal(f.lastKnownBusy, true);
  assert.equal(f.rcExpected, true);
});

test('a live process Claude no longer lists is found from its --resume id', () => {
  const f = byPid.get(300)!;
  assert.equal(f.sessionId, ID.unregistered);
  assert.equal(f.registered, false);
  assert.equal(f.rcState, 'unknown');
  assert.equal(f.rcExpected, true);
  assert.equal(f.title, 'E2E run');
  assert.equal(f.rcUrl, 'https://claude.ai/code/session_01CCC');
  assert.equal(f.pendingTool?.name, 'Bash');
  assert.equal(f.pendingTool?.summary, 'npm run test:e2e');
});

test('a bare process is matched to the newest transcript in its folder', () => {
  assert.equal(byPid.get(400)?.sessionId, ID.bare);
});

test('one-off commands and unregistered app helpers are ignored', () => {
  assert.equal(byPid.has(500), false);
  assert.equal(byPid.has(700), false);
  assert.equal(byPid.has(900), false);
});

test('Claude app sessions are marked as desktop', () => {
  const f = byPid.get(600)!;
  assert.equal(f.host, 'desktop');
  assert.equal(f.phase, 'busy');
  assert.equal(f.title, 'App task');
});

test('--fork-session never reuses the parent conversation id', () => {
  const f = byPid.get(800)!;
  assert.notEqual(f.sessionId, ID.forkParent);
});
