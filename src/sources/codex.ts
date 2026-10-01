import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { ProcInfo, Snapshot } from '../proc/helper.ts';
import type { LastMessage, Phase, SessionFacts } from '../types.ts';
import { baseName, flagValue, normPath, readdirSafe, splitCommandLine, statSafe, truncate, UUID_RE } from '../util.ts';
import { childProcs, newest } from './common.ts';
import { FollowerCache, readFirstLine } from './jsonl.ts';

export interface RolloutMeta {
  id: string;
  cwd?: string;
  originator?: string;
  source?: string;
  startedAt?: number;
}

export interface RolloutState {
  phase: Phase;
  lastAt?: number;
  lastAgent?: LastMessage;
  lastUser?: LastMessage;
  pendingApproval?: string;
}

export interface DaemonStatus {
  running: boolean;
  detail?: string;
  checkedAt: number;
}

/** CLI subcommands that are not an interactive Codex session. */
const NON_SESSION = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'app',
  'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts',
  'unarchive', 'cloud', 'exec-server', 'features', 'help', 'agents',
]);

export function initRollout(): RolloutState {
  return { phase: 'unknown' };
}

function userText(content: any[]): string | undefined {
  const parts = content
    .filter((c) => c?.type === 'input_text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .filter((t) => !t.trimStart().startsWith('<') && !t.startsWith('# AGENTS.md'));
  return parts.length ? parts.join('\n') : undefined;
}

export function reduceRollout(s: RolloutState, e: any): void {
  if (!e || typeof e !== 'object') return;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : undefined;
  if (at && !Number.isNaN(at)) s.lastAt = at;
  const p = e.payload;
  if (!p || typeof p !== 'object') return;

  if (e.type === 'event_msg') {
    const t = String(p.type ?? '');
    if (t === 'task_started') {
      s.phase = 'busy';
      s.pendingApproval = undefined;
    } else if (t === 'task_complete') {
      s.phase = 'idle';
      s.pendingApproval = undefined;
      if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) {
        s.lastAgent = { role: 'assistant', text: p.last_agent_message, at };
      }
    } else if (t === 'turn_aborted') {
      s.phase = 'idle';
      s.pendingApproval = undefined;
    } else if (t === 'user_message' && typeof p.message === 'string') {
      s.lastUser = { role: 'user', text: p.message, at };
    } else if (t === 'agent_message' && typeof p.message === 'string') {
      s.lastAgent = { role: 'assistant', text: p.message, at };
    } else if (/approval_request|request_user_input|elicitation_request/.test(t)) {
      const what = Array.isArray(p.command) ? p.command.join(' ') : (p.command ?? p.reason ?? p.message ?? t);
      s.pendingApproval = truncate(String(what), 160);
    } else if (t === 'item_completed' || t.endsWith('_end')) {
      s.pendingApproval = undefined;
    }
    return;
  }

  if (e.type === 'response_item') {
    if (p.type === 'message' && Array.isArray(p.content)) {
      if (p.role === 'user') {
        const text = userText(p.content);
        if (text) s.lastUser = { role: 'user', text, at };
      } else if (p.role === 'assistant') {
        const text = p.content
          .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
        if (text.trim()) s.lastAgent = { role: 'assistant', text, at };
      }
    } else if (typeof p.type === 'string' && p.type.endsWith('_output')) {
      s.pendingApproval = undefined;
    }
  }
}

interface RolloutFile {
  file: string;
  mtimeMs: number;
  meta?: RolloutMeta;
}

