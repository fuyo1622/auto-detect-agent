import type { Actions } from './actions.ts';
import type { Logger } from './log.ts';
import type { Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { SessionView } from './types.ts';

const WAIT_MS = 2 * 60 * 1000;
const SPACING_MS = 15 * 60 * 1000;
const MAX_PER_HOUR = 3;

/**
 * Optional (off by default): when a terminal Claude session has lost Remote Control and is
 * idle, reopen it with Remote Control instead of waiting for a tap on the phone.
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

  onUpdate(sessions: SessionView[]): void {
    if (!this.store.data.settings.autoReconnect) return;
    const now = Date.now();
    for (const s of sessions) {
      if (s.health !== 'rc-lost' || s.tool !== 'claude' || s.host !== 'cli' || !s.alive || s.busy) continue;
      if (!s.actions.includes('reconnect') || now - s.healthSince < WAIT_MS) continue;
      const recent = (this.attempts.get(s.key) ?? []).filter((t) => now - t < 3600_000);
      if (recent.length >= MAX_PER_HOUR || (recent.length && now - recent[recent.length - 1] < SPACING_MS)) continue;
      recent.push(now);
      this.attempts.set(s.key, recent);
      this.log.info('auto-reconnecting', s.title);
      void this.actions.session(s.key, 'reconnect', { by: 'auto-reconnect' }).then((r) => {
        void this.notifier.send('problems', {
          title: `Claude · ${s.title}`,
          body: r.ok ? 'Remote Control was lost, so it was reopened in Windows Terminal.' : `Auto-reconnect failed: ${r.message}`,
          tag: s.key,
          url: `/#s=${encodeURIComponent(s.key)}`,
        });
      });
    }
  }
}
