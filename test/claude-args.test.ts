import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeUrl, isInteractiveCli, projectSlug } from '../src/sources/claude.ts';

test('isInteractiveCli tells sessions from one-off commands', () => {
  assert.equal(isInteractiveCli([]), true);
  assert.equal(isInteractiveCli(['--remote-control']), true);
  assert.equal(isInteractiveCli(['--remote-control', '--resume', 'abc']), true);
  assert.equal(isInteractiveCli(['mcp', 'list']), false);
  assert.equal(isInteractiveCli(['agents', '--json']), false);
  assert.equal(isInteractiveCli(['-p', 'hello']), false);
  assert.equal(isInteractiveCli(['--version']), false);
  assert.equal(isInteractiveCli(['--resume', 'agents']), true);
});

test('projectSlug matches the folder names under ~/.claude/projects', () => {
  assert.equal(projectSlug('C:\\Users\\user1\\Desktop\\my_app'), 'C--Users-user1-Desktop-my-app');
  assert.equal(projectSlug('D:\\auto-detect-agent'), 'D--auto-detect-agent');
});

test('Remote Control links come from bridge session ids', () => {
  assert.equal(bridgeUrl('cse_01ABC'), 'https://claude.ai/code/session_01ABC');
  assert.equal(bridgeUrl('session_01ABC'), 'https://claude.ai/code/session_01ABC');
});
