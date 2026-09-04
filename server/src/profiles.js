/**
 * Who is watching, and what each of them is allowed to see.
 *
 * The passcode in auth.js answers a different question: whether a device may
 * reach this library at all. It is one secret for the whole household, and it
 * has to be, because it guards the front door. Once through that door there
 * was previously nobody in particular watching — one Continue Watching row,
 * one set of favourites, shared by everyone who knew the code.
 *
 * A profile is the answer to "which of us is this". Picking one cannot get
 * anybody into a library they could not already reach, which is why a PIN here
 * is optional and its absence is not a hole: it stops a younger reader
 * wandering into an older sibling's row, which is the thing being asked for.
 *
 * One profile is the owner. That one is not a matter of taste — it is the only
 * profile allowed to see where the library's files live or to change them, so
 * that handing the passcode to a brother in another city shares the films
 * without also sharing the drives they sit on.
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';
import { hashPasscode } from './config.js';

/** Colours offered when none is chosen, so profiles are told apart at a glance. */
const PALETTE = ['#e50914', '#0071eb', '#e6b91e', '#1db954', '#b14ae0', '#ff6b35'];

/**
 * Certifications in order of how much they assume of a viewer.
 *
 * Film and television are rated in two different vocabularies and a library
 * holds both, so they share one ladder here. The rungs do not line up
 * perfectly — no two countries' boards agree either — but they are ordered
 * well enough to answer the only question asked of them: is this above the
 * line a profile was given.
 */
const CERTIFICATION_RANK = new Map(Object.entries({
  'TV-Y': 0,
  G: 0,
  'TV-Y7': 1,
  'TV-G': 1,
  PG: 2,
  'TV-PG': 2,
  'PG-13': 3,
  'TV-14': 3,
  R: 4,
  'TV-MA': 4,
  'NC-17': 5,
}));

/**
 * Every certification at or below a limit, or null when there is no limit.
 *
 * Null and "no rating I recognise" are deliberately the same answer. A limit
 * this module cannot place is not a limit it can enforce, and quietly hiding
 * the whole library would be a worse failure than showing it.
 */
export function allowedCertifications(limit) {
  if (!limit) return null;
  const ceiling = CERTIFICATION_RANK.get(limit);
  if (ceiling == null) return null;
  return [...CERTIFICATION_RANK.entries()]
    .filter(([, rank]) => rank <= ceiling)
    .map(([name]) => name);
}

/** The shape handed to the UI. The PIN hash never leaves this module. */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    colour: row.colour || PALETTE[0],
    kind: row.kind,
    isOwner: Boolean(row.is_owner),
    hasPin: Boolean(row.pin_hash),
    maxCertification: row.max_certification ?? null,
  };
}

export function listProfiles() {
  return getDb()
    .prepare('SELECT * FROM profiles ORDER BY position, created_at')
    .all()
    .map(shape);
}

