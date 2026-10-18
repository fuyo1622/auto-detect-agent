import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Config } from './config.ts';
import { describeLaunch, isAlive, killTree, launchInTerminal, launchPackagedApp } from './launch.ts';
import type { Logger } from './log.ts';
import type { Monitor } from './monitor.ts';
import type { Store } from './store.ts';
import type { ActionLogEntry, AppAction, AppId, ResumeSpec, SessionAction, SessionFacts } from './types.ts';
import { sleep } from './util.ts';

export interface ActionRequest {
  /** The user confirmed a warning (e.g. "it's still working"). */
  force?: boolean;
  dryRun?: boolean;
  /** Who asked: a device name, "PC", "auto-reconnect". */
  by: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Not done: the phone should ask "are you sure?" and retry with force. */
  needsConfirm?: boolean;
  /** Steps the action takes (always filled for dry runs). */
  plan?: string[];
}

type Step = { describe: string; run: () => Promise<void> };

/** How sessions and the app are opened (tests replace this so no windows open). */
export interface Launcher {
  inTerminal: (spec: ResumeSpec, log: Logger) => Promise<void>;
  packagedApp: (aumid: string) => Promise<void>;
}

const REAL_LAUNCHER: Launcher = { inTerminal: launchInTerminal, packagedApp: launchPackagedApp };

export class Actions extends EventEmitter {
  history: ActionLogEntry[] = [];
  private readonly inFlight = new Set<string>();
  private readonly cfg: Config;
  private readonly monitor: Monitor;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly launch: Launcher;

  constructor(cfg: Config, monitor: Monitor, store: Store, log: Logger, launch: Launcher = REAL_LAUNCHER) {
    super();
    this.cfg = cfg;
    this.monitor = monitor;
    this.store = store;
    this.log = log;
    this.launch = launch;
  }

  async session(key: string, action: SessionAction, req: ActionRequest): Promise<ActionResult> {
    const f = this.monitor.facts(key);
    const v = this.monitor.view(key);
    if (!f || !v) return { ok: false, message: 'That session is no longer listed.' };
    if (!v.actions.includes(action)) return { ok: false, message: `"${action}" is not available for this session right now.` };

    switch (action) {
      case 'dismiss':
        this.store.data.dismissed[key] = Date.now();
        this.store.save();
        this.monitor.refreshSoon(0);
        return { ok: true, message: 'Hidden from the list.' };
      case 'restart-app':
        return this.app('claude-desktop', 'restart', req);
      case 'start-app':
        return this.app('claude-desktop', 'start', req);
    }

    const resume = f.resume;
    if (!resume) return { ok: false, message: "I don't know which folder this session ran in, so I can't reopen it." };
    // Check before closing anything: a reconnect that cannot reopen would just end the session.
    if (!fs.existsSync(resume.cwd)) return { ok: false, message: `Can't reopen it: the folder ${resume.cwd} is not reachable. Nothing was closed.` };
    const steps: Step[] = [];
    if (action === 'reconnect') {
      if (f.alive && f.phase === 'busy' && !req.force) {
        return confirm('It is still working. Reconnecting stops the current step (the conversation is kept). Continue?');
      }
      if (f.alive) steps.push(this.killStep(f));
    } else if (f.alive) {
      return { ok: false, message: 'It is still running. Use Reconnect instead.' };
    }
    steps.push({ describe: `Open Windows Terminal. ${describeLaunch(resume)}`, run: () => this.launch.inTerminal(resume, this.log) });
    const done = 'Reopened in Windows Terminal with Remote Control on. It appears here in a few seconds.';
    return this.execute(key, `${action} · ${v.title}`, steps, done, req);
  }

  async app(id: AppId, action: AppAction, req: ActionRequest): Promise<ActionResult> {
    const aumid = this.monitor.appId;
    const proc = this.monitor.appProcess();
    const steps: Step[] = [];
    if (!aumid) return { ok: false, message: 'The Claude app is not installed.' };
    if (action === 'start' && proc) return { ok: false, message: 'The Claude app is already running.' };

    if (action === 'restart' && proc) {
      const busy = this.monitor.sessions.filter((s) => s.host === 'desktop' && s.busy).length;
      if (busy > 0 && !req.force) {
        return confirm(`${busy} Claude app session${busy > 1 ? 's are' : ' is'} still working. Restart the app anyway?`);
      }
      steps.push({
        describe: `Close the Claude app (process ${proc.pid} and its children)`,
        run: async () => {
          // Its sessions close on purpose: show them as "Stopped", not as crashes, until they run again.
          for (const s of this.monitor.sessions) if (s.host === 'desktop' && s.alive) this.monitor.markStopped(s.key);
          if (!(await killTree(proc.pid, 20000))) throw new Error('The Claude app did not close.');
          await sleep(1500);
        },
      });
    }
    steps.push({ describe: `Start the Claude app (${aumid})`, run: () => this.launch.packagedApp(aumid) });
    const done = action === 'start' ? 'Started the Claude app.' : 'Restarted the Claude app.';
    return this.execute(id, `${action} · ${id}`, steps, done, req);
  }

  private killStep(f: SessionFacts): Step {
    const pid = f.pid!;
    return {
      describe: `Close process ${pid} and anything it started`,
      run: async () => {
        this.monitor.markStopped(f.key); // closed on purpose: show "Stopped", not a crash
        if (!isAlive(pid)) return;
        if (!(await killTree(pid))) throw new Error(`Process ${pid} did not close.`);
      },
    };
  }

  private async execute(key: string, label: string, steps: Step[], done: string, req: ActionRequest): Promise<ActionResult> {
    const plan = steps.map((s) => s.describe);
    if (req.dryRun || this.cfg.dryRun) return { ok: true, message: `Dry run, nothing was changed. ${done}`, plan };
    if (this.inFlight.has(key)) return { ok: false, message: 'Already on it. Give it a few seconds.' };
    this.inFlight.add(key);
    let result: ActionResult;
    try {
      for (const s of steps) {
        this.log.info(`[${req.by}] ${label}: ${s.describe}`);
        await s.run();
      }
      result = { ok: true, message: done, plan };
    } catch (e) {
      result = { ok: false, message: (e as Error).message, plan };
      this.log.warn(`[${req.by}] ${label} failed:`, (e as Error).message);
    } finally {
      this.inFlight.delete(key);
    }
    this.history.unshift({ at: Date.now(), target: key, action: label, ok: result.ok, message: result.message, by: req.by });
    this.history.length = Math.min(this.history.length, 30);
    this.emit('done', result);
    this.monitor.refreshSoon(1500);
    return result;
  }
}

function confirm(message: string): ActionResult {
  return { ok: false, needsConfirm: true, message };
}
