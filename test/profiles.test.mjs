/**
 * Checks that two people watching one library stay out of each other's way.
 *
 * Run against a throwaway data folder, so the real library is never opened.
 * Two things are worth proving here and neither is obvious from reading the
 * SQL: that a library which already exists survives being given profiles, and
 * that one profile's answers are genuinely invisible to another rather than
 * merely filtered out of one query somebody remembered to change.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'profiletest-'));
process.env.MEDIA_CONFIG_DIR = sandbox;
process.env.MEDIA_DATA_DIR = path.join(sandbox, 'data');

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + (error.stack ?? error.message));
    process.exitCode = 1;
  }
}

/*
 * A library from before profiles existed, written by hand.
 *
 * Only the columns the upgrade actually touches are here. Recreating the whole
 * old schema would make this test a copy of the file it is checking, and would
 * pass just as happily if that copy drifted.
 */
const dataDir = path.join(sandbox, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const legacy = new DatabaseSync(path.join(dataDir, 'library.db'));
legacy.exec(`
  CREATE TABLE items (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
    sort_title TEXT NOT NULL, year INTEGER, scan_key TEXT NOT NULL,
    source_folders TEXT NOT NULL DEFAULT '[]', certification TEXT,
    genres TEXT, poster_path TEXT, backdrop_path TEXT, logo_path TEXT,
    added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE videos (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, path TEXT NOT NULL,
    season INTEGER, episode INTEGER, duration REAL, added_at INTEGER NOT NULL
  );
  CREATE TABLE progress (
    video_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
    duration REAL, watched INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_progress_recent ON progress(updated_at DESC);
  CREATE TABLE favorites (item_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL);

  INSERT INTO items VALUES
    ('film-1','movie','Heat','heat',1995,'heat','[]','R','["Crime"]',NULL,NULL,NULL,1,1),
    ('film-2','movie','Paddington','paddington',2014,'pad','[]','PG','["Family"]',NULL,NULL,NULL,1,1);
  INSERT INTO videos VALUES
    ('vid-1','film-1','/films/heat.mkv',NULL,NULL,7000,1),
    ('vid-2','film-2','/films/paddington.mkv',NULL,NULL,5600,1);
  INSERT INTO progress VALUES ('vid-1','film-1',1234,7000,0,111);
  INSERT INTO favorites VALUES ('film-2',222);
`);
legacy.close();

const { getDb } = await import('../server/src/db.js');
const library = await import('../server/src/library.js');
const {
  listProfiles, createProfile, deleteProfile, updateProfile, pinMatches, getProfile,
} = await import('../server/src/profiles.js');

// Opening the database is what runs the upgrade.
const db = getDb();
const owner = listProfiles()[0];

// --- the upgrade ----------------------------------------------------------

check('an existing library gains an owner profile', () => {
  assert.strictEqual(listProfiles().length, 1);
  assert.strictEqual(owner.isOwner, true);
  assert.strictEqual(owner.kind, 'adult');
});

check('what was already watched belongs to that profile', () => {
  const resuming = library.continueWatching(20, owner);
  assert.strictEqual(resuming.length, 1);
  assert.strictEqual(resuming[0].video.id, 'vid-1');
  assert.strictEqual(library.listFavourites(owner).length, 1);
});

check('the index the old table carried is rebuilt, not lost with it', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
  assert.ok(indexes.some((row) => row.name === 'idx_progress_recent'));
});

check('nothing is left behind from the rebuild', () => {
  const leftovers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_pre_profiles'")
    .all();
  assert.deepStrictEqual(leftovers, []);
});

// --- one library, two people ---------------------------------------------

const second = createProfile({ name: 'Brother', pin: '4821' });

check('a second profile starts with nothing watched', () => {
  assert.strictEqual(library.continueWatching(20, second).length, 0);
  assert.strictEqual(library.listFavourites(second).length, 0);
});

check('a new profile never owns the library', () => {
  assert.strictEqual(second.isOwner, false);
});

