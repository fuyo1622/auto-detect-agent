import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Logger } from './log.ts';
import type { ResumeSpec } from './types.ts';
import { sleep } from './util.ts';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export function runCli(file: string, args: string[], timeoutMs = 60000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: e ? e.message : undefined,
      });
    });
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await sleep(250);
  }
  return !isAlive(pid);
}

/** Ends a process and everything it started. */
export async function killTree(pid: number, timeoutMs = 10000): Promise<boolean> {
  if (!isAlive(pid)) return true;
  await runCli('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 20000);
  return waitForExit(pid, timeoutMs);
}

/** Windows Terminal treats `;` as a command separator. */
function wtEscape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/;/g, '\\;');
}

export function windowsTerminalArgs(spec: ResumeSpec): string[] {
  return ['-w', '0', 'new-tab', '--title', wtEscape(spec.title), '-d', wtEscape(spec.cwd), ...spec.command.map(wtEscape)];
}

export function describeLaunch(spec: ResumeSpec): string {
  const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return `In ${spec.cwd}: ${spec.command.map(quote).join(' ')}`;
}

/** Opens the command in a new Windows Terminal tab (or a console window if WT is missing). */
export async function launchInTerminal(spec: ResumeSpec, log: Logger): Promise<void> {
  if (!fs.existsSync(spec.cwd)) throw new Error(`Folder not found: ${spec.cwd}`);
  try {
    await spawnDetached('wt.exe', windowsTerminalArgs(spec));
    log.info('launched in Windows Terminal:', describeLaunch(spec));
    return;
  } catch (e) {
    log.warn('Windows Terminal launch failed, using a console window:', (e as Error).message);
  }
  // cmd's `start` has its own quoting rules, so build its command line by hand.
  const q = (s: string) => `"${s.replace(/"/g, '')}"`;
  const line = ['/c', 'start', q(spec.title), '/D', q(spec.cwd), ...spec.command.map(q)].join(' ');
  await spawnDetached('cmd.exe', [line], spec.cwd, true);
  log.info('launched in console window:', describeLaunch(spec));
}

function spawnDetached(file: string, args: string[], cwd?: string, verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd, windowsVerbatimArguments: verbatim });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Starts an MSIX app by its AppUserModelID (e.g. Claude_pzs8sxrjxfjjc!Claude). */
export function launchPackagedApp(aumid: string): Promise<void> {
  return spawnDetached('explorer.exe', [`shell:AppsFolder\\${aumid}`]);
}

export interface AppIds {
  claude?: string;
  codex?: string;
}

/** Looks up the AppUserModelIDs of the Claude and Codex desktop apps. */
export async function detectAppIds(): Promise<AppIds> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$o=@{};foreach($n in 'Claude','OpenAI.Codex'){$p=Get-AppxPackage -Name $n|Select-Object -First 1;" +
    'if($p){$m=$p|Get-AppxPackageManifest;$apps=@($m.Package.Applications.Application);' +
    "$a=$apps|Where-Object{$_.Executable -match '(Claude|ChatGPT)\\.exe$'}|Select-Object -First 1;if(-not $a){$a=$apps[0]};" +
    "$o[$n]=$p.PackageFamilyName+'!'+$a.Id}};$o|ConvertTo-Json -Compress";
  const r = await runCli('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000);
  try {
    const o = JSON.parse(r.stdout.trim() || '{}');
    return { claude: o.Claude || undefined, codex: o['OpenAI.Codex'] || undefined };
  } catch {
    return {};
  }
}
