/**
 * Draws the home-screen icon.
 *
 * Added to the Home Screen on an iPad, a web page without an icon is given a
 * screenshot of itself, which looks like a mistake. This writes a real one.
 *
 * Written by hand rather than with an image library: it is a coloured square
 * and a triangle, and a dependency that has to be installed, audited and
 * updated forever is a poor trade for that. iOS rounds the corners itself, so
 * the square is drawn full bleed.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Vite copies this folder to the site root untouched, which is what an
// absolute /icon-180.png in the page needs.
const OUT_DIR = path.resolve(HERE, '..', 'desktop', 'web', 'public');

/** Netflix-ish red, matching the default the header uses. */
const BACKGROUND = [229, 9, 20];
const MARK = [255, 255, 255];

/** Anti-aliasing: each pixel is sampled this many times across and down. */
const SAMPLES = 4;

/**
 * Whether a point falls inside the play triangle.
 *
 * Expressed in fractions of the icon so it scales to any size, and nudged right
 * because a triangle centred on its bounding box looks left-heavy.
 */
function insideTriangle(x, y) {
  const left = 0.34;
  const right = 0.72;
  const top = 0.25;
  const bottom = 0.75;

  if (x < left || x > right) return false;
  // How far across the triangle this column is, 0 at the flat edge and 1 at
  // the point; the triangle narrows to nothing as it approaches the tip.
  const across = (x - left) / (right - left);
  const halfHeight = (1 - across) * (bottom - top) / 2;
  const middle = (top + bottom) / 2;
  return y >= middle - halfHeight && y <= middle + halfHeight;
}

function drawIcon(size) {
  // One filter byte per row, then three bytes per pixel.
  const raw = Buffer.alloc(size * (size * 3 + 1));

  for (let row = 0; row < size; row++) {
    const rowStart = row * (size * 3 + 1);
    raw[rowStart] = 0;                       // filter: none

    for (let column = 0; column < size; column++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (column + (sx + 0.5) / SAMPLES) / size;
          const y = (row + (sy + 0.5) / SAMPLES) / size;
          if (insideTriangle(x, y)) hits++;
        }
      }

      const coverage = hits / (SAMPLES * SAMPLES);
      const offset = rowStart + 1 + column * 3;
      for (let channel = 0; channel < 3; channel++) {
        raw[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - coverage) + MARK[channel] * coverage,
        );
      }
    }
  }

  return raw;
}

/** CRC32, as PNG requires after every chunk. */
const crc32 = zlib.crc32 ?? ((buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
});

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;      // bits per channel
  header[9] = 2;      // truecolour, no alpha
  header[10] = 0;     // deflate
  header[11] = 0;     // adaptive filtering
  header[12] = 0;     // not interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// 180 is what iOS asks for; 512 covers Android and anything that wants larger.
for (const size of [180, 512]) {
  const file = path.join(OUT_DIR, 'icon-' + size + '.png');
  fs.writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log('wrote ' + path.relative(process.cwd(), file)
    + ' (' + (fs.statSync(file).size / 1024).toFixed(1) + ' KB)');
}
