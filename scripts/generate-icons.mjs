#!/usr/bin/env node
/**
 * Generate the AURA app icon set.
 *
 * The repository ships no third-party artwork, so the icon is generated: a
 * soft radial gradient disc on a dark rounded square. Run `npm run icons`
 * before packaging; `npm run tauri icon src-tauri/icons/icon.png` expands it
 * into the platform-specific formats (`.ico`, `.icns`, Android densities).
 */

import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'src-tauri', 'icons');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const center = (size - 1) / 2;
  const radius = size * 0.38;

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const offset = rowStart + 1 + x * 4;

      // Rounded-square background with a soft vignette.
      const corner = Math.max(Math.abs(x - center) / center, Math.abs(y - center) / center);
      const background = corner > 0.97 ? 0 : 1 - Math.max(0, corner - 0.75) * 3.4;

      // Teal-to-cyan radial gradient disc, brighter to the upper left.
      const glow = Math.max(0, 1 - distance / radius);
      const highlight = Math.max(0, 1 - Math.hypot(x - size * 0.36, y - size * 0.34) / (radius * 0.9));

      const r = Math.round(16 + glow * 60 + highlight * 90);
      const g = Math.round(22 + glow * 150 + highlight * 70);
      const b = Math.round(30 + glow * 190 + highlight * 40);
      const alpha = Math.round(255 * Math.max(background, glow * 0.95));

      raw[offset] = Math.min(255, r);
      raw[offset + 1] = Math.min(255, g);
      raw[offset + 2] = Math.min(255, b);
      raw[offset + 3] = Math.min(255, alpha);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [512, 128, 32]) {
  const name = size === 512 ? 'icon.png' : `${size}x${size}.png`;
  writeFileSync(resolve(outDir, name), png(size));
  process.stdout.write(`wrote src-tauri/icons/${name}\n`);
}
