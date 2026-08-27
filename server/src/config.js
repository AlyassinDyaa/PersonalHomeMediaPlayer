/**
 * Configuration resolution.
 *
 * Precedence: environment variables, then config.local.json (gitignored, for
 * machine-specific paths and secrets), then config.json (committed defaults).
 */

import crypto from 'node:crypto';
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
    // A key left behind with nothing after the equals sign means "no value",
    // not "the empty value". Loading it would mask the saved setting below.
    if (!value) continue;
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

/**
 * The first of these values that is actually set.
 *
 * `??` alone is not enough, because an empty string is neither null nor
 * undefined and therefore wins. That is how a saved API key could appear to
 * vanish on every restart: a blank TMDB_API_KEY — a line left in .env after
 * the key was removed, or a system variable set to nothing — took precedence
 * over the key in the settings file, every time, however many times it was
 * entered again.
 */
function firstSet(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      return trimmed;
    }
    return value;
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

const dataDir = firstSet(process.env.MEDIA_DATA_DIR, local.dataDir, defaults.dataDir)
  ?? path.join(PROJECT_ROOT, 'data');

export const config = {
  /** Directories to scan. A missing root is reported, not fatal. */
  libraryRoots: firstSet(
    // An empty list is not an answer either: a blank variable must fall
    // through to the settings file rather than emptying the library.
    process.env.MEDIA_LIBRARY_ROOTS?.split(path.delimiter).filter(Boolean).length
      ? process.env.MEDIA_LIBRARY_ROOTS.split(path.delimiter).filter(Boolean)
      : null,
    local.libraryRoots?.length ? local.libraryRoots : null,
    defaults.libraryRoots?.length ? defaults.libraryRoots : null,
  ) ?? [],

  dataDir,
  databasePath: path.join(dataDir, 'library.db'),
  artworkDir: path.join(dataDir, 'artwork'),

  tmdbApiKey: firstSet(process.env.TMDB_API_KEY, local.tmdbApiKey),
  tmdbLanguage: firstSet(process.env.TMDB_LANGUAGE, local.tmdbLanguage) ?? 'en-US',

  /**
   * Skip Intro and Skip Outro prompts. Both can be turned off: without chapter
   * markers their timings are conventional guesses rather than measurements,
   * and a prompt at the wrong moment is worse than none.
   */
  skipIntroEnabled: local.skipIntroEnabled ?? defaults.skipIntroEnabled ?? true,
  skipOutroEnabled: local.skipOutroEnabled ?? defaults.skipOutroEnabled ?? true,

  /**
   * Whether the computer stays awake while the library is shared.
   *
   * On by default, because a sleeping computer serves nobody: a tablet halfway
   * through an episode simply loses the picture, and one that has not started
   * yet cannot reach the library at all. Sharing is already a deliberate choice
   * rather than something that happens quietly, so staying awake to honour it
   * is the behaviour that matches the intent. Only the system is kept up — the
   * screen is still free to turn itself off.
   */
  keepAwakeWhileSharing: local.keepAwakeWhileSharing ?? defaults.keepAwakeWhileSharing ?? true,

  /** Shown in the header, e.g. "Dyaa's Library". Blank falls back to a generic label. */
  libraryName: local.libraryName ?? defaults.libraryName ?? '',
  libraryColor: local.libraryColor ?? defaults.libraryColor ?? '',

  port: Number(process.env.PORT ?? local.port ?? defaults.port ?? 8787),

  /** Path to the mpv binary; resolved at playback time if left null. */
  mpvPath: firstSet(process.env.MPV_PATH, local.mpvPath, defaults.mpvPath),

  /** Folder holding ffmpeg and ffprobe; found automatically when left null. */
  ffmpegDir: firstSet(process.env.FFMPEG_DIR, local.ffmpegDir, defaults.ffmpegDir),

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
    // Normalise separators and drop blanks and duplicates.
    allowed.libraryRoots = [...new Set(
      patch.libraryRoots
        .filter((root) => typeof root === 'string' && root.trim())
        .map((root) => root.trim().replace(/\\/g, '/').replace(/\/+$/, '')),
    )];
  }
  if (typeof patch.keepAwakeWhileSharing === 'boolean') {
    allowed.keepAwakeWhileSharing = patch.keepAwakeWhileSharing;
  }
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
  // An empty value is how the key is removed. Storing it as a blank string
  // would leave a setting that reads as present and behaves as absent.
  if (typeof patch.tmdbApiKey === 'string') {
    allowed.tmdbApiKey = patch.tmdbApiKey.trim() || null;
  }

  const current = readJson(LOCAL_CONFIG_PATH);
  const next = { ...current, ...allowed };
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

  Object.assign(config, allowed);
  return settingsView();
}

/** Enough of a secret to recognise it by, and no more. */
function keyHint(key) {
  if (!key) return null;
  return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
}

/** The subset of configuration safe to expose to the UI. */
export function settingsView() {
  return {
    libraryName: config.libraryName,
    libraryColor: config.libraryColor,
    keepAwakeWhileSharing: config.keepAwakeWhileSharing,
    skipIntroEnabled: config.skipIntroEnabled,
    skipOutroEnabled: config.skipOutroEnabled,
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
    // Never return the key itself, only whether one is present and enough of
    // it to recognise. Without that the field is always blank, there is no way
    // to tell a saved key from a lost one, and the natural response is to paste
    // it again — which is what made this look like it was never being saved.
    tmdbConfigured: hasTmdb(),
    tmdbKeyHint: keyHint(config.tmdbApiKey),
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
