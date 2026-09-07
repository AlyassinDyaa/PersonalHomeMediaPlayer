/**
 * Checks that "New" means new.
 *
 * The mark is worth exactly as much as its restraint: a library where every
 * poster is flagged is a library saying nothing. That is not a hypothetical —
 * the date a title carries is the date it was last scanned, so moving the
 * films to another drive stamps all of them with the same moment, and the
 * obvious rule of "added in the last fortnight" marks the entire shelf.
 *
 * These are the cases that rule has to tell apart, and two of them were wrong
 * in the first version: three films arriving marked all 136, and a third of
 * the library arriving at once marked 45 rather than none.
 */

import assert from 'node:assert';
import { rememberArrivals, isRecent } from '../desktop/src/recent.js';

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

const DAY = 24 * 60 * 60 * 1000;
const scanned = Date.now() - 2 * DAY;

/** A library of `count` titles, all scanned at the same moment. */
function library(count = 136) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'item-' + index,
    addedAt: scanned,
  }));
}

/** How many of a library would wear the mark. */
function flagged(items) {
  rememberArrivals(items);
  return items.filter(isRecent).length;
}

/** Give the first `howMany` titles a later arrival, `days` after the scan. */
function arriving(items, howMany, days) {
  return items.map((item, index) => (
    index < howMany ? { ...item, addedAt: scanned + days * DAY } : item
  ));
}

check('a freshly scanned library marks nothing', () => {
  assert.strictEqual(flagged(library()), 0);
});

check('three films arriving later are the three that are marked', () => {
  assert.strictEqual(flagged(arriving(library(), 3, 1)), 3);
});

check('a third of the library arriving at once is a rescan, not an arrival', () => {
  assert.strictEqual(flagged(arriving(library(), 45, 1)), 0);
});

check('a season arriving together is still too much to mark', () => {
  assert.strictEqual(flagged(arriving(library(), 20, 1)), 0);
});

check('a few evenings of downloading are all marked', () => {
  const items = library().map((item, index) => (
    index < 12 ? { ...item, addedAt: scanned + (1 + (index % 4)) * DAY } : item
  ));
  assert.strictEqual(flagged(items), 12);
});

check('nothing old enough to be forgotten is marked', () => {
  assert.strictEqual(flagged(arriving(library(), 3, -400)), 0);
});

check('a library too small to have proportions marks nothing', () => {
  assert.strictEqual(flagged(arriving(library(6), 1, 1)), 0);
});

check('titles with no date at all are simply not marked', () => {
  const items = library().map((item) => ({ ...item, addedAt: undefined }));
  assert.strictEqual(flagged(items), 0);
});

console.log('\npassed ' + passed + ' of ' + total);
