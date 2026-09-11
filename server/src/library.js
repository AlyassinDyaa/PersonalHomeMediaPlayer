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

/**
 * Fraction of runtime past which an item counts as finished rather than in-progress.
 *
 * Very nearly all of it, deliberately. This used to be 92%, on the reasoning
 * that the credits had started and the episode was effectively over — but that
 * decided on somebody's behalf that they had finished watching, and took the
 * episode off Continue Watching while they were still in it. Leaving at 93%
 * should return you to 93%.
 *
 * Reaching the actual end is reported separately by the player, so nothing
 * depends on this to notice a finished episode; it only catches a viewer who
 * closed the tab in the last few seconds.
 */
const WATCHED_THRESHOLD = 0.995;

/**
 * Far enough through to count as seen, when counting rather than resuming.
 *
 * These are two different questions and they want two different answers. The
 * threshold above decides whether to stop offering to resume something, and is
 * deliberately almost the whole way: taking an episode off Continue Watching
 * at 93% decides on somebody's behalf that they are done with it.
 *
 * "How many of these have you seen" is not that question. An episode left at
 * 98% — the credits skipped, the next one started — has been seen by any
 * ordinary meaning, and counting it as outstanding made a season somebody had
 * worked through read as barely begun. Only the flag was ever consulted, and
 * the flag is set by reaching the actual end, which almost nobody does.
 */
const SEEN_FRACTION = 0.9;
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

/*
 * An empty column reads as the fallback, not as null.
 *
 * JSON.parse(null) does not throw — it parses the string "null" and returns
 * null — so an empty column slipped past the catch and handed null to callers
 * expecting a list. Every one of them then threw while shaping the row, which
 * takes out the whole page rather than one field of one title.
 */
