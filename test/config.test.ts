import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

test('config.example.json lists only options the agent reads, at their defaults', () => {
  const example: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.example.json'), 'utf8'));
  const defaults: Record<string, unknown> = { ...loadConfig(path.join(import.meta.dirname, 'no-such-config.json')) };
  for (const [key, value] of Object.entries(example)) {
    assert.ok(key in defaults, `config.example.json has an option the agent ignores: ${key}`);
    assert.deepEqual(value, defaults[key], `config.example.json shows another value than the default for ${key}`);
  }
});
