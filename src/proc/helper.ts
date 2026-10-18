import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from '../log.ts';
import { fileTimeToMs } from '../util.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  startMs?: number;
  /** Raw FILETIME string, comparable with Claude's `procStart`. */
  startFt?: string;
  cmd?: string;
  exe?: string;
  cwd?: string;
}

export interface Snapshot {
  at: number;
  procs: ProcInfo[];
  byPid: Map<number, ProcInfo>;
}

export const WATCHED_IMAGES = ['claude.exe'];

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to proc-helper.exe (compiled from helper/ProcHelper.cs on first use; built into AgentMonitor.exe).
 * Falls back to a PowerShell CIM query when the helper can't be built or keeps dying.
 */
export class ProcHelper {
  mode: 'ok' | 'fallback' | 'down' = 'down';
  private child: ChildProcess | undefined;
  private queue: Pending[] = [];
  private restarts = 0;
  private readonly log: Logger;
  private readonly exe: string;
  private readonly source: string;
  private awakeWanted = false;

  constructor(opts: { exe: string; source: string; log: Logger }) {
    this.exe = opts.exe;
    this.source = opts.source;
    this.log = opts.log;
  }

  async start(): Promise<void> {
    try {
      await this.ensureBuilt();
      await this.spawnChild();
      this.mode = 'ok';
    } catch (e) {
      this.log.warn('proc-helper unavailable, using PowerShell fallback:', (e as Error).message);
      this.mode = 'fallback';
    }
  }

  stop(): void {
    const c = this.child;
    this.child = undefined;
    if (c && !c.killed) {
      try {
        c.stdin?.end('exit\n');
      } catch {
        /* already gone */
      }
      setTimeout(() => c.kill(), 1000).unref();
    }
  }

  async snapshot(images = WATCHED_IMAGES): Promise<Snapshot> {
    if (this.mode === 'ok') {
      try {
        const r = await this.request(`snap ${images.join(',')}`, 15000);
        if (!r.ok) throw new Error(r.error ?? 'snapshot failed');
        return buildSnapshot(r.now, r.procs);
      } catch (e) {
        this.log.warn('proc-helper snapshot failed:', (e as Error).message);
        await this.recover();
        if (this.mode === 'ok') {
          const r = await this.request(`snap ${images.join(',')}`, 15000);
          if (r.ok) return buildSnapshot(r.now, r.procs);
        }
      }
    }
    return fallbackSnapshot(images);
  }

  /** Keep the PC from idle-sleeping. Only the helper can hold this state. */
  async setAwake(on: boolean): Promise<boolean> {
    this.awakeWanted = on;
    if (this.mode !== 'ok') return false;
    try {
      const r = await this.request(`awake ${on ? 1 : 0}`, 5000);
      return !!r.ok;
    } catch {
      return false;
    }
  }

  private async ensureBuilt(): Promise<void> {
    if (!this.source) {
      if (!fs.existsSync(this.exe)) throw new Error(`${this.exe} is missing`);
      return; // packaged: the helper comes prebuilt
    }
    const src = fs.statSync(this.source);
    const out = fs.existsSync(this.exe) ? fs.statSync(this.exe) : undefined;
    if (out && out.mtimeMs >= src.mtimeMs) return;
    const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`);
    fs.mkdirSync(path.dirname(this.exe), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        csc,
        ['-nologo', '-optimize+', '-target:exe', '-platform:x64', `-out:${this.exe}`, this.source],
        { windowsHide: true, timeout: 60000 },
        (err, stdout) => (err ? reject(new Error(`csc failed: ${stdout || err.message}`)) : resolve()),
      );
    });
    this.log.info('built', this.exe);
  }

  private spawnChild(): Promise<void> {
    const child = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const p = this.queue.shift();
      if (!p) return;
      clearTimeout(p.timer);
      try {
        p.resolve(JSON.parse(line));
      } catch (e) {
        p.reject(e as Error);
      }
    });
    child.stderr?.on('data', (d) => this.log.warn('proc-helper:', String(d).trim()));
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      for (const p of this.queue.splice(0)) {
        clearTimeout(p.timer);
        p.reject(new Error(`proc-helper exited (${code})`));
      }
    });
    return this.request('ping', 10000).then((r) => {
      if (!r.ok) throw new Error('proc-helper ping failed');
    });
  }

  private request(cmd: string, timeoutMs: number): Promise<any> {
    const child = this.child;
    if (!child || !child.stdin || child.exitCode !== null) return Promise.reject(new Error('proc-helper not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((p) => p.timer === timer);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(`proc-helper timeout: ${cmd.split(' ')[0]}`));
        child.kill();
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
      child.stdin!.write(cmd + '\n');
    });
  }

  private async recover(): Promise<void> {
    this.stop();
    if (++this.restarts > 5) {
      this.mode = 'fallback';
      return;
    }
    try {
      await this.spawnChild();
      this.mode = 'ok';
      if (this.awakeWanted) await this.setAwake(true);
    } catch {
      this.mode = 'fallback';
    }
  }
}

export function buildSnapshot(at: number, raw: any[]): Snapshot {
  const procs: ProcInfo[] = raw.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    name: p.name,
    startFt: p.startFt,
    startMs: fileTimeToMs(p.startFt),
    cmd: p.cmd,
    exe: p.exe,
    cwd: p.cwd,
  }));
  return { at, procs, byPid: new Map(procs.map((p) => [p.pid, p])) };
}

/** Slow path: one CIM query through PowerShell (~1 s). No working directories. */
async function fallbackSnapshot(images: string[]): Promise<Snapshot> {
  const filter = images.map((i) => `Name='${i.replace(/'/g, '')}'`).join(' OR ');
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
    `@(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{` +
    'pid=$_.ProcessId;ppid=$_.ParentProcessId;name=$_.Name;exe=$_.ExecutablePath;cmd=$_.CommandLine;' +
    'startFt=$(if($_.CreationDate){$_.CreationDate.ToFileTimeUtc().ToString()}else{$null})} }) | ConvertTo-Json -Compress';
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  const all: any[] = [].concat(JSON.parse(out.trim() || '[]'));
  return buildSnapshot(Date.now(), all);
}
