/**
 * Checks who is let into a section of the library.
 *
 * Run against a throwaway data folder, so the real library is never opened.
 *
 * The rule that needs proving is the default. What is stored is who is shut
 * out, not who is let in, precisely so that a section switched on for the
 * first time is on for the whole house — record it the other way round and
 * turning Comics on would show it to nobody, and the switch would look broken.
 * The other is that the owner cannot be shut out of something they administer.
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
const { maySee, setAllowed, blockedFrom } = await import('../server/src/sections.js');

const owner = listProfiles().find((profile) => profile.isOwner);
const child = createProfile({ name: 'Sam', kind: 'kid' });
const guest = createProfile({ name: 'Alex' });

check('a section nobody has touched is open to the whole house', () => {
  assert.strictEqual(maySee('comics', owner.id), true);
  assert.strictEqual(maySee('comics', child.id), true);
  assert.strictEqual(maySee('comics', guest.id), true);
  assert.deepStrictEqual(blockedFrom('comics'), []);
});

check('somebody left off the list is shut out, and the rest are not', () => {
  setAllowed('comics', [child.id]);
  assert.strictEqual(maySee('comics', child.id), true);
  assert.strictEqual(maySee('comics', guest.id), false);
});

check('the owner keeps a section they were not listed for', () => {
  setAllowed('comics', []);
  assert.strictEqual(maySee('comics', owner.id), true, 'the owner holds the switch');
  assert.strictEqual(maySee('comics', child.id), false);
  assert.strictEqual(maySee('comics', guest.id), false);
});

check('giving it back to everybody leaves nobody shut out', () => {
  setAllowed('comics', [child.id, guest.id]);
  assert.deepStrictEqual(blockedFrom('comics'), []);
  assert.strictEqual(maySee('comics', guest.id), true);
});

check('one section says nothing about another', () => {
  setAllowed('comics', []);
  // Anything this module was not told to govern is nobody's business to gate.
  assert.strictEqual(maySee('films', child.id), true);
  assert.deepStrictEqual(blockedFrom('films'), []);
});

check('a section that does not exist cannot be set', () => {
  assert.throws(() => setAllowed('sweets', []), /no section/i);
});

check('the machine the library runs on is not asked who it is', () => {
  setAllowed('comics', []);
  // No profile at all means the console at home, which is already the owner's.
  assert.strictEqual(maySee('comics', null), true);
});

check('a profile that is removed takes its exclusion with it', () => {
  setAllowed('comics', [guest.id]);
  assert.ok(blockedFrom('comics').includes(child.id));

  deleteProfile(child.id);
  assert.ok(!blockedFrom('comics').includes(child.id), 'no rows left pointing at nobody');
});

console.log('\npassed ' + passed + ' of ' + total);
