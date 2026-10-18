import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';

declare const AGENT_MONITOR_VERSION: string | undefined;
declare const AGENT_MONITOR_BUILD: string | undefined;

/** Built into AgentMonitor.exe; read from package.json when running from source. */
export const VERSION: string =
  typeof AGENT_MONITOR_VERSION === 'string' ? AGENT_MONITOR_VERSION : JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** Identifies one build of the exe (its embedded files are unpacked again when it changes). */
export const BUILD: string = typeof AGENT_MONITOR_BUILD === 'string' ? AGENT_MONITOR_BUILD : 'source';
