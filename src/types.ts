export type Host = 'cli' | 'desktop';

/** What the phone shows for a session, worst first. */
export type Health = 'dead' | 'rc-lost' | 'working' | 'waiting' | 'ended';

export const PROBLEM_HEALTHS: ReadonlySet<Health> = new Set<Health>(['dead', 'rc-lost']);

export type RcState = 'on' | 'off' | 'unknown' | 'n/a';
export type Phase = 'busy' | 'idle' | 'unknown';

export type SessionAction =
  | 'reconnect' // restart a terminal session in Windows Terminal with Remote Control on
  | 'resume' // the terminal session is gone: open it again with Remote Control on
  | 'restart-app' // restart the Claude app (the fix for its sessions)
  | 'start-app' // start the Claude app again
  | 'dismiss'; // hide a closed session from the list

export type AppId = 'claude-desktop';
export type AppAction = 'restart' | 'start';

/** How to bring a session back in a terminal. */
export interface ResumeSpec {
  cwd: string;
  /** Executable plus arguments. */
  command: string[];
  title: string;
}

/** Everything known about one session, before health is derived. */
export interface SessionFacts {
  key: string;
  host: Host;
  title: string;
  cwd?: string;
  pid?: number;
  procStartMs?: number;
  sessionId?: string;
  alive: boolean;
  phase: Phase;
  startedAt?: number;
  lastActivityAt?: number;
  /** Whether Claude's own session registry still lists this process. */
  registered: boolean;
  /** A record says the session existed but its process is gone. */
  staleRecord: boolean;
  /** For gone sessions: was it working when it went away? */
  lastKnownBusy: boolean;
  /** Gone because it was closed from here (Reconnect, app restart), so it is not a crash. */
  stoppedByUser?: boolean;
  rcExpected: boolean;
  rcState: RcState;
  rcUrl?: string;
  resume?: ResumeSpec;
  appRunning?: boolean;
}

export interface SessionView {
  key: string;
  host: Host;
  title: string;
  folder?: string;
  cwd?: string;
  pid?: number;
  sessionId?: string;
  alive: boolean;
  busy: boolean;
  /** Known to be idle (Claude's own status says so), so it is safe to restart. */
  idle: boolean;
  health: Health;
  detail: string;
  healthSince: number;
  /** Whether the current state is worth a push notification. */
  notify: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  rc: { expected: boolean; state: RcState; url?: string };
  actions: SessionAction[];
}

export interface AppStatus {
  id: AppId;
  name: string;
  installed: boolean;
  running: boolean;
  pid?: number;
  actions: AppAction[];
}

export interface ActionLogEntry {
  at: number;
  target: string;
  action: string;
  ok: boolean;
  message: string;
  by: string;
}

export interface PublicState {
  agent: {
    version: string;
    host: string;
    startedAt: number;
    now: number;
    publicUrl?: string;
    awake: boolean;
    lastWakeAt?: number;
    helper: 'ok' | 'fallback' | 'down';
    settings: Settings;
  };
  apps: AppStatus[];
  sessions: SessionView[];
  activity: ActionLogEntry[];
}

export type KeepAwake = 'off' | 'while-working' | 'always';

export interface Settings {
  keepAwake: KeepAwake;
  autoReconnect: boolean;
}

export interface NotifyPrefs {
  /** Remote Control lost, or a session stopped unexpectedly. */
  problems: boolean;
  /** The PC woke up or came back online. */
  system: boolean;
}
