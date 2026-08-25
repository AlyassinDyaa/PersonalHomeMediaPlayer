/**
 * Filesystem traversal for library roots.
 *
 * Produces a flat list of media files annotated with the folder chain that led
 * to them, which the grouping stage needs in order to resolve seasons from
 * parent directories.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, extensionOf, isJunkFolder, isJunkName,
} from './parse.js';

/** Files below this size are suspected samples/extras rather than content. */
const SMALL_FILE_BYTES = 60 * 1024 * 1024;

/**
 * @typedef {Object} MediaFile
 * @property {string} path        Absolute path.
 * @property {string} name        Basename with extension.
 * @property {string} ext         Lowercased extension including the dot.
 * @property {number} size        Bytes.
 * @property {string} root        The library root this file was found under.
 * @property {string} topFolder   Name of the root's direct child containing it.
 * @property {string[]} chain     Folder names from topFolder down to the parent.
 */

/**
 * Recursively collect video and subtitle files under a single library root.
 * @param {string} root
 * @returns {{videos: MediaFile[], subtitles: MediaFile[], skipped: string[]}}
 */
export function walkRoot(root) {
  const videos = [];
  const subtitles = [];
  const skipped = [];

  /** @param {string} dir @param {string} topFolder @param {string[]} chain */
  function descend(dir, topFolder, chain) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push(`${dir} (${err.code})`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('$') || entry.name.startsWith('.')) continue;
        // Subtitle folders are traversed (we want the .srt files) but never
        // contribute a folder level to the season chain.
        const isSubs = /^subs?$|^subtitles?$/i.test(entry.name.trim());
        if (isJunkFolder(entry.name) && !isSubs) {
          skipped.push(full);
          continue;
        }
        const nextTop = topFolder ?? entry.name;
        const nextChain = topFolder === null ? [] : isSubs ? chain : [...chain, entry.name];
        descend(full, nextTop, nextChain);
        continue;
      }

      const ext = extensionOf(entry.name);
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isSubtitle = SUBTITLE_EXTENSIONS.has(ext);
      if (!isVideo && !isSubtitle) continue;

      let size = 0;
      try {
        size = entry.isSymbolicLink() ? 0 : fs.statSync(full).size;
      } catch {
        // Unreadable file — keep it with size 0 rather than dropping silently.
      }

      const record = {
        path: full,
        name: entry.name,
        ext,
        size,
        root,
        topFolder: topFolder ?? path.basename(full, ext),
        chain,
      };

      if (isVideo) {
        if (isJunkName(entry.name)) {
          skipped.push(full);
          continue;
        }
        videos.push(record);
      } else {
        subtitles.push(record);
      }
    }
  }

  for (const entry of safeReadDir(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('$') || entry.name.startsWith('.')) continue;
      if (isJunkFolder(entry.name)) { skipped.push(full); continue; }
      descend(full, entry.name, []);
    } else {
      // A loose file sitting directly in the library root.
      const ext = extensionOf(entry.name);
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      if (isJunkName(entry.name)) { skipped.push(full); continue; }
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* keep with size 0 */ }
      videos.push({
        path: full, name: entry.name, ext, size, root,
        topFolder: path.basename(entry.name, ext), chain: [],
      });
    }
  }

  return { videos, subtitles, skipped };
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Drop files that are dwarfed by their siblings — the usual signature of a
 * sample or a bundled intro clip that escaped name-based filtering.
 * @param {MediaFile[]} videos
 */
export function dropOutlierSmallFiles(videos) {
  const byFolder = new Map();
  for (const video of videos) {
    const dir = path.dirname(video.path);
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir).push(video);
  }

  const kept = [];
  const dropped = [];
  for (const group of byFolder.values()) {
    if (group.length < 2) { kept.push(...group); continue; }
    const sizes = group.map((v) => v.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    for (const video of group) {
      if (median > 0 && video.size < SMALL_FILE_BYTES && video.size < median * 0.2) {
        dropped.push(video);
      } else {
        kept.push(video);
      }
    }
  }
  return { kept, dropped };
}

/**
 * Walk every configured library root.
 * @param {string[]} roots
 */
export function walkLibrary(roots) {
  const videos = [];
  const subtitles = [];
  const skipped = [];
  const missingRoots = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      missingRoots.push(root);
      continue;
    }
    const result = walkRoot(root);
    videos.push(...result.videos);
    subtitles.push(...result.subtitles);
    skipped.push(...result.skipped);
  }

  const { kept, dropped } = dropOutlierSmallFiles(videos);
  return { videos: kept, subtitles, skipped: [...skipped, ...dropped.map((d) => d.path)], missingRoots };
}
