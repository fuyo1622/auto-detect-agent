import type { Health, SessionFacts } from './types.ts';

export interface HealthResult {
  health: Health;
  detail: string;
  /** Whether this state deserves a push notification. */
  notify: boolean;
}

/** A session that just started is still registering and connecting Remote Control. */
export const RC_GRACE_MS = 30_000;

export function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function deriveHealth(f: SessionFacts, now: number): HealthResult {
  if (!f.alive) {
    if (f.stoppedByUser) return { health: 'ended', detail: 'Stopped', notify: false };
    const crashed = f.staleRecord && (f.host === 'cli' || f.lastKnownBusy);
    if (crashed) {
      const detail = f.lastKnownBusy ? 'Stopped while it was working' : 'The process ended without closing the session';
      return { health: 'dead', detail, notify: f.lastKnownBusy || f.rcExpected };
    }
    return { health: 'ended', detail: 'Closed', notify: false };
  }

  const starting = f.procStartMs !== undefined && now - f.procStartMs < RC_GRACE_MS;
  if (f.rcExpected && f.rcState !== 'on' && !starting) {
    const detail =
      f.rcState === 'unknown'
        ? 'Claude no longer lists this session, so Remote Control is probably disconnected'
        : 'Remote Control is not connected';
    return { health: 'rc-lost', detail, notify: true };
  }
  if (f.phase === 'busy') return { health: 'working', detail: 'Working', notify: false };
  return { health: 'waiting', detail: 'Waiting for your next message', notify: false };
}

const ORDER: Record<Health, number> = { dead: 0, 'rc-lost': 1, working: 2, waiting: 3, ended: 4 };

export function healthRank(h: Health): number {
  return ORDER[h];
}
