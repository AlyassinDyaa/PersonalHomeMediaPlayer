/**
 * Configuration resolution.
 *
 * Precedence: environment variables, then config.local.json (gitignored, for
 * machine-specific paths and secrets), then config.json (committed defaults).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bundledKey } from './bundled-key.js';
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

/** The first value that was actually supplied; blank strings do not count. */
function firstSet(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function readJson(file) {
  try {
    // Strip a byte-order mark first. These files can be edited by hand, and a
    // Windows editor that saves one would otherwise make the whole file parse
    // as nothing at all — settings silently ignored, with no error anywhere.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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

/**
 * The key shipped inside the build, read once.
 *
 * Kept separately from the resolved key so that clearing a user's own key in
 * Settings falls back to this one rather than leaving the library with no
 * artwork at all.
 */
const BUNDLED_TMDB_KEY = bundledKey(process.env.MEDIA_INSTALL_DIR);

/*
 * Blank is treated as absent rather than as an answer: an empty environment
 * variable is easy to end up with, and ?? would take it as a deliberate choice
 * and leave the library with no artwork and no explanation.
 */
const userTmdbKey = firstSet(process.env.TMDB_API_KEY, local.tmdbApiKey);

const dataDir = process.env.MEDIA_DATA_DIR
  ?? local.dataDir
  ?? defaults.dataDir
  ?? path.join(PROJECT_ROOT, 'data');

/**
 * Tidy a list of folders: one separator, no trailing slash, no blanks, no
 * repeats. Shared by the film roots and the comic roots, which want the same
 * treatment and used to have two copies of it.
 */
function normaliseRoots(roots) {
  return [...new Set(
    (Array.isArray(roots) ? roots : [])
      .filter((root) => typeof root === 'string' && root.trim())
      .map((root) => root.trim().replace(/\\/g, '/').replace(/\/+$/, '')),
  )];
}

export const config = {
  /** Directories to scan. A missing root is reported, not fatal. */
  libraryRoots: (process.env.MEDIA_LIBRARY_ROOTS?.split(path.delimiter).filter(Boolean))
    ?? local.libraryRoots
    ?? defaults.libraryRoots
    ?? [],

  dataDir,
  databasePath: path.join(dataDir, 'library.db'),
  artworkDir: path.join(dataDir, 'artwork'),

  /**
   * Where the video caches go — repacked films and streaming segments.
   *
   * Separate from dataDir because these are the only things here measured in
   * hundreds of gigabytes, while everything else beside them is a database and
   * some posters. A portable build keeps its data next to the executable, so
   * left together the caches grow inside whatever folder the app was unzipped
   * into, which is rarely where somebody wants a third of a terabyte.
   *
   * Defaults to sitting with the rest of the data, so an untouched install
   * behaves as it always did.
   */
  cacheDir: process.env.MEDIA_CACHE_DIR ?? local.cacheDir ?? defaults.cacheDir ?? dataDir,

  /*
   * A key the user typed always wins, so replacing an expired one in Settings
   * takes effect. Below it sits the key shipped inside the build, so a fresh
   * copy has artwork and descriptions without anything being pasted in first.
   */
  tmdbApiKey: userTmdbKey ?? BUNDLED_TMDB_KEY,

  /**
   * Whether the key in use came with the build rather than from the user.
   * Only used to word the Settings screen honestly: a key someone pasted and a
   * key that was already there are not the same thing to look at.
   */
  tmdbKeyIsBundled: !userTmdbKey && Boolean(BUNDLED_TMDB_KEY),
  tmdbLanguage: process.env.TMDB_LANGUAGE ?? local.tmdbLanguage ?? 'en-US',

  /**
   * Skip Intro and Skip Outro prompts. Both can be turned off: without chapter
   * markers their timings are conventional guesses rather than measurements,
   * and a prompt at the wrong moment is worse than none.
   */
  skipIntroEnabled: local.skipIntroEnabled ?? defaults.skipIntroEnabled ?? true,
  skipOutroEnabled: local.skipOutroEnabled ?? defaults.skipOutroEnabled ?? true,

  /**
   * Folders holding comics.
   *
   * Separate from libraryRoots because they are a different medium read by
   * different code: pointing the video scanner at a shelf of .cbr files would
   * find nothing, and pointing the comic scanner at a film folder the same.
   */
  comicRoots: normaliseRoots(local.comicRoots ?? defaults.comicRoots ?? []),

  /**
   * Whether the Comics tab is offered at all.
   *
   * A library of films and nothing else should not carry a tab that opens on
   * an empty shelf.
   */
  showComics: local.showComics ?? defaults.showComics ?? true,

  /*
   * Whether the Movies and TV Shows screens arrange titles under genre
   * headings or simply list everything.
   *
   * Kept separately for the two, because a library is rarely the same shape on
   * both sides: fifty films spread across a dozen genres are worth arranging,
   * while twenty series that are nearly all Animation are not.
   */
  groupMoviesByGenre: local.groupMoviesByGenre ?? defaults.groupMoviesByGenre ?? true,
  groupShowsByGenre: local.groupShowsByGenre ?? defaults.groupShowsByGenre ?? true,

  /** Shown in the header, e.g. "Dyaa's Library". Blank falls back to a generic label. */
  libraryName: local.libraryName ?? defaults.libraryName ?? '',
  libraryColor: local.libraryColor ?? defaults.libraryColor ?? '',

  port: Number(process.env.PORT ?? local.port ?? defaults.port ?? 8787),

  /** Path to the mpv binary; resolved at playback time if left null. */
  mpvPath: process.env.MPV_PATH ?? local.mpvPath ?? defaults.mpvPath ?? null,

  /** Folder holding ffmpeg and ffprobe; found automatically when left null. */
  ffmpegDir: process.env.FFMPEG_DIR ?? local.ffmpegDir ?? defaults.ffmpegDir ?? null,

  /**
   * Whether other devices on the home network may reach the library.
   *
   * Off by default. Turning it on makes the server listen on every interface
   * rather than only on this machine, so it is a deliberate choice rather than
   * something that happens quietly.
   */
  remoteAccess: local.remoteAccess ?? defaults.remoteAccess ?? false,

  /**
   * The passcode that guards remote access, kept only as a hash.
   *
   * A browser on the home network is not the same as a trusted desktop app, so
   * remote access is refused outright unless a passcode has been set.
   */
  passcodeHash: local.passcodeHash ?? null,
  passcodeSalt: local.passcodeSalt ?? null,

  /**
   * Signs the cookie that keeps a browser logged in. Generated once and kept,
   * so a restart does not sign everyone out.
   */
  sessionSecret: local.sessionSecret ?? null,
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
 * Hash a passcode.
 *
 * scrypt rather than a plain digest: it is deliberately slow, so a stolen
 * settings file cannot be run through a word list at speed.
 */
export function hashPasscode(passcode, salt) {
  return crypto.scryptSync(passcode, salt, 32).toString('hex');
}

/**
 * Whether a passcode matches the stored one.
 * Compared in constant time, so a wrong guess reveals nothing by how long it
 * took to reject.
 */
export function passcodeMatches(passcode) {
  if (!config.passcodeHash || !config.passcodeSalt) return false;
  const attempt = Buffer.from(hashPasscode(String(passcode ?? ''), config.passcodeSalt), 'hex');
  const stored = Buffer.from(config.passcodeHash, 'hex');
  if (attempt.length !== stored.length) return false;
  return crypto.timingSafeEqual(attempt, stored);
}

/** The secret used to sign login cookies, created on first use. */
export function sessionSecret() {
  if (!config.sessionSecret) {
    const secret = crypto.randomBytes(32).toString('hex');
    // Written straight to disk: a secret that changed every restart would sign
    // every browser out whenever the app was reopened.
    const current = readJson(LOCAL_CONFIG_PATH);
    fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      LOCAL_CONFIG_PATH,
      JSON.stringify({ ...current, sessionSecret: secret }, null, 2) + '\n',
      'utf8',
    );
    config.sessionSecret = secret;
  }
  return config.sessionSecret;
}

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
    allowed.libraryRoots = normaliseRoots(patch.libraryRoots);
  }
  if (typeof patch.showComics === 'boolean') allowed.showComics = patch.showComics;
  if (Array.isArray(patch.comicRoots)) {
    allowed.comicRoots = normaliseRoots(patch.comicRoots);
  }
  if (typeof patch.groupMoviesByGenre === 'boolean') allowed.groupMoviesByGenre = patch.groupMoviesByGenre;
  if (typeof patch.groupShowsByGenre === 'boolean') allowed.groupShowsByGenre = patch.groupShowsByGenre;
  if (typeof patch.skipIntroEnabled === 'boolean') allowed.skipIntroEnabled = patch.skipIntroEnabled;
  if (typeof patch.skipOutroEnabled === 'boolean') allowed.skipOutroEnabled = patch.skipOutroEnabled;
  if (typeof patch.libraryName === 'string') allowed.libraryName = patch.libraryName.trim().slice(0, 40);
  // The colour the library's name is written in. Only a plain hex colour is
  // accepted: this value is interpolated into a stylesheet, and anything else
  // reaching that far would be a way to inject rules into the page.
  if (typeof patch.libraryColor === 'string') {
    const wanted = patch.libraryColor.trim();
    allowed.libraryColor = /^#[0-9a-fA-F]{6}$/.test(wanted) ? wanted.toLowerCase() : '';
  }
  if (typeof patch.mpvPath === 'string') allowed.mpvPath = patch.mpvPath.trim() || null;
  if (typeof patch.remoteAccess === 'boolean') {
    // An unguarded library on a shared network is not something to allow by
    // accident, so this is refused rather than quietly corrected.
    if (patch.remoteAccess && !config.passcodeHash && typeof patch.passcode !== 'string') {
      throw new Error('Set a passcode before sharing the library');
    }
    allowed.remoteAccess = patch.remoteAccess;
  }

  // The passcode is never stored, only a hash of it. Clearing it is done by
  // sending an empty string, which also switches remote access off, because
  // an unguarded library on the network is not something to leave running.
  if (typeof patch.passcode === 'string') {
    const wanted = patch.passcode.trim();
    if (!wanted) {
      allowed.passcodeHash = null;
      allowed.passcodeSalt = null;
      allowed.remoteAccess = false;
    } else if (wanted.length < 4) {
      throw new Error('A passcode needs at least four characters');
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      allowed.passcodeSalt = salt;
      allowed.passcodeHash = hashPasscode(wanted, salt);
    }
  }
  // Where the database and artwork live. Applying it needs a restart, which the
  // desktop app performs; the value is stored here so both processes agree.
  if (typeof patch.dataDir === 'string' && patch.dataDir.trim()) {
    allowed.dataDir = patch.dataDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }
  // A key the user pastes replaces the one that shipped with the build, and
  // clearing the box goes back to the shipped one rather than to nothing — the
  // way to undo a mistyped key without hunting for the original.
  if (typeof patch.tmdbApiKey === 'string') allowed.tmdbApiKey = patch.tmdbApiKey.trim() || null;

  const current = readJson(LOCAL_CONFIG_PATH);
  const next = { ...current, ...allowed };
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

  Object.assign(config, allowed);
  if ('tmdbApiKey' in allowed) {
    config.tmdbApiKey = allowed.tmdbApiKey ?? BUNDLED_TMDB_KEY;
    config.tmdbKeyIsBundled = !allowed.tmdbApiKey && Boolean(BUNDLED_TMDB_KEY);
  }
  return settingsView();
}

/** The subset of configuration safe to expose to the UI. */
export function settingsView() {
  return {
    libraryName: config.libraryName,
    libraryColor: config.libraryColor,
    skipIntroEnabled: config.skipIntroEnabled,
    skipOutroEnabled: config.skipOutroEnabled,
    comicRoots: config.comicRoots,
    showComics: config.showComics,
    comicRootsStatus: config.comicRoots.map((root) => ({
      path: root,
      available: fs.existsSync(root),
    })),
    groupMoviesByGenre: config.groupMoviesByGenre,
    groupShowsByGenre: config.groupShowsByGenre,
    libraryRoots: config.libraryRoots,
    rootsStatus: config.libraryRoots.map((root) => ({
      path: root,
      available: fs.existsSync(root),
    })),
    dataDir: config.dataDir,
    mpvPath: config.mpvPath,
    remoteAccess: config.remoteAccess,
    // Whether one is set, never what it is.
    passcodeSet: Boolean(config.passcodeHash),
    // Never return the key itself, only whether one is present and where it
    // came from, so Settings can say whether it is the included key or one the
    // user supplied — and offer to go back to the included one.
    tmdbConfigured: hasTmdb(),
    tmdbKeyIsBundled: Boolean(config.tmdbKeyIsBundled),
    tmdbKeyBundledAvailable: Boolean(BUNDLED_TMDB_KEY),
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
