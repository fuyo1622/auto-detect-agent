import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from '../src/config.ts';
import { descendants, ProcHelper, type Snapshot } from '../src/proc/helper.ts';
import { normPath } from '../src/util.ts';
import { memoryLog, tempDir } from './helpers.ts';

// The real helper on this PC: compiled from helper/ProcHelper.cs, then asked about live processes.
const dir = tempDir(undefined, 'agent monitor 測試 ');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const log = memoryLog();
const helper = new ProcHelper({ exe: path.join(dir, 'proc-helper.exe'), source: path.join(ROOT, 'helper', 'ProcHelper.cs'), log });
const fallback = new ProcHelper({ exe: path.join(dir, 'missing.exe'), source: path.join(dir, 'missing.cs'), log });

// A child with a non-ASCII folder and arguments, like sessions in folders named in Chinese.
const ARG = '中文 參數 "quoted"';
let child: ChildProcess;
before(async () => {
  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ARG], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await new Promise((r) => child.once('spawn', r));
  await helper.start();
  await fallback.start();
});
after(() => {
  child.kill();
  helper.stop();
});

test('the helper builds with the C# compiler that ships with Windows and answers', () => {
  assert.equal(helper.mode, 'ok', log.lines.join('\n'));
  assert.ok(fs.existsSync(path.join(dir, 'proc-helper.exe')));
  assert.ok(log.lines.some((l) => l.includes('built')));
});

test('a snapshot has command line, executable, working folder, start time and CPU time', async () => {
  const snap = await helper.snapshot(['node.exe']);
  const me = snap.byPid.get(process.pid)!;
  assert.ok(me, 'this test process is listed');
  assert.equal(me.root, true);
  assert.equal(normPath(me.exe), normPath(process.execPath));
  assert.equal(normPath(me.cwd), normPath(process.cwd()));
  assert.match(me.cmd ?? '', /proc-helper\.test\.ts|--test/);
  const startedMs = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(me.startMs! - startedMs) < 5000, `start time ${me.startMs} vs ${startedMs}`);
  assert.ok((me.cpuMs ?? 0) > 0);
});

test('non-ASCII folders and arguments come through intact', async () => {
  const snap = await helper.snapshot(['node.exe']);
  const c = snap.byPid.get(child.pid!)!;
  assert.ok(c, 'child listed');
  assert.equal(c.ppid, process.pid);
  assert.equal(normPath(c.cwd), normPath(dir));
  assert.ok(c.cmd?.includes('中文 參數'), c.cmd);
  assert.ok(descendants(snap, process.pid).every((p) => p.pid !== process.pid));
});

test('descendants of a watched process are included, with the parent link', async () => {
  const kid = spawn('ping.exe', ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => kid.once('spawn', r));
  try {
    const snap = await helper.snapshot(['node.exe']);
    const p = snap.byPid.get(kid.pid!)!;
    assert.ok(p, 'ping.exe started by a node.exe is in the snapshot');
    assert.equal(p.root, false);
    assert.equal(p.ppid, process.pid);
    assert.equal(p.exe, undefined, 'only watched processes get exe and cwd');
  } finally {
    kid.kill();
  }
});

test('the slow PowerShell fallback finds the same processes', async () => {
  assert.equal(fallback.mode, 'fallback');
  const [a, b]: Snapshot[] = [await helper.snapshot(['node.exe']), await fallback.snapshot(['node.exe'])];
  const x = a.byPid.get(child.pid!)!;
  const y = b.byPid.get(child.pid!)!;
  assert.ok(y, 'fallback lists the child');
  assert.equal(y.cmd, x.cmd);
  assert.equal(normPath(y.exe), normPath(x.exe));
  assert.ok(Math.abs(y.startMs! - x.startMs!) < 2, 'same start time');
  assert.equal(y.cwd, undefined, 'the fallback cannot see working folders');
});

test('keep-awake can be switched on and off', async () => {
  assert.equal(await helper.setAwake(true), true);
  assert.equal(await helper.setAwake(false), true);
  assert.equal(await fallback.setAwake(true), false, 'only the helper can hold the PC awake');
});

test('a hung or dead helper is restarted', async () => {
  const h = new ProcHelper({ exe: path.join(dir, 'proc-helper.exe'), source: path.join(ROOT, 'helper', 'ProcHelper.cs'), log });
  await h.start();
  (h as any).child.kill();
  await new Promise((r) => setTimeout(r, 300));
  const snap = await h.snapshot(['node.exe']);
  assert.ok(snap.byPid.get(process.pid), 'still answers after the helper died');
  assert.equal(h.mode, 'ok', 'restarted, not stuck in the slow fallback');
  h.stop();
});

test('the helper exits when the agent goes away (stdin closes)', async () => {
  const p = spawn(path.join(dir, 'proc-helper.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((r) => p.once('spawn', r));
  const exited = new Promise<number | null>((r) => p.once('exit', r));
  p.stdin!.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  assert.equal(code, 0);
});

test('the snapshot is fast enough to run every 5 seconds', async () => {
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await helper.snapshot();
  const each = (performance.now() - t0) / 5;
  assert.ok(each < 500, `${each.toFixed(0)} ms per snapshot`);
  console.log(`# helper snapshot: ${each.toFixed(1)} ms on ${os.cpus().length} cores`);
});
