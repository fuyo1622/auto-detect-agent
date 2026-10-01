import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const MAX_BYTES = 5 * 1024 * 1024;

export function createLogger(file: string | undefined, toConsole: boolean, verbose = false): Logger {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = file ? (fs.existsSync(file) ? fs.statSync(file).size : 0) : 0;

  const write = (level: string, args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 160 }))).join(' ');
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`;
    if (toConsole) (level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout).write(line);
    if (!file) return;
    try {
      if (size + line.length > MAX_BYTES) {
        fs.renameSync(file, file + '.1');
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // Logging must never take the agent down.
    }
  };

  return {
    debug: (...a) => verbose && write('DEBUG', a),
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  };
}
