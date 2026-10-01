import fs from 'node:fs';
import path from 'node:path';

/** Windows FILETIME (100 ns ticks since 1601) as a decimal string -> Unix ms. */
export function fileTimeToMs(ft: string | undefined | null): number | undefined {
  if (!ft || !/^\d+$/.test(ft)) return undefined;
  return Number(BigInt(ft) / 10000n - 11644473600000n);
}

export function normPath(p: string | undefined): string {
  if (!p) return '';
  let s = p.replace(/\//g, '\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s.toLowerCase();
}

export function baseName(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1];
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function readJsonFile<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function statSafe(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

export function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Split a Windows command line into arguments (CommandLineToArgvW rules, close enough
 * for the flags we look at).
 */
export function splitCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      let n = 0;
      while (cmd[i] === '\\') {
        n++;
        i++;
      }
      if (cmd[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQuotes = !inQuotes;
        has = true;
      } else {
        cur += '\\'.repeat(n);
        i--;
        has = true;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      has = true;
      continue;
    }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** Value that follows a flag, e.g. flagValue(['--resume','x'], ['-r','--resume']) === 'x'. */
export function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n) {
        const v = args[i + 1];
        return v !== undefined && !v.startsWith('-') ? v : undefined;
      }
      if (a.startsWith(n + '=')) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
