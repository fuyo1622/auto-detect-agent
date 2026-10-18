import type { Actions } from './actions.ts';
import type { Logger } from './log.ts';
import { sessionUrl, type Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { SessionView } from './types.ts';

/** Remote Control often comes back by itself after a network blip; wait this long first. */
const WAIT_MS = 2 * 60 * 1000;
const SPACING_MS = 15 * 60 * 1000;
const MAX_PER_HOUR = 3;

/**
 * The "Auto-reconnect" setting (off by default): when a terminal session has lost Remote Control
 * and is idle, reopen it with Remote Control instead of waiting for a tap on the phone.
 */
export class AutoReconnect {
  private readonly attempts = new Map<string, number[]>();
  private readonly store: Store;
  private readonly actions: Actions;
  private readonly notifier: Notifier;
  private readonly log: Logger;

  constructor(store: Store, actions: Actions, notifier: Notifier, log: Logger) {
    this.store = store;
    this.actions = actions;
    this.notifier = notifier;
    this.log = log;
  }

  /** Reconnects what it can; returns the sessions it takes care of (so no separate "lost" alert is needed). */
  onUpdate(sessions: SessionView[]): Set<string> {
    const handled = new Set<string>();
    if (!this.store.data.settings.autoReconnect) return handled;
    const now = Date.now();
    for (const s of sessions) {
      if (s.health !== 'rc-lost' || s.host !== 'cli' || !s.alive || !s.idle || !s.actions.includes('reconnect')) continue;
      const recent = (this.attempts.get(s.key) ?? []).filter((t) => now - t < 3600_000);
      this.attempts.set(s.key, recent);
      if (recent.length >= MAX_PER_HOUR) continue; // give up for now: the normal alert goes out
      handled.add(s.key);
      if (now - s.healthSince < WAIT_MS || (recent.length && now - recent[recent.length - 1] < SPACING_MS)) continue;
      recent.push(now);
      this.log.info('auto-reconnecting', s.title);
      void this.actions.session(s.key, 'reconnect', { by: 'auto-reconnect' }).then((r) => {
        void this.notifier.send('problems', {
          title: s.title,
          body: r.ok ? 'Remote Control was lost, so it was reopened in Windows Terminal.' : `Auto-reconnect failed: ${r.message}`,
          tag: s.key,
          url: sessionUrl(s),
        });
      });
    }
    return handled;
  }
}
