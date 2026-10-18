// End-to-end self-test of Agent Monitor with REAL actions, against fake claude.exe sessions only.
// The agent under test uses its own fake ~/.claude, so real Claude app sessions are invisible to it
// (it skips app sessions it has no registry entry for), and every action targets a fake pid.
// `npm run e2e` tests the source, `npm run e2e:exe` the built dist\AgentMonitor.exe (or set E2E_EXE).
// It takes about 5 minutes. Meanwhile Windows Terminal tabs saying "AGENT MONITOR SELF-TEST" open and
// close by themselves, and a second tray icon shows.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectBrowser, openPage, sleep, startEdge, stopEdge } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HERE = path.join(os.tmpdir(), 'agent-monitor-e2e'); // everything the test writes
const EXE = process.argv.includes('--exe') ? path.join(ROOT, 'dist', 'AgentMonitor.exe') : process.env.E2E_EXE;
if (EXE && !fs.existsSync(EXE)) throw new Error(`${EXE} not found. Build it first: npm run build`);
const FAKEBIN = path.join(HERE, 'fakebin');
const FAKE = path.join(FAKEBIN, 'claude.exe');
const LAUNCHES = path.join(FAKEBIN, 'launches.txt');
const CLAUDE_HOME = path.join(HERE, 'claude-home');
const SESSIONS = path.join(CLAUDE_HOME, 'sessions');
const DATA = path.join(HERE, 'data');
const SANDBOX = path.join(HERE, 'localappdata'); // packaged: where it unpacks its files
const ADMIN = 'http://127.0.0.1:17431';
const PHONE = 'http://127.0.0.1:17430';
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const step = (s) => console.log(`\n== ${s}`);

// ---------------------------------------------------------------- setup
for (const d of [CLAUDE_HOME, DATA, SANDBOX, path.join(HERE, 'work')]) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(LAUNCHES, { force: true });
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(FAKEBIN, { recursive: true });
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const fakeSource = path.join(import.meta.dirname, 'FakeClaude.cs');
if (!fs.existsSync(FAKE) || fs.statSync(FAKE).mtimeMs < fs.statSync(fakeSource).mtimeMs) execFileSync(csc, ['-nologo', `-out:${FAKE}`, fakeSource]);
const work = (name) => {
  const d = path.join(HERE, 'work', `selftest-${name}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
fs.writeFileSync(
  path.join(HERE, 'config.json'),
  JSON.stringify({
    phonePort: 17430,
    adminPort: 17431,
    dryRun: false,
    tray: true,
    pollIntervalMs: 2000,
    alertDelaySeconds: 2,
    claudeCommand: FAKE,
    defaults: { keepAwake: 'off', autoReconnect: false },
    paths: { data: DATA, claudeHome: CLAUDE_HOME, claudeAppData: path.join(HERE, 'claude-appdata') },
  }),
);

const mine = new Set(); // pids of fake sessions: the only processes actions may touch
function spawnFake(cwd, args) {
  const p = spawn(FAKE, args, { cwd, stdio: 'ignore', windowsHide: true });
  mine.add(p.pid);
  return p.pid;
}
const procStart = (pid) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8' }).trim();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
function registry(pid, sessionId, cwd, title, extra = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now(), procStart: procStart(pid), kind: 'interactive', entrypoint: 'cli', name: title, nameSource: 'user', status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now(), bridgeSessionId: 'cse_01SELFTEST', ...extra }),
  );
}
function transcript(sessionId, cwd) {
  const dir = path.join(CLAUDE_HOME, 'projects', slug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'hi' } }) + '\n');
}
const launches = () => (fs.existsSync(LAUNCHES) ? fs.readFileSync(LAUNCHES, 'utf8').trim().split(/\r?\n/).map((l) => l.split('\t')) : []);

async function api(method, p, body, base = ADMIN, headers = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'X-Agent-Client': 'e2e', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const sessions = async () => (await api('GET', '/api/state')).json.sessions;
const find = async (key) => (await sessions()).find((s) => s.key === key);
async function until(desc, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) {
      console.log(`  (timed out waiting for ${desc})`);
      return undefined;
    }
    await sleep(500);
  }
}
async function act(key, action, body, base = ADMIN, headers = {}) {
  const s = await find(key);
  if (!s) throw new Error(`no session ${key}`);
  if (s.pid !== undefined && !mine.has(s.pid)) throw new Error(`SAFETY STOP: ${key} is pid ${s.pid}, not a fake session`);
  return (await api('POST', `/api/sessions/${encodeURIComponent(key)}/${action}`, body, base, headers)).json;
}
const ID = (n) => `5e1f7e57-0000-4000-8000-00000000000${n}`;
/** A reopened fake shows up in launches.txt; register it the way real Claude does when it starts. */
async function reopened(id, cwd, title) {
  const l = await until(`relaunch of ${id}`, async () => launches().find((x) => x[3].includes(`--resume ${id}`)));
  if (l) {
    mine.add(Number(l[1]));
    registry(Number(l[1]), id, cwd, title);
  }
  return l;
}

// ---------------------------------------------------------------- start the agent
step(EXE ? `start the packaged agent (${path.basename(EXE)})` : 'start the agent from source');
const agentLog = path.join(HERE, 'agent-console.txt');
fs.writeFileSync(agentLog, '');
const env = { ...process.env, AGENT_MONITOR_CONFIG: path.join(HERE, 'config.json'), ...(EXE ? { LOCALAPPDATA: SANDBOX } : {}) };
const agent = EXE
  ? spawn(EXE, ['--foreground'], { cwd: path.dirname(EXE), env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.execPath, [path.join(ROOT, 'src', 'main.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
agent.stdout.on('data', (d) => fs.appendFileSync(agentLog, d));
agent.stderr.on('data', (d) => fs.appendFileSync(agentLog, d));
check('agent answers', !!(await until('agent', async () => (await api('GET', '/api/whoami')).status === 200)));
const whoami = (await api('GET', '/api/whoami')).json;
console.log(`  version ${whoami.version}`);
const kids = () =>
  JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${agent.pid}" | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress`], { encoding: 'utf8' }) || '[]');
