import fs from 'node:fs';
import path from 'node:path';
import { runCli } from './launch.ts';
import type { Logger } from './log.ts';

export interface TailscaleStatus {
  installed: boolean;
  /** Logged in and connected. */
  running: boolean;
  state?: string;
  dnsName?: string;
  /** `tailscale serve` forwards HTTPS to the phone port. */
  serving: boolean;
  url?: string;
  checkedAt: number;
}

/** Finds Tailscale and whether `tailscale serve` already publishes the phone port to the tailnet. */
export class Tailscale {
  status: TailscaleStatus = { installed: false, running: false, serving: false, checkedAt: 0 };
  private exe: string | undefined;
  private checking = false;
  private readonly port: number;
  private readonly log: Logger;

  constructor(port: number, log: Logger) {
    this.port = port;
    this.log = log;
  }

  async refresh(force = false): Promise<TailscaleStatus> {
    if (this.checking || (!force && Date.now() - this.status.checkedAt < 60000)) return this.status;
    this.checking = true;
    try {
      this.status = await this.check();
    } finally {
      this.checking = false;
    }
    return this.status;
  }

  /** Publishes the phone port as https://<pc>.<tailnet>.ts.net (tailnet only, not the internet). */
  async enableServe(): Promise<{ ok: boolean; message: string }> {
    const exe = this.findExe();
    if (!exe) return { ok: false, message: 'Tailscale is not installed on this PC.' };
    const r = await runCli(exe, ['serve', '--bg', '--https=443', `http://127.0.0.1:${this.port}`], 60000);
    const out = (r.stdout + '\n' + r.stderr).trim();
    this.log.info('tailscale serve:', out);
    await this.refresh(true);
    if (this.status.serving) return { ok: true, message: `Phone address: ${this.status.url}` };
    return { ok: false, message: out || r.error || 'tailscale serve failed' };
  }

  private findExe(): string | undefined {
    if (this.exe && fs.existsSync(this.exe)) return this.exe;
    const candidates = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
      ...(process.env.PATH ?? '').split(';').filter(Boolean).map((d) => path.join(d, 'tailscale.exe')),
    ];
    this.exe = candidates.find((c) => fs.existsSync(c));
    return this.exe;
  }

  private async check(): Promise<TailscaleStatus> {
    const now = Date.now();
    const exe = this.findExe();
    if (!exe) return { installed: false, running: false, serving: false, checkedAt: now };
    const st = await runCli(exe, ['status', '--json'], 15000);
    let state: string | undefined;
    let dnsName: string | undefined;
    try {
      const j = JSON.parse(st.stdout);
      state = j.BackendState;
      dnsName = typeof j.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : undefined;
    } catch {
      state = st.stdout.trim().split('\n')[0] || st.error;
    }
    const running = state === 'Running';
    let serving = false;
    if (running) {
      const sv = await runCli(exe, ['serve', 'status', '--json'], 15000);
      const text = sv.stdout.replace(/\s/g, '');
      serving = text.includes(`127.0.0.1:${this.port}`) || text.includes(`localhost:${this.port}`);
    }
    return {
      installed: true,
      running,
      state,
      dnsName,
      serving,
      url: serving && dnsName ? `https://${dnsName}` : undefined,
      checkedAt: now,
    };
  }
}
