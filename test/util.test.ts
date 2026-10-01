import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsTerminalArgs } from '../src/launch.ts';
import { fileTimeToMs, flagValue, normPath, splitCommandLine } from '../src/util.ts';

test('splitCommandLine follows Windows quoting', () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\x\\claude.exe" --remote-control --resume abc'), [
    'C:\\Program Files\\x\\claude.exe',
    '--remote-control',
    '--resume',
    'abc',
  ]);
  assert.deepEqual(splitCommandLine('a "b c" d\\"e "f\\\\"'), ['a', 'b c', 'd"e', 'f\\']);
  assert.deepEqual(splitCommandLine('  spaced   out  '), ['spaced', 'out']);
});

test('flagValue reads "--flag value" and "--flag=value" but not a following flag', () => {
  assert.equal(flagValue(['--resume', 'x'], ['--resume']), 'x');
  assert.equal(flagValue(['--resume=y'], ['--resume']), 'y');
  assert.equal(flagValue(['-r', 'z'], ['--resume', '-r']), 'z');
  assert.equal(flagValue(['--resume', '--fork-session'], ['--resume']), undefined);
  assert.equal(flagValue(['--other'], ['--resume']), undefined);
});

test('fileTimeToMs converts the FILETIME that Claude stores as procStart', () => {
  // Registry entry: procStart 134353077442557803, startedAt 1790834146337 (written ~2 s after start).
  assert.equal(fileTimeToMs('134353077442557803'), 1790834144255);
  assert.equal(fileTimeToMs('not a number'), undefined);
  assert.equal(fileTimeToMs(undefined), undefined);
});

test('normPath compares Windows paths loosely', () => {
  assert.equal(normPath('D:/Work/Project/'), normPath('d:\\work\\project'));
  assert.equal(normPath('C:\\'), 'c:\\');
});

test('windowsTerminalArgs escapes the ; that Windows Terminal treats as a separator', () => {
  const args = windowsTerminalArgs({ cwd: 'D:\\a;b', title: 'x; y', command: ['claude', '--resume', 'id'] });
  assert.deepEqual(args, ['-w', '0', 'new-tab', '--title', 'x\\; y', '-d', 'D:\\a\\;b', 'claude', '--resume', 'id']);
});
