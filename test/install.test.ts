import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { removeFolderWhenFree } from '../src/install.ts';
import { tempDir } from './helpers.ts';

test('uninstall deletes the program folder once the process holding it has exited', { timeout: 30000 }, async (t) => {
  // Spaces and & in the path: an earlier version broke on quoting and left the folder behind.
  const dir = path.join(tempDir(t), 'Agent Monitor & co (test)');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'AgentMonitor.exe'), 'stand-in');
  // Like the running exe, this process keeps the folder from being deleted (it is its working folder).
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { cwd: dir, stdio: 'ignore' });
  await once(holder, 'spawn');

  const cleanup = removeFolderWhenFree(dir);
  cleanup.ref();
  const [code] = await once(cleanup, 'exit');

  assert.equal(code, 0);
  assert.notEqual(holder.exitCode, null, 'the folder went only after the holder exited');
  assert.equal(fs.existsSync(dir), false);
});