export class CodexSource {
  private readonly cfg: Config;
  private readonly followers = new FollowerCache<RolloutState>(initRollout, reduceRollout);
  private readonly metaCache = new Map<string, RolloutMeta | null>();
  private names = new Map<string, string>();
  private namesMtime = 0;
  daemon: DaemonStatus = { running: false, checkedAt: 0 };
  private daemonChecking = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  collect(snap: Snapshot, now: number, desktopMain: ProcInfo | undefined): SessionFacts[] {
    this.followers.prune();
    this.refreshNames();
    const files = this.listRollouts(now);
    const facts: SessionFacts[] = [];
    const claimed = new Set<string>();

    for (const proc of cliProcesses(snap, desktopMain)) {
      const args = splitCommandLine(proc.cmd ?? '').slice(1);
      const rollout = this.matchProcess(proc, args, files, claimed);
      if (rollout?.meta) claimed.add(rollout.meta.id);
      facts.push(this.cliFacts(snap, proc, rollout));
    }

    const desktopRunning = !!desktopMain;
    const recent = now - this.cfg.recentHours * 3600_000;
    const endedWindow = now - this.cfg.endedRetentionMinutes * 60_000;
    const staleWindow = now - this.cfg.staleRetentionHours * 3600_000;
    for (const f of files) {
      const meta = f.meta;
      if (!meta || claimed.has(meta.id) || meta.source === 'exec') continue;
      const desktop = isDesktopRollout(meta);
      const st = this.followers.get(f.file)?.state;
      const busy = st?.phase === 'busy';
      if (desktop && desktopRunning) {
        if (f.mtimeMs < recent) continue;
        facts.push(this.threadFacts(f, st, 'desktop', true, desktopRunning));
      } else if (f.mtimeMs >= endedWindow || (busy && f.mtimeMs >= staleWindow)) {
        facts.push(this.threadFacts(f, st, desktop ? 'desktop' : 'cli', false, desktopRunning));
      }
    }
    return facts;
  }

