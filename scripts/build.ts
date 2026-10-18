// Builds dist/AgentMonitor.exe: one file holding Node, the agent, the web app, the tray script and the
// process helper (Node "single executable application"). Run with `npm run build`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';

const require = createRequire(import.meta.url);
const { inject } = require('postject') as { inject: (file: string, name: string, data: Buffer, opts: { sentinelFuse: string }) => Promise<void> };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'AgentMonitor.exe');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version: string = pkg.version;
const step = (s: string) => console.log(`- ${s}`);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

step('compiling the process helper');
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const helperExe = path.join(BUILD, 'proc-helper.exe');
execFileSync(csc, ['-nologo', '-optimize+', '-target:exe', '-platform:x64', `-out:${helperExe}`, path.join(ROOT, 'helper', 'ProcHelper.cs')], { stdio: 'inherit' });

step('bundling the agent');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(BUILD, 'agent.cjs'),
  define: {
    AGENT_MONITOR_VERSION: JSON.stringify(version),
    AGENT_MONITOR_BUILD: JSON.stringify(new Date().toISOString()),
    'import.meta.url': '__importMetaUrl',
  },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
});

step('packing the web app, tray script and helper');
const assets: Record<string, string> = { 'tray.ps1': path.join(ROOT, 'scripts', 'tray.ps1'), 'proc-helper.exe': helperExe };
for (const f of fs.readdirSync(path.join(ROOT, 'web'), { recursive: true }) as string[]) {
  const full = path.join(ROOT, 'web', f);
  if (fs.statSync(full).isFile()) assets[`web/${f.replace(/\\/g, '/')}`] = full;
}
const seaConfig = path.join(BUILD, 'sea-config.json');
const blob = path.join(BUILD, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(BUILD, 'agent.cjs'), output: blob, disableExperimentalSEAWarning: true, assets }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

step('embedding the agent into a copy of Node');
fs.copyFileSync(process.execPath, OUT);
await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
console.log('  (that warning is expected: the signature of node.exe no longer matches, so it is removed next)');

step('naming the exe and giving it its icon');
// Node's own signature is no longer valid after the changes, so it is dropped (ignoreCert).
const exe = ResEdit.NtExecutable.from(fs.readFileSync(OUT), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'app.ico')));
for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map((i) => i.data));
}
const [major, minor, patch] = version.split('.').map(Number);
for (const vi of ResEdit.Resource.VersionInfo.fromEntries(res.entries)) {
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(lang, {
      FileDescription: 'Agent Monitor',
      ProductName: 'Agent Monitor',
      CompanyName: 'Agent Monitor',
      InternalName: 'AgentMonitor',
      OriginalFilename: 'AgentMonitor.exe',
      FileVersion: version,
      ProductVersion: version,
      LegalCopyright: '',
    });
  }
  vi.setFileVersion(major, minor, patch, 0);
  vi.setProductVersion(major, minor, patch, 0);
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(OUT, Buffer.from(exe.generate()));

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`\nBuilt ${path.relative(ROOT, OUT)} (${mb} MB, Agent Monitor ${version}).`);
