// Small command-line companion: `npm run status`, `npm run pair`, `npm run stop`.
import http from 'node:http';
import QRCode from 'qrcode';
import { loadConfig } from './config.ts';

const cfg = loadConfig();

function call(method: string, path: string): Promise<any> {
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
    req.on('error', () => reject(new Error('Agent Monitor is not running. Start it with: npm start')));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const ICON: Record<string, string> = {
  dead: '✖', 'rc-lost': '⚠', stuck: '⏸', approval: '✋', working: '●', waiting: '○', ended: '·',
};

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'status') {
    const s = await call('GET', '/api/state');
    console.log(`${s.agent.host} · Agent Monitor ${s.agent.version} · phone URL: ${s.agent.publicUrl ?? '(Tailscale not set up yet)'}`);
    for (const a of s.apps) console.log(`  ${a.running ? '●' : '○'} ${a.name}${a.detail ? ` (${a.detail})` : ''}`);
    console.log('');
    for (const v of s.sessions) {
      const tool = `${v.tool === 'claude' ? 'Claude' : 'Codex'} ${v.host === 'cli' ? 'CLI' : 'app'}`;
      console.log(`${ICON[v.health] ?? '?'} ${v.health.padEnd(8)} ${tool.padEnd(11)} ${v.title}`);
      console.log(`  ${''.padEnd(19)} ${v.detail}${v.pid ? `  (pid ${v.pid})` : ''}`);
    }
    if (!s.sessions.length) console.log('No sessions right now.');
  } else if (cmd === 'pair') {
    const p = await call('POST', '/api/admin/pairing');
    console.log(`Pairing code: ${p.code}  (valid for 15 minutes)`);
    if (p.link) {
      console.log(await QRCode.toString(p.link, { type: 'terminal', small: true }));
      console.log(`Or open ${p.url} on the iPhone.`);
    } else {
      console.log('The phone address is not ready yet: set up Tailscale first (see README).');
    }
  } else if (cmd === 'stop') {
    await call('POST', '/api/admin/shutdown');
    console.log('Agent Monitor is stopping.');
  } else {
    console.log('Usage: node src/cli.ts [status|pair|stop]');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
