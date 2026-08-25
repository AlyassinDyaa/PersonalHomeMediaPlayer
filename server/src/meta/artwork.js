/**
 * Local artwork cache.
 *
 * Images are stored on disk keyed by TMDB path and size. Once warmed, the
 * library browses fully offline: nothing in the UI reaches the network, since
 * every image is served from here and all metadata already lives in SQLite.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ensureDataDirs } from '../config.js';
import { getDb } from '../db.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CONCURRENCY = 8;

/** Sizes used by the UI, per artwork kind. */
export const SIZES = {
  poster: 'w500',
  backdrop: 'w1280',
  logo: 'w500',
  still: 'w300',
  seasonPoster: 'w300',
};

export function cachePathFor(size, tmdbPath) {
  const file = tmdbPath.replace(/^\//, '');
  return path.join(config.artworkDir, size, file);
}

export function isCached(size, tmdbPath) {
  if (!tmdbPath) return false;
  try {
    return fs.existsSync(cachePathFor(size, tmdbPath));
  } catch {
    return false;
  }
}

/**
 * Download one image unless it is already on disk.
 * @returns {Promise<'cached'|'downloaded'|'failed'>}
 */
export async function cacheImage(size, tmdbPath) {
  if (!tmdbPath) return 'failed';
  const target = cachePathFor(size, tmdbPath);
  if (fs.existsSync(target)) return 'cached';

  try {
    const response = await fetch(IMAGE_BASE + '/' + size + tmdbPath);
    if (!response.ok) return 'failed';
    const buffer = Buffer.from(await response.arrayBuffer());

    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Write via a temporary name so an interrupted download cannot leave a
    // truncated file that would then be served from cache forever.
    const temp = target + '.part';
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

/** Every image the UI could ask for, as {size, path} pairs. */
export function collectImageRefs({ includeStills = true } = {}) {
  const db = getDb();
  const refs = [];
  const add = (size, tmdbPath) => {
    if (tmdbPath) refs.push({ size, path: tmdbPath });
  };

  for (const row of db.prepare('SELECT poster_path, backdrop_path, logo_path FROM items').all()) {
    add(SIZES.poster, row.poster_path);
    add(SIZES.backdrop, row.backdrop_path);
    add(SIZES.logo, row.logo_path);
  }

  for (const row of db.prepare('SELECT poster_path FROM seasons').all()) {
    add(SIZES.seasonPoster, row.poster_path);
  }

  if (includeStills) {
    for (const row of db.prepare('SELECT still_path FROM videos WHERE still_path IS NOT NULL').all()) {
      add(SIZES.still, row.still_path);
    }
  }

  // De-duplicate: many items share artwork paths across sizes.
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.size + ref.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Warm the cache for the whole library.
 * @param {{includeStills?: boolean, onProgress?: (p: {done: number, total: number, downloaded: number}) => void}} [options]
 */
export async function prefetchArtwork({ includeStills = true, onProgress = () => {} } = {}) {
  ensureDataDirs();
  const refs = collectImageRefs({ includeStills });

  let done = 0;
  let downloaded = 0;
  let failed = 0;

  // Simple worker pool: keeps a fixed number of downloads in flight.
  const queue = [...refs];
  const worker = async () => {
    for (;;) {
      const ref = queue.shift();
      if (!ref) return;
      const result = await cacheImage(ref.size, ref.path);
      if (result === 'downloaded') downloaded++;
      else if (result === 'failed') failed++;
      done++;
      if (done % 10 === 0 || done === refs.length) {
        onProgress({ done, total: refs.length, downloaded });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { total: refs.length, downloaded, failed, alreadyCached: refs.length - downloaded - failed };
}

/** Count and total size of cached images, for the settings screen. */
export function artworkStats() {
  let files = 0;
  let bytes = 0;
  let missing = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.part')) continue;
      files++;
      try { bytes += fs.statSync(full).size; } catch { /* ignore */ }
    }
  };
  walk(config.artworkDir);

  try {
    for (const ref of collectImageRefs()) {
      if (!isCached(ref.size, ref.path)) missing++;
    }
  } catch {
    // Database may not exist yet on a first run.
  }

  return { files, bytes, missing };
}
