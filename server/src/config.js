/**
 * Configuration resolution.
 *
 * Precedence: environment variables, then config.local.json (gitignored, for
 * machine-specific paths and secrets), then config.json (committed defaults).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/** Minimal .env reader — avoids a dependency for a two-line file. */
function loadDotEnv() {
  const file = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const defaults = readJson(path.join(PROJECT_ROOT, 'config.json'));
const local = readJson(path.join(PROJECT_ROOT, 'config.local.json'));

const dataDir = process.env.MEDIA_DATA_DIR
  ?? local.dataDir
  ?? defaults.dataDir
  ?? path.join(PROJECT_ROOT, 'data');

export const config = {
  /** Directories to scan. A missing root is reported, not fatal. */
  libraryRoots: (process.env.MEDIA_LIBRARY_ROOTS?.split(path.delimiter).filter(Boolean))
    ?? local.libraryRoots
    ?? defaults.libraryRoots
    ?? [],

  dataDir,
  databasePath: path.join(dataDir, 'library.db'),
  artworkDir: path.join(dataDir, 'artwork'),

  tmdbApiKey: process.env.TMDB_API_KEY ?? local.tmdbApiKey ?? null,
  tmdbLanguage: process.env.TMDB_LANGUAGE ?? local.tmdbLanguage ?? 'en-US',

  port: Number(process.env.PORT ?? local.port ?? defaults.port ?? 8787),

  /** Path to the mpv binary; resolved at playback time if left null. */
  mpvPath: process.env.MPV_PATH ?? local.mpvPath ?? defaults.mpvPath ?? null,
};

export function ensureDataDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.artworkDir, { recursive: true });
}

/** True when metadata lookups can run. The app still works without a key. */
export function hasTmdb() {
  return Boolean(config.tmdbApiKey);
}
