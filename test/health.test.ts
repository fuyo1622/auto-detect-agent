import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveHealth } from '../src/health.ts';
import type { SessionFacts } from '../src/types.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ctx = { now: NOW, stuckMs: 15 * MIN, approvalMs: MIN };

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    key: 'k',
    tool: 'claude',
    host: 'cli',
    title: 'Session',
    alive: true,
    phase: 'idle',
    registered: true,
    staleRecord: false,
    lastKnownBusy: false,
    rcExpected: true,
    rcState: 'on',
    approvalsDisabled: false,
    children: [],
    startedAt: NOW - 60 * MIN,
    lastActivityAt: NOW - 1000,
    ...over,
  };
}

test('idle with Remote Control on is just waiting', () => {
  assert.equal(deriveHealth(facts(), ctx).health, 'waiting');
});

test('busy with recent activity is working', () => {
  assert.equal(deriveHealth(facts({ phase: 'busy' }), ctx).health, 'working');
});

test('busy with no activity past the threshold is stuck', () => {
  const h = deriveHealth(facts({ phase: 'busy', lastActivityAt: NOW - 20 * MIN }), ctx);
  assert.equal(h.health, 'stuck');
  assert.match(h.detail, /20 min/);
  assert.equal(h.notify, true);
});

test('CPU use by the session or its tools counts as progress', () => {
  const h = deriveHealth(facts({ phase: 'busy', lastActivityAt: NOW - 20 * MIN }), { ...ctx, cpuActiveAt: NOW - 5000 });
  assert.equal(h.health, 'working');
});

test('a tool call with nothing running behind it means it waits for approval', () => {
  const pendingTool = { name: 'Bash', summary: 'npm run test:e2e', at: NOW - 2 * MIN };
  const h = deriveHealth(facts({ phase: 'busy', pendingTool, lastActivityAt: NOW - 2 * MIN }), ctx);
  assert.equal(h.health, 'approval');
  assert.match(h.detail, /npm run test:e2e/);
});

test('a tool call with a process started for it is working, not waiting for approval', () => {
  const pendingTool = { name: 'Bash', summary: 'npm test', at: NOW - 2 * MIN };
  const children = [{ pid: 9, name: 'bash.exe', startMs: NOW - 2 * MIN + 500 }];
  const h = deriveHealth(facts({ phase: 'busy', pendingTool, children, lastActivityAt: NOW - 2 * MIN }), ctx);
  assert.equal(h.health, 'working');
  assert.match(h.detail, /Running Bash/);
});

test('long-lived helpers started before the tool call (MCP servers) do not count', () => {
  const pendingTool = { name: 'Edit', summary: 'a.ts', at: NOW - 2 * MIN };
  const children = [{ pid: 9, name: 'node.exe', startMs: NOW - 50 * MIN }];
  assert.equal(deriveHealth(facts({ phase: 'busy', pendingTool, children, lastActivityAt: NOW - 2 * MIN }), ctx).health, 'approval');
});

test('subagents and web tools run without processes and are not approvals', () => {
  const pendingTool = { name: 'Agent', summary: 'research', at: NOW - 5 * MIN };
  assert.equal(deriveHealth(facts({ phase: 'busy', pendingTool, lastActivityAt: NOW - 5 * MIN }), ctx).health, 'working');
});

test('AskUserQuestion is reported as a question', () => {
  const pendingTool = { name: 'AskUserQuestion', summary: '', at: NOW - 2 * MIN };
  const h = deriveHealth(facts({ phase: 'idle', pendingTool, lastActivityAt: NOW - 2 * MIN }), ctx);
  assert.equal(h.health, 'approval');
  assert.equal(h.detail, 'Asking you a question');
});

test('with approvals disabled a quiet tool call is never an approval', () => {
  const pendingTool = { name: 'Bash', summary: 'x', at: NOW - 30 * MIN };
  const h = deriveHealth(facts({ phase: 'busy', pendingTool, approvalsDisabled: true, lastActivityAt: NOW - 30 * MIN }), ctx);
  assert.equal(h.health, 'stuck');
});

test('Remote Control expected but off is the headline problem', () => {
  const h = deriveHealth(facts({ rcState: 'off' }), ctx);
  assert.equal(h.health, 'rc-lost');
  assert.equal(h.activity, 'waiting');
  assert.equal(h.notify, true);
});

test('a session Claude no longer lists is reported as probably disconnected', () => {
  const pendingTool = { name: 'Bash', summary: 'npm test', at: NOW - 5 * MIN };
  const h = deriveHealth(facts({ registered: false, rcState: 'unknown', phase: 'busy', pendingTool, lastActivityAt: NOW - 5 * MIN }), ctx);
  assert.equal(h.health, 'rc-lost');
  assert.match(h.detail, /no longer lists/);
  assert.equal(h.activity, 'approval');
});

test('Remote Control off is fine when it was never expected', () => {
  assert.equal(deriveHealth(facts({ rcExpected: false, rcState: 'off' }), ctx).health, 'waiting');
});

test('gone processes: crashed terminal sessions are dead, closed app sessions are ended', () => {
  const gone = { alive: false, phase: 'unknown' as const, rcState: 'n/a' as const, rcExpected: false };
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true }), ctx).health, 'dead');
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true, host: 'desktop' }), ctx).health, 'ended');
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true, host: 'desktop', lastKnownBusy: true }), ctx).health, 'dead');
  assert.equal(deriveHealth(facts({ ...gone }), ctx).health, 'ended');
});

test('only dead sessions that were working or reachable remotely are worth a push', () => {
  const gone = { alive: false, phase: 'unknown' as const, rcState: 'n/a' as const, staleRecord: true };
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: false }), ctx).notify, false);
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: true }), ctx).notify, true);
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: false, lastKnownBusy: true }), ctx).notify, true);
});

test('Codex approval requests are surfaced directly', () => {
  const h = deriveHealth(facts({ tool: 'codex', rcExpected: false, rcState: 'n/a', phase: 'busy', pendingApproval: 'npm publish' }), ctx);
  assert.equal(h.health, 'approval');
  assert.match(h.detail, /npm publish/);
});