const tray = await until('tray', async () => [].concat(kids()).find((c) => /tray\.ps1/.test(c.CommandLine ?? '')), 15000);
const helperProc = [].concat(kids()).find((c) => c.Name === 'proc-helper.exe');
check('tray icon process started', !!tray);
check('proc-helper started', !!helperProc);
if (EXE) {
  check('tray offers "Uninstall" (packaged)', /-ExePath/.test(tray?.CommandLine ?? ''));
  check('helper and tray run from the unpacked files', /localappdata\\AgentMonitor\\app\\/i.test(`${helperProc?.CommandLine} ${tray?.CommandLine}`));
}

// ---------------------------------------------------------------- a "phone": headless Edge with real push
step('pair a phone (headless Edge) and turn on notifications');
await startEdge();
const browser = await connectBrowser();
const code = (await api('POST', '/api/admin/pairing')).json.code;
const token = (await api('POST', '/api/pair', { code, name: 'Self-test phone' }, PHONE)).json.token;
const phone = { Authorization: `Bearer ${token}` };
const page = await openPage(browser, `${PHONE}/`);
await page.evaluate(`localStorage.setItem('agentMonitor.token', ${JSON.stringify(token)}), true`);
await page.reload();
await page.waitFor(`document.querySelector('#hdr')?.innerText.includes('Live')`);
await browser.send('Browser.grantPermissions', { origin: PHONE, permissions: ['notifications'] });
await page.waitFor(`navigator.serviceWorker.ready.then(r => !!r.active)`);
await page.evaluate(`document.querySelector('[data-act=tab][data-tab=settings]').click(), true`);
await page.waitFor(`!!document.querySelector('[data-act=push-on]')`);
await page.evaluate(`document.querySelector('[data-act=push-on]').click(), true`);
const pushOn = await until('push subscription', async () => (await api('GET', '/api/admin/devices')).json.find((d) => d.name === 'Self-test phone')?.push);
check('phone subscribed to push (Microsoft push service)', !!pushOn);
await page.evaluate(`document.querySelector('[data-act=tab][data-tab=sessions]').click(), true`);
await page.evaluate(`window.__seen = []; setInterval(async () => { const r = await navigator.serviceWorker.ready; for (const n of await r.getNotifications()) { const k = n.tag + '|' + n.title + '|' + n.body; if (!window.__seen.includes(k)) window.__seen.push(k); } }, 300), true`);
const seen = () => page.evaluate(`window.__seen`);
const waitPush = (re, ms = 30000) => until(`push ${re}`, async () => (await seen()).find((n) => re.test(n)), ms);