  /** `codex app-server daemon version` answers only when the daemon is up. */
  refreshDaemon(now: number): void {
    if (this.daemonChecking || now - this.daemon.checkedAt < 30000) return;
    this.daemonChecking = true;
    execFile(
      this.cfg.codexCommand,
      ['app-server', 'daemon', 'version'],
      { windowsHide: true, timeout: 15000, shell: false },
      (err, stdout, stderr) => {
        this.daemonChecking = false;
        const out = String(stdout ?? '').trim();
        let running = !err && out.startsWith('{');
        let detail: string | undefined;
        if (running) {
          try {
            const v = JSON.parse(out);
            detail = v.app_server_version || v.appServerVersion || v.running_version || undefined;
            if (detail) detail = `app-server ${detail}`;
          } catch {
            running = false;
          }
        } else if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          detail = 'codex CLI not found';
        } else {
          const msg = String(stderr || out).split('\n')[0];
          detail = /failed to connect/i.test(msg) ? 'not running' : truncate(msg, 120) || 'not running';
        }
        this.daemon = { running, detail, checkedAt: Date.now() };
      },
    );
  }

  private cliFacts(snap: Snapshot, proc: ProcInfo, rollout: RolloutFile | undefined): SessionFacts {
    const st = rollout ? this.followers.get(rollout.file)?.state : undefined;
    const meta = rollout?.meta;
    const cwd = meta?.cwd ?? proc.cwd;
    const folder = baseName(cwd);
    const title = (meta && this.names.get(meta.id)) ?? (st?.lastUser ? truncate(st.lastUser.text, 60) : undefined) ?? folder ?? 'Codex session';
    const exe = proc.exe && fs.existsSync(proc.exe) ? proc.exe : this.cfg.codexCommand;
    return {
      key: meta ? `codex:${meta.id}` : `codex-pid:${proc.pid}:${proc.startFt ?? ''}`,
      tool: 'codex',
      host: 'cli',
      title,
      cwd,
      pid: proc.pid,
      procStartMs: proc.startMs,
      sessionId: meta?.id,
      alive: true,
      phase: st?.phase === 'unknown' || !st ? 'idle' : st.phase,
      startedAt: proc.startMs,
      lastActivityAt: rollout?.mtimeMs,
      registered: null,
      staleRecord: false,
      lastKnownBusy: st?.phase === 'busy',
      rcExpected: false,
      rcState: 'n/a',
      pendingApproval: st?.pendingApproval,
      approvalsDisabled: false,
      lastMessage: newest(st?.lastAgent, st?.lastUser),
      exe: proc.exe,
      resume: cwd ? { cwd, title, command: meta ? [exe, 'resume', meta.id] : [exe] } : undefined,
      selfCpuMs: proc.cpuMs,
      children: childProcs(snap, proc.pid),
    };
  }

  private threadFacts(f: RolloutFile, st: RolloutState | undefined, host: 'cli' | 'desktop', alive: boolean, appRunning: boolean): SessionFacts {
    const meta = f.meta!;
    const folder = baseName(meta.cwd);
    const title = this.names.get(meta.id) ?? (st?.lastUser ? truncate(st.lastUser.text, 60) : undefined) ?? folder ?? 'Codex thread';
    const phase: Phase = st?.phase === 'busy' ? 'busy' : 'idle';
    return {
      key: `codex:${meta.id}`,
      tool: 'codex',
      host,
      title,
      cwd: meta.cwd,
      sessionId: meta.id,
      alive,
      phase: alive ? phase : 'unknown',
      startedAt: meta.startedAt,
      lastActivityAt: f.mtimeMs,
      registered: null,
      staleRecord: !alive && phase === 'busy',
      lastKnownBusy: phase === 'busy',
      rcExpected: false,
      rcState: 'n/a',
      pendingApproval: alive ? st?.pendingApproval : undefined,
      approvalsDisabled: false,
      lastMessage: newest(st?.lastAgent, st?.lastUser),
      resume: meta.cwd ? { cwd: meta.cwd, title, command: [this.cfg.codexCommand, 'resume', meta.id] } : undefined,
      appRunning: host === 'desktop' ? appRunning : undefined,
      children: [],
    };
  }

  /** Which rollout a running `codex` process is writing. */
  private matchProcess(proc: ProcInfo, args: string[], files: RolloutFile[], claimed: Set<string>): RolloutFile | undefined {
    const sub = firstPositional(args);
    if (sub === 'resume') {
      const after = args.slice(args.indexOf('resume') + 1).find((a) => !a.startsWith('-'));
      if (after && UUID_RE.test(after)) {
        const hit = files.find((f) => f.meta?.id === after) ?? this.findById(after);
        if (hit) return hit;
      }
    }
    const cwd = normPath(proc.cwd);
    if (!cwd) return undefined;
    const since = (proc.startMs ?? 0) - 10_000;
    const resumingLast = sub === 'resume' && args.includes('--last');
    let best: RolloutFile | undefined;
    for (const f of files) {
      const m = f.meta;
      if (!m || claimed.has(m.id) || isDesktopRollout(m) || normPath(m.cwd) !== cwd) continue;
      if (f.mtimeMs < since) continue;
      if (!resumingLast && (m.startedAt ?? 0) < since) continue;
      if (!best || f.mtimeMs > best.mtimeMs) best = f;
    }
    return best;
  }

  private findById(id: string): RolloutFile | undefined {
    const root = path.join(this.cfg.paths.codexHome, 'sessions');
    for (const y of readdirSafe(root)) {
      for (const m of readdirSafe(path.join(root, y.name))) {
        for (const d of readdirSafe(path.join(root, y.name, m.name))) {
          const dir = path.join(root, y.name, m.name, d.name);
          const hit = readdirSafe(dir).find((f) => f.name.endsWith(`${id}.jsonl`));
          if (hit) {
            const file = path.join(dir, hit.name);
            return { file, mtimeMs: statSafe(file)?.mtimeMs ?? 0, meta: this.metaFor(file) };
          }
        }
      }
    }
    return undefined;
  }

  private listRollouts(now: number): RolloutFile[] {
    const root = path.join(this.cfg.paths.codexHome, 'sessions');
    const out: RolloutFile[] = [];
    const window = now - Math.max(this.cfg.recentHours, this.cfg.staleRetentionHours) * 3600_000;
    for (const y of readdirSafe(root)) {
      if (!y.isDirectory()) continue;
      for (const m of readdirSafe(path.join(root, y.name))) {
        if (!m.isDirectory()) continue;
        for (const d of readdirSafe(path.join(root, y.name, m.name))) {
          if (!d.isDirectory()) continue;
          const dir = path.join(root, y.name, m.name, d.name);
          for (const f of readdirSafe(dir)) {
            if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, f.name);
            const st = statSafe(file);
            if (!st || st.mtimeMs < window) continue;
            out.push({ file, mtimeMs: st.mtimeMs, meta: this.metaFor(file) });
          }
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private metaFor(file: string): RolloutMeta | undefined {
    if (this.metaCache.has(file)) return this.metaCache.get(file) ?? undefined;
    const first = readFirstLine(file);
    const p = first?.type === 'session_meta' ? first.payload : undefined;
    const meta: RolloutMeta | null = p?.id
      ? { id: p.id, cwd: p.cwd, originator: p.originator, source: p.source, startedAt: Date.parse(p.timestamp ?? first.timestamp) || undefined }
      : null;
    // A brand-new file may not have its first line yet; try again next time.
    if (meta) this.metaCache.set(file, meta);
    return meta ?? undefined;
  }

  private refreshNames(): void {
    const file = path.join(this.cfg.paths.codexHome, 'session_index.jsonl');
    const st = statSafe(file);
    if (!st || st.mtimeMs === this.namesMtime) return;
    this.namesMtime = st.mtimeMs;
    const names = new Map<string, string>();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.id && o.thread_name) names.set(o.id, o.thread_name);
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      return;
    }
    this.names = names;
  }
}

