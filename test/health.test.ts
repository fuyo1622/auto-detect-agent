import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveHealth, healthRank } from '../src/health.ts';
import type { SessionFacts } from '../src/types.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    key: 'k',
    host: 'cli',
    title: 'Session',
    alive: true,
    phase: 'idle',
    registered: true,
    staleRecord: false,
    lastKnownBusy: false,
    rcExpected: true,
    rcState: 'on',
    startedAt: NOW - 60 * MIN,
    lastActivityAt: NOW - 1000,
    ...over,
  };
}

test('idle with Remote Control on is just waiting', () => {
  const h = deriveHealth(facts(), NOW);
  assert.deepEqual([h.health, h.notify], ['waiting', false]);
});

test('busy is working, however long it takes (the official app shows the details)', () => {
  assert.equal(deriveHealth(facts({ phase: 'busy', lastActivityAt: NOW - 90 * MIN }), NOW).health, 'working');
});

test('Remote Control expected but off is the headline problem, busy or not', () => {
  for (const phase of ['idle', 'busy', 'unknown'] as const) {
    const h = deriveHealth(facts({ rcState: 'off', phase }), NOW);
    assert.deepEqual([h.health, h.notify], ['rc-lost', true], phase);
    assert.equal(h.detail, 'Remote Control is not connected');
  }
});

test('a session Claude no longer lists is reported as probably disconnected', () => {
  const h = deriveHealth(facts({ registered: false, rcState: 'unknown', phase: 'unknown' }), NOW);
  assert.equal(h.health, 'rc-lost');
  assert.match(h.detail, /no longer lists/);
});

test('Remote Control off is fine when it was never expected', () => {
  assert.equal(deriveHealth(facts({ rcExpected: false, rcState: 'off' }), NOW).health, 'waiting');
});

test('a session that just started gets 30 s to connect Remote Control', () => {
  assert.equal(deriveHealth(facts({ rcState: 'off', procStartMs: NOW - 10_000 }), NOW).health, 'waiting');
  assert.equal(deriveHealth(facts({ rcState: 'unknown', registered: false, procStartMs: NOW - 10_000 }), NOW).health, 'waiting');
  assert.equal(deriveHealth(facts({ rcState: 'off', procStartMs: NOW - 31_000 }), NOW).health, 'rc-lost');
});

test('gone processes: crashed terminal sessions are dead, closed app sessions are ended', () => {
  const gone = { alive: false, phase: 'unknown' as const, rcState: 'n/a' as const, rcExpected: false };
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true }), NOW).health, 'dead');
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true, host: 'desktop' }), NOW).health, 'ended');
  assert.equal(deriveHealth(facts({ ...gone, staleRecord: true, host: 'desktop', lastKnownBusy: true }), NOW).health, 'dead');
  assert.equal(deriveHealth(facts({ ...gone }), NOW).health, 'ended');
});

test('only dead sessions that were working or reachable remotely are worth a push', () => {
  const gone = { alive: false, phase: 'unknown' as const, rcState: 'n/a' as const, staleRecord: true };
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: false }), NOW).notify, false);
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: true }), NOW).notify, true);
  assert.equal(deriveHealth(facts({ ...gone, rcExpected: false, lastKnownBusy: true }), NOW).notify, true);
});

test('a session closed from Agent Monitor (Reconnect, app restart) is "Stopped", not a crash, and never pushed', () => {
  const gone = { alive: false, phase: 'unknown' as const, rcState: 'n/a' as const, staleRecord: true, lastKnownBusy: true, rcExpected: true };
  const h = deriveHealth(facts({ ...gone, stoppedByUser: true }), NOW);
  assert.deepEqual([h.health, h.detail, h.notify], ['ended', 'Stopped', false]);
});

test('problems sort first', () => {
  const order = (['waiting', 'ended', 'rc-lost', 'working', 'dead'] as const).slice().sort((a, b) => healthRank(a) - healthRank(b));
  assert.deepEqual(order, ['dead', 'rc-lost', 'working', 'waiting', 'ended']);
});