function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) ?? fallback;
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
    accent: row.accent,
    rating: row.rating,
    genres: canonicalGenres(parseJsonColumn(row.genres, [])),
    runtime: row.runtime,
    certification: row.certification,
    status: row.status,
    endYear: row.end_year ?? null,
    /* Which part of the library, and which folder within it. Only the
       sections that keep their own folders use either. */
    section: row.section ?? 'library',
    folderId: row.folder_id ?? null,
    tmdbId: row.tmdb_id,
    confidence: row.confidence,
    sourceFolders: parseJsonColumn(row.source_folders, []),
    episodeCount: row.episode_count ?? undefined,
    seasonCount: row.season_count ?? undefined,
    addedAt: row.added_at,
    favourite: Boolean(row.favourite),
    watchlist: Boolean(row.watchlist),
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
    /* When the position was last written; only the show page asks for it. */
    progressAt: row.progress_at ?? 0,
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
             WHERE v.item_id = i.id
               AND COALESCE(p.watched, 0) = 0
               /*
                * Every term defaulted, because an episode nobody has opened
                * has no duration recorded either — and a NULL anywhere in
                * here makes the whole condition NULL rather than false, which
                * drops the row from the count instead of keeping it. That is
                * the wrong way round: what has never been played is exactly
                * what is left to watch.
                */
               AND NOT (COALESCE(p.position, 0) > 0
                        AND COALESCE(p.duration, v.duration, 0) > 0
                        AND COALESCE(p.position, 0)
                            >= COALESCE(p.duration, v.duration, 0) * ${SEEN_FRACTION})) AS unwatched_count,
           (SELECT 1 FROM watchlist w
             WHERE w.kind = 'item' AND w.target_id = i.id AND w.profile_id = ?) AS watchlist
    FROM items i
    WHERE 1 = 1
      /*
       * The film library, and not the sections beside it.
       *
       * Family and artwork are written as ordinary items so they can be
       * played and resumed like anything else, which means every list that
       * means "the library" has to say so — otherwise somebody's holiday
       * turns up between two Batman films.
       */
      AND i.section = 'library'
      ${kind ? 'AND i.kind = ?' : ''}
      ${limit.sql}
    ORDER BY ${order}
  `).all(profileId, profileId, profileId, ...(kind ? [kind] : []), ...limit.values);

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
  /* Before the film's early return, so a film carries it as a series does. */
  item.watchlist = Boolean(db.prepare(
    "SELECT 1 FROM watchlist WHERE profile_id = ? AND kind = 'item' AND target_id = ?",
  ).get(profileId, id));

  item.backlog = Boolean(db.prepare(
    'SELECT 1 FROM backlog WHERE profile_id = ? AND item_id = ?',
  ).get(profileId, id));

  const videos = db.prepare(`
    SELECT v.*, p.position, p.watched, p.updated_at AS progress_at
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

  /*
   * What the play button should target, and what the list points at.
   *
   * The episode being watched comes first: somebody halfway through one has
   * a place to go back to, and that beats any episode not yet started. If
   * more than one is part-way through — a household sharing a profile, or
   * someone who skipped ahead — the one touched most recently is the one
   * meant. With nothing under way, the first unwatched; with nothing
   * unwatched, the first.
   */
  const underWay = videos
    .filter((video) => !video.watched && video.position > 0)
    .sort((a, b) => b.progressAt - a.progressAt);
  item.nextUp = underWay[0]
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
           i.backdrop_path, i.poster_path, i.logo_path, i.accent
    FROM progress p
    JOIN videos v ON v.id = p.video_id
    JOIN items i ON i.id = p.item_id
    WHERE p.profile_id = ? AND p.watched = 0 AND p.position > ? ${rated.sql}
    ORDER BY p.updated_at DESC
  `).all(profileId, RESUME_MIN_SECONDS, ...rated.values);

  /*
   * A show whose last episode is finished offers the next one.
   *
   * An episode is counted as watched once the credits start, so finishing one
   * takes it off this row — correctly, nobody wants to be offered a film they
   * have just seen. For a series that left nothing behind at all, which is
   * wrong in the other direction: the thing wanted next is obvious, and it is
   * the next episode.
   */
  const finished = getDb().prepare(`
    SELECT p.item_id, v.season, v.episode, p.updated_at
    FROM progress p
    JOIN videos v ON v.id = p.video_id
    JOIN items i ON i.id = p.item_id
    WHERE p.profile_id = ? AND p.watched = 1 AND i.kind = 'show' ${rated.sql}
    ORDER BY p.updated_at DESC
  `).all(profileId, ...rated.values);

  const nextUp = [];
  const offered = new Set();
  const findNext = getDb().prepare(`
    SELECT v.*, i.title AS item_title, i.kind AS item_kind,
           i.backdrop_path, i.poster_path, i.logo_path, i.accent
    FROM videos v
    JOIN items i ON i.id = v.item_id
    LEFT JOIN progress p ON p.video_id = v.id AND p.profile_id = ?
    WHERE v.item_id = ?
      AND COALESCE(p.watched, 0) = 0
      AND (v.season > ? OR (v.season = ? AND v.episode > ?))
    ORDER BY v.season ASC, v.episode ASC
    LIMIT 1
  `);

  for (const row of finished) {
    if (offered.has(row.item_id)) continue;
    offered.add(row.item_id);
    const next = findNext.get(profileId, row.item_id, row.season, row.season, row.episode);
    // Carries the finished episode's time so it sorts among the rest by when
    // it was actually watched, not by where it sits in the series.
    if (next) nextUp.push({ ...next, position: 0, watched: 0, updated_at: row.updated_at });
  }

  const merged = [...rows, ...nextUp].sort((a, b) => b.updated_at - a.updated_at);

  /*
   * Anything set aside is not offered, including the next episode of it.
   *
   * Filtered here rather than in the two queries above so it applies to both
   * of them, and so a title on the backlog cannot come back through the
   * "your last episode is finished" path.
   */
  const setAside = new Set(getDb()
    .prepare('SELECT item_id FROM backlog WHERE profile_id = ?')
    .all(profileId)
    .map((row) => row.item_id));

  const seen = new Set();
  const result = [];
  for (const row of merged) {
    if (seen.has(row.item_id)) continue;
    if (setAside.has(row.item_id)) continue;
    seen.add(row.item_id);
    result.push({
      item: {
        id: row.item_id,
        title: row.item_title,
        kind: row.item_kind,
        backdrop: row.backdrop_path,
        poster: row.poster_path,
        logo: row.logo_path,
        accent: row.accent,
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

  /*
   * Watching it again is the end of it being set aside.
   *
   * Without this a title could sit on the backlog and in the middle of being
   * watched at the same time, and Continue Watching — which skips the backlog
   * — would be hiding the very thing being played.
   */
  db.prepare('DELETE FROM backlog WHERE profile_id = ? AND item_id = ?')
    .run(profileId, video.item_id);

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
 * What somebody means to get to, newest first.
 *
 * The titles come back shaped; the comics come back as ids, because their
 * shape lives with the comics and whether they may be seen at all is a
 * question the route answers.
 */
export function listWatchlist(profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const rated = certificationFilter(profile);

  const items = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT COUNT(*) FROM seasons s WHERE s.item_id = i.id) AS season_count,
           (SELECT 1 FROM favorites f WHERE f.item_id = i.id AND f.profile_id = ?) AS favourite,
           1 AS watchlist
    FROM watchlist w
    JOIN items i ON i.id = w.target_id
    WHERE w.profile_id = ? AND w.kind = 'item' ${rated.sql}
    ORDER BY w.added_at DESC
  `).all(profileId, profileId, ...rated.values).map(shapeItem);

  const comicIds = db.prepare(`
    SELECT target_id FROM watchlist
    WHERE profile_id = ? AND kind = 'comic'
    ORDER BY added_at DESC
  `).all(profileId).map((row) => row.target_id);

  return { items, comicIds };
}

