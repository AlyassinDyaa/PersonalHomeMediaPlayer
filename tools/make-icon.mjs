/**
 * Draws the application icon.
 *
 * Added to the Home Screen on an iPad, a web page without an icon is given a
 * screenshot of itself, which looks like a mistake. This writes a real one.
 *
 * The mark is an aperture: six blades around an opening, the shape a lens makes
 * when it lets a picture through. It carries no letter and no play triangle, so
 * it is not mistaken at a glance for one of the streaming services.
 *
 * It is drawn rather than drafted in an editor, so it can be regenerated at any
 * size and recoloured by changing two lines. The soft, lit look comes from
 * clay.mjs, which turns the flat shape into a height field and lights it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClay } from './clay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Vite copies this folder to the site root untouched, which is what an
// absolute /icon-180.png in the page needs.
const OUT_DIR = path.resolve(HERE, '..', 'desktop', 'web', 'public');

/** Six blades: one full turn divided six ways. */
const BLADES = 6;
const SEGMENT = (Math.PI * 2) / BLADES;
/** How wide the gap between blades is, in radians. */
const GAP = 0.20;
/** Turned slightly off square, so it reads as machined rather than aligned. */
const TILT = Math.PI / 7;

const OUTER = 0.33;
const OPENING = 0.115;

const PALETTE = {
  body: [96, 170, 255],
  bodyDark: [30, 74, 176],
  highlight: [240, 248, 255],
  rim: [175, 215, 255],
  shadow: [4, 8, 26],
  backTop: [22, 26, 48],
  backBottom: [9, 10, 22],
};

function inAperture(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const radius = Math.sqrt(dx * dx + dy * dy);
  if (radius > OUTER || radius < OPENING) return false;

  const angle = Math.atan2(dy, dx) + TILT;
  const withinBlade = ((angle % SEGMENT) + SEGMENT) % SEGMENT;
  return withinBlade < SEGMENT - GAP;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// 180 is what iOS asks for; 512 covers Android and anything wanting larger.
for (const size of [180, 512]) {
  const file = path.join(OUT_DIR, 'icon-' + size + '.png');
  fs.writeFileSync(file, renderClay(size, {
    shape: inAperture,
    palette: PALETTE,
    shoulder: 0.045,
  }));
  console.log('wrote ' + path.relative(process.cwd(), file)
    + ' (' + (fs.statSync(file).size / 1024).toFixed(1) + ' KB)');
}
