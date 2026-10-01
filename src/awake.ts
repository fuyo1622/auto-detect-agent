import type { Logger } from './log.ts';
import type { ProcHelper } from './proc/helper.ts';
import type { Store } from './store.ts';
import type { SessionView } from './types.ts';

/** How long the PC stays awake after the last session stops working. */
const HOLD_MS = 2 * 60 * 1000;

/**
 * Stops Windows from going to sleep on its own: always, only while a session is working,
 * or never. The display can still turn off, and closing the lid or choosing Sleep still works.
 */
export class KeepAwake {
  active = false;
  private holdUntil = 0;
  private readonly helper: ProcHelper;
  private readonly store: Store;
  private readonly log: Logger;

  constructor(helper: ProcHelper, store: Store, log: Logger) {
    this.helper = helper;
    this.store = store;
    this.log = log;
  }

  async update(sessions: SessionView[]): Promise<void> {
    const mode = this.store.data.settings.keepAwake;
    const now = Date.now();
    if (sessions.some((s) => s.alive && s.busy)) this.holdUntil = now + HOLD_MS;
    const want = mode === 'always' || (mode === 'while-working' && now < this.holdUntil);
    if (want === this.active) return;
    const ok = await this.helper.setAwake(want);
    this.active = want && ok;
    this.log.info(want ? (ok ? 'keeping the PC awake' : 'could not keep the PC awake') : 'PC may sleep again');
  }

  async release(): Promise<void> {
    if (this.active) await this.helper.setAwake(false);
    this.active = false;
  }
}
