/**
 * Checks moving a title from one shelf to another.
 *
 * Run against a throwaway data folder, so the real library is never opened.
 *
 * The reason this is one operation rather than a remove followed by an add:
 * a shelved title is hidden from the main grid, so a title caught between the
 * two calls is on no shelf and in no grid — findable only by searching for a
 * name you would have to already know. The transaction is the point, and these
 * are the cases that prove it holds.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'shelftest-'));
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

const { getDb } = await import('../server/src/db.js');
const {
  createCollection, addToCollection, collectionItems, moveTitles,
} = await import('../server/src/collections.js');

/** A title in the library, written straight in — the scanner is not the subject. */
function title(id, name, kind = 'movie') {
  getDb().prepare(`
    INSERT INTO items (id, kind, title, sort_title, scan_key, source_folders, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
  `).run(id, kind, name, name.toLowerCase(), 'key:' + id, Date.now(), Date.now());
  return id;
}

const alpha = createCollection({ name: 'Alpha', shownOn: 'movie' });
const beta = createCollection({ name: 'Beta', shownOn: 'movie' });

title('film-1', 'One');
title('film-2', 'Two');
title('film-3', 'Three');
addToCollection(alpha.id, 'film-1');
addToCollection(alpha.id, 'film-2');

const idsOn = (shelf) => collectionItems(shelf).map((entry) => entry.id).sort();

check('a title leaves the old shelf and lands on the new one', () => {
  const result = moveTitles(alpha.id, beta.id, ['film-1']);
  assert.strictEqual(result.moved, 1);
  assert.deepStrictEqual(idsOn(alpha.id), ['film-2']);
  assert.deepStrictEqual(idsOn(beta.id), ['film-1']);
});

check('a title that was never on the shelf is not conjured onto the other', () => {
  const result = moveTitles(alpha.id, beta.id, ['film-3']);
  assert.strictEqual(result.moved, 0);
  assert.deepStrictEqual(idsOn(beta.id), ['film-1'], 'nothing added');
  assert.deepStrictEqual(idsOn(alpha.id), ['film-2'], 'nothing lost');
});

check('a title the target already holds is simply taken off the old shelf', () => {
  addToCollection(alpha.id, 'film-1');
  assert.deepStrictEqual(idsOn(alpha.id), ['film-1', 'film-2']);

  const result = moveTitles(alpha.id, beta.id, ['film-1']);
  assert.strictEqual(result.moved, 1);
  assert.deepStrictEqual(idsOn(alpha.id), ['film-2']);
  assert.deepStrictEqual(idsOn(beta.id), ['film-1'], 'still there once, not twice');
});

check('several titles move together', () => {
  addToCollection(alpha.id, 'film-3');
  const result = moveTitles(alpha.id, beta.id, ['film-2', 'film-3']);
  assert.strictEqual(result.moved, 2);
  assert.deepStrictEqual(idsOn(alpha.id), []);
  assert.deepStrictEqual(idsOn(beta.id), ['film-1', 'film-2', 'film-3']);
});

check('moving to the shelf it is already on is refused', () => {
  assert.throws(() => moveTitles(beta.id, beta.id, ['film-1']), /already on/i);
});

check('a shelf that follows a folder is not edited by hand', () => {
  const folder = createCollection({ name: 'On the stick', folderPath: 'G:/Stick', shownOn: 'movie' });
  assert.throws(() => moveTitles(beta.id, folder.id, ['film-1']), /follows a folder/i);
  assert.throws(() => moveTitles(folder.id, beta.id, ['film-1']), /follows a folder/i);
});

check('a shelf that does not exist is not found', () => {
  assert.strictEqual(moveTitles(beta.id, 'nowhere', ['film-1']), null);
  assert.strictEqual(moveTitles('nowhere', beta.id, ['film-1']), null);
});

check('nothing asked for is nothing done', () => {
  const result = moveTitles(beta.id, alpha.id, []);
  assert.strictEqual(result.moved, 0);
  assert.deepStrictEqual(idsOn(beta.id), ['film-1', 'film-2', 'film-3']);
});

/*
 * A title lives on one shelf.
 *
 * The shelves are the library's arrangement rather than a set of tags, and a
 * shelved title is taken out of the main grid — so a title on two shelves is
 * one listed twice, with nothing to say which shelf it really belongs to.
 * Filing it somewhere is filing it, not copying it.
 */

check('putting a title on a shelf takes it off the one it was on', () => {
  const gamma = createCollection({ name: 'Gamma', shownOn: 'movie' });
  addToCollection(alpha.id, 'film-1');
  assert.deepStrictEqual(idsOn(alpha.id), ['film-1']);

  addToCollection(gamma.id, 'film-1');
  assert.deepStrictEqual(idsOn(gamma.id), ['film-1']);
  assert.deepStrictEqual(idsOn(alpha.id), [], 'no longer on the shelf it came from');
});

check('a shelf keeps its other titles when one of them is filed elsewhere', () => {
  const delta = createCollection({ name: 'Delta', shownOn: 'movie' });
  addToCollection(delta.id, 'film-2');
  addToCollection(delta.id, 'film-3');
  assert.deepStrictEqual(idsOn(delta.id), ['film-2', 'film-3']);

  const epsilon = createCollection({ name: 'Epsilon', shownOn: 'movie' });
  addToCollection(epsilon.id, 'film-2');
  assert.deepStrictEqual(idsOn(delta.id), ['film-3'], 'only the one filed moved');
  assert.deepStrictEqual(idsOn(epsilon.id), ['film-2']);
});

console.log('\npassed ' + passed + ' of ' + total);
