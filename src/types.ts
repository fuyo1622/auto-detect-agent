export type Tool = 'claude' | 'codex';
export type Host = 'cli' | 'desktop';

/** What the phone shows for a session, worst first. */
export type Health = 'dead' | 'rc-lost' | 'stuck' | 'approval' | 'working' | 'waiting' | 'ended';

export const PROBLEM_HEALTHS: ReadonlySet<Health> = new Set<Health>(['dead', 'rc-lost', 'stuck', 'approval']);

export type RcState = 'on' | 'off' | 'unknown' | 'n/a';
export type Phase = 'busy' | 'idle' | 'unknown';

export type SessionAction =
  | 'reconnect' // restart the session in Windows Terminal with Remote Control on
  | 'resume' // the session is gone: open it again in Windows Terminal
  | 'stop' // kill the session process
  | 'open-terminal' // open a Codex app thread in the Codex CLI
  | 'restart-app' // restart the desktop app that hosts the session
  | 'start-app' // start the desktop app that hosted the session
  | 'dismiss'; // hide a closed session from the list

export type AppId = 'claude-desktop' | 'codex-desktop' | 'codex-daemon';
export type AppAction = 'restart' | 'start' | 'stop';

export interface PendingTool {
  name: string;
  summary: string;
  at: number;
}

export interface LastMessage {
  role: 'assistant' | 'user';
  text: string;
  at?: number;
}

export interface ChildProc {
  pid: number;
  name: string;
  startMs?: number;
  cpuMs?: number;
  cmd?: string;
}

/** How to bring a session back in a terminal. */
export interface ResumeSpec {
  cwd: string;
  /** Executable plus arguments. */
  command: string[];
  title: string;
}

/** Everything the sources know about one session, before health is derived. */
export interface SessionFacts {
  key: string;
  tool: Tool;
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
  /** Claude only: whether Claude's own session registry still lists this process. */
  registered: boolean | null;
  /** A record says the session existed but its process is gone. */
  staleRecord: boolean;
  /** For gone sessions: was it working when it went away? */
  lastKnownBusy: boolean;
  rcExpected: boolean;
  rcState: RcState;
  rcUrl?: string;
  pendingTool?: PendingTool;
  /** Codex: an approval request is open. */
  pendingApproval?: string;
  approvalsDisabled: boolean;
  lastMessage?: LastMessage;
  /** Executable of the session process, used to relaunch with the same build. */
  exe?: string;
  resume?: ResumeSpec;
  appRunning?: boolean;
  /** CPU time of the session process itself. */
  selfCpuMs?: number;
  /** Processes started by the session (shells, test runners, MCP servers), console hosts excluded. */
  children: ChildProc[];
}

export interface SessionView {
  key: string;
  tool: Tool;
  host: Host;
  title: string;
  folder?: string;
  cwd?: string;
  pid?: number;
  sessionId?: string;
  alive: boolean;
  busy: boolean;
  health: Health;
  detail: string;
  /** What the session is doing underneath a Remote Control problem. */
  activity: Health;
  activityDetail: string;
  healthSince: number;
  /** Whether the current state is worth a push notification. */
  notify: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  rc: { expected: boolean; state: RcState; url?: string };
  lastMessage?: LastMessage;
  pendingTool?: PendingTool;
  running?: string[];
  actions: SessionAction[];
}

export interface AppStatus {
  id: AppId;
  name: string;
  installed: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
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
  stuckMinutes: number;
  autoReconnect: boolean;
}

export interface NotifyPrefs {
  problems: boolean;
  approval: boolean;
  finished: boolean;
  system: boolean;
}