/**
 * Put something on the watchlist, or take it off.
 *
 * @param {'item'|'comic'} kind  a title, or a run of comics
 * @returns {{kind: string, id: string, watchlist: boolean}|null} null when there is no such thing.
 */
export function setWatchlist(kind, id, on, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const table = kind === 'comic' ? 'comic_series' : kind === 'item' ? 'items' : null;
  if (!table) return null;
  if (!db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id)) return null;

  if (on) {
    db.prepare('INSERT OR IGNORE INTO watchlist (profile_id, kind, target_id, added_at) VALUES (?, ?, ?, ?)')
      .run(profileId, kind, id, Date.now());
  } else {
    db.prepare('DELETE FROM watchlist WHERE profile_id = ? AND kind = ? AND target_id = ?')
      .run(profileId, kind, id);
  }
  return { kind, id, watchlist: Boolean(on) };
}

/**
 * Everything in one of the sections that keeps its own folders.
 *
 * Folders first, because they are the arrangement — whatever the folders on
 * the disk are, those are the groups, and a name given by hand stands in
 * front of the folder's own where there is one.
 *
 * Videos come back shaped as titles, because that is what they are: they were
 * written as ordinary items precisely so the same card, the same page and the
 * same player work on them. Pictures come back as little more than an id and
 * a name, which is all a gallery needs.
 */
export function sectionContents(section, profile) {
  const db = getDb();
  const profileId = idOf(profile);

  const folders = db.prepare(`
    SELECT * FROM section_folders WHERE section = ? ORDER BY kind, path
  `).all(section);

  /*
   * The file behind each one comes back with it.
   *
   * Nothing here has a poster — these are somebody's own videos, not films
   * anybody has published artwork for — so the only picture available is one
   * taken out of the video itself, and that needs the file's id to ask for.
   */
  const videos = db.prepare(`
    SELECT i.*,
           (SELECT COUNT(*) FROM videos v WHERE v.item_id = i.id) AS episode_count,
           (SELECT 1 FROM favorites f WHERE f.item_id = i.id AND f.profile_id = ?) AS favourite,
           (SELECT v.id FROM videos v WHERE v.item_id = i.id ORDER BY v.id LIMIT 1) AS video_id,
           (SELECT v.duration FROM videos v WHERE v.item_id = i.id ORDER BY v.id LIMIT 1) AS video_duration
    FROM items i
    WHERE i.section = ?
    ORDER BY i.sort_title
  `).all(profileId, section).map((row) => ({
    ...shapeItem(row),
    video: row.video_id ? { id: row.video_id, duration: row.video_duration ?? null } : null,
  }));

  const images = db.prepare(`
    SELECT id, folder_id, name FROM section_images
    WHERE section = ? ORDER BY name
  `).all(section);

  /* Counted here rather than in three more subqueries: the lists are already
     in hand and a section is a folder of holidays, not a film library. */
  const videosIn = new Map();
  for (const item of videos) {
    videosIn.set(item.folderId, (videosIn.get(item.folderId) ?? 0) + 1);
  }
  const imagesIn = new Map();
  for (const image of images) {
    imagesIn.set(image.folder_id, (imagesIn.get(image.folder_id) ?? 0) + 1);
  }

  return {
    section,
    folders: folders.map((folder) => ({
      id: folder.id,
      kind: folder.kind,
      /* The name given, or the folder's own as a fallback. */
      name: folder.name || folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path,
      renamed: Boolean(folder.name),
      path: folder.path,
      videos: videosIn.get(folder.id) ?? 0,
      images: imagesIn.get(folder.id) ?? 0,
    })),
    videos,
    images: images.map((image) => ({
      id: image.id,
      folderId: image.folder_id,
      name: image.name,
    })),
  };
}

