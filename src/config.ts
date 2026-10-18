import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './util.ts';
import type { Settings } from './types.ts';

/** Running as the single AgentMonitor.exe (Node single executable application), not from source. */
export const PACKAGED = isSea();

/** Source mode: the project folder. Packaged: the folder of AgentMonitor.exe. */
export const ROOT = PACKAGED ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where settings, pairings and logs live: the project folder from source, %LOCALAPPDATA%\AgentMonitor when packaged. */
export const HOME = PACKAGED ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'AgentMonitor') : ROOT;

export interface Config {
  /** Port the phone reaches (through `tailscale serve`). Needs a paired-device token. */
  phonePort: number;
  /** Port for this PC only: dashboard, pairing, tray. Never expose it. */
  adminPort: number;
  /** Where the phone port listens. Keep 127.0.0.1 when using `tailscale serve`. */
  listenHost: string;
  pollIntervalMs: number;
  /** A problem must last this long before a push notification goes out. */
  alertDelaySeconds: number;
  /** Sessions whose process vanished without cleanup are listed this long. */
  staleRetentionHours: number;
  /** Sessions that closed normally stay visible this long. */
  endedRetentionMinutes: number;
  /** Used when the original Claude executable no longer exists. */
  claudeCommand: string;
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
    /** C# source of the process helper; empty when packaged (the helper comes prebuilt). */
    helperSource: string;
    helperExe: string;
    trayScript: string;
    claudeHome: string;
    claudeAppData: string;
  };
}

const DEFAULTS: Omit<Config, 'paths'> = {
  phonePort: 7420,
  adminPort: 7421,
  listenHost: '127.0.0.1',
  pollIntervalMs: 5000,
  alertDelaySeconds: 30,
  staleRetentionHours: 24,
  endedRetentionMinutes: 30,
  claudeCommand: 'claude',
  tray: true,
  publicUrl: '',
  vapidSubject: 'mailto:auto-detect-agent@example.com',
  dryRun: false,
  defaults: { keepAwake: 'off', autoReconnect: false },
};

/** AGENT_MONITOR_CONFIG points at another config file (`npm run dev` uses it to run a dry-run copy). */
export function loadConfig(file = path.resolve(HOME, process.env.AGENT_MONITOR_CONFIG || 'config.json')): Config {
  const user = readJsonFile<Partial<Config>>(file) ?? {};
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const app = path.join(HOME, 'app'); // packaged: files unpacked from the exe
  const defaultPaths: Config['paths'] = {
    data: path.join(HOME, 'data'),
    web: PACKAGED ? path.join(app, 'web') : path.join(ROOT, 'web'),
    helperSource: PACKAGED ? '' : path.join(ROOT, 'helper', 'ProcHelper.cs'),
    helperExe: PACKAGED ? path.join(app, 'proc-helper.exe') : path.join(ROOT, 'bin', 'proc-helper.exe'),
    trayScript: PACKAGED ? path.join(app, 'tray.ps1') : path.join(ROOT, 'scripts', 'tray.ps1'),
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    claudeAppData: path.join(appData, 'Claude'),
  };
  const defaults = { ...DEFAULTS.defaults, ...(user.defaults ?? {}) };
  return {
    ...DEFAULTS,
    ...user,
    defaults: { keepAwake: defaults.keepAwake, autoReconnect: defaults.autoReconnect },
    // Relative paths in config.json are relative to the project folder (or the AgentMonitor folder when packaged).
    paths: Object.fromEntries(Object.entries({ ...defaultPaths, ...(user.paths ?? {}) }).map(([k, v]) => [k, v && path.resolve(HOME, v)])) as Config['paths'],
  };
}
