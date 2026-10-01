// Draws the app icons (PNG) with no dependencies: `npm run icons`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

type RGB = [number, number, number];
const TOP: RGB = [67, 56, 202];
const BOTTOM: RGB = [15, 23, 42];
const WHITE: RGB = [255, 255, 255];
const GREEN: RGB = [52, 211, 153];

const PULSE: [number, number][] = [
  [0.17, 0.56], [0.33, 0.56], [0.42, 0.34], [0.53, 0.72], [0.60, 0.48], [0.645, 0.56],
];
const DOT: [number, number] = [0.79, 0.56];

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const cover = (d: number) => Math.max(0, Math.min(1, 0.5 - d));
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function draw(size: number, opts: { background: boolean; scale?: number }): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const s = size * (opts.scale ?? 1);
  const off = (size - s) / 2;
  const half = 0.034 * s;
  const pts = PULSE.map(([x, y]) => [off + x * s, off + y * s]);
  const [cx, cy] = [off + DOT[0] * s, off + DOT[1] * s];
  const r = 0.062 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      let line = Infinity;
      for (let i = 0; i < pts.length - 1; i++) line = Math.min(line, segDist(fx, fy, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
      const lineA = cover(line - half);
      const dotD = Math.hypot(fx - cx, fy - cy);
      const dotA = cover(dotD - r);
      const haloA = cover(Math.abs(dotD - r * 1.75) - r * 0.2) * 0.45;
      const i = (y * size + x) * 4;
      if (opts.background) {
        let c = mix(TOP, BOTTOM, (x + y) / (2 * size));
        c = mix(c, GREEN, haloA);
        c = mix(c, WHITE, lineA);
        c = mix(c, GREEN, dotA);
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = 255;
      } else {
        // Monochrome badge: white shapes on transparent.
        const a = Math.max(lineA, dotA, haloA);
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const icons: [string, number, { background: boolean; scale?: number }][] = [
  ['apple-touch-icon.png', 180, { background: true }],
  ['icon-192.png', 192, { background: true }],
  ['icon-512.png', 512, { background: true }],
  ['icon-maskable-512.png', 512, { background: true, scale: 0.82 }],
  ['favicon-32.png', 32, { background: true }],
  ['badge-72.png', 72, { background: false }],
];
for (const [name, size, opts] of icons) {
  fs.writeFileSync(path.join(OUT, name), png(size, draw(size, opts)));
  console.log('wrote', name);
}
