import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Tailscale } from '../src/tailscale.ts';
import { compileFake, memoryLog, tempDir } from './helpers.ts';

// A fake tailscale.exe that prints what the real CLI prints (status --json, serve status --json, serve --bg).
const FAKE = `
using System; using System.IO;
static class Fake {
  static int Main(string[] a) {
    string dir = Environment.GetEnvironmentVariable("FAKE_TS_DIR");
    string args = string.Join(" ", a);
    File.AppendAllText(Path.Combine(dir, "calls.txt"), args + "\\n");
    Func<string, bool> has = n => File.Exists(Path.Combine(dir, n));
    if (has("daemon-down")) { Console.Error.WriteLine("failed to connect to local tailscaled; it doesn't appear to be running"); return 1; }
    string state = has("logged-out") ? "NeedsLogin" : "Running";
    if (args == "status --json") {
      Console.WriteLine("{\\n  \\"Version\\": \\"1.88.1-t\\",\\n  \\"BackendState\\": \\"" + state + "\\",\\n  \\"Self\\": {\\n    \\"DNSName\\": \\"my-pc.tail1234.ts.net.\\"\\n  }\\n}");
      return 0;
    }
    if (args == "serve status --json") {
      if (!has("serving")) { Console.WriteLine("{}"); return 0; }
      Console.WriteLine("{\\n  \\"TCP\\": {\\n    \\"443\\": {\\n      \\"HTTPS\\": true\\n    }\\n  },\\n  \\"Web\\": {\\n    \\"my-pc.tail1234.ts.net:443\\": {\\n      \\"Handlers\\": {\\n        \\"/\\": {\\n          \\"Proxy\\": \\"http://127.0.0.1:" + Environment.GetEnvironmentVariable("FAKE_TS_PORT") + "\\"\\n        }\\n      }\\n    }\\n  }\\n}");
      return 0;
    }
    if (a.Length > 0 && a[0] == "serve") {
      if (has("https-off")) { Console.Error.WriteLine("Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/serve?node=nXXXX"); return 1; }
      File.WriteAllText(Path.Combine(dir, "serving"), "1");
      Console.WriteLine("Available within your tailnet:\\n\\nhttps://my-pc.tail1234.ts.net/\\n|-- proxy http://127.0.0.1:7420\\n\\nServe started and running in the background.");
      return 0;
    }
    return 2;
  }
}`;

const dir = tempDir(undefined);
const state = path.join(dir, 'state');
const saved = { pf: process.env.ProgramFiles, pf86: process.env['ProgramFiles(x86)'] };
const PORT = 7420;

before(() => {
  compileFake(path.join(dir, 'Tailscale'), 'tailscale.exe', FAKE);
  fs.mkdirSync(state);
  process.env.ProgramFiles = dir; // the agent looks in %ProgramFiles%\Tailscale first
  process.env['ProgramFiles(x86)'] = dir;
  process.env.FAKE_TS_DIR = state;
  process.env.FAKE_TS_PORT = String(PORT);
});
after(() => {
  process.env.ProgramFiles = saved.pf;
  process.env['ProgramFiles(x86)'] = saved.pf86;
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f));
});
const flag = (name: string) => fs.writeFileSync(path.join(state, name), '1');
const calls = () => fs.readFileSync(path.join(state, 'calls.txt'), 'utf8').trim().split('\n');

test('signed in, not serving yet: no phone address', async () => {
  const s = await new Tailscale(PORT, memoryLog()).refresh(true);
  assert.equal(s.installed, true);
  assert.equal(s.running, true);
  assert.equal(s.dnsName, 'my-pc.tail1234.ts.net');
  assert.equal(s.serving, false);
  assert.equal(s.url, undefined);
});

test('"Turn on phone address" runs tailscale serve and then reports the https address', async () => {
  const ts = new Tailscale(PORT, memoryLog());
  const r = await ts.enableServe();
  assert.deepEqual(r, { ok: true, message: 'Phone address: https://my-pc.tail1234.ts.net' });
  assert.ok(calls().includes(`serve --bg --https=443 http://127.0.0.1:${PORT}`), calls().join(' | '));
  assert.equal(ts.status.url, 'https://my-pc.tail1234.ts.net');
});

test('serving a different port does not count', async () => {
  flag('serving');
  const s = await new Tailscale(PORT + 1, memoryLog()).refresh(true);
  assert.equal(s.serving, false);
});

test('HTTPS certificates off in the tailnet: the message with the link is passed on', async () => {
  flag('https-off');
  const r = await new Tailscale(PORT, memoryLog()).enableServe();
  assert.equal(r.ok, false);
  assert.match(r.message, /login\.tailscale\.com\/f\/serve/);
});

test('logged out: not running, and serve is not even asked', async () => {
  flag('logged-out');
  const s = await new Tailscale(PORT, memoryLog()).refresh(true);
  assert.equal(s.running, false);
  assert.equal(s.state, 'NeedsLogin');
  assert.equal(calls().some((c) => c.startsWith('serve')), false);
});

test('Tailscale service not running: the reason is shown, not a stack of command output', async () => {
  flag('daemon-down');
  const s = await new Tailscale(PORT, memoryLog()).refresh(true);
  assert.equal(s.running, false);
  assert.equal(s.state, "failed to connect to local tailscaled; it doesn't appear to be running");
});

test('results are cached for a minute unless forced', async () => {
  const ts = new Tailscale(PORT, memoryLog());
  await ts.refresh(true);
  const n = calls().length;
  await ts.refresh();
  assert.equal(calls().length, n);
  await ts.refresh(true);
  assert.ok(calls().length > n);
});
