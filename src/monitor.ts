import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { deriveHealth, healthRank } from './health.ts';
import type { Logger } from './log.ts';
import type { ProcHelper, ProcInfo, Snapshot } from './proc/helper.ts';
import { ClaudeSource } from './sources/claude.ts';
import { CodexSource, daemonProcesses, findCodexDesktop } from './sources/codex.ts';
import type { Store } from './store.ts';
import type { AppStatus, Health, SessionAction, SessionFacts, SessionView } from './types.ts';
import { baseName } from './util.ts';

export interface Transition {
  key: string;
  from: Health | undefined;
  to: Health;
  view: SessionView;
  previous?: SessionView;
}

interface Tracked {
  view: SessionView;
  facts: SessionFacts;
  /** For sessions that vanished: when to stop showing them. */
  expiresAt?: number;
}

interface CpuSample {
  pid: number;
  self: number;
  kids: number;
  at: number;
  activeAt?: number;
}

/** Rates of CPU use that count as "doing something", as a fraction of one core. */
const SELF_ACTIVE_RATE = 0.25;
const CHILD_ACTIVE_RATE = 0.03;

export class Monitor extends EventEmitter {
  sessions: SessionView[] = [];
  apps: AppStatus[] = [];
  lastWakeAt?: number;
  appIds: { claude?: string; codex?: string } = {};
  private tracked = new Map<string, Tracked>();
  private cpu = new Map<string, CpuSample>();
  private claude: ClaudeSource;
  private codex: CodexSource;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private stopped = false;
  private lastTickAt = 0;
  private watchers: fs.FSWatcher[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private desktop: { claude?: ProcInfo; codex?: ProcInfo } = {};
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly helper: ProcHelper;
  private readonly log: Logger;

  constructor(cfg: Config, store: Store, helper: ProcHelper, log: Logger) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.helper = helper;
    this.log = log;
    this.claude = new ClaudeSource(cfg);
    this.codex = new CodexSource(cfg);
  }

  start(): void {
    this.watch(path.join(this.cfg.paths.claudeHome, 'sessions'));
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
  }

  /** Latest facts for a session (what actions need). */
  facts(key: string): SessionFacts | undefined {
    return this.tracked.get(key)?.facts;
  }

  view(key: string): SessionView | undefined {
    return this.tracked.get(key)?.view;
  }

  desktopProcess(app: 'claude' | 'codex'): ProcInfo | undefined {
    return this.desktop[app];
  }

  /** Ask the Codex daemon for its status again on the next scan. */
  recheckDaemon(): void {
    this.codex.daemon.checkedAt = 0;
    this.refreshSoon(3000);
  }

