/**
 * Films kept ready to play, in a container the browser can seek.
 *
 * Most of this library needs no re-encoding at all. A 4K film in a Matroska
 * file already holds exactly the video a tablet wants; the only thing wrong
 * with it is the box it comes in. Streaming it as HLS therefore spends real
 * work solving a problem that was never about the video: segments have to be
 * produced from wherever the viewer jumped to, so every scrub of the timeline
 * costs a few seconds and a fresh ffmpeg.
 *
 * Repacking the whole film once, into MP4, removes all of that. The browser
 * then fetches byte ranges of an ordinary file and seeks the way it seeks
 * anything else — instantly, with nothing running on the server. Copying the
 * streams across rather than re-encoding them means the picture is untouched
 * and the work is limited by the disk, not the processor.
 *
 * Only worth doing where the streams are already ones a browser accepts. A
 * file that genuinely needs its picture re-encoded is left to the HLS path,
 * which can at least start playing before it has finished.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { ffmpegPaths } from './ffmpeg.js';

/** Video codecs a browser plays from an MP4 without help. */
const KEEPABLE_VIDEO = new Set(['h264', 'hevc']);
/** Audio it plays as-is; anything else is converted, which is cheap. */
const KEEPABLE_AUDIO = new Set(['aac']);

/** Stop the cache growing without limit. Oldest use goes first. */
const CACHE_LIMIT_BYTES = 400 * 1024 * 1024 * 1024;

/** videoId -> promise, so two requests cannot start the same work twice. */
const building = new Map();

/**
 * Only one film is repacked at a time.
 *
 * Each reads a film end to end and writes another beside it. Two at once
 * halve each other and, worse, take the disk away from whatever is being
 * watched — the very stalling this exists to prevent. Waiting costs nothing:
 * the viewer is watching over the streaming path meanwhile, and a queued film
 * is one nobody has asked for yet.
 */
let queue = Promise.resolve();
/** videoId -> message, so a failure is reported rather than retried forever. */
const failures = new Map();

function cacheDir() {
  return path.join(config.dataDir, 'prepared');
}

export function preparedPath(videoId) {
  return path.join(cacheDir(), videoId + '.mp4');
}

/**
 * Whether repacking this file would produce something playable.
 *
 * @param {object} probed ffprobe output
 */
export function canPrepare(probed) {
  const streams = probed?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  return Boolean(video && KEEPABLE_VIDEO.has(video.codec_name));
}

/**
 * What state this film's prepared copy is in.
 *
 * @returns {'ready'|'building'|'failed'|'none'}
 */
export function preparedState(videoId) {
  if (fs.existsSync(preparedPath(videoId))) return 'ready';
  if (building.has(videoId)) return 'building';
  if (failures.has(videoId)) return 'failed';
  return 'none';
}

/**
 * Repack one film, once.
 *
 * The promise is registered before anything is awaited. Registering it after
 * would leave a window where a second request sees no work in progress and
 * starts its own, and two ffmpegs writing one file produce a broken one.
 */
export function prepare(videoId, filePath, probed) {
  const existing = building.get(videoId);
  if (existing) return existing;
  if (fs.existsSync(preparedPath(videoId))) return Promise.resolve(preparedPath(videoId));

  const work = queue
    .catch(() => {}) // One film failing must not stop the next.
    .then(() => run(videoId, filePath, probed))
    .finally(() => building.delete(videoId));

  building.set(videoId, work);
  queue = work.catch(() => {});
  return work;
}

async function run(videoId, filePath, probed) {
  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) throw new Error('ffmpeg was not found');

  await fsp.mkdir(cacheDir(), { recursive: true });

  const streams = probed?.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const keepAudio = audio && KEEPABLE_AUDIO.has(audio.codec_name);

  // Written under a temporary name: a half-finished file that happened to be
  // named like a finished one would be served, and would not play.
  const target = preparedPath(videoId);
  const temp = target + '.part';
  await fsp.rm(temp, { force: true });

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    /*
     * Read at twenty times playback, not flat out.
     *
     * Repacking happens while the same film is being watched over the
     * streaming path, and uncapped it takes the disk away from the very thing
     * it is meant to help: measured at 3.7 minutes alone, but dragging the
     * live stream below playback speed when the two ran together. Twenty times
     * still finishes a two hour film in about six minutes and leaves the
     * stream its share.
     */
    '-readrate', '20',
    '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    ...(keepAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
    // The index has to sit at the front, or a browser must download the whole
    // file before it can seek — which is the problem this exists to solve.
    '-movflags', '+faststart',
    '-f', 'mp4',
    temp,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim().split('\n').pop() || ('ffmpeg exited ' + code)));
    });
  }).catch(async (error) => {
    await fsp.rm(temp, { force: true });
    failures.set(videoId, error.message);
    throw error;
  });

  await fsp.rename(temp, target);
  failures.delete(videoId);
  await prunePrepared().catch(() => {});
  return target;
}

/**
 * Keep the cache under its limit, discarding whatever was read longest ago.
 *
 * Last read rather than last written: a film watched every week should stay,
 * however long ago it was prepared.
 */
export async function prunePrepared(limit = CACHE_LIMIT_BYTES) {
  let entries;
  try {
    entries = await fsp.readdir(cacheDir());
  } catch {
    return { removed: 0, freed: 0 };
  }

  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.mp4')) continue;
    const full = path.join(cacheDir(), name);
    try {
      const stat = await fsp.stat(full);
      files.push({ full, size: stat.size, used: stat.atimeMs || stat.mtimeMs });
    } catch { /* vanished */ }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= limit) return { removed: 0, freed: 0 };

  files.sort((a, b) => a.used - b.used);
  let removed = 0;
  let freed = 0;
  for (const file of files) {
    if (total <= limit) break;
    // Never delete one being written; that file has no .mp4 name yet, so this
    // only guards against a rename landing mid-sweep.
    if (building.has(path.basename(file.full, '.mp4'))) continue;
    await fsp.rm(file.full, { force: true }).catch(() => {});
    total -= file.size;
    freed += file.size;
    removed++;
  }
  return { removed, freed };
}

/** Everything prepared, for reporting in settings. */
export async function preparedStats() {
  try {
    const entries = await fsp.readdir(cacheDir());
    let count = 0;
    let bytes = 0;
    for (const name of entries) {
      if (!name.endsWith('.mp4')) continue;
      count++;
      bytes += (await fsp.stat(path.join(cacheDir(), name))).size;
    }
    return { count, bytes, building: building.size };
  } catch {
    return { count: 0, bytes: 0, building: building.size };
  }
}
