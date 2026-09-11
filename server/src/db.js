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

const BASE_SCHEMA = `
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

-- Who is watching.
--
-- One row per person who uses the library. The passcode decides whether a
-- device may reach the library at all; a profile decides whose half-watched
-- episodes and favourites it sees once it is in. The two are separate
-- questions, and answering only the first is what made one household share a
-- single Continue Watching row.
--
-- A PIN is optional and is not a second passcode: it stops a younger reader
-- wandering into someone else's profile, and it is stored the way the
-- passcode is, as a salted scrypt hash.
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  colour       TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'adult' CHECK (kind IN ('adult', 'kid')),
  -- The one profile allowed to see where the library's files live, and to
  -- point it at new ones. Exactly one row carries it: the profile the library
  -- was set up with. Sharing the passcode shares the films, not the drives.
  is_owner     INTEGER NOT NULL DEFAULT 0,
  pin_hash     TEXT,
  pin_salt     TEXT,
  -- Highest certification this profile may see, e.g. 'PG'. Null means no limit.
  max_certification TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_order ON profiles(position, created_at);

-- Who is kept out of a whole section of the library.
--
-- Stored as the people shut out rather than the people let in, so that no rows
-- means everybody, which is what a section switched on for the first time has
-- to mean. Recording the allowed instead would make an empty table say "nobody
-- may see this", and turning comics on would show them to no one.
--
-- Keyed by section name rather than by a column per section, because the next
-- one of these is already known about and a table that grows a column every
-- time is a migration every time.
/*
 * A folder inside a section, and what to call it.
 *
 * The arrangement comes from the disk — whatever the folders are, those are
 * the groups — but the name does not have to. A folder called "2019-08
 * holiday raw" is a fine name for a folder and a poor heading on a screen, so
 * a name given here stands in front of it. Empty means use the folder's own.
 */
CREATE TABLE IF NOT EXISTS section_folders (
  id         TEXT PRIMARY KEY,
  section    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL,
  UNIQUE (section, kind, path)
);

/*
 * A picture in a section.
 *
 * Not a video and so not an item: it has no runtime, nothing to resume, and
 * nothing to look up anywhere. Kept apart rather than forced into a shape
 * built for films.
 */
CREATE TABLE IF NOT EXISTS section_images (
  id         TEXT PRIMARY KEY,
  section    TEXT NOT NULL,
  folder_id  TEXT,
  path       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_section_images ON section_images(section, folder_id);

/*
 * Who has been let into a section.
 *
 * The other way round from how this started. It used to record who was shut
 * out, so switching a section on gave it to the whole house at once — the
 * right default for a shelf of comics bought for everybody, and the wrong one
 * for anything private. Now nobody has a section until they are given it, and
 * the owner always has it.
 */
CREATE TABLE IF NOT EXISTS section_grants (
  section    TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (section, profile_id)
);

CREATE TABLE IF NOT EXISTS section_blocks (
  section    TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (section, profile_id)
);

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

-- Shelves arranged by hand.
--
-- A collection either lists its titles in collection_items, or names a folder
-- and takes whatever is under it. folder_path is what tells the two apart:
-- null means somebody picked the titles, a path means the disk decides.
CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  folder_path TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items ON collection_items(collection_id, position);

-- Things people would like added.
--
-- A profile that is not the owner cannot add to the library or even see where
-- the files are kept, so there was no way to say "I would like this" short of
-- telling the owner in person. This is that, written down.
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  note        TEXT,
  -- open, done, or declined. Kept rather than deleted so somebody is not left
  -- wondering whether their request was ever seen.
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'done', 'declined')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, created_at DESC);

-- A universe's logo, once it has been found.
--
-- Remembered rather than fetched per page: the picture for "DC" does not
-- change between scans, and a library opened without a network connection
-- should still look like itself.
CREATE TABLE IF NOT EXISTS universe_logos (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  logo_path  TEXT,
  updated_at INTEGER NOT NULL
);

-- Comics.
--
-- Kept apart from items and videos rather than folded into them: a comic is
-- a folder of archives read a page at a time, with no seasons, no episodes
-- and no runtime, and the two would only be sharing the word "library".
--
-- A series is any folder that directly holds comic files. The shelf above it
-- is remembered as a plain string, because that is what the folder tree
-- already says and there is nothing to gain by modelling it twice.
CREATE TABLE IF NOT EXISTS comic_series (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  sort_title TEXT NOT NULL,
  shelf      TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL UNIQUE,
  added_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comic_series_shelf ON comic_series(shelf);

CREATE TABLE IF NOT EXISTS comic_issues (
  id         TEXT PRIMARY KEY,
  series_id  TEXT NOT NULL REFERENCES comic_series(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  number     REAL,
  year       INTEGER,
  path       TEXT NOT NULL UNIQUE,
  format     TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  -- Filled in the first time the comic is opened, not during a scan: it
  -- means reading the archive, and a library of a thousand issues would
  -- turn a scan into an afternoon.
  pages      INTEGER,
  added_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comic_issues_series ON comic_issues(series_id);

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

/**
 * Tables holding one person's answers rather than the library's facts.
 *
 * Kept out of the schema above and described here because they are the three
 * that had to change shape when profiles arrived, and a library that already
 * exists cannot simply be given the new shape: `CREATE TABLE IF NOT EXISTS`
 * sees a table of that name and leaves the old one alone. Each therefore
 * carries its own CREATE, the columns to copy across, and the indexes that
 * follow the old table when it is renamed out of the way.
 *
 * `columns` deliberately lists every column except `profile_id`, because that
 * is exactly the set an upgrade copies — the new column is supplied, the rest
 * come over untouched.
 */
const PER_PROFILE_TABLES = [
  {
    table: 'progress',
    columns: 'video_id, item_id, position, duration, watched, updated_at',
    indexes: ['idx_progress_recent'],
    create: `
