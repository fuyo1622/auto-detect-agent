import crypto from 'node:crypto';
import type { Device, Store } from './store.ts';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Pairing: the PC shows a 6-digit code, the phone trades it for a long-lived token.
 * Only a hash of each token is stored.
 */
export class Pairing {
  private code: { value: string; expiresAt: number } | undefined;
  private failures: number[] = [];
  private lastSeenSave = 0;
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** The active code, creating one if needed. */
  current(): { code: string; expiresAt: number } {
    if (!this.code || this.code.expiresAt <= Date.now()) this.renew();
    return { code: this.code!.value, expiresAt: this.code!.expiresAt };
  }

  renew(): { code: string; expiresAt: number } {
    this.code = { value: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + CODE_TTL_MS };
    return { code: this.code.value, expiresAt: this.code.expiresAt };
  }

  redeem(code: string, name: string, userAgent?: string): { token: string; device: Device } | { error: string } {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) return { error: 'Too many wrong codes. Create a new code on the PC and wait a few minutes.' };
    const wanted = this.code;
    const given = String(code ?? '').replace(/\D/g, '');
    if (!wanted || wanted.expiresAt <= now || given.length !== 6 || !safeEqual(given, wanted.value)) {
      this.failures.push(now);
      return { error: 'That code is wrong or expired. Check the code on the PC.' };
    }
    this.code = undefined; // one phone per code
    const token = crypto.randomBytes(32).toString('base64url');
    const device: Device = {
      id: crypto.randomUUID(),
      name: (name || 'iPhone').slice(0, 60),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      userAgent: userAgent?.slice(0, 300),
    };
    this.store.data.devices.push(device);
    this.store.saveNow();
    return { token, device };
  }

  authenticate(token: string | undefined): Device | undefined {
    if (!token) return undefined;
    const hash = hashToken(token);
    const device = this.store.data.devices.find((d) => safeEqual(d.tokenHash, hash));
    if (device) {
      const now = Date.now();
      device.lastSeenAt = now;
      if (now - this.lastSeenSave > 60000) {
        this.lastSeenSave = now;
        this.store.save();
      }
    }
    return device;
  }

  revoke(id: string): boolean {
    const before = this.store.data.devices.length;
    this.store.data.devices = this.store.data.devices.filter((d) => d.id !== id);
    this.store.saveNow();
    return this.store.data.devices.length < before;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
