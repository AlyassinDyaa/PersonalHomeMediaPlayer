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

/** The layouts that exist, in the order they are offered. */
export const SHELF_LAYOUTS = ['rows', 'grid', 'list'];

/** The ways a cover can be drawn, and what a row can stand on; the page holds the drawings. */
export const SHELF_STYLES = ['plain', 'glass', 'prints', 'tiles', 'neon', 'spines'];
/** How much of a screen one cover takes. */
export const CARD_SIZES = ['small', 'medium', 'large'];
export const SHELF_ROWS = ['none', 'ledge', 'spotlight', 'panel', 'band', 'underglow'];
/** What the sidebar is made of. */
export const RAIL_STYLES = ['solid', 'glass', 'clear'];

/**
 * Sanitise a list of layouts.
 *
 * Anything unrecognised is dropped, and an empty list becomes rails — a
 * library with no way to show its collections at all is not a setting anybody
 * meant to choose, whatever the file says.
 */
function readLayouts(value) {
  if (!Array.isArray(value)) return [...SHELF_LAYOUTS];
  const kept = SHELF_LAYOUTS.filter((name) => value.includes(name));
  return kept.length ? kept : ['rows'];
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
  /*
   * Where the sections added after comics keep their files.
   *
   * Each has its own, because the point of a section is that it is somewhere
   * else — pointing two of them at one folder would scan the same files twice
   * and file them under two names.
   */
  familyRoots: normaliseRoots(local.familyRoots ?? defaults.familyRoots ?? []),
  artworkRoots: normaliseRoots(local.artworkRoots ?? defaults.artworkRoots ?? []),
  /*
   * Which sections are switched on.
   *
   * Films and television are on unless somebody says otherwise, because a
   * library that hides them is not a library. Everything else is off until
   * it has been given somewhere to look.
   */
  sectionsOn: {
    shows: local.sectionsOn?.shows ?? true,
    movies: local.sectionsOn?.movies ?? true,
    comics: local.sectionsOn?.comics ?? (local.showComics ?? false),
    family: local.sectionsOn?.family ?? false,
    artwork: local.sectionsOn?.artwork ?? false,
  },

  /**
   * Whether the Comics tab is offered at all.
   *
   * A library of films and nothing else should not carry a tab that opens on
   * an empty shelf.
   */
  showComics: local.showComics ?? defaults.showComics ?? true,
  /*
   * What sits behind the library.
   *
   * Flat black is honest and, on a screen showing three rows of covers with
   * space around them, completely inert — a wall rather than a room. The
   * alternatives are all slow, dim and made of nothing but the colours the
   * artwork is already using, so they lift the page without competing with
   * the thing the page is for.
   */
  background: local.background ?? defaults.background ?? 'flat',
  /*
   * The colour the backdrop is drawn from.
   *
   * Empty means follow the artwork, which is the default: each page already
   * sets an accent from the poster in front of you, so the room changes as
   * you move through the library at no cost. A value here freezes it.
   */
  backgroundColor: local.backgroundColor ?? defaults.backgroundColor ?? '',
  /*
   * How each row of covers is drawn.
   *
   * The covers on their own is the plain default; the rest are treatments of
   * the same rail — a ledge under it, a frame around each, a wash behind —
   * chosen by looking, in Settings. The page itself does the drawing.
   */
  shelfStyle: local.shelfStyle ?? defaults.shelfStyle ?? 'plain',
  /* And what each row stands on: nothing, a ledge, or a wash of colour. */
  shelfRow: local.shelfRow ?? defaults.shelfRow ?? 'none',
  /* The colour the shelf is drawn in; empty follows the artwork. */
  shelfColor: local.shelfColor ?? defaults.shelfColor ?? '',
  /* How strongly the row's design is drawn, as a percentage. */
  shelfStrength: local.shelfStrength ?? defaults.shelfStrength ?? 50,
  /* What the sidebar is made of: a solid strip, glass, or nothing. */
  railStyle: local.railStyle ?? defaults.railStyle ?? 'glass',
  /* How large the covers are drawn, everywhere they are drawn. */
  cardSize: local.cardSize ?? defaults.cardSize ?? 'medium',
  /* How opaque the sidebar's strip is, as a percentage. */
  railOpacity: local.railOpacity ?? defaults.railOpacity ?? 45,
  /* How strongly the backdrop is drawn, as a percentage of its design. */
  backgroundStrength: local.backgroundStrength ?? defaults.backgroundStrength ?? 100,
  /*
   * Whether televisions on this network may find the library by themselves.
   *
   * Off unless asked for. The protocol a set speaks has no notion of who is
   * asking and no way to add one, so switching this on shares the library with
   * everything in the house — which is exactly what is wanted for a television
   * in the living room and exactly what must not happen by default.
   */
  serveToTelevisions: local.serveToTelevisions ?? defaults.serveToTelevisions ?? false,
  /*
   * Which layouts the collections may be shown in.
   *
   * The choice between rails, tiles and lines belongs to whoever is looking,
   * but which choices exist belongs to whoever looks after the library — a
   * household that only ever wants rails should not have two buttons offering
   * to change something nobody wants changed.
   */
  shelfLayouts: readLayouts(local.shelfLayouts ?? defaults.shelfLayouts),

  /**
   * Whether the home screen also arranges titles by genre.
   *
   * On by default, because a library with no shelves of its own needs some
   * arrangement. Once somebody has made their own shelves those say far more
   * about the library than "Animation" ever did, and this turns the guessed
   * ones off so the made ones are what the page is.
   */
  genreShelves: local.genreShelves ?? defaults.genreShelves ?? true,

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
  /*
   * A line under the name, for when the name is initials.
   *
   * Empty by default, and empty means the door keeps saying "<name>'s
   * Library" — which is right when the name is a person's. Filled in, the
   * name stands alone and this explains it.
   */
  librarySubtitle: local.librarySubtitle ?? defaults.librarySubtitle ?? '',
  libraryColor: local.libraryColor ?? defaults.libraryColor ?? '',

  port: Number(process.env.PORT ?? local.port ?? defaults.port ?? 8787),

  /**
   * The second port, used only when a certificate has been issued.
   *
   * A separate port rather than replacing the first: the certificate covers
   * one name on the private mesh, so a browser reaching this machine by its
   * address on the home network would be shown a certificate for a name it
   * did not ask for and refuse it. The plain port keeps that door open.
   */
  securePort: Number(process.env.SECURE_PORT ?? local.securePort ?? defaults.securePort ?? 8443),

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
  if (typeof patch.background === 'string') allowed.background = patch.background.trim().slice(0, 24);
  if (typeof patch.backgroundColor === 'string') {
    const wanted = patch.backgroundColor.trim();
    // A colour or nothing; anything else is not a thing to paint a room with.
    allowed.backgroundColor = /^#[0-9a-f]{6}$/i.test(wanted) ? wanted.toLowerCase() : '';
  }
  if (typeof patch.shelfStyle === 'string') {
    // One of the styles the page knows how to draw, or the plain one.
    const wanted = patch.shelfStyle.trim();
    allowed.shelfStyle = SHELF_STYLES.includes(wanted) ? wanted : 'plain';
  }
  if (typeof patch.shelfRow === 'string') {
    const wanted = patch.shelfRow.trim();
    allowed.shelfRow = SHELF_ROWS.includes(wanted) ? wanted : 'none';
  }
  if (typeof patch.shelfColor === 'string') {
    const wanted = patch.shelfColor.trim();
    allowed.shelfColor = /^#[0-9a-f]{6}$/i.test(wanted) ? wanted.toLowerCase() : '';
  }
  if (typeof patch.railStyle === 'string') {
    const wanted = patch.railStyle.trim();
    allowed.railStyle = RAIL_STYLES.includes(wanted) ? wanted : 'glass';
  }
  if (typeof patch.cardSize === 'string') {
    const wanted = patch.cardSize.trim();
    allowed.cardSize = CARD_SIZES.includes(wanted) ? wanted : 'medium';
  }
  if (typeof patch.railOpacity === 'number' && Number.isFinite(patch.railOpacity)) {
    allowed.railOpacity = Math.min(100, Math.max(0, Math.round(patch.railOpacity)));
  }
  if (typeof patch.backgroundStrength === 'number' && Number.isFinite(patch.backgroundStrength)) {
    allowed.backgroundStrength = Math.min(100, Math.max(10, Math.round(patch.backgroundStrength)));
  }
  if (typeof patch.shelfStrength === 'number' && Number.isFinite(patch.shelfStrength)) {
    // A whole percentage, and never so faint it looks like a fault.
    allowed.shelfStrength = Math.min(100, Math.max(10, Math.round(patch.shelfStrength)));
  }
  if (typeof patch.serveToTelevisions === 'boolean') allowed.serveToTelevisions = patch.serveToTelevisions;
  if (Array.isArray(patch.shelfLayouts)) allowed.shelfLayouts = readLayouts(patch.shelfLayouts);
  if (typeof patch.genreShelves === 'boolean') allowed.genreShelves = patch.genreShelves;
  if (Array.isArray(patch.comicRoots)) {
    allowed.comicRoots = normaliseRoots(patch.comicRoots);
  }
  if (Array.isArray(patch.familyRoots)) allowed.familyRoots = normaliseRoots(patch.familyRoots);
  if (Array.isArray(patch.artworkRoots)) allowed.artworkRoots = normaliseRoots(patch.artworkRoots);
  if (patch.sectionsOn && typeof patch.sectionsOn === 'object') {
    const on = {};
    for (const id of ['shows', 'movies', 'comics', 'family', 'artwork']) {
      if (typeof patch.sectionsOn[id] === 'boolean') on[id] = patch.sectionsOn[id];
    }
    /* Merged onto what is already set, so switching one section does
       not silently clear the others. */
    allowed.sectionsOn = { ...config.sectionsOn, ...on };
    /* Kept in step for anything still reading the old name. */
    if ('comics' in on) allowed.showComics = on.comics;
  }
  if (typeof patch.groupMoviesByGenre === 'boolean') allowed.groupMoviesByGenre = patch.groupMoviesByGenre;
  if (typeof patch.groupShowsByGenre === 'boolean') allowed.groupShowsByGenre = patch.groupShowsByGenre;
  if (typeof patch.skipIntroEnabled === 'boolean') allowed.skipIntroEnabled = patch.skipIntroEnabled;
  if (typeof patch.skipOutroEnabled === 'boolean') allowed.skipOutroEnabled = patch.skipOutroEnabled;
  if (typeof patch.libraryName === 'string') allowed.libraryName = patch.libraryName.trim().slice(0, 40);
  if (typeof patch.librarySubtitle === 'string') {
    allowed.librarySubtitle = patch.librarySubtitle.trim().slice(0, 60);
  }
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
    librarySubtitle: config.librarySubtitle,
    libraryColor: config.libraryColor,
    skipIntroEnabled: config.skipIntroEnabled,
    skipOutroEnabled: config.skipOutroEnabled,
    comicRoots: config.comicRoots,
    familyRoots: config.familyRoots,
    artworkRoots: config.artworkRoots,
    sectionsOn: config.sectionsOn,
    showComics: config.showComics,
    background: config.background,
    backgroundColor: config.backgroundColor,
    shelfStyle: config.shelfStyle,
    shelfRow: config.shelfRow,
    shelfColor: config.shelfColor,
    shelfStrength: config.shelfStrength,
    railStyle: config.railStyle,
    cardSize: config.cardSize,
    railOpacity: config.railOpacity,
    backgroundStrength: config.backgroundStrength,
    serveToTelevisions: config.serveToTelevisions,
    shelfLayouts: config.shelfLayouts,
    genreShelves: config.genreShelves,
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