export function getProfile(id) {
  if (!id) return null;
  return shape(getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

/**
 * The profile to assume when nobody has said who they are.
 *
 * Opening the library on the machine it runs on should not demand a choice
 * before anything can be seen, so the owner stands in until one is picked.
 * db.js guarantees there is one.
 */
export function defaultProfileId() {
  const row = getDb()
    .prepare('SELECT id FROM profiles ORDER BY is_owner DESC, position, created_at LIMIT 1')
    .get();
  return row?.id ?? null;
}

/** Whether an id names a profile that exists. */
export function profileExists(id) {
  if (!id) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM profiles WHERE id = ?').get(id));
}

/** Whether a profile may see and change where the library's files live. */
export function isOwner(id) {
  if (!id) return false;
  const row = getDb().prepare('SELECT is_owner FROM profiles WHERE id = ?').get(id);
  return Boolean(row?.is_owner);
}

function normaliseName(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('A profile needs a name');
  if (text.length > 40) throw new Error('That name is too long');
  return text;
}

/**
 * A PIN is four or more digits, or nothing at all.
 *
 * Refused rather than quietly accepted when shorter, for the same reason the
 * passcode is: a two-digit PIN reads as protection and is not.
 */
function hashPin(pin) {
  if (pin == null || pin === '') return { hash: null, salt: null };
  const text = String(pin).trim();
  if (!/^\d{4,}$/.test(text)) throw new Error('A PIN must be at least four digits');
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: hashPasscode(text, salt), salt };
}

/**
 * Add a profile.
 *
 * Never an owner: there is exactly one, it is the profile the library was set
 * up with, and a route that could mint another would undo the whole point of
 * having one.
 */
export function createProfile({ name, colour, kind = 'adult', pin, maxCertification } = {}) {
  const db = getDb();
  const clean = normaliseName(name);
  if (kind !== 'adult' && kind !== 'kid') throw new Error('Unknown kind of profile');

  const taken = db.prepare('SELECT 1 FROM profiles WHERE LOWER(name) = ?').get(clean.toLowerCase());
  if (taken) throw new Error('There is already a profile called ' + clean);

  const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  const { hash, salt } = hashPin(pin);
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO profiles
      (id, name, colour, kind, is_owner, pin_hash, pin_salt, max_certification, position, created_at)
    VALUES (?,?,?,?,0,?,?,?,?,?)
  `).run(
    id,
    clean,
    colour || PALETTE[count % PALETTE.length],
    kind,
    hash,
    salt,
    maxCertification ?? (kind === 'kid' ? 'PG' : null),
    count,
    Date.now(),
  );

  return getProfile(id);
}

/**
 * Change a profile. Only the keys present are touched.
 *
 * A `pin` of empty string removes the PIN; leaving the key out keeps whatever
 * is there. The difference matters, because a settings form that always sent
 * every field would otherwise wipe a PIN each time a name was edited.
 *
 * Ownership is not in the list, and cannot be: it is the one property that
 * decides who may see the drives, so it does not move by PUT.
 */
export function updateProfile(id, patch = {}) {
  const db = getDb();
  const existing = getProfile(id);
  if (!existing) return null;

  const sets = [];
  const values = [];

  if ('name' in patch) {
    const clean = normaliseName(patch.name);
    const taken = db
      .prepare('SELECT 1 FROM profiles WHERE LOWER(name) = ? AND id <> ?')
      .get(clean.toLowerCase(), id);
    if (taken) throw new Error('There is already a profile called ' + clean);
    sets.push('name = ?');
    values.push(clean);
  }
  if ('colour' in patch) {
    sets.push('colour = ?');
    values.push(patch.colour ?? '');
  }
  if ('kind' in patch) {
    if (patch.kind !== 'adult' && patch.kind !== 'kid') throw new Error('Unknown kind of profile');
    // The owner administers the library. A profile that cannot see a film
    // rated above PG is not the one to be pointing it at new drives.
    if (patch.kind === 'kid' && existing.isOwner) {
      throw new Error('The owner profile cannot be a kids profile');
    }
    sets.push('kind = ?');
    values.push(patch.kind);
  }
  if ('maxCertification' in patch) {
    sets.push('max_certification = ?');
    values.push(patch.maxCertification || null);
  }
  if ('pin' in patch) {
    const { hash, salt } = hashPin(patch.pin);
    sets.push('pin_hash = ?', 'pin_salt = ?');
    values.push(hash, salt);
  }

  if (sets.length) {
    db.prepare('UPDATE profiles SET ' + sets.join(', ') + ' WHERE id = ?').run(...values, id);
  }
  return getProfile(id);
}

/**
 * Remove a profile, and with it everything that profile had watched.
 *
 * The owner cannot go. Nothing else in the library can name where the films
 * live, so deleting it would leave a library nobody could ever point at a new
 * drive again.
 */
export function deleteProfile(id) {
  const db = getDb();
  const existing = getProfile(id);
  if (!existing) return null;
  if (existing.isOwner) throw new Error('The owner profile cannot be removed');

  // progress, favorites and comic_progress cascade from here.
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return { id, removed: true };
}

/**
 * Whether a PIN opens a profile.
 *
 * Compared in constant time, and a profile with no PIN opens for anybody —
 * which is what leaving it unset means, not an oversight.
 */
export function pinMatches(id, pin) {
  const row = getDb().prepare('SELECT pin_hash, pin_salt FROM profiles WHERE id = ?').get(id);
  if (!row) return false;
  if (!row.pin_hash || !row.pin_salt) return true;

  const expected = Buffer.from(row.pin_hash);
  const given = Buffer.from(hashPasscode(String(pin ?? '').trim(), row.pin_salt));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}
