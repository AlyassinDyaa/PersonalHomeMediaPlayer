/**
 * What the library would tell you if you asked it what was wrong.
 *
 * Every fault here was found the hard way: a show that turned out to be
 * missing its middle episodes, a title the metadata never matched, a file that
 * had been moved off a drive and left a dead entry behind. Each was noticed by
 * accident, weeks later, by someone trying to watch the thing.
 *
 * None of these are errors the library can fix on its own — it cannot download
 * a missing episode — so this reports rather than repairs, and says precisely
 * which episode is missing rather than that something is.
 */

import fs from 'node:fs';
import { getDb } from './db.js';

/**
 * Gaps in a season's numbering.
 *
 * Only gaps below the highest episode present are reported. A season that
 * stops at episode 8 is either incomplete or eight episodes long, and there is
 * no way to tell from the files alone — whereas a season holding 1, 2 and 4 is
 * unambiguously missing episode 3.
 */
function gapsIn(episodes) {
  const present = new Set(episodes);
  const highest = Math.max(...episodes);
  const missing = [];
  for (let number = 1; number < highest; number++) {
    if (!present.has(number)) missing.push(number);
  }
  return missing;
}

/** Runs of consecutive numbers written as "3, 7-9" rather than "3, 7, 8, 9". */
function asRanges(numbers) {
  const parts = [];
  let start = null;
  let previous = null;

  for (const number of [...numbers].sort((a, b) => a - b)) {
    if (start === null) { start = number; previous = number; continue; }
    if (number === previous + 1) { previous = number; continue; }
    parts.push(start === previous ? String(start) : start + '-' + previous);
    start = number;
    previous = number;
  }
  if (start !== null) parts.push(start === previous ? String(start) : start + '-' + previous);
  return parts.join(', ');
}

/**
 * Everything worth somebody's attention, most actionable first.
 *
 * @param {number} fileCheckLimit How many files to test for existence. Reading
 *   the whole library off external drives takes long enough to be worth
 *   bounding; the newest entries are the ones most likely to have moved.
 */
export function libraryHealth({ fileCheckLimit = 4000 } = {}) {
  const db = getDb();

  // --- shows missing episodes ---------------------------------------------
  const incomplete = [];
  // The year comes along because two different shows can share a name — the
  // 2003 and 2012 Turtles both sit in this library, and a report naming only
  // the title reads as one show with impossible seasons.
  const shows = db.prepare("SELECT id, title, year FROM items WHERE kind = 'show' ORDER BY sort_title").all();
  const episodesOf = db.prepare(
    'SELECT season, episode FROM videos WHERE item_id = ? AND episode IS NOT NULL',
  );

  for (const show of shows) {
    const bySeason = new Map();
    for (const row of episodesOf.all(show.id)) {
      const season = row.season ?? 1;
      if (!bySeason.has(season)) bySeason.set(season, []);
      bySeason.get(season).push(row.episode);
    }

    const seasons = [];
    for (const [season, episodes] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      if (!episodes.length) continue;
      const missing = gapsIn(episodes);
      if (missing.length) {
        seasons.push({ season, missing, summary: asRanges(missing) });
      }
    }
    if (seasons.length) incomplete.push({ id: show.id, title: show.title, year: show.year, seasons });
  }

  // --- files that are no longer where the library left them ----------------
  const missingFiles = [];
  const recent = db.prepare(`
    SELECT v.id, v.path, i.title AS item_title
    FROM videos v JOIN items i ON i.id = v.item_id
    ORDER BY v.id LIMIT ?
  `).all(fileCheckLimit);

  for (const row of recent) {
    if (!fs.existsSync(row.path)) {
      missingFiles.push({ id: row.id, title: row.item_title, path: row.path });
    }
  }

  // --- titles the metadata never recognised --------------------------------
  const unmatched = db.prepare(`
    SELECT id, title, kind, year FROM items WHERE tmdb_id IS NULL ORDER BY sort_title
  `).all();

  // --- shelves pointing at nothing -----------------------------------------
  const emptyCollections = db.prepare(`
    SELECT c.id, c.name, c.folder_path FROM collections c
    WHERE c.folder_path IS NULL
      AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.collection_id = c.id)
  `).all().map((row) => ({ id: row.id, name: row.name }));

  return {
    checkedFiles: recent.length,
    totalVideos: db.prepare('SELECT COUNT(*) n FROM videos').get().n,
    incomplete,
    missingFiles,
    unmatched,
    emptyCollections,
    problems: incomplete.length + missingFiles.length + unmatched.length + emptyCollections.length,
  };
}