-- Playback position, the backbone of "Continue Watching".
CREATE TABLE IF NOT EXISTS progress (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position   REAL NOT NULL DEFAULT 0,
  duration   REAL,
  watched    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_recent ON progress(profile_id, updated_at DESC);
`,
  },
  {
    table: 'favorites',
    columns: 'item_id, added_at',
    indexes: [],
    create: `
CREATE TABLE IF NOT EXISTS favorites (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);
`,
  },
  {
    table: 'watchlist',
    columns: 'kind, target_id, added_at',
    indexes: [],
    /*
     * What somebody means to get to. One table for every medium: a title is
     * an item, a run of comics is a series, and `kind` says which the id
     * belongs to. Nothing is enforced against either parent, because a
     * comic series lives in a table that can be rebuilt by a scan and a
     * dangling row is simply skipped when the list is read.
     */
    create: `
CREATE TABLE IF NOT EXISTS watchlist (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, target_id)
);
`,
  },
  {
    table: 'backlog',
    columns: 'item_id, added_at',
    indexes: [],
    /*
     * Started, and set aside.
     *
     * Continue Watching answers "what were you in the middle of", and a title
     * nobody intends to go back to soon makes it answer badly — four episodes
     * of something abandoned in March push out the thing being watched this
     * week. Taking it off used to mean forgetting where you were, which is a
     * poor trade for tidiness.
     *
     * A row here keeps the position and stops the title being offered. It is
     * a shelf, not a bin.
     */
    create: `
CREATE TABLE IF NOT EXISTS backlog (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);
`,
  },
  {
    table: 'comic_progress',
    columns: 'issue_id, series_id, page, pages, finished, updated_at',
    indexes: [],
    create: `
