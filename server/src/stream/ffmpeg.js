/**
 * Finding ffmpeg, and asking it what is inside a file.
 *
 * A portable build carries its own copy beside the executable so nothing has to
 * be installed; a development checkout uses the one in vendor/. An explicit
 * path in the settings wins over both, for anyone who already has a build they
 * prefer.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Places a bundled ffmpeg may sit, nearest first. */
function candidates(name) {
  const found = [];
  const configured = config.ffmpegDir;
  if (configured) found.push(path.join(configured, name + EXE));
  // Beside the packaged application.
  if (process.env.MEDIA_INSTALL_DIR) {
    found.push(path.join(process.env.MEDIA_INSTALL_DIR, 'ffmpeg', name + EXE));
  }
  found.push(path.join(PROJECT_ROOT, 'vendor', 'ffmpeg', name + EXE));
  return found;
}

let resolved = null;

/**
 * Paths to ffmpeg and ffprobe, or nulls when neither can be found.
 * Resolved once: this is asked on every stream request.
 */
export function ffmpegPaths() {
  if (resolved) return resolved;

  const pick = (name) => {
    for (const candidate of candidates(name)) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // An unreadable candidate is simply not the one.
      }
    }
    // Fall back to whatever is on PATH; spawning will fail clearly if absent.
    return null;
  };

  resolved = { ffmpeg: pick('ffmpeg'), ffprobe: pick('ffprobe') };
  return resolved;
}

/** Whether streaming to a browser is possible at all. */
export function ffmpegAvailable() {
  const { ffmpeg, ffprobe } = ffmpegPaths();
  return Boolean(ffmpeg && ffprobe);
}

// Probing costs a process launch and a disk seek, and the answer cannot change
// while the file is what it is, so it is remembered.
const probeCache = new Map();
const PROBE_CACHE_LIMIT = 500;

/**
 * What ffprobe reports about a file: its container, and its streams.
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export function probeFile(filePath) {
  const cached = probeCache.get(filePath);
  if (cached) return Promise.resolve(cached);

  const { ffprobe } = ffmpegPaths();
  if (!ffprobe) return Promise.reject(new Error('ffprobe was not found'));

  const args = [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,channels,bit_rate,avg_frame_rate,r_frame_rate,disposition',
    '-of', 'json',
    filePath,
  ];

  return new Promise((resolve, reject) => {
    execFile(ffprobe, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error('Could not read ' + path.basename(filePath) + ': ' + error.message));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error('ffprobe returned something unreadable'));
        return;
      }

      if (probeCache.size >= PROBE_CACHE_LIMIT) {
        probeCache.delete(probeCache.keys().next().value);
      }
      probeCache.set(filePath, parsed);
      resolve(parsed);
    });
  });
}
