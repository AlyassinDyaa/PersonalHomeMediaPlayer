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

/**
 * Where user-editable settings live.
 *
 * In development that is the project directory. In a packaged build the app
 * directory is read-only (and inside an archive), so the host passes a writable
 * location instead.
 */
export const CONFIG_DIR = process.env.MEDIA_CONFIG_DIR || PROJECT_ROOT;

const defaults = readJson(path.join(PROJECT_ROOT, 'config.json'));
const local = readJson(path.join(CONFIG_DIR, 'config.local.json'));

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

  /** Shown in the header, e.g. "Dyaa's Library". Blank falls back to a generic label. */
  libraryName: local.libraryName ?? defaults.libraryName ?? '',

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

const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.json');

/**
 * Persist user-editable settings to config.local.json and apply them to the
 * running process, so a change takes effect without a restart.
 *
 * Only whitelisted keys are accepted: this is reachable from the UI, and the
 * config object also carries secrets that must not be settable this way.
 * @param {{libraryRoots?: string[], tmdbApiKey?: string, mpvPath?: string}} patch
 */
export function saveSettings(patch) {
  const allowed = {};

  if (Array.isArray(patch.libraryRoots)) {
    // Normalise separators and drop blanks and duplicates.
    allowed.libraryRoots = [...new Set(
      patch.libraryRoots
        .filter((root) => typeof root === 'string' && root.trim())
        .map((root) => root.trim().replace(/\\/g, '/').replace(/\/+$/, '')),
    )];
  }
  if (typeof patch.libraryName === 'string') allowed.libraryName = patch.libraryName.trim().slice(0, 40);
  if (typeof patch.mpvPath === 'string') allowed.mpvPath = patch.mpvPath.trim() || null;
  if (typeof patch.tmdbApiKey === 'string') allowed.tmdbApiKey = patch.tmdbApiKey.trim();

  const current = readJson(LOCAL_CONFIG_PATH);
  const next = { ...current, ...allowed };
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

  Object.assign(config, allowed);
  return settingsView();
}

/** The subset of configuration safe to expose to the UI. */
export function settingsView() {
  return {
    libraryName: config.libraryName,
    libraryRoots: config.libraryRoots,
    rootsStatus: config.libraryRoots.map((root) => ({
      path: root,
      available: fs.existsSync(root),
    })),
    dataDir: config.dataDir,
    mpvPath: config.mpvPath,
    // Never return the key itself, only whether one is present.
    tmdbConfigured: hasTmdb(),
    port: config.port,
  };
}

/** List drives/directories so the UI can browse without a native dialog. */
export function listDirectories(target) {
  if (!target) {
    // Enumerate drive roots on Windows, filesystem root elsewhere.
    if (process.platform === 'win32') {
      const drives = [];
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = letter + ':/';
        try {
          if (fs.existsSync(root)) drives.push({ name: letter + ':', path: root });
        } catch {
          // Unreadable drive; skip.
        }
      }
      return { parent: null, entries: drives };
    }
    return { parent: null, entries: [{ name: '/', path: '/' }] };
  }

  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$') && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name).replace(/\\/g, '/') }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return {
    parent: parent === target ? null : parent.replace(/\\/g, '/'),
    entries,
  };
}
