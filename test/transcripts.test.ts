import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeUrl, initTranscript, isInteractiveCli, projectSlug, reduceTranscript } from '../src/sources/claude.ts';
import { cliProcesses, firstPositional, initRollout, reduceRollout } from '../src/sources/codex.ts';
import { buildSnapshot } from '../src/proc/helper.ts';

const at = (sec: number) => new Date(Date.UTC(2026, 9, 1, 4, 0, sec)).toISOString();

function claude(lines: any[]) {
  const s = initTranscript();
  for (const l of lines) reduceTranscript(s, l);
  return s;
}

const prompt = (sec: number, text: string) => ({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } });
const toolUse = (sec: number, id: string, name: string, input: object) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (sec: number, id: string) => ({
  type: 'user',
  timestamp: at(sec),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const answer = (sec: number, text: string) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

test('a tool call stays pending until its result arrives', () => {
  const s = claude([prompt(1, 'run the tests'), toolUse(2, 't1', 'Bash', { command: 'npm test' })]);
  assert.equal(s.phase, 'busy');
  assert.equal(s.pending.get('t1')?.summary, 'npm test');
  reduceTranscript(s, toolResult(3, 't1'));
  assert.equal(s.pending.size, 0);
  assert.equal(s.phase, 'busy');
  reduceTranscript(s, answer(4, 'All tests pass.'));
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastAssistant?.text, 'All tests pass.');
  assert.equal(s.lastUser?.text, 'run the tests');
});

test('an interrupt ends the turn and drops pending tools', () => {
  const s = claude([
    toolUse(1, 't1', 'Edit', { file_path: 'a.ts' }),
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]);
  assert.equal(s.phase, 'idle');
  assert.equal(s.pending.size, 0);
});

test('turn_duration / stop hooks mark the turn finished', () => {
  const s = claude([toolUse(1, 't1', 'Bash', { command: 'x' }), { type: 'system', subtype: 'turn_duration', timestamp: at(2) }]);
  assert.equal(s.phase, 'idle');
  assert.equal(s.pending.size, 0);
});

test('slash-command echoes and meta messages are not prompts', () => {
  const s = claude([
    { type: 'user', timestamp: at(1), message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', isMeta: true, timestamp: at(2), message: { content: 'caveat' } },
  ]);
  assert.equal(s.lastUser, undefined);
  assert.equal(s.phase, 'unknown');
});

test('Remote Control links come from bridge records', () => {
  assert.equal(bridgeUrl('cse_01ABC'), 'https://claude.ai/code/session_01ABC');
  assert.equal(bridgeUrl('session_01ABC'), 'https://claude.ai/code/session_01ABC');
  const s = claude([
    { type: 'bridge-session', sessionId: 'x', bridgeSessionId: 'cse_01OLD' },
    { type: 'system', subtype: 'bridge_status', url: 'https://claude.ai/code/session_01NEW', timestamp: at(5) },
    { type: 'custom-title', customTitle: 'My task' },
  ]);
  assert.equal(s.bridgeUrl, 'https://claude.ai/code/session_01NEW');
  assert.equal(s.title, 'My task');
});

test('sidechain (subagent) lines do not change the main conversation', () => {
  const s = claude([answer(1, 'done'), { ...toolUse(2, 's1', 'Bash', { command: 'x' }), isSidechain: true }]);
  assert.equal(s.phase, 'idle');
  assert.equal(s.pending.size, 0);
});

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

function codex(lines: any[]) {
  const s = initRollout();
  for (const l of lines) reduceRollout(s, l);
  return s;
}

test('Codex task events drive busy / idle', () => {
  const s = codex([
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'fix the bug' }] },
    },
  ]);
  assert.equal(s.phase, 'busy');
  assert.equal(s.lastUser?.text, 'fix the bug');
  reduceRollout(s, { timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Fixed.' } });
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastAgent?.text, 'Fixed.');
  reduceRollout(s, { timestamp: at(4), type: 'event_msg', payload: { type: 'task_started' } });
  reduceRollout(s, { timestamp: at(5), type: 'event_msg', payload: { type: 'turn_aborted' } });
  assert.equal(s.phase, 'idle');
});

test('Codex approval requests stay open until the command runs', () => {
  const s = codex([
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'exec_approval_request', command: ['npm', 'publish'] } },
  ]);
  assert.equal(s.pendingApproval, 'npm publish');
  reduceRollout(s, { timestamp: at(3), type: 'response_item', payload: { type: 'function_call_output' } });
  assert.equal(s.pendingApproval, undefined);
});

test('firstPositional skips flags and their values', () => {
  assert.equal(firstPositional(['-c', 'model="x"', 'resume', 'id']), 'resume');
  assert.equal(firstPositional(['-m', 'o3']), undefined);
  assert.equal(firstPositional(['--full-auto', 'fix it']), 'fix it');
});

test('only interactive, top-level codex processes count as CLI sessions', () => {
  const snap = buildSnapshot(0, [
    { pid: 10, ppid: 1, name: 'codex.exe', root: true, cmd: '"C:\\x\\codex.exe"' },
    { pid: 11, ppid: 1, name: 'codex.exe', root: true, cmd: 'codex.exe app-server daemon run' },
    { pid: 12, ppid: 10, name: 'codex.exe', root: true, cmd: 'codex.exe --sandbox-runner' },
    { pid: 13, ppid: 1, name: 'codex.exe', root: true, cmd: 'codex.exe exec "do it"' },
    { pid: 14, ppid: 1, name: 'codex.exe', root: true, cmd: 'codex.exe resume 01a0ddf8-0f7c-77c1-90cd-004bfaa9cd3d' },
    { pid: 15, ppid: 1, name: 'codex.exe', root: true, cmd: 'codex.exe -c model="o3" resume --last' },
  ]);
  assert.deepEqual(
    cliProcesses(snap, undefined).map((p) => p.pid),
    [10, 14, 15],
  );
});

test('a tool call with no readable input is shown by its name once', () => {
  const s = claude([toolUse(1, 'm1', 'mcp__Claude_Browser__browser_batch', { actions: [{ name: 'computer' }] })]);
  assert.equal(s.pending.get('m1')?.summary, '');
});
