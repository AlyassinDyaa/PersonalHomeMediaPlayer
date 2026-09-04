/**
 * Things people would like added to the library.
 *
 * Only the owner can add films, and only the owner can even see which drives
 * they come from — so everybody else's way of asking for something was to
 * mention it in person and hope it was remembered. This writes it down.
 *
 * A resolved request is marked, never deleted. Somebody who asked for a film a
 * fortnight ago should be able to see that it was answered, and whether the
 * answer was yes; a row that quietly disappears is indistinguishable from one
 * that was never read.
 */

import { getDb, stableId } from './db.js';

const now = () => Date.now();

/** Trim and bound a title so the list stays readable. */
function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('A request needs a title.');
  if (text.length > 120) throw new Error('That title is too long.');
  return text;
}

/**
 * Ask for something.
 *
 * The same title from the same person twice is the same request, not two —
 * asking again usually means "did you see this?", and answering it twice is
 * worse than answering it once.
 */
export function addRequest({ profileId, title, note }) {
  const db = getDb();
  const clean = cleanTitle(title);

  const existing = db.prepare(`
    SELECT id FROM requests
    WHERE profile_id = ? AND LOWER(title) = LOWER(?) AND status = 'open'
  `).get(profileId, clean);
  if (existing) return listRequests({ profileId }).find((row) => row.id === existing.id);

  const id = stableId('request', profileId + ':' + clean + ':' + now());
  db.prepare(`
    INSERT INTO requests (id, profile_id, title, note, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(id, profileId, clean, String(note ?? '').trim() || null, now());

  return listRequests({ profileId }).find((row) => row.id === id);
}

/**
 * The list.
 *
 * @param {{profileId?: string, all?: boolean}} options `all` is the owner's
 *   view; anything else sees only its own, because a request can carry a
 *   preference somebody would not put on a shared board.
 */
export function listRequests({ profileId = null, all = false } = {}) {
  const db = getDb();
  const rows = all
    ? db.prepare(`
        SELECT r.*, p.name AS profile_name, p.colour AS profile_colour, p.avatar_at
        FROM requests r JOIN profiles p ON p.id = r.profile_id
        ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      `).all()
    : db.prepare(`
        SELECT r.*, p.name AS profile_name, p.colour AS profile_colour, p.avatar_at
        FROM requests r JOIN profiles p ON p.id = r.profile_id
        WHERE r.profile_id = ?
        ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      `).all(profileId);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    profile: {
      id: row.profile_id,
      name: row.profile_name,
      colour: row.profile_colour,
      avatarAt: row.avatar_at ?? null,
    },
  }));
}

/** Answer a request. Only the owner decides; anyone may withdraw their own. */
export function setRequestStatus(id, status) {
  if (!['open', 'done', 'declined'].includes(status)) {
    throw new Error('That is not a status a request can have.');
  }
  const db = getDb();
  if (!db.prepare('SELECT id FROM requests WHERE id = ?').get(id)) return null;

  db.prepare('UPDATE requests SET status = ?, resolved_at = ? WHERE id = ?')
    .run(status, status === 'open' ? null : now(), id);
  return listRequests({ all: true }).find((row) => row.id === id);
}

export function deleteRequest(id) {
  const db = getDb();
  const row = db.prepare('SELECT profile_id FROM requests WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM requests WHERE id = ?').run(id);
  return { id, profileId: row.profile_id };
}

/** How many are waiting, for a badge on the owner's settings. */
export function openRequestCount() {
  return getDb().prepare("SELECT COUNT(*) n FROM requests WHERE status = 'open'").get().n;
}
