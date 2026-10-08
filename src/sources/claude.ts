import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { ProcInfo, Snapshot } from '../proc/helper.ts';
import type { LastMessage, PendingTool, Phase, SessionFacts } from '../types.ts';
import { baseName, fileTimeToMs, flagValue, normPath, readdirSafe, readJsonFile, splitCommandLine, statSafe, UUID_RE } from '../util.ts';
import { childProcs, maxDefined, mtimeOf, newest, toolSummary } from './common.ts';
import { FollowerCache } from './jsonl.ts';

/** One `~/.claude/sessions/<pid>.json` file: Claude's own list of running sessions. */
export interface RegistryEntry {
  file: string;
  pid: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  nameSource?: string;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
  bridgeSessionId?: string | null;
  hostSessionId?: string;
  spare?: unknown;
}

/** Claude desktop app's record of a Code-tab session. */
export interface DesktopMeta {
  localId: string;
  cliSessionId?: string;
  title?: string;
  cwd?: string;
  remoteControlUserEnabled?: boolean;
  bridgeSessionIds: string[];
  isArchived?: boolean;
  permissionMode?: string;
  lastActivityAt?: number;
}

export interface TranscriptState {
  lastAt?: number;
  cwd?: string;
  bridgeUrl?: string;
  title?: string;
  phase: Phase;
  pending: Map<string, PendingTool>;
  lastAssistant?: LastMessage;
  lastUser?: LastMessage;
  permissionMode?: string;
}

/** How soon to look for new ~/.claude/projects folders when a transcript is missing. */
const RELIST_MS = 5000;

const CLI_SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin',
  'plugins', 'project', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade',
]);

export function bridgeUrl(bridgeSessionId: string): string {
  return `https://claude.ai/code/${bridgeSessionId.replace(/^cse_/, 'session_')}`;
}

