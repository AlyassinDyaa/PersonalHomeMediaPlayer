/**
 * The colour a title is mostly made of.
 *
 * A library where every screen is the same red on the same black tells you
 * nothing about what you are looking at: Arcane and Avatar arrive wearing the
 * same uniform. Taking a colour out of the poster instead gives each title its
 * own light — the play button, the progress bar, the glow under a card — so
 * the page you are on looks like the thing it is about.
 *
 * The picture is shrunk to sixty-four pixels and the most characterful of them
 * wins. An average would not do: averaging a poster gives mud, because the
 * bright and the dark cancel. What is wanted is the colour somebody would name
 * if asked, which is the most saturated one that is neither nearly black nor
 * nearly white.
 *
 * Worked out once and written on the row. It costs a fifth of a second per
 * poster and is never done twice.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getDb } from '../db.js';
import { ffmpegPaths } from '../stream/ffmpeg.js';
import { cachePathFor } from './artwork.js';

const run = promisify(execFile);

/** How far down the picture is shrunk before looking. Eight by eight. */
const GRID = 8;

/** Below this the colour reads as black, above it as white; neither is a hue. */
const TOO_DARK = 0.18;
const TOO_PALE = 0.82;

/** When nothing in a picture is colourful enough to name. */
const NEUTRAL = '#8a8a96';

/**
 * Pull one colour out of an image file.
 *
 * @param {string} file
 * @returns {Promise<string|null>} a hex colour, or null if the file could not be read
 */
export async function accentOf(file) {
  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg || !file || !fs.existsSync(file)) return null;

  let raw;
  try {
    const result = await run(ffmpeg, [
      '-v', 'error',
      '-i', file,
      '-vf', 'scale=' + GRID + ':' + GRID,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ], { encoding: 'buffer', maxBuffer: 1 << 20, windowsHide: true });
    raw = result.stdout;
  } catch {
    // A poster that ffmpeg will not read is not worth failing a scan over.
    return null;
  }

  let best = null;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const red = raw[i];
    const green = raw[i + 1];
    const blue = raw[i + 2];

    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const lightness = (high + low) / 2 / 255;
    if (lightness < TOO_DARK || lightness > TOO_PALE) continue;

    const saturation = high === low
      ? 0
      : (high - low) / (lightness > 0.5 ? (510 - high - low) : (high + low));

    // Saturated, and near the middle of the range where a colour reads as
    // itself rather than as a tint of black or white.
    const score = saturation * (1 - Math.abs(lightness - 0.5));
    if (!best || score > best.score) {
      best = { score, hue: hueOf(red, green, blue, high, low), saturation };
    }
  }

  return best ? usable(best.hue, best.saturation) : NEUTRAL;
}

/**
 * The hue of a colour, in degrees. Standard conversion, kept local because it
 * is wanted in exactly one place.
 */
function hueOf(red, green, blue, high, low) {
  if (high === low) return 0;
  const span = high - low;
  let hue;
  if (high === red) hue = ((green - blue) / span) % 6;
  else if (high === green) hue = (blue - red) / span + 2;
  else hue = (red - green) / span + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/**
 * Keep the hue; put the rest where an interface can use it.
 *
 * A poster's colour is chosen to look well behind a title, not to be legible
 * as a button. Batman Beyond gives up a midnight blue and Avatar Aang a navy
 * barely lighter than the page — printed on a control with dark text on top,
 * both are unreadable, and side by side they are indistinguishable.
 *
 * So only the hue is taken from the picture. How light and how strong it is
 * are decided here, in the band where a colour sits clearly on a dark page and
 * still takes dark text. That is the difference between a colour that came
 * from the poster and a colour that merely is the poster.
 */
function usable(hue, saturation) {
  const strength = Math.min(0.78, Math.max(0.42, saturation));
  return hslToHex(hue, strength, 0.62);
}

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = lightness - chroma / 2;

  const sixth = Math.floor(hue / 60) % 6;
  const [red, green, blue] = [
    [chroma, second, 0], [second, chroma, 0], [0, chroma, second],
    [0, second, chroma], [second, 0, chroma], [chroma, 0, second],
  ][sixth];

  return '#' + [red, green, blue]
    .map((channel) => hex(Math.round((channel + base) * 255)))
    .join('');
}

const hex = (value) => value.toString(16).padStart(2, '0');

/**
 * Give a colour to every title that has a poster and hasn't got one yet.
 *
 * Deliberately additive: a row keeps the colour it already has, so this can be
 * run after every scan without redoing work, and a library of a hundred titles
 * settles in a few seconds the first time and instantly after that.
 *
 * @returns {Promise<{ done: number, skipped: number }>}
 */
export async function ensureAccents({ onLog = () => {} } = {}) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, poster_path FROM items WHERE poster_path IS NOT NULL AND (accent IS NULL OR accent = \'\')',
  ).all();

  if (!rows.length) return { done: 0, skipped: 0 };

  const write = db.prepare('UPDATE items SET accent = ? WHERE id = ?');
  let done = 0;
  let skipped = 0;

  for (const row of rows) {
    const file = cachePathFor('w500', row.poster_path);
    const colour = await accentOf(file);
    if (!colour) { skipped++; continue; }
    write.run(colour, row.id);
    done++;
  }

  if (done) onLog('took a colour from ' + done + ' poster' + (done === 1 ? '' : 's'));
  return { done, skipped };
}
