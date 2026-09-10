/**
 * The library's own mark, drawn rather than fetched.
 *
 * A rounded square carrying a blue-to-violet gradient, a dark disc set into
 * it, and a play triangle cut out of the disc so the gradient shows through
 * the cut. The triangle is the only shape that says "this plays things"
 * without a word of text, and at the size a Home Screen actually draws an
 * icon — under a centimetre — a word would be unreadable anyway.
 *
 * Everything is rasterised here, in this file, because the project has no
 * image library and adding one to draw four shapes would be a strange trade.
 * The output is a PNG written by hand: filtered scanlines, deflated with
 * zlib, wrapped in the three chunks a PNG needs. Windows wants an ICO as
 * well, which is a small header around PNGs it can hold verbatim.
 *
 *   node tools/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

/* --------------------------------------------------------------- colour --- */

/** The two ends of the gradient, and the disc between them. */
const START = [0x4c, 0x8d, 0xff];   // a bright blue, top left
const END = [0xb4, 0x3c, 0xf0];     // violet, bottom right
const DISC = [0x0b, 0x0b, 0x14];    // very nearly the library's own black

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/* ---------------------------------------------------------- the drawing --- */

/**
 * One icon, at one size, as raw RGBA.
 *
 * Sampled four times across and four down per pixel rather than once. Every
 * edge here is a curve or a diagonal, and at 180 pixels a single sample per
 * pixel leaves them visibly stepped — the corners of the rounded square worst
 * of all, because the eye knows exactly what shape they are meant to be.
 */
function draw(size) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;                        // samples per axis
  const r = size * 0.225;             // corner radius, near enough Apple's
  const cx = size / 2;
  const cy = size / 2;
  const discR = size * 0.315;

  /* The triangle, pointing right, centred on the disc and optically balanced:
     a centred triangle looks left-heavy, so it is nudged right a little. */
  const tw = size * 0.30;
  const th = size * 0.33;
  const tx = cx - tw * 0.36 + size * 0.022;
  const ax = tx;
  const ay = cy - th / 2;
  const bx = tx;
  const by = cy + th / 2;
  const px = tx + tw;
  const py = cy;

  /** Distance from a rounded square's edge; negative inside. */
  const roundedSquare = (x, y) => {
    const dx = Math.abs(x - cx) - (size / 2 - r);
    const dy = Math.abs(y - cy) - (size / 2 - r);
    const ox = Math.max(dx, 0);
    const oy = Math.max(dy, 0);
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - r;
  };

  /** Whether a point is inside the play triangle. */
  const inTriangle = (x, y) => {
    const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const s2 = (px - bx) * (y - by) - (py - by) * (x - bx);
    const s3 = (ax - px) * (y - py) - (ay - py) * (x - px);
    return (s1 <= 0 && s2 <= 0 && s3 <= 0) || (s1 >= 0 && s2 >= 0 && s3 >= 0);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px2 = x + (sx + 0.5) / S;
          const py2 = y + (sy + 0.5) / S;

          if (roundedSquare(px2, py2) > 0) continue;   // outside the tile

          /* The gradient runs corner to corner. */
          const t = Math.min(1, Math.max(0, (px2 + py2) / (size * 2)));
          let colour = mix(START, END, t);

          /* The disc, except where the triangle cuts through it. */
          const inDisc = Math.hypot(px2 - cx, py2 - cy) <= discR;
          if (inDisc && !inTriangle(px2, py2)) colour = DISC;

          rSum += colour[0];
          gSum += colour[1];
          bSum += colour[2];
          aSum += 255;
        }
      }

      const n = S * S;
      const i = (y * size + x) * 4;
      if (aSum === 0) continue;
      /* Averaged over every sample, including the empty ones outside the
         tile, so the edge fades rather than stepping. */
      out[i] = Math.round(rSum / (aSum / 255));
      out[i + 1] = Math.round(gSum / (aSum / 255));
      out[i + 2] = Math.round(bSum / (aSum / 255));
      out[i + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------ the file --- */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** RGBA pixels to a PNG. Every scanline unfiltered, which zlib handles well. */
function png(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;      // bits per channel
  head[9] = 6;      // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * One image inside an ICO, in the format Windows has always understood.
 *
 * An ICO may hold a PNG, and every size here was one — which is why the file
 * on disk looked right and the pinned copy did not. The shell reads PNG
 * entries in some places and not in others, and the taskbar is one of the
 * places it does badly: it falls back to whatever it can decode and scales
 * it, so a mark drawn at exactly the right size gets replaced by a blurred
 * one that had to be resized.
 *
 * So everything below 256 is written as a DIB instead, which is what the
 * format meant originally and what every part of Windows reads the same way.
 * A DIB in an icon is upside down, carries its height doubled to account for
 * a mask that follows the colour, and pads every row to four bytes.
 */
function dib(rgba, size) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);       // colour and mask together
  head.writeUInt16LE(1, 12);            // planes
  head.writeUInt16LE(32, 14);           // bits per pixel
  head.writeUInt32LE(0, 16);            // uncompressed

  /* Bottom-up, and blue first. */
  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const i = from + x * 4;
      const o = (y * size + x) * 4;
      colour[o] = rgba[i + 2];
      colour[o + 1] = rgba[i + 1];
      colour[o + 2] = rgba[i];
      colour[o + 3] = rgba[i + 3];
    }
  }

  /* The mask is only consulted for one-bit transparency, which the alpha
     channel above has already answered. Left at zero: nothing masked out. */
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  return Buffer.concat([head, colour, mask]);
}

/** An ICO: a small directory, then each image in whichever form suits it. */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);                 // 1 = icon
  head.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 256 is written as 0, which is the format's way of saying "not a byte".
    dir[at] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0;                        // colours in the palette
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4);           // colour planes
    dir.writeUInt16LE(32, at + 6);          // bits per pixel
    dir.writeUInt32LE(entry.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([head, dir, ...entries.map((entry) => entry.data)]);
}

/* ----------------------------------------------------------------- run --- */

const webDir = path.join(ROOT, 'desktop', 'web', 'public');
const buildDir = path.join(ROOT, 'desktop', 'build');
fs.mkdirSync(buildDir, { recursive: true });

/* The sizes a Home Screen, a manifest and a browser tab ask for. */
for (const size of [180, 192, 512, 1024]) {
  const file = path.join(webDir, 'icon-' + size + '.png');
  fs.writeFileSync(file, png(draw(size), size));
  console.log('  ' + path.relative(ROOT, file));
}

/* And the one Windows wants, holding the sizes it actually draws. */
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoFile = path.join(buildDir, 'icon.ico');
fs.writeFileSync(icoFile, ico(icoSizes.map((size) => {
  const pixels = draw(size);
  /* A DIB at every size, including 256.
     A PNG entry is legal and smaller, and most of Windows reads it — but not
     all of it, which is the whole complaint this is answering. Two hundred
     and sixty kilobytes buys away the question of which surface is reading
     it today. */
  return { size, data: dib(pixels, size) };
})));
console.log('  ' + path.relative(ROOT, icoFile) + '  (' + icoSizes.join(', ') + ')');
