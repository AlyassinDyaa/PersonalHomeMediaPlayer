/**
 * Renders a flat shape as a lit, soft-edged solid.
 *
 * The look — rounded shoulders, light from the top left, a soft shadow beneath
 * — is lighting, not colour, so it cannot be had by filling a path. The shape
 * is rasterised to a mask, a distance transform turns that into a height field
 * with a rounded shoulder, and the surface is lit from that.
 *
 * Any shape can be passed in, so the mark itself stays a separate decision from
 * how it is rendered.
 */

import zlib from 'node:zlib';

/** Samples per pixel, per axis, for edge quality. */
const SAMPLES = 4;

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

export function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Coverage of the shape at every pixel, softened by supersampling. */
function coverageMap(size, inside) {
  const map = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inside(
            (column + (sx + 0.5) / SAMPLES) / size,
            (row + (sy + 0.5) / SAMPLES) / size,
          )) hits++;
        }
      }
      map[row * size + column] = hits / (SAMPLES * SAMPLES);
    }
  }
  return map;
}

/**
 * Distance in pixels from every point to the edge of the set.
 * Two chamfer passes, close enough to true distance for lighting.
 */
function distanceMap(size, isSet) {
  const BIG = 1e9;
  const d = new Float32Array(size * size).fill(BIG);
  for (let i = 0; i < size * size; i++) if (!isSet(i)) d[i] = 0;

  const at = (row, column) => (row < 0 || column < 0 || row >= size || column >= size)
    ? BIG : d[row * size + column];

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const i = row * size + column;
      d[i] = Math.min(d[i], at(row - 1, column) + 1, at(row, column - 1) + 1,
        at(row - 1, column - 1) + 1.414, at(row - 1, column + 1) + 1.414);
    }
  }
  for (let row = size - 1; row >= 0; row--) {
    for (let column = size - 1; column >= 0; column--) {
      const i = row * size + column;
      d[i] = Math.min(d[i], at(row + 1, column) + 1, at(row, column + 1) + 1,
        at(row + 1, column + 1) + 1.414, at(row + 1, column - 1) + 1.414);
    }
  }
  return d;
}

/** Separable box blur, in place. */
function blur(map, size, radius) {
  const scratch = new Float32Array(size * size);
  const span = radius * 2 + 1;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let total = 0;
      for (let k = -radius; k <= radius; k++) {
        total += map[row * size + clamp(column + k, 0, size - 1)];
      }
      scratch[row * size + column] = total / span;
    }
  }
  for (let column = 0; column < size; column++) {
    for (let row = 0; row < size; row++) {
      let total = 0;
      for (let k = -radius; k <= radius; k++) {
        total += scratch[clamp(row + k, 0, size - 1) * size + column];
      }
      map[row * size + column] = total / span;
    }
  }
}

/**
 * Render a mark.
 *
 * @param {number} size pixels square
 * @param {object} options
 * @param {(x:number,y:number)=>boolean} options.shape the solid body
 * @param {object} options.palette body, bodyDark, highlight, rim, shadow, backTop, backBottom
 * @param {(x:number,y:number)=>number[]|null} [options.behind] drawn under the body
 * @param {(x:number,y:number)=>number[]|null} [options.over] drawn on top of everything
 * @param {number} [options.shoulder] how wide the rounded edge is, as a fraction
 */
export function renderClay(size, {
  shape, palette, behind = null, over = null, shoulder: shoulderFraction = 0.075,
}) {
  const coverage = coverageMap(size, shape);
  const solid = (i) => coverage[i] > 0.5;
  const inside = distanceMap(size, solid);
  const outside = distanceMap(size, (i) => !solid(i));

  const shoulder = size * shoulderFraction;

  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    if (!solid(i)) continue;
    const t = clamp(inside[i] / shoulder, 0, 1);
    // A circular profile, so the edge turns over rather than ramping straight.
    height[i] = Math.sqrt(1 - (1 - t) * (1 - t));
  }

  // Smooth before taking any normals. The distance transform moves in whole
  // pixels, so its surface is faintly terraced; height hides that, but the
  // derivative does not, and lighting it draws every terrace as a streak.
  blur(height, size, 2);
  blur(height, size, 2);

  const heightAt = (row, column) => (row < 0 || column < 0 || row >= size || column >= size)
    ? 0 : height[row * size + column];

  const pixels = Buffer.alloc(size * (size * 3 + 1));
  const shadowOffset = Math.round(size * 0.018);

  for (let row = 0; row < size; row++) {
    const rowStart = row * (size * 3 + 1);
    pixels[rowStart] = 0;

    for (let column = 0; column < size; column++) {
      const i = row * size + column;
      const x = column / size;
      const y = row / size;

      let colour = mix(palette.backTop, palette.backBottom, (x + y) / 2);

      if (behind) {
        const drawn = behind(x, y);
        if (drawn) colour = drawn;
      }

      if (!solid(i)) {
        // The shadow the body casts, down and to the right.
        const row2 = row - shadowOffset;
        const column2 = column - shadowOffset;
        const away = (row2 < 0 || column2 < 0 || row2 >= size || column2 >= size)
          ? 1e9 : outside[row2 * size + column2];
        const shadow = clamp(1 - away / (size * 0.075), 0, 1);
        colour = mix(colour, palette.shadow, shadow * 0.55);
      }

      if (coverage[i] > 0) {
        const dx = (heightAt(row, column + 1) - heightAt(row, column - 1)) / 2;
        const dy = (heightAt(row + 1, column) - heightAt(row - 1, column)) / 2;
        const relief = shoulder * 0.9;
        const nx = -dx * relief;
        const ny = -dy * relief;
        const length = Math.sqrt(nx * nx + ny * ny + 1);

        // Light from above and to the left.
        const diffuse = clamp((nx * -0.42 + ny * -0.62 + 0.66) / length, 0, 1);
        const spec = Math.pow(diffuse, 22) * 0.9;

        let body = mix(palette.bodyDark, palette.body, 0.35 + diffuse * 0.75);
        body = mix(body, palette.highlight, spec);

        // A little light along the rim, which stops the shape looking pasted on.
        const rim = clamp(1 - inside[i] / (shoulder * 0.45), 0, 1);
        body = mix(body, palette.rim, rim * 0.18);

        colour = mix(colour, body, coverage[i]);
      }

      if (over) {
        const drawn = over(x, y);
        if (drawn) colour = drawn;
      }

      const offset = rowStart + 1 + column * 3;
      pixels[offset] = Math.round(clamp(colour[0], 0, 255));
      pixels[offset + 1] = Math.round(clamp(colour[1], 0, 255));
      pixels[offset + 2] = Math.round(clamp(colour[2], 0, 255));
    }
  }

  return encodePng(size, pixels);
}

// --- PNG -------------------------------------------------------------------

const crc32 = zlib.crc32 ?? ((buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
