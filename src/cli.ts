// Command-line companion: `AgentMonitor.exe status|pair|stop` (or `npm run status|pair|stop` from source).
import http from 'node:http';
import QRCode from 'qrcode';
import type { Config } from './config.ts';

export const CLI_COMMANDS = new Set(['status', 'pair', 'stop']);

function call(cfg: Config, method: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: cfg.adminPort, path, method, headers: { 'X-Agent-Client': 'cli', 'Content-Length': 0 }, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const body = JSON.parse(data || '{}');
            if ((res.statusCode ?? 500) >= 400) reject(new Error(body.error ?? `HTTP ${res.statusCode}`));
            else resolve(body);
          } catch {
            reject(new Error(`Unexpected reply (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Agent Monitor is not running.')));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const ICON: Record<string, string> = { dead: '✖', 'rc-lost': '⚠', working: '●', waiting: '○', ended: '·' };

/** Runs one command against the running agent; returns the process exit code. */
export async function runCliCommand(cfg: Config, cmd: string): Promise<number> {
  try {
    if (cmd === 'status') {
      const s = await call(cfg, 'GET', '/api/state');
      console.log(`${s.agent.host} · Agent Monitor ${s.agent.version} · phone URL: ${s.agent.publicUrl ?? '(Tailscale not set up yet)'}`);
      for (const a of s.apps) console.log(`  ${a.running ? '●' : '○'} ${a.name}`);
      console.log('');
      for (const v of s.sessions) {
        const where = v.host === 'cli' ? 'Terminal' : 'Claude app';
        const rc = v.rc.state === 'on' ? 'Remote Control on' : v.rc.expected ? 'Remote Control lost' : 'no Remote Control';
        console.log(`${ICON[v.health] ?? '?'} ${v.health.padEnd(8)} ${where.padEnd(11)} ${v.title}`);
        console.log(`  ${''.padEnd(19)} ${v.detail} · ${rc}${v.pid ? `  (pid ${v.pid})` : ''}`);
      }
      if (!s.sessions.length) console.log('No sessions right now.');
    } else if (cmd === 'pair') {
      const p = await call(cfg, 'POST', '/api/admin/pairing');
      console.log(`Pairing code: ${p.code}  (valid for 15 minutes)`);
      if (p.link) {
        console.log(await QRCode.toString(p.link, { type: 'terminal', small: true }));
        console.log(`Or open ${p.url} on the iPhone.`);
      } else {
        console.log('The phone address is not ready yet: set up Tailscale first (see the Phone setup page).');
      }
    } else if (cmd === 'stop') {
      await call(cfg, 'POST', '/api/admin/shutdown');
      console.log('Agent Monitor is stopping.');
    }
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