check('two people can be at different points in the same film', () => {
  library.saveProgress({ videoId: 'vid-1', position: 60, duration: 7000, profile: second });

  const mine = library.continueWatching(20, owner)[0];
  const theirs = library.continueWatching(20, second)[0];
  assert.strictEqual(mine.video.position, 1234);
  assert.strictEqual(theirs.video.position, 60);
});

check('marking something watched does not mark it for everybody', () => {
  library.setWatched('vid-2', true, second);
  assert.strictEqual(library.getVideo('vid-2', second).watched, true);
  assert.strictEqual(library.getVideo('vid-2', owner).watched, false);
});

check('favourites are not shared either', () => {
  library.setFavourite('film-1', true, second);
  assert.deepStrictEqual(library.listFavourites(second).map((i) => i.id), ['film-1']);
  assert.deepStrictEqual(library.listFavourites(owner).map((i) => i.id), ['film-2']);
});

check('forgetting a title only forgets it for the one who asked', () => {
  library.removeFromContinueWatching('film-1', second);
  assert.strictEqual(library.continueWatching(20, second).length, 0);
  assert.strictEqual(library.continueWatching(20, owner).length, 1);
});

check('a query that is not told whose library it is refuses to guess', () => {
  assert.throws(() => library.listItems({}), /whose library/);
  assert.throws(() => library.continueWatching(20), /whose library/);
});

// --- what a limited profile may see --------------------------------------

const child = createProfile({ name: 'Kid', kind: 'kid' });

check('a kids profile is capped at PG by default', () => {
  assert.strictEqual(child.maxCertification, 'PG');
});

check('a rating above the line is off the shelves', () => {
  const titles = library.listItems({ profile: child }).map((item) => item.title);
  assert.deepStrictEqual(titles, ['Paddington']);
});

check('and cannot be reached by knowing its address', () => {
  assert.strictEqual(library.getItem('film-1', child), null);
  assert.strictEqual(library.getVideo('vid-1', child), null);
  assert.strictEqual(library.search('Heat', 60, child).length, 0);
});

check('an unlimited profile still sees everything', () => {
  assert.strictEqual(library.listItems({ profile: owner }).length, 2);
  assert.ok(library.getVideo('vid-1', owner));
});

check('genre rails are counted over what the profile may see', () => {
  const names = library.listGenres(child).map((entry) => entry.name);
  assert.ok(!names.includes('Crime'), 'a rail that would open on nothing');
});

// --- PINs and ownership ---------------------------------------------------

check('a PIN opens its own profile and nothing else opens it', () => {
  assert.strictEqual(pinMatches(second.id, '4821'), true);
  assert.strictEqual(pinMatches(second.id, '0000'), false);
});

check('a profile with no PIN opens for anybody, which is what unset means', () => {
  assert.strictEqual(pinMatches(child.id, ''), true);
});

check('a PIN too short to be protection is refused rather than accepted', () => {
  assert.throws(() => createProfile({ name: 'Short', pin: '12' }), /four digits/);
});

check('the owner cannot be removed, nor demoted to a kids profile', () => {
  assert.throws(() => deleteProfile(owner.id), /owner profile cannot be removed/);
  assert.throws(() => updateProfile(owner.id, { kind: 'kid' }), /cannot be a kids profile/);
});

check('two profiles cannot share a name', () => {
  assert.throws(() => createProfile({ name: 'brother' }), /already a profile/);
});

check('removing a profile takes its history with it', () => {
  const spare = createProfile({ name: 'Guest' });
  library.saveProgress({ videoId: 'vid-1', position: 99, duration: 7000, profile: spare });
  deleteProfile(spare.id);

  assert.strictEqual(getProfile(spare.id), null);
  const orphans = db
    .prepare('SELECT COUNT(*) AS n FROM progress WHERE profile_id = ?')
    .get(spare.id).n;
  assert.strictEqual(orphans, 0);
});

console.log('\npassed ' + passed + ' of ' + total);
