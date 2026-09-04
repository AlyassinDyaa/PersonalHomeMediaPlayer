/**
 * Shelves a person arranges by hand.
 *
 * The library already sorts itself — by genre, by what was added last, by what
 * is half-watched. None of that knows that these four films are the ones the
 * kids are allowed to put on, or that this pile came off a particular drive
 * and should stay together. A collection is the place to say so.
 *
 * Two kinds, sharing one table:
 *
 *   - **Picked**: titles chosen one at a time. Membership lives in
 *     `collection_items`.
 *   - **Folder**: a path, and everything under it belongs. Membership is
 *     worked out when asked rather than stored, so a collection pointed at a
 *     USB drive gains and loses titles as the drive fills and empties, with
 *     nothing to keep in step.
 *
 * A folder collection whose drive is unplugged simply comes back empty, which
 * is the truthful answer: those files are not there to play.
 */

import { getDb, stableId } from './db.js';
import { shapeItem } from './library.js';

const now = () => Date.now();

/**
 * Compare paths the way a file system does, not the way a string does.
 *
 * Separators and letter case both vary without meaning anything: the scanner
 * stores `D:\Shows\Batman` while somebody typing a folder into a settings box
 * writes `d:/shows/batman`. A trailing separator is added so that `/Kids`
 * cannot claim the contents of `/Kids Party`.
 */
function asPrefix(value) {
  const text = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return text ? text + '/' : '';
}

function underFolder(path, prefix) {
  return (String(path ?? '').replace(/[\\/]+/g, '/').toLowerCase() + '/').startsWith(prefix);
}

/** The columns every shelf needs, so a collection row looks like any other card. */
const ITEM_COLUMNS = `
  i.*,
  (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
  (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count,
  (SELECT 1 FROM favorites f WHERE f.item_id = i.id) AS favourite
`;

/** Item ids sitting under a folder, by way of the files themselves. */
function idsUnderFolder(folderPath) {
  const prefix = asPrefix(folderPath);
  if (!prefix) return [];

  const ids = new Set();
  for (const row of getDb().prepare('SELECT DISTINCT item_id, path FROM videos').all()) {
    if (underFolder(row.path, prefix)) ids.add(row.item_id);
  }
  return [...ids];
}

/** The titles in one collection, in the order they should appear. */
export function collectionItems(id) {
  const db = getDb();
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return null;

  if (collection.folder_path) {
    const ids = idsUnderFolder(collection.folder_path);
    if (!ids.length) return [];
    const slots = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT ${ITEM_COLUMNS} FROM items i
      WHERE i.id IN (${slots})
      ORDER BY i.sort_title ASC
    `).all(...ids);
    return rows.map(shapeItem);
  }

  const rows = db.prepare(`
    SELECT ${ITEM_COLUMNS} FROM collection_items c
    JOIN items i ON i.id = c.item_id
    WHERE c.collection_id = ?
    ORDER BY c.position ASC, i.sort_title ASC
  `).all(id);
  return rows.map(shapeItem);
}

/** Every collection, with how many titles it holds. */
export function listCollections() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM collections ORDER BY position ASC, created_at ASC').all();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    folderPath: row.folder_path,
    logo: row.logo_path ?? null,
    accent: row.accent ?? null,
    position: row.position,
    count: row.folder_path
      ? idsUnderFolder(row.folder_path).length
      : db.prepare('SELECT COUNT(*) n FROM collection_items WHERE collection_id = ?').get(row.id).n,
  }));
}

/**
 * Collections ready to be shown as rails.
 *
 * Empty ones are left out: a shelf with nothing on it is a gap on the home
 * screen rather than information, and a folder collection is empty whenever
 * its drive is elsewhere.
 */
export function collectionShelves() {
  return listCollections()
    .map((collection) => ({ ...collection, items: collectionItems(collection.id) ?? [] }))
    .filter((collection) => collection.items.length > 0);
}

export function createCollection({ name, folderPath = null }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A collection needs a name.');

  const db = getDb();
  const id = stableId('collection', trimmed + ':' + now());
  const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM collections').get().n;

  db.prepare(`
    INSERT INTO collections (id, name, folder_path, position, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, trimmed, folderPath ? String(folderPath).trim() || null : null, next, now());

  return listCollections().find((collection) => collection.id === id);
}

/**
 * Change a collection's name, its badge image, or its colour.
 *
 * Each field is only touched when it is actually present in the patch, so
 * renaming a shelf does not quietly clear the logo somebody chose for it.
 * Passing null for logo or accent does clear it, which is how a badge is
 * taken off again.
 */
export function updateCollection(id, patch = {}) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM collections WHERE id = ?').get(id)) return null;

  if ('name' in patch) {
    const trimmed = String(patch.name ?? '').trim();
    if (!trimmed) throw new Error('A collection needs a name.');
    db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(trimmed, id);
  }
  if ('logo' in patch) {
    const logo = patch.logo ? String(patch.logo).trim() : null;
    db.prepare('UPDATE collections SET logo_path = ? WHERE id = ?').run(logo || null, id);
  }
  if ('accent' in patch) {
    const accent = /^#[0-9a-f]{6}$/i.test(String(patch.accent ?? '')) ? patch.accent : null;
    db.prepare('UPDATE collections SET accent = ? WHERE id = ?').run(accent, id);
  }

  return listCollections().find((collection) => collection.id === id);
}

/** @deprecated Use updateCollection; kept so older callers keep working. */
export function renameCollection(id, name) {
  return updateCollection(id, { name });
}

export function deleteCollection(id) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM collections WHERE id = ?').get(id)) return false;
  db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id);
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  return true;
}

/**
 * Put a title on a shelf.
 *
 * Refused for folder collections: their membership is the folder's business,
 * and a title added by hand would vanish at the next look without explanation.
 */
export function addToCollection(id, itemId) {
  const db = getDb();
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return null;
  if (collection.folder_path) throw new Error('This collection follows a folder, so titles cannot be added by hand.');
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)) return null;

  const next = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM collection_items WHERE collection_id = ?',
  ).get(id).n;

  db.prepare(`
    INSERT OR IGNORE INTO collection_items (collection_id, item_id, position, added_at)
    VALUES (?, ?, ?, ?)
  `).run(id, itemId, next, now());

  return { id, itemId };
}

export function removeFromCollection(id, itemId) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM collections WHERE id = ?').get(id)) return null;
  db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?').run(id, itemId);
  return { id, itemId };
}

/** Move a collection up or down the running order. */
export function moveCollection(id, direction) {
  const db = getDb();
  const ordered = db.prepare('SELECT id FROM collections ORDER BY position ASC, created_at ASC').all();
  const index = ordered.findIndex((row) => row.id === id);
  if (index < 0) return null;

  const target = index + (direction === 'up' ? -1 : 1);
  if (target < 0 || target >= ordered.length) return listCollections();

  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const write = db.prepare('UPDATE collections SET position = ? WHERE id = ?');
  ordered.forEach((row, position) => write.run(position, row.id));

  return listCollections();
}
