import fs from 'node:fs';

const MAX_INITIAL_BYTES = 8 * 1024 * 1024;
const MAX_STEP_BYTES = 16 * 1024 * 1024;

/**
 * Follows an append-only JSONL file (a transcript) and folds each new line into a state
 * object, so a 50 MB transcript is read once and then only its new bytes.
 */
export class JsonlFollower<S> {
  state: S;
  mtimeMs = 0;
  size = 0;
  lastUsed = Date.now();
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private readonly file: string;
  private readonly init: () => S;
  private readonly reduce: (state: S, entry: any) => void;

  constructor(file: string, init: () => S, reduce: (state: S, entry: any) => void) {
    this.file = file;
    this.init = init;
    this.reduce = reduce;
    this.state = init();
  }

  /** Reads anything new. Returns false when the file can't be read. */
  update(): boolean {
    this.lastUsed = Date.now();
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs) return true;
    if (st.size < this.offset) this.reset();

    let start = this.offset;
    let skipFirstLine = false;
    if (start === 0 && st.size > MAX_INITIAL_BYTES) {
      start = st.size - MAX_INITIAL_BYTES;
      skipFirstLine = true;
    } else if (st.size - start > MAX_STEP_BYTES) {
      start = st.size - MAX_STEP_BYTES;
      this.partial = Buffer.alloc(0);
      skipFirstLine = true;
    }

    const length = st.size - start;
    const buf = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r');
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buf, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    let data = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    let pos = 0;
    if (skipFirstLine) {
      const nl = data.indexOf(10);
      pos = nl < 0 ? data.length : nl + 1;
    }
    for (;;) {
      const nl = data.indexOf(10, pos);
      if (nl < 0) break;
      const line = data.subarray(pos, nl).toString('utf8').trim();
      pos = nl + 1;
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this.reduce(this.state, entry);
    }
    this.partial = Buffer.from(data.subarray(pos));
    this.offset = st.size;
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return true;
  }

  private reset(): void {
    this.state = this.init();
    this.offset = 0;
    this.partial = Buffer.alloc(0);
  }
}

/** Keeps one follower per file and forgets files nobody asked about for a while. */
export class FollowerCache<S> {
  private readonly map = new Map<string, JsonlFollower<S>>();
  private readonly init: () => S;
  private readonly reduce: (state: S, entry: any) => void;

  constructor(init: () => S, reduce: (state: S, entry: any) => void) {
    this.init = init;
    this.reduce = reduce;
  }

  get(file: string): JsonlFollower<S> | undefined {
    let f = this.map.get(file);
    if (!f) {
      f = new JsonlFollower(file, this.init, this.reduce);
      this.map.set(file, f);
    }
    return f.update() ? f : undefined;
  }

  prune(maxIdleMs = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [k, f] of this.map) if (now - f.lastUsed > maxIdleMs) this.map.delete(k);
  }
}

/** First line of a JSONL file, parsed (Codex keeps session metadata there). */
export function readFirstLine(file: string, maxBytes = 4 * 1024 * 1024): any {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    let size = 64 * 1024;
    for (;;) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) return JSON.parse(buf.subarray(0, nl).toString('utf8'));
      if (n < size || size >= maxBytes) return n > 0 ? JSON.parse(buf.subarray(0, n).toString('utf8')) : undefined;
      size *= 4;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
