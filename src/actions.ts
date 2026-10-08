import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Config } from './config.ts';
import { describeLaunch, isAlive, killTree, launchInTerminal, launchPackagedApp } from './launch.ts';
import type { Logger } from './log.ts';
import type { Monitor } from './monitor.ts';
import type { Store } from './store.ts';
import type { ActionLogEntry, AppAction, AppId, SessionAction, SessionFacts } from './types.ts';
import { sleep } from './util.ts';

export interface ActionRequest {
  /** The user confirmed a warning (e.g. "it's still working"). */
  force?: boolean;
  dryRun?: boolean;
  /** Who asked: a device name, "PC", "auto". */
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

export class Actions extends EventEmitter {
  history: ActionLogEntry[] = [];
  private readonly inFlight = new Set<string>();
  private readonly cfg: Config;
  private readonly monitor: Monitor;
  private readonly store: Store;
  private readonly log: Logger;

  constructor(cfg: Config, monitor: Monitor, store: Store, log: Logger) {
    super();
    this.cfg = cfg;
    this.monitor = monitor;
    this.store = store;
    this.log = log;
  }

  async session(key: string, action: SessionAction, req: ActionRequest): Promise<ActionResult> {
    const f = this.monitor.facts(key);
    const v = this.monitor.view(key);
    if (!f || !v) return { ok: false, message: 'That session is no longer listed.' };
    if (!v.actions.includes(action)) return { ok: false, message: `"${action}" is not available for this session right now.` };
    const label = `${action} · ${v.title}`;

    switch (action) {
      case 'dismiss':
        this.store.data.dismissed[key] = Date.now();
        this.store.save();
        this.monitor.refreshSoon(0);
        return { ok: true, message: 'Hidden from the list.' };
      case 'restart-app':
        return this.app(f.tool === 'claude' ? 'claude-desktop' : 'codex-desktop', 'restart', req);
      case 'start-app':
        return this.app(f.tool === 'claude' ? 'claude-desktop' : 'codex-desktop', 'start', req);
    }

    const steps: Step[] = [];
    const resume = f.resume;
    if (action === 'stop') {
      if (f.alive && f.phase === 'busy' && !req.force) return confirm('It is still working. Stop it anyway? The conversation is kept.');
      steps.push(this.killStep(f));
    } else {
      if (!resume) return { ok: false, message: "I don't know which folder this session ran in, so I can't reopen it." };
      // Check before closing anything: a reconnect that cannot reopen would just end the session.
      if (!fs.existsSync(resume.cwd)) return { ok: false, message: `Can't reopen it: the folder ${resume.cwd} is not reachable. Nothing was closed.` };
      if (action === 'reconnect') {
        if (f.alive && f.phase === 'busy' && !req.force) {
          return confirm('It is still working. Reconnecting stops the current step (the conversation is kept). Continue?');
        }
        if (f.alive) steps.push(this.killStep(f));
      } else if (action === 'resume' && f.alive) {
        return { ok: false, message: 'It is still running. Use Reconnect instead.' };
      }
      steps.push({ describe: `Open Windows Terminal. ${describeLaunch(resume)}`, run: () => launchInTerminal(resume, this.log) });
    }

    const done =
      action === 'stop'
        ? 'Stopped.'
        : f.tool === 'claude'
          ? 'Reopened in Windows Terminal with Remote Control on. It appears here in a few seconds.'
          : 'Reopened in Windows Terminal.';
    return this.execute(key, label, steps, done, req);
  }

  async app(id: AppId, action: AppAction, req: ActionRequest): Promise<ActionResult> {
    const label = `${action} · ${id}`;
    if (id === 'codex-daemon') return this.daemon(action, req, label);

    const which = id === 'claude-desktop' ? 'claude' : 'codex';
    const aumid = this.monitor.appIds[which];
    const proc = this.monitor.desktopProcess(which);
    const name = which === 'claude' ? 'Claude app' : 'Codex app';
    const steps: Step[] = [];

    if (action === 'stop' || action === 'restart') {
      if (!proc) {
        if (action === 'stop') return { ok: false, message: `The ${name} is not running.` };
      } else {
        const busy = this.monitor.sessions.filter((s) => s.tool === which && s.host === 'desktop' && s.busy).length;
        if (busy > 0 && !req.force) {
          return confirm(`${busy} ${name} session${busy > 1 ? 's are' : ' is'} still working. ${action === 'stop' ? 'Close' : 'Restart'} the app anyway?`);
        }
        steps.push({
          describe: `Close the ${name} (process ${proc.pid} and its children)`,
          run: async () => {
            if (!(await killTree(proc.pid, 20000))) throw new Error(`The ${name} did not close.`);
            await sleep(1500);
          },
        });
      }
    }
    if (action === 'start' || action === 'restart') {
      if (!aumid) return { ok: false, message: `The ${name} is not installed.` };
      if (action === 'start' && proc) return { ok: false, message: `The ${name} is already running.` };
      steps.push({ describe: `Start the ${name} (${aumid})`, run: () => launchPackagedApp(aumid) });
    }
    const done = action === 'stop' ? `Closed the ${name}.` : action === 'start' ? `Started the ${name}.` : `Restarted the ${name}.`;
    return this.execute(id, label, steps, done, req);
  }

  private async daemon(action: AppAction, req: ActionRequest, label: string): Promise<ActionResult> {
    const codex = this.cfg.codexCommand;
    const steps: Step[] = [];
    const run = (args: string[], waitMs: number) => ({
      describe: `Run: codex ${args.join(' ')}`,
      run: async () => {
        const r = await runDetached(codex, args, waitMs);
        if (r.exited && r.code !== 0) throw new Error(errorLine(r.output) || `codex ${args.join(' ')} failed (${r.code})`);
      },
    });
    if (action === 'start') steps.push(run(['remote-control', 'start'], 30000));
    else if (action === 'stop') steps.push(run(['app-server', 'daemon', 'stop'], 30000));
    else steps.push(run(['app-server', 'daemon', 'restart'], 45000));
    const done = action === 'stop' ? 'Stopped the Codex daemon.' : action === 'start' ? 'Started Codex remote control.' : 'Restarted the Codex daemon.';
    const result = await this.execute('codex-daemon', label, steps, done, req);
    this.monitor.recheckDaemon();
    return result;
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

/** The line that explains a failed command: its first "Error..." line, else its last line (not a progress line). */
export function errorLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1] ?? '';
}

/**
 * Runs a CLI command but never kills it: some `codex` commands keep running as the daemon.
 * Resolves when it exits or after waitMs, whichever comes first.
 */
function runDetached(file: string, args: string[], waitMs: number): Promise<{ exited: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(file, args, { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.unref();
      resolve({ exited, code, output });
    };
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.once('error', (e) => {
      output += e.message;
      finish(true, -1);
    });
    child.once('exit', (code) => finish(true, code));
    setTimeout(() => finish(false, null), waitMs).unref();
  });
}
