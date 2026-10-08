import fs from 'node:fs';
import { descendants, type Snapshot } from '../proc/helper.ts';
import type { ChildProc, LastMessage } from '../types.ts';
import { truncate } from '../util.ts';

const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe']);

/** Descendants of a session process, minus the console hosts every console app has. */
export function childProcs(snap: Snapshot, pid: number): ChildProc[] {
  return descendants(snap, pid)
    .filter((p) => !CONSOLE_HOSTS.has(p.name.toLowerCase()))
    .map((p) => ({ pid: p.pid, name: p.name, startMs: p.startMs, cpuMs: p.cpuMs, cmd: p.cmd }));
}

export function newest(...msgs: (LastMessage | undefined)[]): LastMessage | undefined {
  let best: LastMessage | undefined;
  for (const m of msgs) if (m && (!best || (m.at ?? 0) >= (best.at ?? 0))) best = m;
  return best ? { ...best, text: truncate(best.text, 280) } : undefined;
}

export function maxDefined(...values: (number | undefined)[]): number | undefined {
  let best: number | undefined;
  for (const v of values) if (v !== undefined && Number.isFinite(v) && (best === undefined || v > best)) best = v;
  return best;
}

export function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Short human summary of a tool call's input. */
export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.command ??
    input.cmd ??
    input.description ??
    input.file_path ??
    input.notebook_path ??
    input.url ??
    input.query ??
    input.pattern ??
    input.prompt ??
    Object.values(input).find((v) => typeof v === 'string');
  if (Array.isArray(pick)) return truncate(pick.join(' '), 160);
  // Nothing readable (e.g. an MCP call with only structured input): the tool name alone says it.
  return typeof pick === 'string' ? truncate(pick, 160) : '';
}