/** Folder name Claude uses under ~/.claude/projects for a working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function initTranscript(): TranscriptState {
  return { phase: 'unknown', pending: new Map() };
}

function isCommandNoise(text: string): boolean {
  return /^\s*<(command-name|command-message|local-command|bash-input|bash-stdout|system-reminder)/.test(text);
}

/** Fold one transcript line into the running state. */
export function reduceTranscript(s: TranscriptState, e: any): void {
  if (!e || typeof e !== 'object') return;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : undefined;
  if (at && !Number.isNaN(at)) s.lastAt = at;
  if (typeof e.cwd === 'string') s.cwd = e.cwd;

  switch (e.type) {
    case 'bridge-session':
      if (e.bridgeSessionId) s.bridgeUrl = bridgeUrl(e.bridgeSessionId);
      return;
    case 'custom-title':
      if (e.customTitle) s.title = e.customTitle;
      return;
    case 'permission-mode':
      s.permissionMode = e.permissionMode;
      return;
    case 'system':
      if (e.subtype === 'bridge_status' && typeof e.url === 'string') s.bridgeUrl = e.url;
      if (e.subtype === 'stop_hook_summary' || e.subtype === 'turn_duration') {
        s.phase = 'idle';
        s.pending.clear();
      }
      return;
    case 'user': {
      if (e.isSidechain) return;
      const c = e.message?.content;
      if (typeof c === 'string') {
        if (!e.isMeta && !isCommandNoise(c)) {
          s.lastUser = { role: 'user', text: c, at };
          s.phase = 'busy';
        }
        return;
      }
      if (!Array.isArray(c)) return;
      let toolResult = false;
      for (const b of c) {
        if (b?.type === 'tool_result') {
          s.pending.delete(b.tool_use_id);
          toolResult = true;
        } else if (b?.type === 'text' && typeof b.text === 'string' && !e.isMeta) {
          if (b.text.startsWith('[Request interrupted')) {
            s.phase = 'idle';
            s.pending.clear();
            return;
          }
          if (!isCommandNoise(b.text)) {
            s.lastUser = { role: 'user', text: b.text, at };
            s.phase = 'busy';
          }
        }
      }
      if (toolResult) s.phase = 'busy';
      return;
    }
    case 'assistant': {
      if (e.isSidechain) return;
      const m = e.message;
      if (!m || !Array.isArray(m.content)) return;
      for (const b of m.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          s.lastAssistant = { role: 'assistant', text: b.text, at };
        } else if (b?.type === 'tool_use' && b.id) {
          s.pending.set(b.id, { name: String(b.name ?? 'tool'), summary: toolSummary(b.name, b.input), at: at ?? Date.now() });
        }
      }
      if ((m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') && s.pending.size === 0) s.phase = 'idle';
      else s.phase = 'busy';
      return;
    }
  }
}

function latestPending(s: TranscriptState | undefined): PendingTool | undefined {
  let best: PendingTool | undefined;
  for (const p of s?.pending.values() ?? []) if (!best || p.at >= best.at) best = p;
  return best;
}

export class ClaudeSource {
  private readonly cfg: Config;
  private readonly transcripts = new FollowerCache<TranscriptState>(initTranscript, reduceTranscript);
  private readonly transcriptPaths = new Map<string, string>();
  private projectDirs: string[] = [];
  private projectDirsAt = 0;
  private desktopMeta = new Map<string, DesktopMeta>();
  private desktopMetaAt = 0;
  private readonly desktopMetaFiles = new Map<string, { mtimeMs: number; meta: DesktopMeta }>();
  /** Session processes (pid:start) that had Remote Control on at some point. */
  private readonly rcSeen = new Set<string>();
  private readonly superseded: Record<string, number>;
  private readonly onSupersededChange: () => void;

  /** `superseded` is kept by the caller (saved to disk) so it survives restarts. */
  constructor(cfg: Config, superseded: Record<string, number> = {}, onSupersededChange: () => void = () => {}) {
    this.cfg = cfg;
    this.superseded = superseded;
    this.onSupersededChange = onSupersededChange;
  }

  readRegistry(): RegistryEntry[] {
    const dir = path.join(this.cfg.paths.claudeHome, 'sessions');
    const out: RegistryEntry[] = [];
    for (const d of readdirSafe(dir)) {
      if (!d.isFile() || !d.name.endsWith('.json')) continue;
      const file = path.join(dir, d.name);
      const r = readJsonFile<any>(file);
      if (!r || typeof r.pid !== 'number') continue;
      out.push({ ...r, file });
    }
    return out;
  }

  collect(snap: Snapshot, now: number, desktopMainPid: number | undefined): SessionFacts[] {
    const registry = this.readRegistry();
    this.refreshDesktopMeta(now);
    this.transcripts.prune();

    const regByPid = new Map<number, RegistryEntry[]>();
    for (const r of registry) regByPid.set(r.pid, [...(regByPid.get(r.pid) ?? []), r]);

    const sessionProcs = snap.procs.filter(
      (p) => p.root && p.name.toLowerCase() === 'claude.exe' && !!p.exe && !/\\WindowsApps\\/i.test(p.exe),
    );

    const facts: SessionFacts[] = [];
    const linked = new Set<RegistryEntry>();
    const claimed = new Set<string>();
    const pendingCwdLookups: { proc: ProcInfo; args: string[]; desktop: boolean }[] = [];

    // Pass 1: processes we can identify from the registry or their command line.
    for (const proc of sessionProcs) {
      const args = splitCommandLine(proc.cmd ?? '').slice(1);
      const desktop = proc.ppid === desktopMainPid || args.includes('--input-format');
      if (!desktop && !isInteractiveCli(args)) continue;
      const reg = (regByPid.get(proc.pid) ?? []).find((r) => sameProcess(r, proc));
      if (reg) linked.add(reg);
      if (reg?.spare) continue;
      // The desktop app also runs helper processes; only the ones it registered are sessions.
      if (desktop && !reg) continue;
      // With --fork-session the conversation gets a new id, so --resume points at the parent.
      const fromArgs = args.includes('--fork-session') ? undefined : flagValue(args, ['--resume', '-r', '--session-id']);
      const sessionId = reg?.sessionId ?? (fromArgs && UUID_RE.test(fromArgs) ? fromArgs : undefined);
      if (sessionId) {
        claimed.add(sessionId);
        facts.push(this.liveFacts(snap, now, proc, args, desktop, reg, sessionId));
      } else {
        pendingCwdLookups.push({ proc, args, desktop });
      }
    }

    // Pass 2: bare `claude` processes with no registry entry: find their transcript by folder.
    for (const { proc, args, desktop } of pendingCwdLookups) {
      const sessionId = this.findTranscriptByCwd(proc.cwd, proc.startMs, claimed);
      if (sessionId) claimed.add(sessionId);
      facts.push(this.liveFacts(snap, now, proc, args, desktop, undefined, sessionId));
    }

    // A conversation that goes on in a newer process makes the records of its older processes history:
    // they must not come back as a crash once that newer process exits normally.
    const retention = this.cfg.staleRetentionHours * 3600_000;
    let changed = false;
    for (const f of facts) {
      if (!f.sessionId || f.procStartMs === undefined) continue;
      for (const reg of registry) {
        if (reg.sessionId !== f.sessionId || linked.has(reg) || this.superseded[recordId(reg)]) continue;
        if ((fileTimeToMs(reg.procStart) ?? reg.startedAt ?? Infinity) < f.procStartMs) {
          this.superseded[recordId(reg)] = now;
          changed = true;
        }
      }
    }
    for (const [id, at] of Object.entries(this.superseded)) {
      if (now - at > retention + 3600_000) {
        delete this.superseded[id];
        changed = true;
      }
    }
    if (changed) this.onSupersededChange();

    // Registry entries whose process is gone: crashed or killed without cleanup. The newest record speaks for its session.
    const byNewest = [...registry].sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
    for (const reg of byNewest) {
      if (linked.has(reg) || reg.spare || !reg.sessionId || claimed.has(reg.sessionId) || this.superseded[recordId(reg)]) continue;
      const updated = reg.updatedAt ?? reg.startedAt ?? 0;
      if (now - updated > retention) continue;
      claimed.add(reg.sessionId);
      facts.push(this.staleFacts(reg, now));
    }

    // Two live processes on one conversation: keep keys unique.
    const seen = new Map<string, number>();
    for (const f of facts) {
      const n = seen.get(f.key) ?? 0;
      seen.set(f.key, n + 1);
      if (n > 0) f.key = `${f.key}:${f.pid ?? n}`;
    }
    return facts;
  }

  private liveFacts(
    snap: Snapshot,
    now: number,
    proc: ProcInfo,
    args: string[],
    desktop: boolean,
    reg: RegistryEntry | undefined,
    sessionId: string | undefined,
  ): SessionFacts {
    const transcriptPath = sessionId ? this.findTranscript(sessionId) : undefined;
    const t = transcriptPath ? this.transcripts.get(transcriptPath) : undefined;
    const ts = t?.state;
    const meta = this.metaFor(sessionId, reg?.hostSessionId);
    const cwd = reg?.cwd ?? proc.cwd ?? ts?.cwd;
    const folder = baseName(cwd);
    const procKey = `${proc.pid}:${proc.startFt}`;

    const rcOn = !!reg?.bridgeSessionId;
    if (rcOn) this.rcSeen.add(procKey);
    const rcExpected = args.includes('--remote-control') || meta?.remoteControlUserEnabled === true || this.rcSeen.has(procKey);
    const rcUrl = reg?.bridgeSessionId
      ? bridgeUrl(reg.bridgeSessionId)
      : meta?.bridgeSessionIds.length
        ? bridgeUrl(meta.bridgeSessionIds[meta.bridgeSessionIds.length - 1])
        : ts?.bridgeUrl;

    let phase: Phase = ts?.phase ?? 'unknown';
    if (reg?.status === 'busy') phase = 'busy';
    else if (reg?.status) phase = 'idle';

    const permissionMode = flagValue(args, ['--permission-mode']) ?? meta?.permissionMode ?? ts?.permissionMode;
    const title =
      meta?.title ??
      (reg?.name && reg.nameSource !== 'derived' ? reg.name : undefined) ??
      ts?.title ??
      reg?.name ??
      (folder ?? 'Claude session');

    const exe = proc.exe && fs.existsSync(proc.exe) ? proc.exe : this.cfg.claudeCommand;
    const command = sessionId ? [exe, '--remote-control', '--resume', sessionId] : [exe, '--remote-control'];

    return {
      key: sessionId ? `claude:${sessionId}` : `claude-pid:${proc.pid}:${proc.startFt ?? ''}`,
      tool: 'claude',
      host: desktop ? 'desktop' : 'cli',
      title,
      cwd,
      pid: proc.pid,
      procStartMs: proc.startMs,
      sessionId,
      alive: true,
      phase,
      startedAt: reg?.startedAt ?? proc.startMs,
      lastActivityAt: maxDefined(
        t?.mtimeMs,
        transcriptPath && sessionId ? this.subagentActivity(transcriptPath, sessionId) : undefined,
        reg?.statusUpdatedAt,
      ),
      registered: !!reg,
      staleRecord: false,
      lastKnownBusy: phase === 'busy',
      rcExpected,
      rcState: reg ? (rcOn ? 'on' : 'off') : 'unknown',
      rcUrl,
      pendingTool: latestPending(ts),
      approvalsDisabled: args.includes('--dangerously-skip-permissions') || permissionMode === 'bypassPermissions',
      lastMessage: newest(ts?.lastAssistant, ts?.lastUser),
      exe: proc.exe,
      resume: cwd ? { cwd, title, command } : undefined,
      selfCpuMs: proc.cpuMs,
      children: childProcs(snap, proc.pid),
    };
  }

  private staleFacts(reg: RegistryEntry, now: number): SessionFacts {
    const sessionId = reg.sessionId!;
    const transcriptPath = this.findTranscript(sessionId);
    const ts = transcriptPath ? this.transcripts.get(transcriptPath)?.state : undefined;
    const meta = this.metaFor(sessionId, reg.hostSessionId);
    const cwd = reg.cwd ?? ts?.cwd;
    const folder = baseName(cwd);
    const title = meta?.title ?? reg.name ?? ts?.title ?? (folder ?? 'Claude session');
    return {
      key: `claude:${sessionId}`,
      tool: 'claude',
      host: reg.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
      title,
      cwd,
      pid: reg.pid,
      sessionId,
      alive: false,
      phase: 'unknown',
      startedAt: reg.startedAt,
      lastActivityAt: maxDefined(reg.updatedAt, transcriptPath ? mtimeOf(transcriptPath) : undefined),
      registered: true,
      staleRecord: true,
      lastKnownBusy: reg.status === 'busy',
      // It was reachable from the phone, so losing it matters even if it was idle.
      rcExpected: !!reg.bridgeSessionId,
      rcState: 'n/a',
      rcUrl: reg.bridgeSessionId ? bridgeUrl(reg.bridgeSessionId) : ts?.bridgeUrl,
      approvalsDisabled: false,
      lastMessage: newest(ts?.lastAssistant, ts?.lastUser),
      resume: cwd ? { cwd, title, command: [this.cfg.claudeCommand, '--remote-control', '--resume', sessionId] } : undefined,
      children: [],
    };
  }

  private metaFor(sessionId: string | undefined, hostSessionId: string | undefined): DesktopMeta | undefined {
    if (hostSessionId) {
      const m = [...this.desktopMeta.values()].find((x) => x.localId === hostSessionId);
      if (m) return m;
    }
    return sessionId ? this.desktopMeta.get(sessionId) : undefined;
  }

  private refreshDesktopMeta(now: number): void {
    if (now - this.desktopMetaAt < 15000) return;
    this.desktopMetaAt = now;
    const root = path.join(this.cfg.paths.claudeAppData, 'claude-code-sessions');
    const next = new Map<string, DesktopMeta>();
    const weekAgo = now - 7 * 86400_000;
    for (const account of readdirSafe(root)) {
      if (!account.isDirectory()) continue;
      for (const org of readdirSafe(path.join(root, account.name))) {
        if (!org.isDirectory()) continue;
        const dir = path.join(root, account.name, org.name);
        for (const f of readdirSafe(dir)) {
          if (!f.isFile() || !f.name.startsWith('local_') || !f.name.endsWith('.json')) continue;
          const file = path.join(dir, f.name);
          const st = statSafe(file);
          if (!st || st.mtimeMs < weekAgo) continue;
          let cached = this.desktopMetaFiles.get(file);
          if (!cached || cached.mtimeMs !== st.mtimeMs) {
            const raw = readJsonFile<any>(file);
            if (!raw) continue;
            cached = {
              mtimeMs: st.mtimeMs,
              meta: {
                localId: raw.sessionId ?? f.name.replace(/\.json$/, ''),
                cliSessionId: raw.cliSessionId,
                title: raw.title,
                cwd: raw.cwd,
                remoteControlUserEnabled: raw.remoteControlUserEnabled,
                bridgeSessionIds: Array.isArray(raw.bridgeSessionIds) ? raw.bridgeSessionIds : [],
                isArchived: raw.isArchived,
                permissionMode: raw.permissionMode,
                lastActivityAt: raw.lastActivityAt,
              },
            };
            this.desktopMetaFiles.set(file, cached);
          }
          if (cached.meta.cliSessionId) next.set(cached.meta.cliSessionId, cached.meta);
        }
      }
    }
    this.desktopMeta = next;
  }

  /** Folders under ~/.claude/projects, re-read when older than maxAgeMs. */
  private listProjectDirs(maxAgeMs = 60000): string[] {
    const now = Date.now();
    if (now - this.projectDirsAt > maxAgeMs) {
      const root = path.join(this.cfg.paths.claudeHome, 'projects');
      this.projectDirs = readdirSafe(root)
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
      this.projectDirsAt = now;
    }
    return this.projectDirs;
  }

  findTranscript(sessionId: string): string | undefined {
    const cached = this.transcriptPaths.get(sessionId);
    if (cached && fs.existsSync(cached)) return cached;
    const search = (dirs: string[]) => dirs.map((d) => path.join(d, `${sessionId}.jsonl`)).find((file) => fs.existsSync(file));
    // Not found: the session may be in a folder Claude has never used, so its projects folder is new.
    const file = search(this.listProjectDirs()) ?? search(this.listProjectDirs(RELIST_MS));
    if (file) this.transcriptPaths.set(sessionId, file);
    return file;
  }

  /** Newest transcript in the process's folder written since it started and not owned by another session. */
  private findTranscriptByCwd(cwd: string | undefined, startMs: number | undefined, claimed: Set<string>): string | undefined {
    if (!cwd || !startMs) return undefined;
    const want = normPath(path.join(this.cfg.paths.claudeHome, 'projects', projectSlug(cwd)));
    const find = (dirs: string[]) => dirs.find((d) => normPath(d) === want);
    const dir = find(this.listProjectDirs()) ?? find(this.listProjectDirs(RELIST_MS));
    if (!dir) return undefined;
    let best: { id: string; mtime: number } | undefined;
    for (const f of readdirSafe(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(id) || claimed.has(id)) continue;
      const mtime = mtimeOf(path.join(dir, f.name));
      if (mtime === undefined || mtime < startMs) continue;
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    if (best) this.transcriptPaths.set(best.id, path.join(dir, `${best.id}.jsonl`));
    return best?.id;
  }

  /** Subagents write their own transcripts; count them as activity of the parent session. */
  private subagentActivity(transcriptPath: string, sessionId: string): number | undefined {
    const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
    let best: number | undefined;
    for (const f of readdirSafe(dir)) {
      if (!f.isFile()) continue;
      best = maxDefined(best, mtimeOf(path.join(dir, f.name)));
    }
    return best;
  }
}

function recordId(reg: RegistryEntry): string {
  return `${reg.pid}:${reg.procStart ?? reg.startedAt ?? ''}`;
}

function sameProcess(reg: RegistryEntry, proc: ProcInfo): boolean {
  if (reg.procStart && proc.startFt) {
    if (reg.procStart === proc.startFt) return true;
    const a = fileTimeToMs(reg.procStart);
    return a !== undefined && proc.startMs !== undefined && Math.abs(a - proc.startMs) < 2000;
  }
  return reg.startedAt !== undefined && proc.startMs !== undefined && Math.abs(reg.startedAt - proc.startMs) < 15000;
}

/** An interactive `claude` session, as opposed to `claude mcp ...`, `claude -p ...` and friends. */
export function isInteractiveCli(args: string[]): boolean {
  if (args.some((a) => a === '-p' || a === '--print' || a === '-v' || a === '--version' || a === '-h' || a === '--help')) return false;
  const first = args.find((a) => !a.startsWith('-'));
  if (first && CLI_SUBCOMMANDS.has(first)) {
    // `claude --resume <id>` puts the id first among non-flags; only real subcommands count.
    const idx = args.indexOf(first);
    const prev = args[idx - 1];
    const takesValue = prev && ['--resume', '-r', '--session-id', '--remote-control', '--model', '--permission-mode', '--agent', '--effort'].includes(prev);
    if (!takesValue) return false;
  }
  return true;
}
