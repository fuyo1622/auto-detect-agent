import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './util.ts';
import type { Settings } from './types.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  /** Port the phone reaches (through `tailscale serve`). Needs a paired-device token. */
  phonePort: number;
  /** Port for this PC only: dashboard, pairing, tray. Never expose it. */
  adminPort: number;
  /** Where the phone port listens. Keep 127.0.0.1 when using `tailscale serve`. */
  listenHost: string;
  pollIntervalMs: number;
  /** A pending tool with no process behind it for this long counts as "needs approval". */
  approvalSeconds: number;
  /** A problem must last this long before a push notification goes out. */
  alertDelaySeconds: number;
  /** Codex threads updated within this window are listed. */
  recentHours: number;
  /** Sessions whose process vanished without cleanup are listed this long. */
  staleRetentionHours: number;
  /** Sessions that closed normally stay visible this long. */
  endedRetentionMinutes: number;
  /** Used when the original Claude executable no longer exists. */
  claudeCommand: string;
  codexCommand: string;
  tray: boolean;
  /** Phone URL, e.g. https://my-pc.tailnet.ts.net. Empty = detect from Tailscale. */
  publicUrl: string;
  vapidSubject: string;
  /** Plan actions but never kill or launch anything. */
  dryRun: boolean;
  /** Starting values for the settings the phone can change. */
  defaults: Settings;
  paths: {
    data: string;
    web: string;
    helperSource: string;
    helperExe: string;
    claudeHome: string;
    claudeAppData: string;
    codexHome: string;
  };
}

const DEFAULTS: Omit<Config, 'paths'> = {
  phonePort: 7420,
  adminPort: 7421,
  listenHost: '127.0.0.1',
  pollIntervalMs: 5000,
  approvalSeconds: 60,
  alertDelaySeconds: 30,
  recentHours: 12,
  staleRetentionHours: 24,
  endedRetentionMinutes: 30,
  claudeCommand: 'claude',
  codexCommand: 'codex',
  tray: true,
  publicUrl: '',
  vapidSubject: 'mailto:auto-detect-agent@example.com',
  dryRun: false,
  defaults: { keepAwake: 'off', stuckMinutes: 15, autoReconnect: false },
};

export function loadConfig(file = path.join(ROOT, 'config.json')): Config {
  const user = readJsonFile<Partial<Config>>(file) ?? {};
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const defaultPaths: Config['paths'] = {
    data: path.join(ROOT, 'data'),
    web: path.join(ROOT, 'web'),
    helperSource: path.join(ROOT, 'helper', 'ProcHelper.cs'),
    helperExe: path.join(ROOT, 'bin', 'proc-helper.exe'),
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    claudeAppData: path.join(appData, 'Claude'),
    codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  };
  return {
    ...DEFAULTS,
    ...user,
    defaults: { ...DEFAULTS.defaults, ...(user.defaults ?? {}) },
    paths: { ...defaultPaths, ...(user.paths ?? {}) },
  };
}
