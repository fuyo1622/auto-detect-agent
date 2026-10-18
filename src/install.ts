// Installing AgentMonitor.exe for the current user: no admin rights, no installer program.
// Program:  %LOCALAPPDATA%\Programs\AgentMonitor\AgentMonitor.exe
// Data:     %LOCALAPPDATA%\AgentMonitor (settings, paired phones, log; the files the exe carries go in app\)
// Also: Start menu and sign-in shortcuts, and an entry in Settings > Apps for uninstalling.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getAsset, getAssetKeys } from 'node:sea';
import { HOME, PACKAGED, type Config } from './config.ts';
import { BUILD, VERSION } from './version.ts';
import { normPath, sleep } from './util.ts';

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
export const INSTALL_DIR = path.join(LOCAL_APP_DATA, 'Programs', 'AgentMonitor');
export const INSTALLED_EXE = path.join(INSTALL_DIR, 'AgentMonitor.exe');

/** This process is the installed copy (as opposed to a downloaded AgentMonitor.exe). */
export function isInstalledCopy(): boolean {
  return normPath(process.execPath) === normPath(INSTALLED_EXE);
}

/** Packaged: writes the files the exe carries (web app, tray script, process helper), once per build. */
export function unpackAssets(cfg: Config, log: (...a: unknown[]) => void): void {
  if (!PACKAGED) return;
  const appDir = path.join(HOME, 'app');
  const stamp = path.join(appDir, '.build');
  const id = `${VERSION} ${BUILD}`;
  try {
    if (fs.readFileSync(stamp, 'utf8') === id && fs.existsSync(cfg.paths.helperExe)) return;
  } catch {
    /* first run */
  }
  for (const key of getAssetKeys()) {
    const target = path.join(appDir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, Buffer.from(getAsset(key)));
    } catch (e) {
      log(`could not unpack ${key}:`, (e as Error).message); // e.g. still in use; the old copy keeps working
    }
  }
  fs.writeFileSync(stamp, id);
}

function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))),
    );
  });
}

/** Asks a running Agent Monitor (any version) to stop, and waits until it has. */
export async function stopRunning(adminPort: number, timeoutMs = 20000): Promise<boolean> {
  const answering = () =>
    new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: adminPort, path: '/api/whoami', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => (req.destroy(), resolve(false)));
    });
  if (!(await answering())) return false;
  await new Promise<void>((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: adminPort, path: '/api/admin/shutdown', method: 'POST', headers: { 'X-Agent-Client': 'installer', 'Content-Length': 0 } },
      (res) => (res.resume(), resolve()),
    );
    req.on('error', () => resolve());
    req.end();
  });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && (await answering())) await sleep(300);
  await sleep(1000); // let its process exit and release the exe
  return true;
}

function adminPost(adminPort: number, urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: adminPort, path: urlPath, method: 'POST', headers: { 'X-Agent-Client': 'installer', 'Content-Length': 0 }, timeout: 90000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

export async function waitForAgent(adminPort: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: adminPort, path: '/api/whoami', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => (req.destroy(), resolve(false)));
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

/** Opens a page in the default browser. */
export function openUrl(url: string): void {
  spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** Starts the installed copy in the background (it relaunches itself without a window). */
export function startInstalled(): void {
  spawn(INSTALLED_EXE, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: INSTALL_DIR }).unref();
}

const SHORTCUTS_AND_ENTRY = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
foreach ($place in 'Startup', 'Programs') {
  $s = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath($place)) 'Agent Monitor.lnk'))
  $s.TargetPath = $env:AM_EXE
  $s.Arguments = $(if ($place -eq 'Startup') { '--background' } else { '' })
  $s.WorkingDirectory = $env:AM_DIR
  $s.WindowStyle = $(if ($place -eq 'Startup') { 7 } else { 1 })
  $s.IconLocation = "$env:AM_EXE,0"
  $s.Description = 'Agent Monitor: keeps Claude Code Remote Control reachable from your phone'
  $s.Save()
}
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentMonitor'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name DisplayName -Value 'Agent Monitor'
Set-ItemProperty -Path $k -Name DisplayVersion -Value $env:AM_VERSION
Set-ItemProperty -Path $k -Name Publisher -Value 'Agent Monitor'
Set-ItemProperty -Path $k -Name InstallLocation -Value $env:AM_DIR
Set-ItemProperty -Path $k -Name DisplayIcon -Value "$env:AM_EXE,0"
Set-ItemProperty -Path $k -Name UninstallString -Value ('"' + $env:AM_EXE + '" uninstall')
Set-ItemProperty -Path $k -Name QuietUninstallString -Value ('"' + $env:AM_EXE + '" uninstall --quiet')
New-ItemProperty -Path $k -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $k -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $k -Name EstimatedSize -Value ([int]$env:AM_SIZE_KB) -PropertyType DWord -Force | Out-Null
`;

const REMOVE_SHORTCUTS_AND_ENTRY = `
foreach ($place in 'Startup', 'Programs') {
  $f = Join-Path ([Environment]::GetFolderPath($place)) 'Agent Monitor.lnk'
  if (Test-Path $f) { Remove-Item $f -Force }
}
Remove-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentMonitor' -Recurse -Force -ErrorAction SilentlyContinue
`;

/** Copies this exe into place, adds the shortcuts and the Settings > Apps entry, and starts it. */
export async function install(cfg: Config, say: (s: string) => void, openPage = true): Promise<void> {
  if (!PACKAGED) throw new Error('Only AgentMonitor.exe can be installed. Build it with: npm run build');
  if (await stopRunning(cfg.adminPort)) say('Stopped the running Agent Monitor.');
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  if (!isInstalledCopy()) {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.copyFileSync(process.execPath, INSTALLED_EXE);
        break;
      } catch (e) {
        if (attempt >= 10) throw new Error(`Could not copy AgentMonitor.exe into ${INSTALL_DIR}: ${(e as Error).message}`);
        await sleep(500); // the old copy may still be closing
      }
    }
  }
  await powershell(SHORTCUTS_AND_ENTRY, {
    AM_EXE: INSTALLED_EXE,
    AM_DIR: INSTALL_DIR,
    AM_VERSION: VERSION,
    AM_SIZE_KB: String(Math.round(fs.statSync(INSTALLED_EXE).size / 1024)),
  });
  say(`Installed Agent Monitor ${VERSION} in ${INSTALL_DIR}.`);
  startInstalled();
  if (!(await waitForAgent(cfg.adminPort, 30000))) throw new Error('Agent Monitor did not start. See the log in ' + path.join(HOME, 'data', 'agent.log'));
  // With Tailscale already signed in, turn on the phone address right away (only your own devices can open it).
  const serve = await adminPost(cfg.adminPort, '/api/admin/tailscale/serve').catch(() => undefined);
  if (serve?.ok) say(serve.message);
  say('Agent Monitor is running (tray icon, maybe under ^).');
  if (!openPage) return;
  say('Opening the setup page...');
  openUrl(`http://127.0.0.1:${cfg.adminPort}/#pc`);
}

