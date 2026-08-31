/**
 * Notice new files and rescan without being asked.
 *
 * A library like this one grows constantly: an episode is downloaded and then
 * nothing happens until somebody remembers to press Scan. Until they do, the
 * app is quietly wrong about what it holds — which looks exactly like a bug,
 * because the file plainly exists on disk.
 *
 * Watching costs nothing while the library is idle, so the scan becomes a
 * consequence of the download rather than a chore attached to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS } from './parse.js';

/**
 * How long the library must be quiet before scanning.
 *
 * Long on purpose. A download writes its file in pieces and often renames it
 * at the end, so scanning at the first sign of movement would read a half
 * written file and then have to do the whole thing again. Waiting for quiet
 * costs a minute of staleness and saves a wasted scan.
 */
const QUIET_MS = 60_000;

/**
 * Partial downloads, which are not content yet. Their final rename lands as a
 * fresh event, so nothing is missed by ignoring them.
 */
const IN_PROGRESS = /\.(part|crdownload|!qb|tmp|downloading)$/i;

/** Whether a changed path is worth a scan. */
function worthScanning(filename) {
  if (!filename) return true; // The platform did not say; assume it matters.
  if (IN_PROGRESS.test(filename)) return false;
  const extension = path.extname(filename).toLowerCase();
  // No extension usually means a folder appeared, which is how a season or a
  // film most often arrives.
  if (!extension) return true;
  return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
}

/**
 * Watch the library roots and call `onQuiet` once things settle.
 *
 * @param {object} options
 * @param {string[]} options.roots Directories to watch.
 * @param {() => void} options.onQuiet Called after a change and then quiet.
 * @param {(message: string) => void} [options.onLog]
 * @param {number} [options.quietMs]
 * @returns {() => void} Stops watching.
 */
export function startAutoScan({ roots, onQuiet, onLog = () => {}, quietMs = QUIET_MS }) {
  const watchers = [];
  let timer = null;
  let pending = 0;

  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = pending;
      pending = 0;
      onLog('library changed (' + changed + ' events), rescanning');
      onQuiet();
    }, quietMs);
    // Never hold the process open for a scan that has not been asked for.
    timer.unref?.();
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!worthScanning(filename)) return;
        pending++;
        settle();
      });
      // A watch that dies must not take the server with it — an unplugged
      // drive is an ordinary event for a library kept on one.
      watcher.on('error', (error) => onLog('stopped watching ' + root + ': ' + error.message));
      watchers.push(watcher);
      onLog('watching ' + root);
    } catch (error) {
      onLog('could not watch ' + root + ': ' + error.message);
    }
  }

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* already gone */ }
    }
  };
}
