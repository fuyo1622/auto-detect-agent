import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Actions } from './actions.ts';
import { AutoReconnect } from './auto.ts';
import { KeepAwake } from './awake.ts';
import { CLI_COMMANDS, runCliCommand } from './cli.ts';
import { loadConfig, PACKAGED, ROOT, type Config } from './config.ts';
import { install, isInstalledCopy, messageBox, openUrl, startInstalled, uninstall, unpackAssets, waitForAgent } from './install.ts';
import { detectClaudeAppId } from './launch.ts';
import { createLogger, type Logger } from './log.ts';
import { Monitor } from './monitor.ts';
import { Notifier } from './notify.ts';
import { Pairing } from './pairing.ts';
import { ProcHelper } from './proc/helper.ts';
import { Servers } from './server.ts';
import { Store } from './store.ts';
import { Tailscale } from './tailscale.ts';
import { sleep } from './util.ts';
import { VERSION } from './version.ts';

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-'));
const background = args.includes('--background');

const USAGE = `Agent Monitor ${VERSION}
  (no arguments)   install this copy, or open the dashboard of the running one
  --background     run in the background (what the sign-in shortcut does)
  --foreground     run in this console (Ctrl+C to stop)
  status | pair | stop
  install | uninstall [--purge] [--quiet]`;

async function entry(): Promise<void> {
  const cfg = loadConfig();

  if (command && CLI_COMMANDS.has(command)) process.exit(await runCliCommand(cfg, command));
  if (command === 'install' || command === 'uninstall') process.exit(await installCommand(cfg, command));
  if (command) {
    console.log(USAGE);
    process.exit(1);
  }

  // Double-click or Start menu: set up this copy, or show the running one.
  if (PACKAGED && !background && !args.includes('--foreground') && !process.env.AGENT_MONITOR_CHILD) process.exit(await openOrInstall(cfg));

  if (background && !process.env.AGENT_MONITOR_CHILD) {
    // Relaunch without a console window and return right away (used by autostart).
    const self = PACKAGED ? [] : [fileURLToPath(import.meta.url)];
    const child = spawn(process.execPath, [...self, ...args], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AGENT_MONITOR_CHILD: '1' },
    });
    child.unref();
    console.log(`Agent Monitor is starting in the background (pid ${child.pid}).`);
    process.exit(0);
  }

  await runAgent(cfg);
}

async function installCommand(cfg: Config, which: 'install' | 'uninstall'): Promise<number> {
  const quiet = args.includes('--quiet');
  try {
    if (which === 'install') await install(cfg, (s) => console.log(s), !quiet);
    else {
      let said = '';
      await uninstall(cfg, { purge: args.includes('--purge') }, (s) => console.log((said = s)));
      // From Settings > Apps there is no console to read the result in.
      if (!quiet) await messageBox(said);
    }
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    if (!quiet) await messageBox((e as Error).message);
    return 1;
  }
}

async function openOrInstall(cfg: Config): Promise<number> {
  const dashboard = `http://127.0.0.1:${cfg.adminPort}`;
  try {
    if (!isInstalledCopy()) {
      console.log(`Setting up Agent Monitor ${VERSION}...`);
      await install(cfg, (s) => console.log(s));
      await sleep(4000); // time to read the console before it closes
      return 0;
    }
    if (!(await isRunning(cfg))) {
      startInstalled();
      if (!(await waitForAgent(cfg.adminPort, 30000))) throw new Error('Agent Monitor did not start.');
    }
    openUrl(dashboard);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    await messageBox((e as Error).message);
    return 1;
  }
}

async function runAgent(cfg: Config): Promise<void> {
  const log = createLogger(path.join(cfg.paths.data, 'agent.log'), !background, args.includes('--verbose'));
  const version = VERSION;

  if (await isRunning(cfg)) {
    log.info(`Agent Monitor is already running (http://127.0.0.1:${cfg.adminPort}).`);
    process.exit(0);
  }
  unpackAssets(cfg, (...a) => log.warn(...a));

  const store = new Store(path.join(cfg.paths.data, 'state.json'), cfg.defaults);
  const helper = new ProcHelper({ exe: cfg.paths.helperExe, source: cfg.paths.helperSource, log });
  await helper.start();

  const monitor = new Monitor(cfg, store, helper, log);
  const notifier = new Notifier(cfg, store, log);
  notifier.init();
  const pairing = new Pairing(store);
  const tailscale = new Tailscale(cfg.phonePort, log);
  const awake = new KeepAwake(helper, store, log);
  const actions = new Actions(cfg, monitor, store, log);
  const auto = new AutoReconnect(store, actions, notifier, log);
  const startedAt = Date.now();

  let tray: ChildProcess | undefined;
  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping (${why})`);
    monitor.stop();
    servers.close();
    await awake.release();
    helper.stop();
    tray?.kill();
    store.saveNow();
    setTimeout(() => process.exit(0), 300);
  };

  const servers = new Servers({
    cfg,
    log,
    store,
    monitor,
    actions,
    notifier,
    pairing,
    tailscale,
    awake,
    version,
    startedAt,
    helperMode: () => helper.mode,
    shutdown: () => void shutdown('requested'),
  });
  try {
    await servers.listen();
  } catch (e) {
    log.error(`cannot listen on ports ${cfg.adminPort}/${cfg.phonePort}:`, (e as Error).message);
    process.exit(1);
  }

  monitor.on('update', (sessions) => {
    servers.broadcast();
    notifier.onUpdate(sessions, auto.onUpdate(sessions));
    void awake.update(sessions);
  });
  monitor.on('wake', (sleptMs: number) => {
    log.info(`PC woke up after ${Math.round(sleptMs / 60000)} min`);
    void tailscale.refresh(true);
    // Give sessions a moment to reconnect on their own before summarizing.
    setTimeout(() => notifier.onWake(sleptMs, monitor.sessions), 20000);
  });
  monitor.once('update', (sessions) => notifier.onStart(sessions));

  monitor.appId = await detectClaudeAppId();
  log.info('Claude app:', monitor.appId ?? 'not installed');
  monitor.start();
  void tailscale.refresh(true).then((s) => log.info('tailscale:', s.installed ? (s.serving ? s.url : s.state) : 'not installed'));
  setInterval(() => void tailscale.refresh(), 60000).unref();

  if (cfg.tray && !args.includes('--no-tray')) tray = startTray(cfg, log);

  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('uncaughtException', (e) => log.error('uncaught:', e));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e));

  log.info(`Agent Monitor ${version} running. Dashboard: http://127.0.0.1:${cfg.adminPort}  Phone port: ${cfg.listenHost}:${cfg.phonePort}`);
}

function startTray(cfg: Config, log: Logger): ChildProcess | undefined {
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', cfg.paths.trayScript,
        '-AdminUrl', `http://127.0.0.1:${cfg.adminPort}`,
        '-AgentPid', String(process.pid),
        '-LogPath', path.join(cfg.paths.data, 'agent.log'),
        // The installed exe can remove itself; from source there is nothing to uninstall.
        ...(PACKAGED ? ['-ExePath', process.execPath] : []),
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.on('exit', (code) => log.info('tray icon exited', code ?? ''));
    return child;
  } catch (e) {
    log.warn('tray icon failed to start:', (e as Error).message);
    return undefined;
  }
}

/** Another agent already answers on the PC-only port. */
function isRunning(cfg: Config): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: cfg.adminPort, path: '/api/whoami', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

void entry();
