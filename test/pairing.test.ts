import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { hashToken, Pairing } from '../src/pairing.ts';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const cfg = loadConfig(path.join(tempDir(undefined), 'no-config.json'));

function setup(t: any) {
  const file = path.join(tempDir(t), 'state.json');
  const store = new Store(file, cfg.defaults);
  return { store, file, pairing: new Pairing(store) };
}

test('a code is 6 digits, stays the same until used, and lasts 15 minutes', (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const { pairing } = setup(t);
  const a = pairing.current();
  assert.match(a.code, /^\d{6}$/);
  assert.equal(a.expiresAt, Date.now() + 15 * 60_000);
  assert.equal(pairing.current().code, a.code);
  mock.timers.tick(15 * 60_000);
  assert.notEqual(pairing.current().expiresAt, a.expiresAt, 'a new code after expiry');
});

test('an expired code is refused', (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const { pairing } = setup(t);
  const { code } = pairing.renew();
  mock.timers.tick(15 * 60_000 + 1);
  assert.ok('error' in pairing.redeem(code, 'x'));
});

test('redeeming gives a token that is stored only as a hash', (t) => {
  const { pairing, file } = setup(t);
  const { code } = pairing.renew();
  const r = pairing.redeem(code, 'My iPhone', 'Mozilla/5.0 (iPhone)');
  assert.ok('token' in r);
  assert.ok(r.token.length >= 40);
  const saved = fs.readFileSync(file, 'utf8');
  assert.equal(saved.includes(r.token), false, 'the token never touches the disk');
  assert.ok(saved.includes(hashToken(r.token)));
  assert.equal(pairing.authenticate(r.token)?.name, 'My iPhone');
  assert.equal(pairing.authenticate(r.token + 'x'), undefined);
  assert.equal(pairing.authenticate(undefined), undefined);
});

test('ten wrong codes lock pairing for a while, even for the right code', (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const { pairing } = setup(t);
  const { code } = pairing.renew();
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 10; i++) assert.ok('error' in pairing.redeem(wrong, 'x'));
  const locked = pairing.redeem(code, 'x');
  assert.ok('error' in locked && /Too many/.test(locked.error));
  mock.timers.tick(15 * 60_000 + 1);
  pairing.renew();
  assert.ok('token' in pairing.redeem(pairing.current().code, 'x'), 'works again after the window');
});

test('names are trimmed to 60 characters and default to iPhone', (t) => {
  const { pairing } = setup(t);
  const a = pairing.redeem(pairing.renew().code, 'n'.repeat(100));
  const b = pairing.redeem(pairing.renew().code, '');
  assert.ok('device' in a && 'device' in b);
  assert.equal(a.device.name.length, 60);
  assert.equal(b.device.name, 'iPhone');
});

test('revoking a phone ends its token', (t) => {
  const { pairing } = setup(t);
  const r = pairing.redeem(pairing.renew().code, 'x');
  assert.ok('token' in r);
  assert.equal(pairing.revoke(r.device.id), true);
  assert.equal(pairing.authenticate(r.token), undefined);
  assert.equal(pairing.revoke(r.device.id), false);
});