export function isDesktopRollout(m: RolloutMeta): boolean {
  return /desktop/i.test(m.originator ?? '') || m.source === 'vscode';
}

/** The Codex app's main window process. */
export function findCodexDesktop(snap: Snapshot): ProcInfo | undefined {
  return snap.procs.find(
    (p) => p.root && p.name.toLowerCase() === 'chatgpt.exe' && /OpenAI\.Codex/i.test(p.exe ?? '') && !/--type=/.test(p.cmd ?? ''),
  );
}

/** Interactive `codex` processes started from a terminal. */
export function cliProcesses(snap: Snapshot, desktopMain: ProcInfo | undefined): ProcInfo[] {
  return snap.procs.filter((p) => {
    if (!p.root || p.name.toLowerCase() !== 'codex.exe') return false;
    // Skip anything running under the Codex app or another codex process (sandboxes, app-server).
    for (let a = snap.byPid.get(p.ppid), hops = 0; a && hops < 20; a = snap.byPid.get(a.ppid), hops++) {
      if (a.name.toLowerCase() === 'codex.exe' || a.pid === desktopMain?.pid) return false;
    }
    const args = splitCommandLine(p.cmd ?? '').slice(1);
    if (args.some((a) => a === '--version' || a === '-V' || a === '--help' || a === '-h')) return false;
    const sub = firstPositional(args);
    return !(sub && NON_SESSION.has(sub));
  });
}

const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--remote']);

/** First argument that is neither a flag nor a flag's value. */
export function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** codex.exe processes that serve the app-server daemon (not the desktop app's own). */
export function daemonProcesses(snap: Snapshot, desktopMain: ProcInfo | undefined): ProcInfo[] {
  return snap.procs.filter((p) => {
    if (p.name.toLowerCase() !== 'codex.exe' || !/\bapp-server\b/.test(p.cmd ?? '')) return false;
    for (let a = snap.byPid.get(p.ppid), hops = 0; a && hops < 20; a = snap.byPid.get(a.ppid), hops++) {
      if (a.pid === desktopMain?.pid) return false;
    }
    return true;
  });
}