// ---------------------------------------------------------------- A: Remote Control lost -> push -> Reconnect from the phone
step('A: Remote Control drops, then Reconnect from the phone');
const wA = work('A');
const pidA = spawnFake(wA, ['--remote-control']);
await sleep(700);
registry(pidA, ID(1), wA, 'SELF-TEST A (ignore)');
transcript(ID(1), wA);
const kA = `claude:${ID(1)}`;
let s = await until('A waiting', async () => (await find(kA))?.health === 'waiting' && find(kA));
check('A detected as "waiting" with Remote Control on', s?.rc?.state === 'on', s && `${s.health}, pid ${s.pid}`);
registry(pidA, ID(1), wA, 'SELF-TEST A (ignore)', { bridgeSessionId: null });
s = await until('A rc-lost', async () => (await find(kA))?.health === 'rc-lost' && find(kA));
check('A becomes "Remote Control lost"', !!s);
const pushA = await waitPush(/SELF-TEST A.*Remote Control lost/);
check('push "Remote Control lost" arrives on the phone', !!pushA, pushA);
const ui = await page.evaluate(`[...document.querySelectorAll('article.card')].map(c => c.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
check('the phone shows a Reconnect button for it', /Remote Control lost.*SELF-TEST A.*Reconnect/.test(ui), ui.slice(0, 160));
const rA = await act(kA, 'reconnect', {}, PHONE, phone);
check('Reconnect from the phone succeeds', rA.ok === true, rA.message);
check('old process A was closed', !alive(pidA));
const relA = await reopened(ID(1), wA, 'SELF-TEST A (ignore)');
check('A reopened with --remote-control --resume <id>, in the same folder', !!relA && relA[3] === `--remote-control --resume ${ID(1)}` && relA[2].toLowerCase() === wA.toLowerCase(), relA && `${relA[2]} ${relA[3]}`);
check('launched through Windows Terminal', /launched in Windows Terminal/.test(fs.readFileSync(path.join(DATA, 'agent.log'), 'utf8')));
s = await until('A back', async () => {
  const v = await find(kA);
  return v?.alive && v.pid !== pidA && v.health === 'waiting' && v;
});
check('A is back to "waiting" on the new process', !!s, s && `pid ${s.pid}`);

// ---------------------------------------------------------------- B: no Remote Control -> Turn on Remote Control
step('B: a terminal session without Remote Control, then "Turn on Remote Control"');
const wB = work('B');
const pidB = spawnFake(wB, []);
await sleep(700);
registry(pidB, ID(2), wB, 'SELF-TEST B (ignore)', { bridgeSessionId: null });
transcript(ID(2), wB);
const kB = `claude:${ID(2)}`;
s = await until('B listed', async () => (await find(kB))?.health === 'waiting' && find(kB));
check('B is "waiting" with no Remote Control, and is not a problem', !!s && s.rc.expected === false && s.rc.state === 'off', s && `${s.health} rc=${s.rc.state}`);
await sleep(800);
const cardB = await page.evaluate(`[...document.querySelectorAll('article.card')].map(c => c.innerText.replace(/\\s+/g, ' ')).find(t => t.includes('SELF-TEST B')) ?? ''`);
check('the phone marks it "No Remote Control"', /No Remote Control/.test(cardB), cardB);
await page.evaluate(`[...document.querySelectorAll('article.card')].find(c => c.innerText.includes('SELF-TEST B')).querySelector('[data-act=open]').click(), true`);
const sheetB = await page.waitFor(`document.querySelector('#sheet .sheet')?.innerText`);
check('its sheet offers "Turn on Remote Control"', /Turn on Remote Control/.test(sheetB));
await page.evaluate(`document.querySelector('[data-act=close]')?.click(), true`);
const rB = await act(kB, 'reconnect', {}, PHONE, phone);
check('"Turn on Remote Control" succeeds', rB.ok === true, rB.message);
const relB = await reopened(ID(2), wB, 'SELF-TEST B (ignore)');
check('B reopened with --remote-control', !!relB && relB[3] === `--remote-control --resume ${ID(2)}`, relB?.[3]);

// ---------------------------------------------------------------- C: crash -> push -> Resume
step('C: a session crashes while working, then Resume');
const wC = work('C');
const pidC = spawnFake(wC, ['--remote-control']);
await sleep(700);
registry(pidC, ID(3), wC, 'SELF-TEST C (ignore)', { status: 'busy' });
transcript(ID(3), wC);
const kC = `claude:${ID(3)}`;
await until('C working', async () => (await find(kC))?.health === 'working');
execFileSync('taskkill.exe', ['/PID', String(pidC), '/F']); // a crash, from the agent's point of view
s = await until('C dead', async () => (await find(kC))?.health === 'dead' && find(kC));
check('C becomes "Stopped unexpectedly"', !!s, s?.detail);
const pushC = await waitPush(/SELF-TEST C.*Stopped unexpectedly/);
check('push "Stopped unexpectedly" arrives', !!pushC, pushC);
const rC = await act(kC, 'resume', {});
check('Resume succeeds', rC.ok === true, rC.message);
const relC = await reopened(ID(3), wC, 'SELF-TEST C (ignore)');
check('C reopened in its folder with --remote-control --resume <id>', !!relC && relC[2].toLowerCase() === wC.toLowerCase() && relC[3] === `--remote-control --resume ${ID(3)}`);

// ---------------------------------------------------------------- D: auto-reconnect (the setting)
step('D: with Auto-reconnect on, an idle session that lost Remote Control is reopened by itself');
const rs = await api('PATCH', '/api/settings', { autoReconnect: true }, PHONE, phone);
check('Auto-reconnect switched on from the phone', rs.json.autoReconnect === true);
const wD = work('D');
const pidD = spawnFake(wD, ['--remote-control']);
await sleep(700);
registry(pidD, ID(4), wD, 'SELF-TEST D (ignore)');
transcript(ID(4), wD);
const kD = `claude:${ID(4)}`;
await until('D waiting', async () => (await find(kD))?.health === 'waiting');
registry(pidD, ID(4), wD, 'SELF-TEST D (ignore)', { bridgeSessionId: null });
await until('D rc-lost', async () => (await find(kD))?.health === 'rc-lost');
console.log('  (auto-reconnect waits 2 minutes, in case Remote Control comes back by itself)');
const relD = await until('auto relaunch of D', async () => launches().find((x) => x[3].includes(`--resume ${ID(4)}`)), 170_000);
check('reopened automatically with --remote-control --resume <id>', !!relD && relD[3] === `--remote-control --resume ${ID(4)}`, relD?.[3]);
if (relD) {
  mine.add(Number(relD[1]));
  registry(Number(relD[1]), ID(4), wD, 'SELF-TEST D (ignore)');
}
check('old process D was closed', !alive(pidD));
const pushD = await waitPush(/SELF-TEST D.*reopened in Windows Terminal/);
check('one push says it was reopened', !!pushD, pushD);
check('no separate "Remote Control lost" push for it', !(await seen()).some((n) => /SELF-TEST D.*Remote Control lost/.test(n)));
const log = fs.readFileSync(path.join(DATA, 'agent.log'), 'utf8');
check('the log names auto-reconnect as the one who acted', /\[auto-reconnect\] reconnect · SELF-TEST D/.test(log));
await api('PATCH', '/api/settings', { autoReconnect: false }, PHONE, phone);

// ---------------------------------------------------------------- normal exits, dismiss, shutdown
step('the reopened sessions exit normally (they remove their own records)');
const reopenedPids = [relA, relB, relC, relD].filter(Boolean).map((l) => Number(l[1]));
await until('reopened sessions exit', async () => reopenedPids.every((pid) => !alive(pid)), 60000);
await sleep(6000);
for (const [k, name] of [[kA, 'A'], [kB, 'B'], [kC, 'C'], [kD, 'D']]) {
  const v = await find(k);
  check(`${name}: a normal exit after reopening is "Closed", not a crash`, !v || v.health === 'ended', v && `${v.health}: ${v.detail}`);
}
const crashPushes = (await seen()).filter((n) => /Stopped unexpectedly/.test(n));
check('the only "Stopped unexpectedly" push is the real crash of C', crashPushes.length === 1 && /SELF-TEST C/.test(crashPushes[0]), crashPushes.join(' ; '));
const rDis = await act(kA, 'dismiss', {});
check('Dismiss hides a closed session', rDis.ok === true && !!(await until('A hidden', async () => !(await find(kA)))));
console.log('  notifications seen on the phone:\n   - ' + (await seen()).join('\n   - '));
check('no console errors in the phone app', page.consoleErrors.length === 0, page.consoleErrors.join(' ; '));

await api('POST', '/api/admin/shutdown');
const exited = await until('agent exit', async () => agent.exitCode !== null, 10000);
check('agent shuts down cleanly on request', !!exited && agent.exitCode === 0, `exit ${agent.exitCode}`);
await sleep(5000);
check('tray icon exits with the agent', !!tray && !alive(tray.ProcessId));
check('proc-helper exits with the agent', !!helperProc && !alive(helperProc.ProcessId));

browser.close();
await stopEdge();
for (const pid of mine) if (alive(pid)) execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
const errors = fs.readFileSync(path.join(DATA, 'agent.log'), 'utf8').split('\n').filter((l) => / (ERROR|WARN) /.test(l));
console.log(`\nagent log warnings/errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
