/**
 * SQLite persistence, built on Node's bundled `node:sqlite`.
 *
 * Using the built-in driver rather than better-sqlite3 avoids a native module,
 * which in turn avoids rebuilding against Electron's ABI when the desktop app
 * is packaged.
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { config, ensureDataDirs } from './config.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A movie or a show. One row per thing the user sees on the home screen.
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('movie', 'show')),
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  year         INTEGER,
  scan_key     TEXT NOT NULL,
  source_folders TEXT NOT NULL DEFAULT '[]',

  tmdb_id      INTEGER,
  tmdb_score   REAL,
  overview     TEXT,
  tagline      TEXT,
  poster_path  TEXT,
  backdrop_path TEXT,
  logo_path    TEXT,
  rating       REAL,
  genres       TEXT,
  runtime      INTEGER,
  certification TEXT,
  status       TEXT,

  confidence   REAL NOT NULL DEFAULT 1.0,
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_sort ON items(sort_title);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_scan_key ON items(scan_key);

-- Seasons belong to shows.
CREATE TABLE IF NOT EXISTS seasons (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  name        TEXT,
  overview    TEXT,
  poster_path TEXT,
  air_date    TEXT,
  UNIQUE (item_id, number)
);

-- A playable file. Movies have exactly one; episodes have one each.
CREATE TABLE IF NOT EXISTS videos (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  season_id    TEXT REFERENCES seasons(id) ON DELETE CASCADE,
  season       INTEGER,
  episode      INTEGER,
  episode_end  INTEGER,

  title        TEXT,
  overview     TEXT,
  still_path   TEXT,
  air_date     TEXT,

  path         TEXT NOT NULL UNIQUE,
  size         INTEGER NOT NULL DEFAULT 0,
  extension    TEXT,
  duration     REAL,
  parse_pattern TEXT,
  alternatives TEXT NOT NULL DEFAULT '[]',

  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_item ON videos(item_id);
CREATE INDEX IF NOT EXISTS idx_videos_episode ON videos(item_id, season, episode);

CREATE TABLE IF NOT EXISTS subtitles (
  id       TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  name     TEXT,
  language TEXT,
  UNIQUE (video_id, path)
);

-- Playback position, the backbone of "Continue Watching".
CREATE TABLE IF NOT EXISTS progress (
  video_id   TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position   REAL NOT NULL DEFAULT 0,
  duration   REAL,
  watched    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_recent ON progress(updated_at DESC);

-- User corrections that must survive a rescan: forced TMDB matches, forced
-- merges/splits, hidden items.
CREATE TABLE IF NOT EXISTS overrides (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Groupings the scanner is unsure about, surfaced for confirmation.
CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  confidence REAL NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  item_id  TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL
);

-- Cached TMDB responses, so rescans do not re-hit the API.
CREATE TABLE IF NOT EXISTS tmdb_cache (
  url        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  stats       TEXT
);
`;

let database = null;

export function getDb() {
  if (database) return database;
  ensureDataDirs();
  database = new DatabaseSync(config.databasePath);
  database.exec(SCHEMA);
  return database;
}

export function closeDb() {
  if (database) {
    database.close();
    database = null;
  }
}

/**
 * Stable identifier derived from content rather than insertion order, so a
 * rescan produces the same ids and preserves progress and favourites.
 */
export function stableId(...parts) {
  return crypto.createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 16);
}

/** Title used for alphabetical sorting: leading articles moved out of the way. */
export function sortTitle(title) {
  return String(title)
    .replace(/^(the|a|an)\s+/i, '')
    .toLowerCase()
    .trim();
}

export function now() {
  return Date.now();
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
