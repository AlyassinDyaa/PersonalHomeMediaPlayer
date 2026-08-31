/**
 * Draw the Home Screen icon.
 *
 * Written rather than drawn in an editor so the icon can be regenerated at any
 * size without keeping a binary source around. Supersampled four times and
 * averaged down, which is what gives the curve of the triangle a clean edge at
 * 180 pixels.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const SS = 4; // supersampling factor

/** sRGB-ish blend of two colours. */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * One icon, as raw RGBA.
 *
 * A deep red field with a single play triangle. iOS masks the corners itself,
 * so the colour runs to the edge rather than sitting on a drawn square.
 */
function render(size) {
  const w = size * SS;
  const pixels = new Uint8Array(w * w * 4);

  // Warm at the top left, dark at the bottom right, so the icon reads as lit
  // from one side rather than flat.
  const top = [235, 30, 45];
  const bottom = [104, 8, 22];

  const cx = w / 2;
  const cy = w / 2;
  // A triangle that looks centred rather than measuring as centred: the eye
  // puts the balance point of a triangle nearer its leading edge.
  const r = w * 0.29;
  const ax = cx - r * 0.78;
  const bx = cx + r * 0.92;

  const p1 = [ax, cy - r];
  const p2 = [ax, cy + r];
  const p3 = [bx, cy];

  const inside = (x, y) => {
    const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
    const d1 = sign(x, y, p1[0], p1[1], p2[0], p2[1]);
    const d2 = sign(x, y, p2[0], p2[1], p3[0], p3[1]);
    const d3 = sign(x, y, p3[0], p3[1], p1[0], p1[1]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.35 + (y / w) * 0.65;
      let [r8, g8, b8] = mix(top, bottom, Math.min(1, t));

      // A soft highlight behind the triangle lifts it off the field.
      const dx = (x - cx) / w;
      const dy = (y - cy) / w;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.6);
      r8 = Math.min(255, r8 + glow * 26);
      g8 = Math.min(255, g8 + glow * 10);
      b8 = Math.min(255, b8 + glow * 12);

      if (inside(x + 0.5, y + 0.5)) { r8 = 255; g8 = 255; b8 = 255; }

      const i = (y * w + x) * 4;
      pixels[i] = r8;
      pixels[i + 1] = g8;
      pixels[i + 2] = b8;
      pixels[i + 3] = 255;
    }
  }

  // Average each SS x SS block down to one pixel.
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function writePng(file, size, rgba) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }
  const png = Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log('  ' + file + '  ' + size + 'x' + size + '  ' + png.length + ' bytes');
}

const targets = process.argv.slice(2);
for (const target of targets) {
  const size = Number(target.match(/-(\d+)\.png$/)?.[1]);
  if (!size) throw new Error('cannot read a size from ' + target);
  writePng(target, size, render(size));
}
