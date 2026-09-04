/**
 * Read queries over the scanned library.
 *
 * The API layer stays thin by keeping every SQL statement here, shaped into
 * the exact objects the UI renders.
 */

import { getDb } from './db.js';
import { allowedCertifications } from './profiles.js';

/**
 * The id every read and write below is scoped to.
 *
 * Taken from the resolved profile rather than trusted from the caller, and
 * never defaulted here: a query that quietly fell back to "somebody" would
 * write one person's position onto another's row, which is exactly the bug
 * profiles exist to fix. The API layer always has a profile by the time it
 * gets here, because a request without one never reaches a route.
 */
function idOf(profile) {
  const id = typeof profile === 'string' ? profile : profile?.id;
  if (!id) throw new Error('This query needs to know whose library it is reading');
  return id;
}

/**
 * The clause keeping a profile inside its rating limit.
 *
 * A title with no certification at all is hidden from a limited profile
 * rather than shown. Most of a library is rated and the unrated remainder is
 * usually the part nobody checked — showing it by default would make a kids
 * profile a promise the library does not keep.
 */
function certificationFilter(profile, alias = 'i') {
  const allowed = allowedCertifications(profile?.maxCertification);
  if (!allowed) return { sql: '', values: [] };
  const holes = allowed.map(() => '?').join(', ');
  return {
    sql: ` AND ${alias}.certification IS NOT NULL AND ${alias}.certification IN (${holes})`,
    values: allowed,
  };
}

/** Fraction of runtime past which an item counts as finished rather than in-progress. */
const WATCHED_THRESHOLD = 0.92;
/** Ignore trivial positions so accidentally opening something does not pin it to the home row. */
const RESUME_MIN_SECONDS = 30;

/**
 * One genre vocabulary for the whole library.
 *
 * TMDB describes films and television with different words: a film is
 * "Science Fiction", "Action", "Adventure", "Family"; a series covering the
 * same ground is "Sci-Fi & Fantasy", "Action & Adventure", "Kids". Left alone,
 * a library of both ends up with two sets of categories for one set of ideas —
 * an "Action" shelf and an "Action & Adventure" shelf, neither of them whole.
 *
 * The television names are the compound ones, so each maps to the film genres
 * it combines and a series lands on both shelves.
 */
const GENRE_ALIASES = {
  'Action & Adventure': ['Action', 'Adventure'],
  'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War'],
  Kids: ['Family'],
};

/**
 * A title's genres in that single vocabulary, in their original order and
 * without repeats — a series tagged both "Action & Adventure" and "Action"
 * must not end up listed under Action twice.
 */
export function canonicalGenres(genres) {
  const out = [];
  for (const genre of genres) {
    for (const name of GENRE_ALIASES[genre] ?? [genre]) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function parseJsonColumn(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function shapeItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    year: row.year,
    overview: row.overview,
    tagline: row.tagline,
    poster: row.poster_path,
    backdrop: row.backdrop_path,
    logo: row.logo_path,
    rating: row.rating,
    genres: canonicalGenres(parseJsonColumn(row.genres, [])),
    runtime: row.runtime,
    certification: row.certification,
    status: row.status,
    tmdbId: row.tmdb_id,
    confidence: row.confidence,
    sourceFolders: parseJsonColumn(row.source_folders, []),
    episodeCount: row.episode_count ?? undefined,
    seasonCount: row.season_count ?? undefined,
    addedAt: row.added_at,
    favourite: Boolean(row.favourite),
    // Undefined rather than 0 when the query did not ask, so "no unwatched
    // episodes" and "not counted" stay distinguishable.
    unwatchedCount: row.unwatched_count ?? undefined,
  };
}

function shapeVideo(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    season: row.season,
    episode: row.episode,
    episodeEnd: row.episode_end,
    title: row.title,
    overview: row.overview,
    still: row.still_path,
    airDate: row.air_date,
    path: row.path,
    size: row.size,
    extension: row.extension,
    duration: row.duration,
    runtime: row.runtime,
    position: row.position ?? 0,
    watched: Boolean(row.watched),
  };
}

