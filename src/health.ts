import type { Health, SessionFacts } from './types.ts';

export interface HealthContext {
  now: number;
  stuckMs: number;
  approvalMs: number;
  /** Last time the session or the processes it started used noticeable CPU. */
  cpuActiveAt?: number;
}

export interface HealthResult {
  health: Health;
  detail: string;
  /** What the session itself is doing, ignoring Remote Control (shown as a second line). */
  activity: Health;
  activityDetail: string;
  /** Whether this state deserves a push notification. */
  notify: boolean;
}

/** Tools that legitimately run for a long time without starting a process. */
const LONG_RUNNING_TOOLS = /^(Agent|Task|TaskOutput|TaskStop|Monitor|ScheduleWakeup|SendMessage|WebSearch|WebFetch|ToolSearch|Skill|Workflow|Sleep)$/;

/** A session that just started is still registering and connecting Remote Control. */
export const RC_GRACE_MS = 30_000;

export function approvalDetail(name: string, summary: string): string {
  if (name === 'AskUserQuestion') return 'Asking you a question';
  if (name === 'ExitPlanMode') return 'Waiting for you to approve the plan';
  return `Waiting for approval? ${name}${summary ? `: ${summary}` : ''}`;
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function deriveHealth(f: SessionFacts, ctx: HealthContext): HealthResult {
  const { now } = ctx;

  if (!f.alive) {
    if (f.stoppedByUser) return { health: 'ended', detail: 'Stopped', activity: 'ended', activityDetail: 'Stopped', notify: false };
    const crashed = f.staleRecord && (f.host === 'cli' || f.lastKnownBusy);
    if (crashed) {
      const detail = f.lastKnownBusy ? 'Stopped while it was working' : 'The process ended without closing the session';
      return { health: 'dead', detail, activity: 'dead', activityDetail: detail, notify: f.lastKnownBusy || f.rcExpected };
    }
    return { health: 'ended', detail: 'Closed', activity: 'ended', activityDetail: 'Closed', notify: false };
  }

  const lastSign = Math.max(f.lastActivityAt ?? f.startedAt ?? now, ctx.cpuActiveAt ?? 0);
  const quietMs = Math.max(0, now - lastSign);
  const pending = f.pendingTool;
  const toolProcesses = pending ? f.children.filter((c) => (c.startMs ?? 0) >= pending.at - 3000) : [];

  let activity: Health;
  let activityDetail: string;
  if (f.pendingApproval) {
    activity = 'approval';
    activityDetail = `Waiting for approval: ${f.pendingApproval}`;
  } else if (
    pending &&
    !f.approvalsDisabled &&
    toolProcesses.length === 0 &&
    !LONG_RUNNING_TOOLS.test(pending.name) &&
    now - pending.at >= ctx.approvalMs &&
    quietMs >= ctx.approvalMs
  ) {
    activity = 'approval';
    activityDetail = approvalDetail(pending.name, pending.summary);
  } else if (f.phase === 'busy') {
    if (quietMs >= ctx.stuckMs) {
      activity = 'stuck';
      activityDetail = `No progress for ${minutes(quietMs)}`;
    } else {
      activity = 'working';
      activityDetail = pending ? `Running ${pending.name}${pending.summary ? `: ${pending.summary}` : ''}` : 'Working';
    }
  } else {
    activity = 'waiting';
    activityDetail = 'Waiting for your next message';
  }

  const starting = f.procStartMs !== undefined && now - f.procStartMs < RC_GRACE_MS;
  if (f.rcExpected && f.rcState !== 'on' && !starting) {
    const detail =
      f.rcState === 'unknown'
        ? 'Claude no longer lists this session, so Remote Control is probably disconnected'
        : 'Remote Control is not connected';
    return { health: 'rc-lost', detail, activity, activityDetail, notify: true };
  }
  return { health: activity, detail: activityDetail, activity, activityDetail, notify: activity !== 'working' && activity !== 'waiting' };
}

const ORDER: Record<Health, number> = { dead: 0, 'rc-lost': 1, stuck: 2, approval: 3, working: 4, waiting: 5, ended: 6 };

export function healthRank(h: Health): number {
  return ORDER[h];
}