/**
 * What was started and set aside, newest first.
 *
 * Shaped like Continue Watching, because it is the same thing seen from the
 * other side and the page draws it the same way: where you got to, and in
 * which episode. A title whose progress has since been cleared keeps its
 * place on the shelf with nothing to resume, which is honest — it says the
 * title was set aside, not that it was never begun.
 */
export function listBacklog(profile) {
  const db = getDb();
  const profileId = idOf(profile);
  const rated = certificationFilter(profile);

  const rows = db.prepare(`
    SELECT i.*, b.added_at AS set_aside_at
    FROM backlog b
    JOIN items i ON i.id = b.item_id
    WHERE b.profile_id = ? ${rated.sql}
    ORDER BY b.added_at DESC
  `).all(profileId, ...rated.values);

  /* The furthest-along unfinished episode, asked for one title at a time.
     A backlog is a handful of things, so this is a handful of small reads. */
  const furthest = db.prepare(`
    SELECT v.*, p.position, p.watched, p.updated_at
    FROM progress p
    JOIN videos v ON v.id = p.video_id
    WHERE p.profile_id = ? AND p.item_id = ? AND p.watched = 0
    ORDER BY p.updated_at DESC
    LIMIT 1
  `);

  return rows.map((row) => {
    const item = shapeItem(row);
    const where = furthest.get(profileId, row.id);
    return {
      item,
      setAsideAt: row.set_aside_at,
      video: where ? shapeVideo(where) : null,
      progressPercent: where?.duration
        ? Math.min(100, (where.position / where.duration) * 100)
        : 0,
    };
  });
}

/**
 * Set a title aside, or take it back up.
 * @returns {{itemId: string, backlog: boolean}|null} null when there is no such item.
 */
export function setBacklog(itemId, on, profile) {
  const db = getDb();
  const profileId = idOf(profile);
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)) return null;

  if (on) {
    db.prepare('INSERT OR IGNORE INTO backlog (profile_id, item_id, added_at) VALUES (?, ?, ?)')
      .run(profileId, itemId, Date.now());
  } else {
    db.prepare('DELETE FROM backlog WHERE profile_id = ? AND item_id = ?').run(profileId, itemId);
  }
  return { itemId, backlog: Boolean(on) };
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
    .prepare("SELECT genres FROM items i WHERE i.section = 'library' " + rated.sql)
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
    movies: one("SELECT COUNT(*) c FROM items WHERE kind='movie' AND section='library'").c,
    shows: one("SELECT COUNT(*) c FROM items WHERE kind='show' AND section='library'").c,
    episodes: one('SELECT COUNT(*) c FROM videos WHERE episode IS NOT NULL').c,
    videos: one('SELECT COUNT(*) c FROM videos').c,
    totalSize: one('SELECT COALESCE(SUM(size),0) s FROM videos').s,
    unmatched: one("SELECT COUNT(*) c FROM items WHERE tmdb_id IS NULL AND section='library'").c,
    lastScan: one('SELECT MAX(finished_at) t FROM scans').t,
  };
}
