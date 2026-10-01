import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Actions } from './actions.ts';
import { AutoReconnect } from './auto.ts';
import { KeepAwake } from './awake.ts';
import { loadConfig, ROOT, type Config } from './config.ts';
import { detectAppIds } from './launch.ts';
import { createLogger, type Logger } from './log.ts';
import { Monitor } from './monitor.ts';
import { Notifier } from './notify.ts';
import { Pairing } from './pairing.ts';
import { ProcHelper } from './proc/helper.ts';
import { Servers } from './server.ts';
import { Store } from './store.ts';
import { Tailscale } from './tailscale.ts';

const args = process.argv.slice(2);
const background = args.includes('--background');

if (background && !process.env.AGENT_MONITOR_CHILD) {
  // Relaunch without a console window and return right away (used by autostart).
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(path.join(cfg.paths.data, 'agent.log'), !background, args.includes('--verbose'));
  const version: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  if (await isRunning(cfg)) {
    log.info(`Agent Monitor is already running (http://127.0.0.1:${cfg.adminPort}).`);
    process.exit(0);
  }

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
    notifier.onUpdate(sessions);
    auto.onUpdate(sessions);
    void awake.update(sessions);
  });
  monitor.on('transition', (t) => notifier.onTransition(t));
  monitor.on('wake', (sleptMs: number) => {
    log.info(`PC woke up after ${Math.round(sleptMs / 60000)} min`);
    void tailscale.refresh(true);
    // Give sessions a moment to reconnect on their own before summarizing.
    setTimeout(() => notifier.onWake(sleptMs, monitor.sessions), 20000);
  });
  monitor.once('update', (sessions) => notifier.onStart(sessions));

  monitor.appIds = await detectAppIds();
  log.info('desktop apps:', monitor.appIds);
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
  const script = path.join(ROOT, 'scripts', 'tray.ps1');
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-AdminUrl', `http://127.0.0.1:${cfg.adminPort}`,
        '-AgentPid', String(process.pid),
        '-LogPath', path.join(cfg.paths.data, 'agent.log'),
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

void main();
