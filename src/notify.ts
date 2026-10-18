import os from 'node:os';
import webpush, { type PushSubscription } from 'web-push';
import type { Config } from './config.ts';
import { minutes } from './health.ts';
import type { Logger } from './log.ts';
import type { Device, Store } from './store.ts';
import { PROBLEM_HEALTHS, type NotifyPrefs, type SessionView } from './types.ts';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export const DEFAULT_PREFS: NotifyPrefs = { problems: true, system: true };

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;

const PROBLEM_LABEL: Record<string, string> = {
  dead: 'Stopped unexpectedly',
  'rc-lost': 'Remote Control lost',
};

export class Notifier {
  private initialized = false;
  /** Session key -> the problem we already notified about ("health:since"). */
  private readonly alerted = new Map<string, string>();
  private sentAt: number[] = [];
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly log: Logger;

  constructor(cfg: Config, store: Store, log: Logger) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
  }

  init(): void {
    if (!this.store.data.vapid) {
      this.store.data.vapid = webpush.generateVAPIDKeys();
      this.store.saveNow();
    }
    const { publicKey, privateKey } = this.store.data.vapid;
    webpush.setVapidDetails(this.cfg.vapidSubject, publicKey, privateKey);
  }

  get publicKey(): string {
    return this.store.data.vapid!.publicKey;
  }

  subscribe(device: Device, subscription: PushSubscription, prefs?: Partial<NotifyPrefs>): void {
    device.push = { subscription, prefs: { ...DEFAULT_PREFS, ...(device.push?.prefs ?? {}), ...(prefs ?? {}) }, updatedAt: Date.now() };
    this.store.saveNow();
  }

  unsubscribe(device: Device): void {
    delete device.push;
    this.store.saveNow();
  }

  setPrefs(device: Device, prefs: Partial<NotifyPrefs>): void {
    if (!device.push) return;
    device.push.prefs = { ...device.push.prefs, ...prefs };
    this.store.saveNow();
  }

  /** Sends to every device that wants this category (or only to `only`). */
  async send(category: keyof NotifyPrefs, payload: PushPayload, only?: Device): Promise<{ sent: number; failed: number }> {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < RATE_WINDOW_MS);
    if (!only && this.sentAt.length >= RATE_MAX) {
      this.log.warn('push rate limit reached, dropping:', payload.title);
      return { sent: 0, failed: 0 };
    }
    const targets = (only ? [only] : this.store.data.devices).filter((d) => d.push && (only || d.push.prefs[category]));
    let sent = 0;
    let failed = 0;
    await Promise.all(
      targets.map(async (d) => {
        try {
          await webpush.sendNotification(d.push!.subscription, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
          sent++;
        } catch (e) {
          failed++;
          const status = (e as { statusCode?: number }).statusCode;
          this.log.warn(`push to ${d.name} failed (${status ?? 'network'}):`, (e as Error).message);
          if (status === 404 || status === 410) {
            delete d.push; // the phone dropped this subscription
            this.store.save();
          }
        }
      }),
    );
    if (sent) this.sentAt.push(now);
    return { sent, failed };
  }

  /** Called after every scan: alert on problems that have lasted long enough (except those auto-reconnect handles). */
  onUpdate(sessions: SessionView[], handledElsewhere: ReadonlySet<string> = new Set()): void {
    const now = Date.now();
    const current = new Set<string>();
    for (const s of sessions) {
      if (!PROBLEM_HEALTHS.has(s.health) || !s.notify || handledElsewhere.has(s.key)) continue;
      current.add(s.key);
      const id = `${s.health}:${s.healthSince}`;
      if (this.alerted.get(s.key) === id) continue;
      // Problems that were already there when the agent started are shown, not pushed.
      if (!this.initialized) {
        this.alerted.set(s.key, id);
        continue;
      }
      if (now - s.healthSince < this.cfg.alertDelaySeconds * 1000) continue;
      this.alerted.set(s.key, id);
      void this.send('problems', problemPayload(s));
    }
    for (const key of this.alerted.keys()) if (!current.has(key)) this.alerted.delete(key);
    this.initialized = true;
  }

  onWake(sleptMs: number, sessions: SessionView[]): void {
    const problems = sessions.filter((s) => PROBLEM_HEALTHS.has(s.health)).length;
    void this.send('system', {
      title: `${os.hostname()} woke up`,
      body: `It was asleep for ${minutes(sleptMs)}. ${summary(sessions, problems)}`,
      tag: 'system',
      url: '/',
    });
  }

  /** After a reboot, tell the phone the PC is reachable again. */
  onStart(sessions: SessionView[]): void {
    if (os.uptime() > 15 * 60) return;
    const problems = sessions.filter((s) => PROBLEM_HEALTHS.has(s.health)).length;
    void this.send('system', { title: `${os.hostname()} is back online`, body: summary(sessions, problems), tag: 'system', url: '/' });
  }
}

export function sessionUrl(s: { key: string }): string {
  return `/#s=${encodeURIComponent(s.key)}`;
}

function summary(sessions: SessionView[], problems: number): string {
  const live = sessions.filter((s) => s.alive).length;
  return `${live} session${live === 1 ? '' : 's'} running${problems ? `, ${problems} need${problems === 1 ? 's' : ''} attention` : ''}.`;
}

export function problemPayload(s: SessionView): PushPayload {
  return {
    title: s.title,
    body: `${PROBLEM_LABEL[s.health] ?? s.health}. ${s.detail}`,
    tag: s.key,
    url: sessionUrl(s),
  };
}