/** Removes the program, shortcuts, Settings > Apps entry and the phone address. Keeps paired phones unless purge. */
export async function uninstall(cfg: Config, opts: { purge: boolean }, say: (s: string) => void): Promise<void> {
  if (!PACKAGED) throw new Error('Only AgentMonitor.exe can be uninstalled this way.');
  await stopRunning(cfg.adminPort);
  await turnOffPhoneAddress(cfg.phonePort).catch(() => {});
  await powershell(REMOVE_SHORTCUTS_AND_ENTRY);
  fs.rmSync(path.join(HOME, opts.purge ? '' : 'app'), { recursive: true, force: true });
  if (fs.existsSync(INSTALL_DIR)) removeFolderWhenFree(INSTALL_DIR);
  say(opts.purge ? 'Agent Monitor was removed, with its settings and paired phones.' : `Agent Monitor was removed. Paired phones and settings are kept in ${HOME} (delete that folder to remove them).`);
}

/**
 * Deletes a folder as soon as nothing holds it: the program folder holds this running exe until it exits, which can
 * be a while when a message box is still open. Tries every second for 10 minutes.
 */
export function removeFolderWhenFree(dir: string): ChildProcess {
  // Passed to cmd.exe as is: Node would escape the quotes as \", which cmd does not understand. (A detached
  // powershell.exe cannot do this job: without a console it exits at once.)
  const q = `"${dir}"`;
  const line = `/d /c "for /l %i in (1,1,600) do @(ping -n 2 127.0.0.1 >nul & rmdir /s /q ${q} 2>nul & if not exist ${q} exit 0)"`;
  const child = spawn('cmd.exe', [line], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir(), // a working folder inside `dir` would keep it from being deleted
    windowsVerbatimArguments: true,
  });
  child.unref();
  return child;
}

/** Stops `tailscale serve` from publishing the phone port (only when it points at Agent Monitor). */
async function turnOffPhoneAddress(phonePort: number): Promise<void> {
  const exe = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')].find((f) => fs.existsSync(f));
  if (!exe) return;
  const run = (args: string[]) =>
    new Promise<string>((resolve) => execFile(exe, args, { windowsHide: true, timeout: 20000 }, (_e, out) => resolve(String(out ?? ''))));
  const status = (await run(['serve', 'status', '--json'])).replace(/\s/g, '');
  if (status.includes(`127.0.0.1:${phonePort}`)) await run(['serve', '--https=443', 'off']);
}

/** A Windows message box, for messages that must be seen when there is no console to read. */
export function messageBox(text: string, title = 'Agent Monitor'): Promise<void> {
  return powershell(
    'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:AM_TEXT, $env:AM_TITLE)',
    { AM_TEXT: text, AM_TITLE: title },
  )
    .then(() => {})
    .catch(() => {});
}
