/**
 * Which parts of the library each profile is let into.
 *
 * A section is a whole area rather than a title: Comics today, a family area
 * next. Turning one on is the owner's decision and so is who it is on *for* —
 * a shelf of comics that suits one reader is not automatically for everybody
 * in the house, and the same will be true of anything else kept apart.
 *
 * Two rules shape this, and both come from what the first press has to do.
 *
 * A section switched on is on for everybody until somebody is taken off it, so
 * what is stored is who is shut out. Were it the other way round the owner
 * would turn Comics on, see an empty list of permitted readers, and have given
 * it to nobody — the switch would appear not to work.
 *
 * The owner is never shut out. They are the one holding the switch, and a
 * library whose owner can lock themselves out of a section they administer is
 * a library with a support call in it.
 */

import { getDb } from './db.js';
import { isOwner } from './profiles.js';

/** The sections this applies to. Anything not named here is open to everyone. */
export const SECTIONS = new Set(['comics']);

function known(section) {
  return typeof section === 'string' && SECTIONS.has(section);
}

/** The profiles shut out of one section. */
export function blockedFrom(section) {
  if (!known(section)) return [];
  return getDb()
    .prepare('SELECT profile_id FROM section_blocks WHERE section = ?')
    .all(section)
    .map((row) => row.profile_id);
}

/**
 * Whether one profile may see a section.
 *
 * Nobody in particular — a request with no profile at all — is treated as
 * allowed, because that is the machine the library runs on, which has already
 * proved it is the owner's.
 */
export function maySee(section, profileId) {
  if (!known(section)) return true;
  if (!profileId) return true;
  if (isOwner(profileId)) return true;

  const row = getDb()
    .prepare('SELECT 1 FROM section_blocks WHERE section = ? AND profile_id = ?')
    .get(section, profileId);
  return !row;
}

/**
 * Set exactly who may see a section.
 *
 * Takes the allowed list rather than the blocked one, because that is the
 * question the owner is answering — the storing of it the other way round is
 * this module's business, not the caller's.
 *
 * @param {string} section
 * @param {string[]} allowedIds  Profiles that may see it. The owner always may.
 */
export function setAllowed(section, allowedIds) {
  if (!known(section)) throw new Error('There is no section called "' + section + '".');

  const db = getDb();
  const allowed = new Set(Array.isArray(allowedIds) ? allowedIds : []);
  const everyone = db.prepare('SELECT id, is_owner FROM profiles').all();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM section_blocks WHERE section = ?').run(section);
    const block = db.prepare('INSERT INTO section_blocks (section, profile_id) VALUES (?, ?)');
    for (const profile of everyone) {
      if (profile.is_owner) continue;
      if (allowed.has(profile.id)) continue;
      block.run(section, profile.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return blockedFrom(section);
}
