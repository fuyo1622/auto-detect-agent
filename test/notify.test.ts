import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import webpush from 'web-push';
import { loadConfig } from '../src/config.ts';
import { Notifier, problemPayload } from '../src/notify.ts';
import type { Device } from '../src/store.ts';
import { Store } from '../src/store.ts';
import type { Health, NotifyPrefs, SessionView } from '../src/types.ts';
import { baseView, memoryLog, tempDir } from './helpers.ts';

const dir = tempDir(undefined);
after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })));
const cfg = loadConfig(path.join(dir, 'no-config.json'));
const log = memoryLog();

// Every push goes through web-push's real request builder (encryption + VAPID), then is checked
// the way a phone and its push service would: the JWT must verify and the body must decrypt.
interface Sent {
  device: string;
  status: number;
  payload: any;
  headers: Record<string, string>;
}
const sent: Sent[] = [];
const reply = new Map<string, number>(); // endpoint -> status the fake push service answers with
const phoneKeys = new Map<string, { ecdh: crypto.ECDH; auth: Buffer }>();

webpush.sendNotification = (async (sub: webpush.PushSubscription, payload?: string | Buffer | null, options?: webpush.RequestOptions) => {
  const details: any = webpush.generateRequestDetails(sub, payload ?? undefined, options);
  const keys = phoneKeys.get(sub.endpoint)!;
  const plain = decrypt(details.body as Buffer, keys.ecdh, keys.auth);
  const headers = details.headers as Record<string, string>;
  verifyVapid(headers.Authorization, sub.endpoint);
  const status = reply.get(sub.endpoint) ?? 201;
  sent.push({ device: sub.endpoint.split('/').pop()!, status, payload: JSON.parse(plain), headers });
  if (status >= 400) throw new webpush.WebPushError('Received unexpected response code', status, {}, '', sub.endpoint);
  return { statusCode: status, body: '', headers: {} };
}) as typeof webpush.sendNotification;

/** RFC 8291 / RFC 8188 (aes128gcm), single record: what the phone does with a push. */
function decrypt(body: Buffer, ecdh: crypto.ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const senderKey = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const secret = ecdh.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return plain.subarray(0, end).toString('utf8');
}

function verifyVapid(authorization: string, endpoint: string): void {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(m, `Authorization header: ${authorization}`);
  const [h, p, s] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'ES256');
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(claims.sub, cfg.vapidSubject);
  const now = Date.now() / 1000;
  assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, 'exp within 24 h (push services reject longer)');
  const point = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'JWT signature');
}

let store: Store;
let notifier: Notifier;

function phone(name: string, prefs: Partial<NotifyPrefs> = {}): Device {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `https://web.push.apple.com/QF-${name}`;
  phoneKeys.set(endpoint, { ecdh, auth });
  const device: Device = { id: name, name, tokenHash: 'x', createdAt: Date.now(), lastSeenAt: Date.now() };
  store.data.devices.push(device);
  notifier.subscribe(device, { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, prefs);
  return device;
}

function problem(health: Health, sinceMsAgo: number, over: Partial<SessionView> = {}): SessionView {
  return baseView({ key: `claude:${health}`, title: `Task ${health}`, health, detail: `detail ${health}`, healthSince: Date.now() - sinceMsAgo, notify: true, ...over });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  store = new Store(path.join(dir, `state-${Math.random()}.json`), cfg.defaults);
  notifier = new Notifier(cfg, store, log);
  notifier.init();
  sent.length = 0;
  reply.clear();
});

test('a push is encrypted for the phone and signed with the PC key (what Apple checks)', async () => {
  phone('a');
  const r = await notifier.send('system', { title: 'Hello', body: 'World', tag: 't', url: '/' });
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.deepEqual(sent[0].payload, { title: 'Hello', body: 'World', tag: 't', url: '/' });
  assert.equal(sent[0].headers.TTL, 21600);
  assert.equal(sent[0].headers.Urgency, 'high');
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
});

test('problems already there when the agent starts are shown, not pushed', async () => {
  phone('a');
  const existing = problem('rc-lost', 3600_000);
  notifier.onUpdate([existing]);
  await settle();
  assert.equal(sent.length, 0);
  notifier.onUpdate([{ ...existing }]);
  await settle();
  assert.equal(sent.length, 0, 'still the same problem (same healthSince)');
});

test('a new problem is pushed once, after it has lasted alertDelaySeconds', async () => {
  phone('a');
  notifier.onUpdate([]);
  const since = Date.now() - 5000;
  notifier.onUpdate([problem('stuck', 0, { healthSince: since })]);
  await settle();
  assert.equal(sent.length, 0, 'too new: it may fix itself');
  const old = since - cfg.alertDelaySeconds * 1000;
  notifier.onUpdate([problem('stuck', 0, { healthSince: old })]);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Claude · Task stuck');
  assert.equal(sent[0].payload.body, 'Looks stuck. detail stuck');
  assert.equal(sent[0].payload.url, '/#s=claude%3Astuck');
  notifier.onUpdate([problem('stuck', 0, { healthSince: old })]);
  await settle();
  assert.equal(sent.length, 1, 'not repeated');
  notifier.onUpdate([]);
  notifier.onUpdate([problem('stuck', 0, { healthSince: old + 1 })]);
  await settle();
  assert.equal(sent.length, 2, 'a problem that comes back is pushed again');
});

