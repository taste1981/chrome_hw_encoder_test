#!/usr/bin/env node
// experiments/render-pattern.mjs — renders the exact test pattern from
// lib/test-page.js (backgroundCanvas + drawPattern) to BMP files, so the
// pattern can be inspected visually without running Chrome.
//
// Usage: node experiments/render-pattern.mjs [frame0] [frame1] [...]
// Writes results/pattern-frame<N>.bmp for each frame index.
// Default: renders frame 0.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(PROJECT_DIR, 'results');

// Same generator as test-page.js.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Exact replica of drawScreenPattern from test-page.js.
function renderScreenPattern(w, h, frameIndex) {
  const rgb = Buffer.alloc(w * h * 3);
  const set = (x, y, r, g, b) => {
    const o = (y * w + x) * 3;
    rgb[o] = r;
    rgb[o + 1] = g;
    rgb[o + 2] = b;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) set(x, y, 235, 235, 235);
  }
  // Window panel + 1 px border.
  for (let y = 24; y < h - 24; y++) {
    for (let x = 24; x < w - 24; x++) set(x, y, 255, 255, 255);
  }
  for (let i = 24; i < h - 24; i++) {
    set(24, i, 60, 60, 60);
    set(w - 25, i, 60, 60, 60);
  }
  for (let i = 24; i < w - 24; i++) {
    set(i, 24, 60, 60, 60);
    set(i, h - 25, 60, 60, 60);
  }
  // Static pseudo-text glyph blocks.
  const rows = Math.floor((h - 80) / 24);
  const cols = Math.floor((w - 80) / 14);
  for (let ty = 0; ty < rows; ty++) {
    const y = 40 + ty * 24;
    for (let tx = 0; tx < cols; tx++) {
      const s = mulberry32((tx * 0x27d4eb2f + ty * 0x85ebca6b) >>> 0)();
      if (s >= 0.6) continue;
      const x = 40 + tx * 14;
      for (let yy = 0; yy < 12; yy++) {
        for (let xx = 0; xx < 8; xx++) set(x + xx, y + yy, 20, 20, 20);
      }
      if (s < 0.3) {
        for (let yy = 0; yy < 8; yy++) {
          for (let xx = 0; xx < 4; xx++) set(x + 2 + xx, y + 2 + yy, 20, 20, 20);
        }
      }
    }
  }
  // Moving cursor (approx. stroke outline).
  const cx = 30 + ((frameIndex * 7) % Math.max(64, w - 60));
  const cy = 60 + ((frameIndex * 3) % Math.max(64, h - 120));
  for (let i = 0; i <= 16; i++) set(cx, cy + i, 200, 30, 30);
  for (let i = 0; i < 4; i++) set(cx + 1, cy + i, 200, 30, 30);
  for (let i = 0; i < 5; i++) set(cx + 4, cy + 13 + i, 200, 30, 30);
  for (let i = 0; i < 6; i++) set(cx + 9, cy + 17 + i, 200, 30, 30);
  return rgb;
}

// Exact replica of backgroundCanvas + drawPattern from test-page.js.
function renderPattern(w, h, frameIndex) {
  const rgb = Buffer.alloc(w * h * 3);
  const bgCache = new Map();
  const key = `${w}x${h}`;
  // Static background: gradient + 8x8 block dither.
  let bg = bgCache.get(key);
  if (!bg) {
    bg = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bx = x >> 3;
        const by = y >> 3;
        const n = (mulberry32((bx * 0x85ebca6b + by * 0x27d4eb2f) >>> 0)() * 32) | 0;
        const gx = Math.round((140 * x) / w);
        const gy = Math.round((100 * y) / h);
        const o = (y * w + x) * 3;
        bg[o] = Math.min(255, gx + 30 + n - 16);
        bg[o + 1] = Math.min(255, gy + 50 + n - 16);
        bg[o + 2] = Math.min(255, 120 - gx / 2 + gy / 2 + n - 16);
      }
    }
    bgCache.set(key, bg);
  }
  bg.copy(rgb);

  // Moving bars.
  const shift = (frameIndex * 5) % 64;
  const barColors = [
    [180, 90, 90],
    [90, 170, 90],
    [90, 90, 180],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const band = (x + shift) % 64;
      const bar = band < 16 ? 0 : band < 32 ? 1 : band < 48 ? 2 : -1;
      if (bar >= 0) {
        const o = (y * w + x) * 3;
        rgb[o] = barColors[bar][0];
        rgb[o + 1] = barColors[bar][1];
        rgb[o + 2] = barColors[bar][2];
      }
    }
  }
  // Checkerboard strip.
  for (let y = h - 96; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((((x >> 5) + (y >> 5)) & 1) === 0) {
        const o = (y * w + x) * 3;
        rgb[o] = 90;
        rgb[o + 1] = 180;
        rgb[o + 2] = 190;
      }
    }
  }
  return rgb;
}

// Minimal 24-bit BMP writer (BGR, bottom-up rows, 4-byte row padding).
function writeBMP(rgb, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const imageSize = rowSize * h;
  const buf = Buffer.alloc(54 + imageSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + imageSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 3;
    const dstRow = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 3;
      const d = dstRow + x * 3;
      buf[d] = rgb[s + 2];     // B
      buf[d + 1] = rgb[s + 1]; // G
      buf[d + 2] = rgb[s];     // R
    }
  }
  return buf;
}

const args = process.argv.slice(2);
const screen = args[0] === '--screen';
const frames = (screen ? args.slice(1) : args).map(Number);
const list = frames.length ? frames : [0];
const W = 640;
const H = 360;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const f of list) {
    const name = screen ? `screen-frame${f}` : `pattern-frame${f}`;
    const out = path.join(OUT_DIR, `${name}.bmp`);
    const rgb = screen ? renderScreenPattern(W, H, f) : renderPattern(W, H, f);
    await fs.writeFile(out, writeBMP(rgb, W, H));
    console.log(`wrote ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
