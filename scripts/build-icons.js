// Draws the app logo, the word "ping" in white on coral, with no image tools needed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BACKGROUND = [200, 84, 63];
const FOREGROUND = [255, 255, 255];
const SUPERSAMPLE = 3;

const STROKE_RADIUS = 0.024;
const DOT_RADIUS = 0.03;
const BOWL_RADIUS = 0.078;
const TOP = 0.4;
const MIDDLE = TOP + BOWL_RADIUS;
const BASELINE = 0.556;
const BOTTOM = 0.66;

// Each letter's straight strokes, as lines from (x1, y1) to (x2, y2) on a 0-1 canvas.
const LINES = [
  [0.18, TOP, 0.18, BOTTOM], // p
  [0.385, TOP, 0.385, BASELINE], // i
  [0.465, TOP, 0.465, BASELINE], // n
  [0.621, MIDDLE, 0.621, BASELINE],
  [0.82, TOP, 0.82, 0.6], // g
];

// Each letter's curves. `part` limits a circle to its top or bottom half.
const CURVES = [
  { x: 0.258, y: MIDDLE, part: 'all' }, // p
  { x: 0.543, y: MIDDLE, part: 'top' }, // n
  { x: 0.742, y: MIDDLE, part: 'all' }, // g
  { x: 0.742, y: 0.6, part: 'bottom' },
];
const DOT = { x: 0.385, y: 0.335 }; // i

function nearStroke(x, y) {
  if (Math.hypot(x - DOT.x, y - DOT.y) <= DOT_RADIUS) return true;
  const onCurve = CURVES.some((curve) => {
    if ((curve.part === 'top' && y > curve.y) || (curve.part === 'bottom' && y < curve.y)) return false;
    return Math.abs(Math.hypot(x - curve.x, y - curve.y) - BOWL_RADIUS) <= STROKE_RADIUS;
  });
  if (onCurve) return true;
  return LINES.some(([x1, y1, x2, y2]) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const along = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + along * dx), y - (y1 + along * dy)) <= STROKE_RADIUS;
  });
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

function png(size) {
  const rows = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let row = 0; row < size; row += 1) {
    rows[offset++] = 0;
    for (let column = 0; column < size; column += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          if (nearStroke((column + (sx + 0.5) / SUPERSAMPLE) / size, (row + (sy + 0.5) / SUPERSAMPLE) / size)) covered += 1;
        }
      }
      const coverage = covered / SUPERSAMPLE ** 2;
      for (let channel = 0; channel < 3; channel += 1) {
        rows[offset++] = Math.round(BACKGROUND[channel] + (FOREGROUND[channel] - BACKGROUND[channel]) * coverage);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(join(OUT_DIR, name), png(size));
}
