/**
 * A single frame from anywhere in a film, for the seek bar.
 *
 * Dragging along a timeline without seeing anything is guessing. Every service
 * shows the frame under the finger, and it is the difference between finding
 * the scene you meant and landing two minutes past it and dragging back.
 *
 * Frames are pulled one at a time, on demand, rather than by building a sheet
 * of them in advance. A sheet means a job per film that has to be scheduled,
 * cached, pruned and waited for — and until it finishes there is nothing to
 * show. Seeking to a single frame takes about a fifth of a second because the
 * seek happens before decoding starts, so the first drag of a film nobody has
 * ever opened already works.
 *
 * What makes that affordable is rounding: the time asked for is snapped to a
 * ten second grid, so a finger dragging across an hour asks for a few dozen
 * distinct frames rather than a thousand, and asks for each one only once.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { ffmpegPaths } from './ffmpeg.js';

/** The grid times are snapped to. Fine enough to feel live, coarse enough to cache. */
const GRID_SECONDS = 10;

/** Wide enough to recognise a scene, small enough to arrive instantly. */
const WIDTH = 240;

/**
 * How many may be pulled at once.
 *
 * Each one reads from the same disk the film itself is streaming from, so
 * letting a dragging finger start thirty of them would take the disk away from
 * playback — the one thing that must not stutter.
 */
const AT_ONCE = 2;

let running = 0;
const waiting = [];

/** videoId -> promise, so the same frame is never pulled twice at once. */
const inFlight = new Map();

function thumbDir(videoId) {
  return path.join(config.cacheDir, 'thumbs', videoId);
}

/** Where one frame lives, and the time it belongs to. */
export function thumbPath(videoId, second) {
  return path.join(thumbDir(videoId), snap(second) + '.jpg');
}

/** The nearest point on the grid, never negative. */
export function snap(second) {
  const value = Math.max(0, Math.floor(Number(second) || 0));
  return Math.round(value / GRID_SECONDS) * GRID_SECONDS;
}

function next() {
  if (running >= AT_ONCE) return;
  const job = waiting.shift();
  if (!job) return;
  running++;
  job().finally(() => { running--; next(); });
}

function queued(work) {
  return new Promise((resolve, reject) => {
    waiting.push(() => work().then(resolve, reject));
    next();
  });
}

/**
 * Pull one frame, or return the one already pulled.
 *
 * @param {string} videoId
 * @param {string} filePath the film itself
 * @param {number} second where in it
 * @returns {Promise<string|null>} the file, or null if it could not be made
 */
export function frameAt(videoId, filePath, second) {
  const at = snap(second);
  const target = thumbPath(videoId, at);
  if (fs.existsSync(target)) return Promise.resolve(target);

  const key = videoId + '@' + at;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = queued(() => pull(filePath, target, at))
    .catch(() => null)
    .finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
}

async function pull(filePath, target, at) {
  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) return null;

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.part';

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    /*
     * The seek goes before the input, which is what makes this quick.
     *
     * Ahead of -i, ffmpeg jumps to the nearest keyframe and starts decoding
     * there; after it, it decodes the whole film up to that point and throws
     * nearly all of it away. The difference on a two hour film is a fifth of a
     * second against the better part of a minute.
     */
    '-ss', String(at),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=' + WIDTH + ':-2',
    '-q:v', '5',
    '-an', '-sn',
    /*
     * Told what it is writing, because the name does not say.
     *
     * The frame is written under a temporary name ending in .part so a
     * half-written one is never served — and ffmpeg picks its format from
     * the extension, so without this it looks at ".part", recognises
     * nothing, and refuses to write anything at all.
     */
    '-f', 'image2',
    temp,
  ];

  const ok = await new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });

  if (!ok) {
    await fsp.rm(temp, { force: true });
    return null;
  }

  // Named only once it is whole, so a half-written frame is never served.
  await fsp.rename(temp, target);
  return target;
}

/** Forget a film's frames, when its cache is being cleared. */
export async function clearThumbs(videoId = null) {
  const root = videoId ? thumbDir(videoId) : path.join(config.cacheDir, 'thumbs');
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