  /** Re-scan soon (after an action, or when a session file changes). */
  refreshSoon(delayMs = 400): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), delayMs);
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.tick();
    } catch (e) {
      this.log.error('monitor tick failed:', e);
    } finally {
      this.running = false;
      if (!this.stopped) {
        if (this.again) {
          this.again = false;
          setImmediate(() => void this.refresh());
        } else {
          this.timer = setTimeout(() => void this.refresh(), this.cfg.pollIntervalMs);
        }
      }
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (this.lastTickAt && now - this.lastTickAt > this.cfg.pollIntervalMs * 3 + 30000) {
      this.lastWakeAt = now;
      this.emit('wake', now - this.lastTickAt);
    }
    this.lastTickAt = now;

    const snap = await this.helper.snapshot();
    this.desktop.claude = findClaudeDesktop(snap);
    this.desktop.codex = findCodexDesktop(snap);
    this.codex.refreshDaemon(now);

    const facts = [
      ...this.claude.collect(snap, now, this.desktop.claude?.pid),
      ...this.codex.collect(snap, now, this.desktop.codex),
    ];
    for (const f of facts) {
      if (f.host === 'desktop' && f.appRunning === undefined) f.appRunning = !!(f.tool === 'claude' ? this.desktop.claude : this.desktop.codex);
    }
    this.apps = this.appStatuses(snap);

    const settings = this.store.data.settings;
    const ctxBase = { now, stuckMs: settings.stuckMinutes * 60000, approvalMs: this.cfg.approvalSeconds * 1000 };
    const next = new Map<string, Tracked>();
    const transitions: Transition[] = [];

    for (const f of facts) {
      const prev = this.tracked.get(f.key);
      const cpuActiveAt = this.trackCpu(f, now);
      const h = deriveHealth(f, { ...ctxBase, cpuActiveAt });
      const view: SessionView = {
        key: f.key,
        tool: f.tool,
        host: f.host,
        title: f.title,
        folder: baseName(f.cwd),
        cwd: f.cwd,
        pid: f.pid,
        sessionId: f.sessionId,
        alive: f.alive,
        busy: f.alive && f.phase === 'busy',
        health: h.health,
        detail: h.detail,
        activity: h.activity,
        activityDetail: h.activityDetail,
        healthSince: prev && prev.view.health === h.health ? prev.view.healthSince : now,
        notify: h.notify,
        startedAt: f.startedAt,
        lastActivityAt: f.lastActivityAt,
        rc: { expected: f.rcExpected, state: f.rcState, url: f.rcUrl },
        lastMessage: f.lastMessage,
        pendingTool: f.pendingTool,
        running: runningSummary(f),
        actions: actionsFor(f, this.appIds),
      };
      next.set(f.key, { view, facts: f });
      if (!prev || prev.view.health !== view.health) transitions.push({ key: f.key, from: prev?.view.health, to: view.health, view, previous: prev?.view });
    }

    // Sessions that disappeared since the last scan closed normally (their records are gone too).
    const keepUntil = now + this.cfg.endedRetentionMinutes * 60000;
    for (const [key, t] of this.tracked) {
      if (next.has(key)) continue;
      if (t.expiresAt !== undefined) {
        if (t.expiresAt > now) next.set(key, t);
        continue;
      }
      const facts: SessionFacts = { ...t.facts, alive: false, staleRecord: false, phase: 'unknown', children: [] };
      const view: SessionView = {
        ...t.view,
        alive: false,
        busy: false,
        health: 'ended',
        detail: 'Closed',
        activity: 'ended',
        activityDetail: 'Closed',
        healthSince: now,
        notify: false,
        running: [],
        actions: actionsFor(facts, this.appIds),
      };
      next.set(key, { view, facts, expiresAt: keepUntil });
      transitions.push({ key, from: t.view.health, to: 'ended', view, previous: t.view });
    }

    // Dismissed sessions stay hidden until they come back to life.
    const dismissed = this.store.data.dismissed;
    for (const [key, t] of next) {
      if (dismissed[key] === undefined) continue;
      if (t.view.alive) {
        delete dismissed[key];
        this.store.save();
      } else {
        next.delete(key);
      }
    }
    for (const key of Object.keys(dismissed)) {
      if (now - dismissed[key] > 7 * 86400_000) {
        delete dismissed[key];
        this.store.save();
      }
    }

    for (const key of this.cpu.keys()) if (!next.has(key)) this.cpu.delete(key);
    this.tracked = next;
    this.sessions = [...next.values()].map((t) => t.view).sort(compareViews);
    for (const t of transitions) this.emit('transition', t);
    this.emit('update', this.sessions);
  }

  /** Remembers CPU totals between scans; returns when the session last did real work. */
  private trackCpu(f: SessionFacts, now: number): number | undefined {
    if (!f.alive || f.pid === undefined) return undefined;
    const self = f.selfCpuMs ?? 0;
    const kids = f.children.reduce((sum, c) => sum + (c.cpuMs ?? 0), 0);
    const prev = this.cpu.get(f.key);
    const sample: CpuSample = { pid: f.pid, self, kids, at: now, activeAt: prev?.pid === f.pid ? prev.activeAt : undefined };
    if (prev && prev.pid === f.pid && now > prev.at) {
      const span = now - prev.at;
      const selfRate = Math.max(0, self - prev.self) / span;
      const kidRate = Math.max(0, kids - prev.kids) / span;
      if (selfRate >= SELF_ACTIVE_RATE || kidRate >= CHILD_ACTIVE_RATE) sample.activeAt = now;
    }
    this.cpu.set(f.key, sample);
    return sample.activeAt;
  }

  private appStatuses(snap: Snapshot): AppStatus[] {
    const daemon = this.codex.daemon;
    const daemonProcs = daemonProcesses(snap, this.desktop.codex);
    const daemonRunning = daemon.running || (daemon.checkedAt === 0 && daemonProcs.length > 0);
    return [
      {
        id: 'claude-desktop',
        name: 'Claude app',
        installed: !!this.appIds.claude,
        running: !!this.desktop.claude,
        pid: this.desktop.claude?.pid,
        actions: this.desktop.claude ? ['restart', 'stop'] : this.appIds.claude ? ['start'] : [],
      },
      {
        id: 'codex-desktop',
        name: 'Codex app',
        installed: !!this.appIds.codex,
        running: !!this.desktop.codex,
        pid: this.desktop.codex?.pid,
        actions: this.desktop.codex ? ['restart', 'stop'] : this.appIds.codex ? ['start'] : [],
      },
      {
        id: 'codex-daemon',
        name: 'Codex remote control',
        installed: true,
        running: daemonRunning,
        pid: daemonProcs[0]?.pid,
        detail: daemon.detail,
        actions: daemonRunning ? ['restart', 'stop'] : ['start'],
      },
    ];
  }

  private watch(dir: string): void {
    try {
      this.watchers.push(fs.watch(dir, () => this.refreshSoon()));
    } catch (e) {
      this.log.warn('cannot watch', dir, (e as Error).message);
    }
  }
}

export function findClaudeDesktop(snap: Snapshot): ProcInfo | undefined {
  return snap.procs.find(
    (p) => p.root && p.name.toLowerCase() === 'claude.exe' && /\\WindowsApps\\Claude_/i.test(p.exe ?? '') && !/--type=/.test(p.cmd ?? ''),
  );
}

export function actionsFor(f: SessionFacts, appIds: { claude?: string; codex?: string }): SessionAction[] {
  const out: SessionAction[] = [];
  const appId = f.tool === 'claude' ? appIds.claude : appIds.codex;
  if (f.alive) {
    if (f.tool === 'claude' || f.host === 'cli') {
      if (f.resume) out.push('reconnect');
    } else if (f.resume) {
      out.push('open-terminal');
    }
    if (f.host === 'desktop') {
      if (appId) out.push('restart-app');
    } else {
      out.push('stop');
    }
  } else {
    if (f.resume) out.push('resume');
    if (f.host === 'desktop' && appId && f.appRunning === false) out.push('start-app');
    out.push('dismiss');
  }
  return out;
}

function runningSummary(f: SessionFacts): string[] {
  if (!f.pendingTool) return [];
  const since = f.pendingTool.at - 3000;
  return f.children
    .filter((c) => (c.startMs ?? 0) >= since)
    .slice(0, 4)
    .map((c) => c.name);
}

function compareViews(a: SessionView, b: SessionView): number {
  const r = healthRank(a.health) - healthRank(b.health);
  if (r !== 0) return r;
  return (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0);
}