-- Where a reader got to, mirroring what progress does for video.
CREATE TABLE IF NOT EXISTS comic_progress (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  issue_id   TEXT NOT NULL REFERENCES comic_issues(id) ON DELETE CASCADE,
  series_id  TEXT NOT NULL REFERENCES comic_series(id) ON DELETE CASCADE,
  page       INTEGER NOT NULL DEFAULT 0,
  pages      INTEGER,
  finished   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, issue_id)
);
`,
  },
];

const SCHEMA = BASE_SCHEMA + PER_PROFILE_TABLES.map((entry) => entry.create).join('');

let database = null;

/**
 * Columns added after the initial schema.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing database untouched, so new
 * columns have to be added explicitly or an upgrade silently keeps the old
 * shape and queries fail at runtime.
 */
const MIGRATIONS = [
  { table: 'videos', column: 'runtime', definition: 'INTEGER' },
  // Where each profile was last seen, so the owner can tell a tablet in the
  // house from somebody signed in over the mesh network.
  { table: 'profiles', column: 'last_address', definition: 'TEXT' },
  { table: 'profiles', column: 'last_seen_at', definition: 'INTEGER' },
  // When a profile has a picture of its own, this is when it was set — used to
  // bust the browser's cache, since the file name never changes.
  { table: 'profiles', column: 'avatar_at', definition: 'INTEGER' },
  /*
   * What this person wants to hear, and whether they want to read along.
   *
   * Empty means English, which is what the library assumed for everybody
   * before it could be asked. A household is rarely of one mind about this:
   * the same film wants Arabic for one person and subtitles for another, and
   * both were previously settled by whoever packaged the file.
   */
  { table: 'profiles', column: 'audio_language', definition: 'TEXT' },
  { table: 'profiles', column: 'subtitle_language', definition: 'TEXT' },
  { table: 'profiles', column: 'subtitles_on', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // A collection's own badge: an image path at the metadata provider, and a
  // colour to ring it with. Added after collections shipped, so existing
  // libraries need the columns put on rather than the table rebuilt.
  { table: 'collections', column: 'logo_path', definition: 'TEXT' },
  { table: 'collections', column: 'accent', definition: 'TEXT' },
  // The colour taken out of a title's poster, so each one can light its own
  // page rather than every page wearing the same red.
  { table: 'items', column: 'accent', definition: 'TEXT' },
  /*
   * The year a programme finished, where it has.
   *
   * "2000" under a series says when it started and leaves the more useful
   * half unsaid: whether it is still going, and how long it ran. The year it
   * began was already kept; this is the other end of the line.
   */
  { table: 'items', column: 'end_year', definition: 'INTEGER' },
  /*
   * Which part of the library a title belongs to.
   *
   * Everything scanned from the film and television folders is "library" and
   * always was; the sections added later keep their own titles apart under
   * their own name. Held on the title rather than in a table of its own so
   * every query that already knows how to find a film — playback, resume,
   * favourites, the lot — keeps working for them without being taught
   * anything new. What it must be taught is to leave them out, which is one
   * clause in the few places that list "the library".
   */
  { table: 'items', column: 'section', definition: "TEXT NOT NULL DEFAULT 'library'" },
  /* The folder it was found in, for the sections that are arranged that way. */
  { table: 'items', column: 'folder_id', definition: 'TEXT' },
  /*
   * Where a shelf belongs: the films screen, the shows screen, or both.
   *
   * Added after collections shipped, so existing shelves need the column put
   * on rather than the table rebuilt. Empty means "wherever its titles live",
   * which is what every shelf made before this did.
   */
  { table: 'collections', column: 'shown_on', definition: 'TEXT' },
  /*
   * The key the scanner groups by, kept beside the one it is stored under.
   *
   * An item that matched is stored under its database identity, so the key it
   * was found by is otherwise lost — and that is the key every user
   * correction is filed against. Without it, forcing a title wrote a note the
   * scanner never read, and 'Wrong title?' quietly did nothing.
   */
  { table: 'items', column: 'group_key', definition: 'TEXT' },
];

function migrate(db) {
  for (const { table, column, definition } of MIGRATIONS) {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (columns.some((info) => info.name === column)) continue;
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  }
  try {
    fillEndYears(db);
  } catch {
    // A date that could not be filled in is not a reason to refuse to open.
  }
  try {
    carryOverSectionAccess(db);
  } catch {
    // Same: a library that opens without this is better than one that does not.
  }
}

/**
 * Fill in when a series finished, for the ones already scanned.
 *
 * A new column arrives empty, and the year a programme ended would otherwise
 * appear only for whatever is scanned next — so a library would show the
 * dates of its newest handful and nothing for the rest until somebody
 * rescanned every folder they own.
 *
 * Nothing needs fetching. The answer is in the replies already kept from the
 * metadata provider, which are stored against the address they came from, so
 * this reads what is on the disk and asks nobody. Only rows still empty are
 * touched, so it costs one query on every start after the first.
 */
function fillEndYears(db) {
  /*
   * Nothing here is worth failing to open a database over.
   *
   * This runs on every open, including one being made from scratch and one
   * old enough to predate the columns it reads — a test fixture, or a library
   * carried forward from far enough back. Asked for a column that is not
   * there, SQLite raises, and raising inside a migration takes the whole
   * library down rather than leaving one date unfilled.
   */
  const columns = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!columns.has('end_year') || !columns.has('tmdb_id') || !columns.has('kind')) return;
  const hasCache = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tmdb_cache'",
  ).get();
  if (!hasCache) return;

  const pending = db.prepare(`
    SELECT id, tmdb_id FROM items
    WHERE kind = 'show' AND end_year IS NULL AND tmdb_id IS NOT NULL
  `).all();
  if (pending.length === 0) return;

  const cached = db.prepare(
    "SELECT body FROM tmdb_cache WHERE url LIKE ? AND url NOT LIKE '%/season/%' LIMIT 1",
  );
  const write = db.prepare('UPDATE items SET end_year = ? WHERE id = ?');

  let filled = 0;
  for (const row of pending) {
    const hit = cached.get('/tv/' + row.tmdb_id + '%');
    if (!hit) continue;
    try {
      const ended = JSON.parse(hit.body)?.last_air_date;
      if (!ended) continue;
      const year = Number(String(ended).slice(0, 4));
      if (!year) continue;
      write.run(year, row.id);
      filled += 1;
    } catch {
      // A reply that will not parse is one this cannot help with.
    }
  }
  if (filled) console.log('filled in the end year for ' + filled + ' series');
}

/**
 * Turn "who was shut out" into "who was let in", once.
 *
 * Comics used to be on for the whole house the moment it was switched on, and
 * a row existed only for somebody taken off it. Reading that table the new way
 * round would have said nobody had comics at all, so everybody in the house
 * would have lost a section they were using — a silent revocation, which is
 * the worst way for a permission change to arrive.
 *
 * So the old answer is carried across: anybody not shut out is granted. Done
 * once, guarded by whether any grant exists yet, and only where the old table
 * is actually there.
 */
function carryOverSectionAccess(db) {
  const has = (name) => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  if (!has('section_grants') || !has('section_blocks') || !has('profiles')) return;

  const already = db.prepare('SELECT 1 FROM section_grants LIMIT 1').get();
  if (already) return;

  const sections = db.prepare('SELECT DISTINCT section FROM section_blocks').all();
  /* Nothing was ever restricted, so there is nothing to carry: comics was on
     for everybody, and that is what an empty blocks table meant. */
  if (sections.length === 0) return;

  const profiles = db.prepare('SELECT id FROM profiles').all();
  const blocked = db.prepare('SELECT 1 FROM section_blocks WHERE section = ? AND profile_id = ?');
  const grant = db.prepare('INSERT OR IGNORE INTO section_grants (section, profile_id) VALUES (?, ?)');

  let carried = 0;
  for (const { section } of sections) {
    for (const profile of profiles) {
      if (blocked.get(section, profile.id)) continue;
      grant.run(section, profile.id);
      carried += 1;
    }
  }
  if (carried) console.log('carried ' + carried + ' section permissions across');
}

/**
 * The profile that owns everything watched before there were profiles.
 *
 * Named after the library when it has a name, because that is what the person
 * who set it up already called it, and a first profile labelled "Profile 1"
 * would be a worse answer than one labelled with their own words.
 *
 * @returns {string} the id of the first profile, creating it if need be.
 */
function ensureDefaultProfile(db) {
  const existing = db
    .prepare('SELECT id FROM profiles ORDER BY position, created_at LIMIT 1')
    .get();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO profiles (id, name, colour, kind, is_owner, position, created_at)
    VALUES (?,?,?,?,1,?,?)
  `).run(id, (config.libraryName ?? '').trim() || 'Me', config.libraryColor ?? '', 'adult', 0, Date.now());
  return id;
}

