/**
 * The parts of the library, what each is made of, and who is let into it.
 *
 * A section is a whole area rather than a title. Films and television are the
 * two that were always here; comics, family and artwork are kept apart from
 * them and from each other, because a shelf collected for one person is not
 * automatically for everybody in the house.
 *
 * Two rules, and the first one has been turned around since this was written.
 *
 * Nobody has a section until they are given it. It used to be the other way
 * — a section switched on was on for the whole house until somebody was taken
 * off it — which is right for a shelf of comics bought for everybody and
 * quite wrong for anything private. Switching one on and finding it went to
 * nobody is a surprise; switching one on and finding it went to everybody is
 * a disclosure, and only one of those can be undone.
 *
 * The owner is never shut out. They hold the switch, and a library whose
 * owner can lock themselves out of a section they administer is a library
 * with a support call in it.
 */

import { getDb } from './db.js';
import { isOwner } from './profiles.js';

/**
 * Every section, in the order they are offered.
 *
 * `folders` says whether it keeps its own place on the disk and is scanned
 * separately; films and television share the main library folders and are
 * scanned with it, so they have none of their own. `media` says what a scan
 * should look for.
 */
export const SECTIONS = [
  {
    id: 'shows',
    label: 'TV Shows',
    hint: 'Series from the main library folders',
    folders: false,
    media: [],
  },
  {
    id: 'movies',
    label: 'Movies',
    hint: 'Films from the main library folders',
    folders: false,
    media: [],
  },
  {
    id: 'comics',
    label: 'Comics',
    hint: 'Folders of .cbz and .cbr files, read page by page',
    folders: true,
    media: ['comic'],
  },
  {
    id: 'family',
    label: 'Family',
    hint: 'Home videos, kept in whatever folders you already keep them in',
    folders: true,
    media: ['video', 'image'],
  },
  {
    id: 'artwork',
    label: 'Artwork',
    hint: 'Pictures and videos, arranged by folder',
    folders: true,
    media: ['video', 'image'],
  },
];

const BY_ID = new Map(SECTIONS.map((entry) => [entry.id, entry]));

/** One section's description, or null. */
export function sectionInfo(id) {
  return BY_ID.get(id) ?? null;
}

/** Whether a name is one of ours. */
function known(section) {
  return typeof section === 'string' && BY_ID.has(section);
}

/** The sections that keep their own folders and are scanned on their own. */
export const SCANNED_SECTIONS = SECTIONS.filter((entry) => entry.folders).map((entry) => entry.id);

/* ------------------------------------------------------------- who may --- */

/** The profiles let into one section. */
export function allowedIn(section) {
  if (!known(section)) return [];
  return getDb()
    .prepare('SELECT profile_id FROM section_grants WHERE section = ?')
    .all(section)
    .map((row) => row.profile_id);
}

/**
 * Whether one profile may see a section.
 *
 * Nobody in particular — a request carrying no profile at all — is treated as
 * the owner, because that is the machine the library runs on and it has
 * already proved whose it is.
 *
 * Films and television are not gated by this unless somebody has actually
 * restricted them: a library where nobody has been given Movies should show
 * Movies, not present an empty house.
 */
export function maySee(section, profileId) {
  if (!known(section)) return true;
  if (!profileId) return true;
  if (isOwner(profileId)) return true;

  const db = getDb();
  const info = BY_ID.get(section);

  /*
   * A section that has never had anybody added to it.
   *
   * For the two that came with the library that means "not restricted", and
   * everybody keeps them. For a section somebody made on purpose it means
   * exactly what it says: nobody has been let in yet.
   */
  if (!info.folders) {
    const any = db.prepare('SELECT 1 FROM section_grants WHERE section = ? LIMIT 1').get(section);
    if (!any) return true;
  }

  const row = db
    .prepare('SELECT 1 FROM section_grants WHERE section = ? AND profile_id = ?')
    .get(section, profileId);
  return Boolean(row);
}

/**
 * Set exactly who may see a section.
 *
 * @param {string} section
 * @param {string[]} allowedIds Profiles let in. The owner is not stored: they
 *   always have it, and writing it down would only invite it being removed.
 */
export function setAllowed(section, allowedIds) {
  if (!known(section)) throw new Error('There is no section called "' + section + '".');

  const db = getDb();
  const wanted = new Set(Array.isArray(allowedIds) ? allowedIds : []);
  const everyone = db.prepare('SELECT id, is_owner FROM profiles').all();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM section_grants WHERE section = ?').run(section);
    const grant = db.prepare('INSERT INTO section_grants (section, profile_id) VALUES (?, ?)');
    for (const profile of everyone) {
      if (profile.is_owner) continue;
      if (!wanted.has(profile.id)) continue;
      grant.run(section, profile.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return allowedIn(section);
}
