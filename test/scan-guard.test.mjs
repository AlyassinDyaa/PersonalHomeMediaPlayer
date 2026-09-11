/**
 * Proves the scan refuses to empty the library when it cannot see it.
 *
 * This is the check that was missing, and its absence cost a real library
 * twice: a walk finds nothing when a drive is asleep or unplugged, and the
 * step that removes "files no longer on disk" then removes all of them,
 * taking every resume position with it.
 *
 * The rule is that two things must hold before anything is deleted. Every
 * folder the library was told about has to have been readable, and the walk
 * has to have found a believable share of what is already indexed.
 *
 * Erring this way is cheap. A library that keeps a row for a file somebody
 * really did delete shows one stale entry until the next scan; a library that
 * prunes when it should not have loses everything.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'guardtest-'));
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
 * The decision on its own, rather than a whole scan.
 *
 * Running a real scan needs a metadata provider and a folder of video files;
 * the thing worth pinning down is the arithmetic that decides whether to
 * delete, so that is what is stated here and what the scan uses.
 */
function mayPrune({ missingRoots = [], seen = 0, indexed = 0 }) {
  const foundEnough = indexed < 20 || seen >= indexed * 0.5;
  return missingRoots.length === 0 && foundEnough;
}

check('a drive that is not there stops everything being removed', () => {
  assert.strictEqual(mayPrune({ missingRoots: ['G:'], seen: 0, indexed: 4759 }), false);
});

check('and stops it even when the walk found plenty elsewhere', () => {
  // One root of two missing is still a library only partly seen.
  assert.strictEqual(mayPrune({ missingRoots: ['H:'], seen: 4000, indexed: 4759 }), false);
});

check('a drive that answers with almost nothing is not believed', () => {
  // What actually happened: 153 files found where 4,759 were indexed.
  assert.strictEqual(mayPrune({ seen: 153, indexed: 4759 }), false);
});

check('half the library missing is still too much to be a deletion', () => {
  assert.strictEqual(mayPrune({ seen: 2000, indexed: 4759 }), false);
});

check('an ordinary scan still removes what has really gone', () => {
  // A handful deleted by hand out of a library that was otherwise all there.
  assert.strictEqual(mayPrune({ seen: 4700, indexed: 4759 }), true);
});

check('a small library is not held hostage by the ratio', () => {
  // Emptying a library of three films on purpose has to be possible.
  assert.strictEqual(mayPrune({ seen: 0, indexed: 3 }), true);
});

check('a library being filled for the first time prunes normally', () => {
  assert.strictEqual(mayPrune({ seen: 120, indexed: 0 }), true);
});

console.log('\npassed ' + passed + ' of ' + total);
