import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { deriveHealth, healthRank } from './health.ts';
import type { Logger } from './log.ts';
import type { ProcHelper, ProcInfo, Snapshot } from './proc/helper.ts';
import { ClaudeSource } from './sources/claude.ts';
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

export class Monitor extends EventEmitter {
  sessions: SessionView[] = [];
  apps: AppStatus[] = [];
  lastWakeAt?: number;
  /** AppUserModelID of the Claude app, when it is installed. */
  appId: string | undefined;
  private tracked = new Map<string, Tracked>();
  private claude: ClaudeSource;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private stopped = false;
  private lastTickAt = 0;
  private watchers: fs.FSWatcher[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private app: ProcInfo | undefined;
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
    this.claude = new ClaudeSource(cfg, store.data.superseded, () => store.save());
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

  /** The Claude app's main process, when it is running. */
  appProcess(): ProcInfo | undefined {
    return this.app;
  }

  /** Remember that the session's process is being closed on purpose (kept until it runs again). */
  markStopped(key: string): void {
    this.store.data.stopped[key] = Date.now();
    this.store.save();
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
    this.app = findClaudeApp(snap);
    const facts = this.claude.collect(snap, now, this.app?.pid);
    for (const f of facts) if (f.host === 'desktop') f.appRunning = !!this.app;
    this.apps = [
      {
        id: 'claude-desktop',
        name: 'Claude app',
        installed: !!this.appId,
        running: !!this.app,
        pid: this.app?.pid,
        actions: this.app ? ['restart'] : this.appId ? ['start'] : [],
      },
    ];

    const next = new Map<string, Tracked>();
    const transitions: Transition[] = [];
    const liveProcs = new Set<string>();

    const stopped = this.store.data.stopped;
    for (const [key, at] of Object.entries(stopped)) {
      if (now - at > this.cfg.staleRetentionHours * 3600_000) {
        delete stopped[key];
        this.store.save();
      }
    }
    for (const f of facts) {
      const prev = this.tracked.get(f.key);
      const stoppedAt = stopped[f.key];
      if (f.alive) {
        if (f.pid !== undefined) liveProcs.add(`${f.pid}:${f.procStartMs}`);
        // Running again in a process started after the stop: forget it.
        if (stoppedAt !== undefined && (f.procStartMs ?? 0) > stoppedAt) {
          delete stopped[f.key];
          this.store.save();
        }
      } else if (stoppedAt !== undefined) {
        f.stoppedByUser = true;
      }
      const h = deriveHealth(f, now);
      const view: SessionView = {
        key: f.key,
        host: f.host,
        title: f.title,
        folder: baseName(f.cwd),
        cwd: f.cwd,
        pid: f.pid,
        sessionId: f.sessionId,
        alive: f.alive,
        busy: f.alive && f.phase === 'busy',
        idle: f.alive && f.phase === 'idle',
        health: h.health,
        detail: h.detail,
        healthSince: prev && prev.view.health === h.health ? prev.view.healthSince : now,
        notify: h.notify,
        startedAt: f.startedAt,
        lastActivityAt: f.lastActivityAt,
        rc: { expected: f.rcExpected, state: f.rcState, url: f.rcUrl },
        actions: actionsFor(f, this.appId),
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
      // Same process, new key (Claude registered it, or its transcript appeared): not a closed session.
      if (t.facts.alive && t.facts.pid !== undefined && liveProcs.has(`${t.facts.pid}:${t.facts.procStartMs}`)) continue;
      const facts: SessionFacts = { ...t.facts, alive: false, staleRecord: false, phase: 'unknown' };
      const view: SessionView = {
        ...t.view,
        alive: false,
        busy: false,
        idle: false,
        health: 'ended',
        detail: 'Closed',
        healthSince: now,
        notify: false,
        actions: actionsFor(facts, this.appId),
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

    this.tracked = next;
    this.sessions = [...next.values()].map((t) => t.view).sort(compareViews);
    for (const t of transitions) this.emit('transition', t);
    this.emit('update', this.sessions);
  }

  private watch(dir: string): void {
    try {
      this.watchers.push(fs.watch(dir, () => this.refreshSoon()));
    } catch (e) {
      this.log.warn('cannot watch', dir, (e as Error).message);
    }
  }
}

/** The Claude app's main window process (its other processes run with --type=...). */
export function findClaudeApp(snap: Snapshot): ProcInfo | undefined {
  return snap.procs.find((p) => p.name.toLowerCase() === 'claude.exe' && /\\WindowsApps\\Claude_/i.test(p.exe ?? '') && !/--type=/.test(p.cmd ?? ''));
}

export function actionsFor(f: SessionFacts, appId: string | undefined): SessionAction[] {
  const out: SessionAction[] = [];
  // The Claude app reopens a session's process by itself when it closes, and its scratch folders exist only
  // inside the app's own view of the disk. A terminal copy would run the conversation twice, so app sessions
  // are fixed by restarting the app instead.
  if (f.host === 'cli') {
    if (f.resume) out.push(f.alive ? 'reconnect' : 'resume');
  } else if (appId) {
    if (f.alive) out.push('restart-app');
    else if (f.appRunning === false) out.push('start-app');
  }
  if (!f.alive) out.push('dismiss');
  return out;
}

function compareViews(a: SessionView, b: SessionView): number {
  const r = healthRank(a.health) - healthRank(b.health);
  if (r !== 0) return r;
  return (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0);
}
