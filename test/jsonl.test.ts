import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FollowerCache, JsonlFollower, readFirstLine } from '../src/sources/jsonl.ts';
import { tempDir } from './helpers.ts';

// Transcripts are read once, then only their new bytes.
type S = { lines: any[] };
const init = (): S => ({ lines: [] });
const reduce = (s: S, e: any) => void s.lines.push(e);

test('reads whole lines only, then continues where it stopped', (t) => {
  const file = path.join(tempDir(t), 'a.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":');
  const f = new JsonlFollower(file, init, reduce);
  assert.equal(f.update(), true);
  assert.deepEqual(f.state.lines.map((l) => l.n), [1, 2], 'the half-written line waits');
  fs.appendFileSync(file, '3}\nnot json\n\n{"n":4}\n');
  f.update();
  assert.deepEqual(f.state.lines.map((l) => l.n), [1, 2, 3, 4], 'bad and empty lines are skipped');
  f.update();
  assert.equal(f.state.lines.length, 4, 'nothing new, nothing read');
});

test('a file that got shorter (rewritten) is read again from the start', (t) => {
  const file = path.join(tempDir(t), 'b.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const f = new JsonlFollower(file, init, reduce);
  f.update();
  fs.writeFileSync(file, '{"n":9}\n');
  f.update();
  assert.deepEqual(f.state.lines.map((l) => l.n), [9]);
});

test('multi-byte characters split across reads stay intact', (t) => {
  const file = path.join(tempDir(t), 'c.jsonl');
  const line = Buffer.from(JSON.stringify({ text: '繁體中文 ✓' }) + '\n');
  fs.writeFileSync(file, line.subarray(0, 12)); // cuts a character in half
  const f = new JsonlFollower(file, init, reduce);
  f.update();
  fs.appendFileSync(file, line.subarray(12));
  f.update();
  assert.equal(f.state.lines[0].text, '繁體中文 ✓');
});

test('a huge transcript is read from its last 8 MB only', (t) => {
  const file = path.join(tempDir(t), 'd.jsonl');
  const pad = 'x'.repeat(1000);
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < 9000; i++) fs.writeSync(fd, JSON.stringify({ n: i, pad }) + '\n');
  fs.closeSync(fd);
  const f = new JsonlFollower(file, init, reduce);
  const t0 = performance.now();
  f.update();
  const ms = performance.now() - t0;
  assert.equal(f.state.lines.at(-1).n, 8999);
  assert.ok(f.state.lines[0].n > 0, 'older lines skipped');
  assert.ok(f.state.lines.every((l) => typeof l.n === 'number'), 'no torn first line');
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test('a missing file is reported, and the cache forgets idle files', (t) => {
  const dir = tempDir(t);
  const cache = new FollowerCache<S>(init, reduce);
  assert.equal(cache.get(path.join(dir, 'missing.jsonl')), undefined);
  const file = path.join(dir, 'e.jsonl');
  fs.writeFileSync(file, '{"n":1}\n');
  const a = cache.get(file)!;
  assert.equal(cache.get(file), a, 'same follower while in use');
  a.lastUsed = Date.now() - 31 * 60_000;
  cache.prune();
  assert.notEqual(cache.get(file), a, 'a fresh follower after pruning');
});

test('readFirstLine reads Codex session metadata, even when the first line is long', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'f.jsonl');
  const big = { type: 'session_meta', payload: { id: 'x', base_instructions: 'y'.repeat(300_000) } };
  fs.writeFileSync(file, JSON.stringify(big) + '\n{"type":"event_msg"}\n');
  assert.equal(readFirstLine(file).payload.id, 'x');
  const partial = path.join(dir, 'g.jsonl');
  fs.writeFileSync(partial, '{"type":"session_meta","payload":{"id":"z"}}');
  assert.equal(readFirstLine(partial).payload.id, 'z', 'no newline yet');
  fs.writeFileSync(partial, '{"type":"sess');
  assert.equal(readFirstLine(partial), undefined, 'half-written: try again later');
  assert.equal(readFirstLine(path.join(dir, 'missing')), undefined);
});