/** Every item, with counts, for the browse grid. */
export function listItems({ kind = null, sort = 'title', profile } = {}) {
  const db = getDb();
  const profileId = idOf(profile);
  const order = {
    title: 'i.sort_title ASC',
    year: 'i.year DESC NULLS LAST, i.sort_title ASC',
    added: 'i.added_at DESC',
    rating: 'i.rating DESC NULLS LAST',
  }[sort] ?? 'i.sort_title ASC';

  const limit = certificationFilter(profile);

  const rows = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count,
           (SELECT 1 FROM favorites f WHERE f.item_id = i.id AND f.profile_id = ?) AS favourite,
           (SELECT COUNT(*) FROM videos v
              LEFT JOIN progress p ON p.video_id = v.id AND p.profile_id = ?
             WHERE v.item_id = i.id AND COALESCE(p.watched, 0) = 0) AS unwatched_count
    FROM items i
    WHERE 1 = 1
      ${kind ? 'AND i.kind = ?' : ''}
      ${limit.sql}
    ORDER BY ${order}
  `).all(profileId, profileId, ...(kind ? [kind] : []), ...limit.values);

  return rows.map(shapeItem);
}

/**
 * One item with its seasons, episodes and per-video progress.
 *
 * Returns null for a title this profile is not allowed to see, so that a
 * guessed or bookmarked address is no way around the rating limit that hid it
 * from the shelves.
 */
export function getItem(id, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const limit = certificationFilter(profile);

  const row = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count
    FROM items i WHERE i.id = ? ${limit.sql}
  `).get(id, ...limit.values);
  if (!row) return null;

  const item = shapeItem(row);

  const videos = db.prepare(`
    SELECT v.*, p.position, p.watched
    FROM videos v
    LEFT JOIN progress p ON p.video_id = v.id AND p.profile_id = ?
    WHERE v.item_id = ?
    ORDER BY v.season ASC, v.episode ASC
  `).all(profileId, id).map(shapeVideo);

  if (item.kind === 'movie') {
    item.video = videos[0] ?? null;
    item.subtitles = videos[0] ? listSubtitles(videos[0].id) : [];
    return item;
  }

  const seasonRows = db.prepare(
    'SELECT * FROM seasons WHERE item_id = ? ORDER BY number ASC',
  ).all(id);

  item.seasons = seasonRows
    .map((season) => ({
      number: season.number,
      name: season.name || 'Season ' + season.number,
      overview: season.overview,
      poster: season.poster_path,
      airDate: season.air_date,
      episodes: videos.filter((video) => video.season === season.number),
    }))
    // A season with nothing in it is a tab that opens on an empty list. The
    // scan clears these away, but a folder can be deleted between scans, and
    // the shelf should be honest in the meantime.
    .filter((season) => season.episodes.length > 0);

  // Next unwatched episode, which is what the play button should target.
  item.nextUp = videos.find((video) => !video.watched && video.position === 0)
    ?? videos.find((video) => !video.watched)
    ?? videos[0]
    ?? null;

  return item;
}

export function listSubtitles(videoId) {
  return getDb()
    .prepare('SELECT id, path, name, language FROM subtitles WHERE video_id = ? ORDER BY language, name')
    .all(videoId);
}

/**
 * One video, as the player and every streaming route need it.
 *
 * The item is joined in only so the rating limit can be applied here too.
 * Hiding a film from the shelves but still serving its bytes to anyone who
 * knew the id would make the limit decorative, and the ids are not secret —
 * they appear in every page the profile is allowed to see.
 */
export function getVideo(id, profile) {
  const profileId = idOf(profile);
  const limit = certificationFilter(profile);

  const row = getDb().prepare(`
    SELECT v.*, p.position, p.watched
    FROM videos v
    JOIN items i ON i.id = v.item_id
    LEFT JOIN progress p ON p.video_id = v.id AND p.profile_id = ?
    WHERE v.id = ? ${limit.sql}
  `).get(profileId, id, ...limit.values);
  if (!row) return null;
  const video = shapeVideo(row);
  video.subtitles = listSubtitles(id);
  return video;
}

/**
 * "Continue Watching": partially-watched videos, most recent first, one row per
 * show so a series does not occupy the whole rail.
 */