test('"needs you" is pushed right away, in its own category', async () => {
  phone('wants-all');
  phone('no-approvals', { approval: false });
  notifier.onUpdate([]);
  notifier.onUpdate([problem('approval', 0)]);
  await settle();
  assert.deepEqual(sent.map((s) => s.device), ['QF-wants-all']);
  assert.match(sent[0].payload.body, /^Needs you\./);
});

test('states that do not deserve a push are skipped', async () => {
  phone('a');
  notifier.onUpdate([]);
  notifier.onUpdate([problem('dead', 3600_000, { notify: false }), problem('working', 3600_000), problem('waiting', 3600_000)]);
  await settle();
  assert.equal(sent.length, 0);
});

test('"finished" goes only to phones that asked for it, after real work', async () => {
  phone('default');
  phone('finished', { finished: true });
  notifier.onUpdate([]);
  const view = baseView({ key: 'codex:1', tool: 'codex', title: 'Refactor', health: 'waiting', lastMessage: { role: 'assistant', text: 'All done.' } });
  notifier.onTransition({ key: view.key, from: 'working', to: 'waiting', view, previous: { ...view, health: 'working', healthSince: Date.now() - 5000 } });
  await settle();
  assert.equal(sent.length, 0, 'a 5-second turn is not worth a push');
  notifier.onTransition({ key: view.key, from: 'working', to: 'waiting', view, previous: { ...view, health: 'working', healthSince: Date.now() - 60_000 } });
  await settle();
  assert.deepEqual(sent.map((s) => s.device), ['QF-finished']);
  assert.equal(sent[0].payload.title, 'Codex · Refactor');
  assert.equal(sent[0].payload.body, 'Done: All done.');
});

test('a phone that dropped its subscription (404/410) is cleaned up', async () => {
  const gone = phone('gone');
  const alive = phone('alive');
  reply.set(gone.push!.subscription.endpoint, 410);
  const r = await notifier.send('system', { title: 't', body: 'b' });
  assert.deepEqual(r, { sent: 1, failed: 1 });
  assert.equal(gone.push, undefined);
  assert.ok(alive.push);
  const flaky = phone('flaky');
  reply.set(flaky.push!.subscription.endpoint, 500);
  await notifier.send('system', { title: 't', body: 'b' });
  assert.ok(flaky.push, 'a server error is not a reason to forget the phone');
});

test('at most 30 pushes per 10 minutes; tests to one phone are never dropped', async () => {
  const d = phone('a');
  for (let i = 0; i < 35; i++) await notifier.send('system', { title: `n${i}`, body: '' });
  assert.equal(sent.length, 30);
  assert.ok(log.lines.some((l) => l.includes('push rate limit')));
  await notifier.send('system', { title: 'test', body: '' }, d);
  assert.equal(sent.length, 31);
});

test('wake-up and back-online messages summarize the sessions', async () => {
  phone('a');
  const sessions = [problem('rc-lost', 0), baseView({ key: 'x', health: 'working' }), baseView({ key: 'y', alive: false, health: 'ended' })];
  notifier.onWake(45 * 60000, sessions);
  await settle();
  assert.equal(sent[0].payload.title, `${os.hostname()} woke up`);
  assert.equal(sent[0].payload.body, 'It was asleep for 45 min. 2 sessions running, 1 needs attention.');

  const realUptime = os.uptime;
  try {
    os.uptime = () => 3600;
    notifier.onStart(sessions);
    await settle();
    assert.equal(sent.length, 1, 'no "back online" when the PC has been up for an hour');
    os.uptime = () => 120;
    notifier.onStart(sessions);
    await settle();
    assert.equal(sent[1].payload.title, `${os.hostname()} is back online`);
  } finally {
    os.uptime = realUptime;
  }
});

test('notification text for each problem', () => {
  assert.equal(problemPayload(problem('dead', 0)).body, 'Stopped unexpectedly. detail dead');
  assert.equal(problemPayload(problem('rc-lost', 0)).body, 'Remote Control lost. detail rc-lost');
});

test('the PC key pair is created once and kept', () => {
  const file = path.join(dir, 'keys.json');
  const a = new Store(file, cfg.defaults);
  new Notifier(cfg, a, log).init();
  const key = a.data.vapid!.publicKey;
  const b = new Store(file, cfg.defaults);
  new Notifier(cfg, b, log).init();
  assert.equal(b.data.vapid!.publicKey, key, 'same key after a restart, so phones stay subscribed');
});