/**
 * Give an existing library the per-profile shape.
 *
 * The three tables holding personal answers were keyed on the video, the item
 * and the issue alone, because there was only ever one viewer. Adding a column
 * is not enough: the primary key has to widen too, or two people cannot both
 * be halfway through the same episode. SQLite cannot alter a primary key, so
 * each table is rebuilt beside itself and its rows handed to the first
 * profile — which is the truthful answer, since that history really was one
 * person's.
 */
function adoptProfiles(db) {
  const pending = PER_PROFILE_TABLES.filter(({ table }) => {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
    return columns.length > 0 && !columns.some((info) => info.name === 'profile_id');
  });
  if (pending.length === 0) return;

  const profileId = ensureDefaultProfile(db);

  /*
   * Rows are copied between two tables pointing at the same parents, so the
   * constraints are stood down rather than tripped by a half-finished copy.
   * The pragma has no effect inside a transaction, which is why it sits
   * outside one.
   */
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      for (const { table, columns, indexes, create } of pending) {
        /*
         * An index follows its table through a rename and keeps its name, so
         * the new table's `CREATE INDEX IF NOT EXISTS` would quietly find the
         * name taken, do nothing, and leave the index to be dropped with the
         * old table — an upgraded library slower than a fresh one, silently.
         */
        for (const index of indexes) db.exec('DROP INDEX IF EXISTS ' + index);

        db.exec('ALTER TABLE ' + table + ' RENAME TO ' + table + '_pre_profiles');
        db.exec(create);
        db.prepare(
          'INSERT INTO ' + table + ' (profile_id, ' + columns + ') '
          + 'SELECT ?, ' + columns + ' FROM ' + table + '_pre_profiles',
        ).run(profileId);
        db.exec('DROP TABLE ' + table + '_pre_profiles');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Whether an error means the connection itself has gone, rather than the query
 * being wrong.
 *
 * SQLite reports a handle whose file has become unreachable as a disk I/O
 * error. It keeps reporting it for every statement afterwards, because the
 * connection stays open and stays broken.
 */
function connectionLost(error) {
  const text = String(error?.message ?? '').toLowerCase();
  return text.includes('disk i/o error')
    || text.includes('sqlite_ioerr')
    || text.includes('database disk image');
}

/** Open the file and bring the schema up to date. */
function open() {
  ensureDataDirs();
  const db = new DatabaseSync(config.databasePath);
  db.exec(SCHEMA);
  migrate(db);
  adoptProfiles(db);
  // A library always has somebody watching it, including on the very first
  // run, so every query below can assume a profile exists rather than guard.
  ensureDefaultProfile(db);
  return db;
}

/**
 * The connection, reopened if it has died under us.
 *
 * The library lives on a large drive that can briefly go away — asleep, or
 * unplugged and back. When that happens every statement on the open handle
 * fails with a disk I/O error from then on, even though the file is perfectly
 * readable again: nothing ever reopened it, so the library stayed empty until
 * the app was restarted by hand. Reopening once and retrying turns that from
 * an evening's outage into a pause.
 *
 * Only I/O errors retry. A constraint violation or a mistake in a query is
 * reported as it always was, because running it a second time would not help.
 */
function withRetry(run) {
  try {
    return run(database);
  } catch (error) {
    if (!connectionLost(error)) throw error;
    console.warn('database connection lost (' + error.message + '); reopening');
    try { database.close(); } catch { /* it is already gone */ }
    database = open();
    return run(database);
  }
}

/**
 * A statement that can survive its connection being replaced.
 *
 * The error surfaces when the statement runs, not when it is prepared, so the
 * text is kept and prepared again against the new connection.
 */
function resilientStatement(sql) {
  let statement = database.prepare(sql);
  const call = (method) => (...args) => withRetry((db) => {
    // A reopened connection invalidates the old statement, so it is rebuilt
    // whenever the one we hold belongs to a connection that has been replaced.
    if (statement.__db !== db) {
      statement = db.prepare(sql);
      statement.__db = db;
    }
    return statement[method](...args);
  });

  statement.__db = database;
  return {
    all: call('all'),
    get: call('get'),
    run: call('run'),
    iterate: call('iterate'),
  };
}

export function getDb() {
  if (!database) database = open();
  return {
    prepare: (sql) => resilientStatement(sql),
    exec: (sql) => withRetry((db) => db.exec(sql)),
  };
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