export function continueWatching(limit = 20, profile) {
  const profileId = idOf(profile);
  const rated = certificationFilter(profile);

  const rows = getDb().prepare(`
    SELECT v.*, p.position, p.watched, p.updated_at,
           i.title AS item_title, i.kind AS item_kind,
           i.backdrop_path, i.poster_path, i.logo_path
    FROM progress p
    JOIN videos v ON v.id = p.video_id
    JOIN items i ON i.id = p.item_id
    WHERE p.profile_id = ? AND p.watched = 0 AND p.position > ? ${rated.sql}
    ORDER BY p.updated_at DESC
  `).all(profileId, RESUME_MIN_SECONDS, ...rated.values);

  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (seen.has(row.item_id)) continue;
    seen.add(row.item_id);
    result.push({
      item: {
        id: row.item_id,
        title: row.item_title,
        kind: row.item_kind,
        backdrop: row.backdrop_path,
        poster: row.poster_path,
        logo: row.logo_path,
      },
      video: shapeVideo(row),
      progressPercent: row.duration ? Math.min(100, (row.position / row.duration) * 100) : 0,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/** Record a playback position. Marks watched automatically near the end. */
/**
 * Take a title off Continue Watching.
 *
 * Only the unfinished positions go: a half-watched episode is what puts a
 * title on that row, so forgetting those removes it. Episodes already finished
 * keep their watched mark, so a series does not offer to replay them and the
 * next unwatched episode is still found correctly.
 *
 * The position is genuinely forgotten rather than hidden — playing the title
 * again starts it from the beginning, which is what asking to remove it from
 * "continue watching" means.
 *
 * @returns {{removed: number}|null} null when there is no such item.
 */
export function removeFromContinueWatching(itemId, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
  if (!item) return null;

  const result = db
    .prepare('DELETE FROM progress WHERE profile_id = ? AND item_id = ? AND watched = 0')
    .run(profileId, itemId);
  return { removed: Number(result.changes ?? 0) };
}

export function saveProgress({ videoId, position, duration, profile }) {
  const db = getDb();
  const profileId = idOf(profile);
  const video = db.prepare('SELECT item_id, duration FROM videos WHERE id = ?').get(videoId);
  if (!video) return null;

  const total = duration ?? video.duration ?? null;
  const watched = total && position / total >= WATCHED_THRESHOLD ? 1 : 0;

  db.prepare(`
    INSERT INTO progress (profile_id, video_id, item_id, position, duration, watched, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(profile_id, video_id) DO UPDATE SET
      position = excluded.position,
      duration = COALESCE(excluded.duration, progress.duration),
      watched = excluded.watched,
      updated_at = excluded.updated_at
  `).run(profileId, videoId, video.item_id, position, total, watched, Date.now());

  // Cache the runtime on the video the first time we learn it from playback.
  // This one is a fact about the file, not about the viewer, so it is not
  // kept per profile.
  if (total && !video.duration) {
    db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(total, videoId);
  }

  return { videoId, position, duration: total, watched: Boolean(watched) };
}

export function setWatched(videoId, watched, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const video = db.prepare('SELECT item_id, duration FROM videos WHERE id = ?').get(videoId);
  if (!video) return null;
  db.prepare(`
    INSERT INTO progress (profile_id, video_id, item_id, position, duration, watched, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(profile_id, video_id) DO UPDATE SET
      watched = excluded.watched,
      position = CASE WHEN excluded.watched = 1 THEN 0 ELSE progress.position END,
      updated_at = excluded.updated_at
  `).run(profileId, videoId, video.item_id, 0, video.duration, watched ? 1 : 0, Date.now());
  return { videoId, watched };
}

/** Substring search across titles, plus episode titles. */
export function search(query, limit = 60, profile) {
  const db = getDb();
  const like = '%' + query.toLowerCase().replace(/[%_]/g, '') + '%';
  const rated = certificationFilter(profile);

  const items = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count
    FROM items i
    WHERE LOWER(i.title) LIKE ? ${rated.sql}
    ORDER BY
      CASE WHEN LOWER(i.title) = ? THEN 0
           WHEN LOWER(i.title) LIKE ? THEN 1
           ELSE 2 END,
      i.sort_title
    LIMIT ?
  `).all(like, ...rated.values, query.toLowerCase(), query.toLowerCase() + '%', limit);

  return items.map(shapeItem);
}

/**
 * Titles kept to hand, most recently marked first.
 *
 * The table for this has existed since the schema was written; nothing ever
 * read or wrote it.
 */
export function listFavourites(profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const rated = certificationFilter(profile);

  const rows = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count,
           1 AS favourite
    FROM favorites f
    JOIN items i ON i.id = f.item_id
    WHERE f.profile_id = ? ${rated.sql}
    ORDER BY f.added_at DESC
  `).all(profileId, ...rated.values);
  return rows.map(shapeItem);
}

/**
 * Keep a title to hand, or stop.
 * @returns {{itemId: string, favourite: boolean}|null} null when there is no such item.
 */
export function setFavourite(itemId, favourite, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)) return null;

  if (favourite) {
    db.prepare('INSERT OR IGNORE INTO favorites (profile_id, item_id, added_at) VALUES (?, ?, ?)')
      .run(profileId, itemId, Date.now());
  } else {
    db.prepare('DELETE FROM favorites WHERE profile_id = ? AND item_id = ?').run(profileId, itemId);
  }
  return { itemId, favourite: Boolean(favourite) };
}

/**
 * Genre rails for the home screen.
 *
 * Counted over what this profile may see, so a limited one is not offered a
 * Horror rail that opens on nothing.
 */
export function listGenres(profile) {
  const rated = certificationFilter(profile);
  const counts = new Map();
  const rows = getDb()
    .prepare('SELECT genres FROM items i WHERE 1 = 1 ' + rated.sql)
    .all(...rated.values);

  for (const row of rows) {
    for (const genre of canonicalGenres(parseJsonColumn(row.genres, []))) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function listByGenre(genre, limit = 40, profile) {
  return listItems({ profile })
    .filter((item) => item.genres.includes(genre))
    .slice(0, limit);
}

export function listSuggestions() {
  return getDb()
    .prepare('SELECT id, kind, payload, confidence FROM suggestions WHERE resolved = 0 ORDER BY confidence DESC')
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      confidence: row.confidence,
      ...parseJsonColumn(row.payload, {}),
    }));
}

export function libraryStats() {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  return {
    movies: one("SELECT COUNT(*) c FROM items WHERE kind='movie'").c,
    shows: one("SELECT COUNT(*) c FROM items WHERE kind='show'").c,
    episodes: one('SELECT COUNT(*) c FROM videos WHERE episode IS NOT NULL').c,
    videos: one('SELECT COUNT(*) c FROM videos').c,
    totalSize: one('SELECT COALESCE(SUM(size),0) s FROM videos').s,
    unmatched: one('SELECT COUNT(*) c FROM items WHERE tmdb_id IS NULL').c,
    lastScan: one('SELECT MAX(finished_at) t FROM scans').t,
  };
}
