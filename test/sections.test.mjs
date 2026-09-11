/**
 * Checks who is let into a section of the library.
 *
 * Run against a throwaway data folder, so the real library is never opened.
 *
 * The rule that needs proving is the default, and it is the opposite of the
 * one this file used to prove. What is stored is who has been let in, so a
 * section switched on for the first time is on for nobody until somebody is
 * named. Recorded the other way round — which is how it began — switching a
 * section on handed it to the whole house at once, and a permission that
 * arrives without being granted is the one mistake here that cannot be taken
 * back once somebody has looked.
 *
 * Films and television are the exception, and deliberately: they are not a
 * section somebody made, they are the library. Until somebody actually
 * restricts them they stay open, because a fresh library that shows nobody
 * any films is broken rather than private.
 *
 * The last rule is that the owner cannot be shut out of what they administer.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sectiontest-'));
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

const { createProfile, listProfiles, deleteProfile } = await import('../server/src/profiles.js');
const { maySee, setAllowed, allowedIn } = await import('../server/src/sections.js');

const owner = listProfiles().find((profile) => profile.isOwner);
const child = createProfile({ name: 'Sam', kind: 'kid' });
const guest = createProfile({ name: 'Alex' });

check('a section nobody has been added to is on for nobody', () => {
  assert.strictEqual(maySee('artwork', child.id), false);
  assert.strictEqual(maySee('artwork', guest.id), false);
  assert.deepStrictEqual(allowedIn('artwork'), []);
});

check('the owner has it before anybody has been named', () => {
  assert.strictEqual(maySee('artwork', owner.id), true, 'the owner holds the switch');
});

check('the library itself stays open until somebody restricts it', () => {
  // Not a section somebody made: a house where nobody has been given Movies
  // should still be shown Movies.
  assert.strictEqual(maySee('movies', child.id), true);
  assert.strictEqual(maySee('shows', guest.id), true);
});

check('naming somebody lets in exactly them', () => {
  setAllowed('comics', [child.id]);
  assert.strictEqual(maySee('comics', child.id), true);
  assert.strictEqual(maySee('comics', guest.id), false);
  assert.deepStrictEqual(allowedIn('comics'), [child.id]);
});

check('and restricting the library works the same way once it is done', () => {
  setAllowed('movies', [guest.id]);
  assert.strictEqual(maySee('movies', guest.id), true);
  assert.strictEqual(maySee('movies', child.id), false, 'named nobody else, so nobody else');
});

check('the owner keeps a section they were not listed for', () => {
  setAllowed('comics', []);
  assert.strictEqual(maySee('comics', owner.id), true);
  assert.strictEqual(maySee('comics', child.id), false);
});

check('the owner is never written down, so cannot be removed', () => {
  setAllowed('comics', [owner.id, guest.id]);
  assert.ok(!allowedIn('comics').includes(owner.id), 'held by right, not by row');
  assert.strictEqual(maySee('comics', owner.id), true);
});

check('one section says nothing about another', () => {
  setAllowed('comics', [guest.id]);
  assert.strictEqual(maySee('artwork', guest.id), false);
});

check('anything this module does not govern is nobody to gate', () => {
  assert.strictEqual(maySee('sweets', child.id), true);
  assert.deepStrictEqual(allowedIn('sweets'), []);
});

check('a section that does not exist cannot be set', () => {
  assert.throws(() => setAllowed('sweets', []), /no section/i);
});

check('the machine the library runs on is not asked who it is', () => {
  setAllowed('comics', []);
  // No profile at all means the console at home, which is already the owner's.
  assert.strictEqual(maySee('comics', null), true);
});

check('a profile that is removed takes its permission with it', () => {
  setAllowed('comics', [child.id, guest.id]);
  assert.ok(allowedIn('comics').includes(child.id));

  deleteProfile(child.id);
  assert.ok(!allowedIn('comics').includes(child.id), 'no rows left pointing at nobody');
  assert.ok(allowedIn('comics').includes(guest.id), 'and nobody else disturbed');
});

console.log('\npassed ' + passed + ' of ' + total);
