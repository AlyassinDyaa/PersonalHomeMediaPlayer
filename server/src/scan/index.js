/**
 * Scan orchestration: walk the library, group it, enrich it from TMDB, and
 * persist the result.
 *
 * Identifiers are derived from content, not from row order or absolute paths
 * where avoidable, so that rescanning preserves watch progress and favourites.
 */

import { config, hasTmdb } from '../config.js';
import { getDb, stableId, sortTitle, now, transaction } from '../db.js';
import { walkLibrary } from './walk.js';
import { groupLibrary, pairKey } from './group.js';
import { seriesKey, cleanEpisodeTitle } from './parse.js';
import {
  findBestMatch, getMovie, getShow, getSeason, pickLogo, pickCertification,
} from '../meta/tmdb.js';
import { prefetchArtwork } from '../meta/artwork.js';

/** Scan-stable key for an item, unaffected by which folders it came from. */
function scanKeyFor(item) {
  if (item.kind === 'movie') {
    return 'movie:' + seriesKey(item.title) + ':' + (item.year ?? '');
  }
  return 'show:' + item.key;
}

/** Read a user override, e.g. a manually forced TMDB id. */
function getOverride(scope, key) {
  const row = getDb()
    .prepare('SELECT value FROM overrides WHERE scope = ? AND key = ?')
    .get(scope, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Shows that have been folded into one another, and what they were folded into.
 *
 * Answering "one show" was a one-way door: the suggestion disappeared once it
 * was answered, so a wrong answer could not be taken back from anywhere in the
 * app. Justice League and Justice League Unlimited are the case that proved it
 * — genuinely separate series, joined by one press and then unreachable.
 */
export function listMerges() {
  return getDb()
    .prepare("SELECT key, value FROM overrides WHERE scope = 'merge' ORDER BY key")
    .all()
    .map((row) => {
      let into = row.value;
      try { into = JSON.parse(row.value); } catch { /* stored plainly */ }
      return { alias: row.key, into };
    });
}

/**
 * Remember that two shows are not the same.
 *
 * Answering "keep separate" was forgotten at the next scan, because the
 * suggestion is rebuilt from the folders and nothing recorded the answer. The
 * question came back every time, and one stray press joined two series with no
 * way back. Both answers are now remembered.
 */
export function rememberSeparate(shows) {
  setOverride('separate', pairKey(shows), true);
}

/** Undo one of those, so the next scan separates them again. */
export function clearMerge(alias) {
  const result = getDb()
    .prepare("DELETE FROM overrides WHERE scope = 'merge' AND key = ?")
    .run(alias);
  return Number(result.changes ?? 0) > 0;
}

export function setOverride(scope, key, value) {
  getDb()
    .prepare(`INSERT INTO overrides (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(scope, key, JSON.stringify(value), now());
}

/**
 * Resolve TMDB metadata for one grouped item.
 * Returns null when there is no key, no match, or the lookup fails — the item
 * is still perfectly usable, just without artwork.
 */
async function resolveMetadata(item, scanKey) {
  if (!hasTmdb()) return null;

  const kind = item.kind === 'movie' ? 'movie' : 'tv';
  const forcedId = getOverride('tmdb', scanKey);

  let matchId = forcedId;
  let score = forcedId ? 1 : 0;

  if (!matchId) {
    let match = null;
    try {
      match = await findBestMatch(kind, { title: item.title, year: item.year });

      // The name taken from the files is not always the name of the show. Try
      // whatever else the folder called it before giving up on artwork.
      if (!match) {
        for (const alternate of item.titleCandidates ?? []) {
          if (alternate === item.title) continue;
          match = await findBestMatch(kind, { title: alternate, year: item.year });
          if (match) break;
        }
      }
    } catch (error) {
      // Search is unavailable (typically offline). Reuse the id resolved on a
      // previous scan so this title keeps its identity, and therefore its id,
      // its artwork, and the watch progress attached to it.
      const remembered = getOverride('resolved', scanKey);
      if (!remembered) throw error;
      matchId = remembered;
      score = 0.9;
    }

    if (!matchId) {
      if (!match) return null;
      matchId = match.id;
      score = match.score;
    }
  }

  // Remember the resolution so a later offline scan can reuse it.
  if (matchId && !forcedId) setOverride('resolved', scanKey, matchId);

  const details = kind === 'movie' ? await getMovie(matchId) : await getShow(matchId);
  if (!details) return null;

  return {
    tmdbId: matchId,
    score,
    title: kind === 'movie' ? details.title : details.name,
    year: Number(
      (kind === 'movie' ? details.release_date : details.first_air_date)?.slice(0, 4),
    ) || item.year,
    overview: details.overview || null,
    tagline: details.tagline || null,
    posterPath: details.poster_path || null,
    backdropPath: details.backdrop_path || null,
    logoPath: pickLogo(details),
    rating: details.vote_average ?? null,
    genres: (details.genres ?? []).map((g) => g.name),
    runtime: details.runtime ?? details.episode_run_time?.[0] ?? null,
    certification: pickCertification(details, kind),
    status: details.status ?? null,
    details,
  };
}

/**
 * Fetch episode metadata for every season of a show, keyed "season:episode".
 */
async function resolveEpisodes(tmdbId, seasonNumbers) {
  const byKey = new Map();
  const seasonInfo = new Map();

  await Promise.all(
    seasonNumbers.map(async (number) => {
      const season = await getSeason(tmdbId, number);
      if (!season) return;
      seasonInfo.set(number, {
        name: season.name ?? null,
        overview: season.overview ?? null,
        posterPath: season.poster_path ?? null,
        airDate: season.air_date ?? null,
      });
      for (const episode of season.episodes ?? []) {
        byKey.set(number + ':' + episode.episode_number, {
          title: episode.name ?? null,
          overview: episode.overview ?? null,
          stillPath: episode.still_path ?? null,
          airDate: episode.air_date ?? null,
          runtime: episode.runtime ?? null,
        });
      }
    }),
  );

  return { byKey, seasonInfo };
}

/**
 * Merge items that resolved to the same TMDB entry.
 *
 * This is the reliable answer to one show being split across folders under
 * inconsistent names: "Marvels Avengers Assemble" and "Marvel's Avengers Black
 * Panther's Quest" are unrecognisable as the same series by title alone, but
 * both resolve to TMDB 59427. Identity comes from the metadata provider rather
 * than from string similarity, so no guessing is involved.
 *
 * @param {Array<{item: object, scanKey: string, metadata: object|null, episodeMeta: object|null}>} enriched
 */
function mergeByTmdbId(enriched) {
  const groups = new Map();
  const merged = [];

  for (const entry of enriched) {
    const tmdbId = entry.metadata?.tmdbId;
    if (!tmdbId) {
      merged.push(entry);
      continue;
    }
    const key = entry.item.kind + ':' + tmdbId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    // Keep the entry with the richest episode metadata as the base.
    group.sort((a, b) => (b.episodeMeta?.byKey.size ?? 0) - (a.episodeMeta?.byKey.size ?? 0));
    const base = group[0];
    const rest = group.slice(1);

    if (base.item.kind === 'movie') {
      // Duplicate copies of one film: keep the largest, remember the others.
      const all = group.map((entry) => entry.item);
      all.sort((a, b) => b.file.size - a.file.size);
      base.item = {
        ...all[0],
        topFolder: all[0].topFolder,
        alternatives: all.slice(1).map((movie) => movie.file),
      };
    } else {
      const seasons = new Map();
      for (const entry of group) {
        for (const season of entry.item.seasons) {
          if (!seasons.has(season.number)) seasons.set(season.number, new Map());
          const bucket = seasons.get(season.number);
          for (const episode of season.episodes) {
            const existing = bucket.get(episode.episode);
            if (!existing) {
              bucket.set(episode.episode, episode);
              continue;
            }
            // Same episode from two sources — keep the larger file.
            const [keep, drop] =
              episode.file.size >= existing.file.size ? [episode, existing] : [existing, episode];
            keep.alternatives = [...(keep.alternatives ?? []), ...(drop.alternatives ?? []), drop];
            bucket.set(episode.episode, keep);
          }
        }
      }

      base.item = {
        ...base.item,
        sourceFolders: group.flatMap((entry) => entry.item.sourceFolders),
        seasons: [...seasons.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, bucket]) => ({
            number,
            episodes: [...bucket.values()].sort((a, b) => a.episode - b.episode),
          })),
      };
    }

    base.mergedFrom = rest.map((entry) => entry.item.title);
    merged.push(base);
  }

  return merged;
}

/**
 * Run a full scan.
 * @param {{onProgress?: (event: {phase: string, message: string, done?: number, total?: number}) => void}} [options]
 */
export async function runScan({ onProgress = () => {} } = {}) {
  const startedAt = now();
  const scanId = stableId('scan', String(startedAt));

  onProgress({ phase: 'walk', message: 'Reading library folders' });
  const walked = walkLibrary(config.libraryRoots);

  if (walked.missingRoots.length) {
    onProgress({
      phase: 'walk',
      message: 'Skipped unavailable roots: ' + walked.missingRoots.join(', '),
    });
  }

  onProgress({
    phase: 'group',
    message: 'Identifying ' + walked.videos.length + ' files',
  });
  // Merges the user has already accepted, so the same pair is never queried
  // twice and the shows stay joined across rescans. Values are stored encoded,
  // as every override is, so they are read back the same way.
  const mergeInto = Object.fromEntries(
    getDb().prepare("SELECT key FROM overrides WHERE scope = 'merge'").all()
      .map((row) => [row.key, getOverride('merge', row.key)])
      .filter(([, target]) => typeof target === 'string' && target),
  );
  // Pairs already answered "these are two shows", so the question is not
  // asked again at every scan.
  const keepApart = new Set(
    getDb().prepare("SELECT key FROM overrides WHERE scope = 'separate'").all()
      .map((row) => row.key),
  );

  const grouped = groupLibrary(walked, { mergeInto, keepApart });
  const items = [...grouped.movies, ...grouped.shows];

  // Metadata lookups run concurrently; the TMDB client caps real parallelism.
  let done = 0;
  const enriched = await Promise.all(
    items.map(async (item) => {
      const scanKey = scanKeyFor(item);
      let metadata = null;
      try {
        metadata = await resolveMetadata(item, scanKey);
      } catch (error) {
        onProgress({ phase: 'metadata', message: 'Lookup failed for ' + item.title + ': ' + error.message });
      }

      let episodeMeta = null;
      if (metadata && item.kind === 'show') {
        try {
          episodeMeta = await resolveEpisodes(
            metadata.tmdbId,
            item.seasons.map((season) => season.number),
          );
        } catch {
          episodeMeta = null;
        }
      }

      done++;
      onProgress({
        phase: 'metadata',
        message: item.title,
        done,
        total: items.length,
      });

      return { item, scanKey, metadata, episodeMeta };
    }),
  );

  const merged = mergeByTmdbId(enriched);
  const mergeCount = enriched.length - merged.length;
  if (mergeCount > 0) {
    onProgress({
      phase: 'merge',
      message: 'Merged ' + mergeCount + ' duplicate entries by TMDB id',
    });
  }

  onProgress({ phase: 'persist', message: 'Writing to database' });
  const stats = persist(merged, grouped.suggestions, scanId, startedAt);
  stats.mergedByTmdb = mergeCount;

  // Warm the image cache so browsing works with no connection.
  if (hasTmdb()) {
    onProgress({ phase: 'artwork', message: 'Caching artwork for offline use' });
    try {
      const artwork = await prefetchArtwork({
        onProgress: ({ done, total }) => onProgress({
          phase: 'artwork',
          message: 'Caching artwork',
          done,
          total,
        }),
      });
      stats.artwork = artwork;
    } catch (error) {
      onProgress({ phase: 'artwork', message: 'Artwork caching failed: ' + error.message });
    }
  }

  return {
    ...stats,
    walked: walked.videos.length,
    skipped: walked.skipped.length,
    missingRoots: walked.missingRoots,
  };
}

/** Write a scan result to the database in a single transaction. */
function persist(enriched, suggestions, scanId, startedAt) {
  return transaction((db) => {
    const timestamp = now();
    const seenItems = new Set();
    const seenVideos = new Set();

    const upsertItem = db.prepare(`
      INSERT INTO items (
        id, kind, title, sort_title, year, scan_key, source_folders,
        tmdb_id, tmdb_score, overview, tagline, poster_path, backdrop_path,
        logo_path, rating, genres, runtime, certification, status,
        confidence, added_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, sort_title = excluded.sort_title,
        year = excluded.year, source_folders = excluded.source_folders,
        tmdb_id = excluded.tmdb_id, tmdb_score = excluded.tmdb_score,
        overview = excluded.overview, tagline = excluded.tagline,
        poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path,
        logo_path = excluded.logo_path, rating = excluded.rating,
        genres = excluded.genres, runtime = excluded.runtime,
        certification = excluded.certification, status = excluded.status,
        confidence = excluded.confidence, updated_at = excluded.updated_at
    `);

    const upsertSeason = db.prepare(`
      INSERT INTO seasons (id, item_id, number, name, overview, poster_path, air_date)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, overview = excluded.overview,
        poster_path = excluded.poster_path, air_date = excluded.air_date
    `);

    const upsertVideo = db.prepare(`
      INSERT INTO videos (
        id, item_id, season_id, season, episode, episode_end,
        title, overview, still_path, air_date,
        path, size, extension, duration, runtime, parse_pattern, alternatives,
        added_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        item_id = excluded.item_id, season_id = excluded.season_id,
        season = excluded.season, episode = excluded.episode,
        episode_end = excluded.episode_end, title = excluded.title,
        overview = excluded.overview, still_path = excluded.still_path,
        air_date = excluded.air_date, size = excluded.size,
        runtime = excluded.runtime,
        parse_pattern = excluded.parse_pattern,
        alternatives = excluded.alternatives, updated_at = excluded.updated_at
    `);

    const clearSubtitles = db.prepare('DELETE FROM subtitles WHERE video_id = ?');
    const insertSubtitle = db.prepare(
      'INSERT OR IGNORE INTO subtitles (id, video_id, path, name, language) VALUES (?,?,?,?,?)',
    );

    let movieCount = 0;
    let showCount = 0;
    let videoCount = 0;

    for (const { item, scanKey, metadata, episodeMeta } of enriched) {
      // Prefer a TMDB-derived identity: it survives folder renames and keeps
      // two folders of one show pointing at a single row (the UNIQUE index on
      // scan_key then makes a duplicate impossible rather than merely unlikely).
      const identityKey = metadata
        ? item.kind + ':tmdb:' + metadata.tmdbId
        : scanKey;
      const itemId = stableId(identityKey);
      seenItems.add(itemId);

      const title = metadata?.title ?? item.title;
      const year = metadata?.year ?? item.year ?? null;
      const sourceFolders = item.kind === 'movie' ? [item.topFolder] : item.sourceFolders;

      // Confidence reflects how sure we are this item is correctly identified.
      const confidence = metadata ? Math.min(1, metadata.score) : 0.5;

      upsertItem.run(
        itemId,
        item.kind,
        title,
        sortTitle(title),
        year,
        identityKey,
        JSON.stringify(sourceFolders),
        metadata?.tmdbId ?? null,
        metadata?.score ?? null,
        metadata?.overview ?? null,
        metadata?.tagline ?? null,
        metadata?.posterPath ?? null,
        metadata?.backdropPath ?? null,
        metadata?.logoPath ?? null,
        metadata?.rating ?? null,
        JSON.stringify(metadata?.genres ?? []),
        metadata?.runtime ?? null,
        metadata?.certification ?? null,
        metadata?.status ?? null,
        confidence,
        timestamp,
        timestamp,
      );

      const writeVideo = (video, fields) => {
        const videoId = stableId(video.path);
        seenVideos.add(videoId);
        upsertVideo.run(
          videoId,
          itemId,
          fields.seasonId ?? null,
          fields.season ?? null,
          fields.episode ?? null,
          fields.episodeEnd ?? null,
          fields.title ?? null,
          fields.overview ?? null,
          fields.stillPath ?? null,
          fields.airDate ?? null,
          video.path,
          video.size,
          video.ext,
          // duration is learned from playback; runtime comes from metadata.
          null,
          fields.runtime ?? null,
          fields.pattern ?? null,
          JSON.stringify(fields.alternatives ?? []),
          timestamp,
          timestamp,
        );
        videoCount++;

        clearSubtitles.run(videoId);
        for (const subtitle of fields.subtitles ?? []) {
          insertSubtitle.run(
            stableId(videoId, subtitle.path),
            videoId,
            subtitle.path,
            subtitle.name,
            subtitle.language,
          );
        }
        return videoId;
      };

      if (item.kind === 'movie') {
        movieCount++;
        writeVideo(item.file, {
          runtime: metadata?.runtime ?? null,
          subtitles: item.subtitles,
          alternatives: (item.alternatives ?? []).map((alt) => alt.path),
        });
      } else {
        showCount++;
        for (const season of item.seasons) {
          const seasonId = stableId(itemId, 'season', String(season.number));
          const info = episodeMeta?.seasonInfo.get(season.number);
          upsertSeason.run(
            seasonId,
            itemId,
            season.number,
            info?.name ?? null,
            info?.overview ?? null,
            info?.posterPath ?? null,
            info?.airDate ?? null,
          );

          for (const episode of season.episodes) {
            const meta = episodeMeta?.byKey.get(season.number + ':' + episode.episode);
            writeVideo(episode.file, {
              seasonId,
              season: season.number,
              episode: episode.episode,
              episodeEnd: episode.episodeEnd,
              // Prefer TMDB's episode title. The filename fallback is validated,
              // because scene names often leave junk fragments behind.
              title: meta?.title ?? cleanEpisodeTitle(episode.title),
              overview: meta?.overview ?? null,
              stillPath: meta?.stillPath ?? null,
              airDate: meta?.airDate ?? null,
              runtime: meta?.runtime ?? metadata?.runtime ?? null,
              pattern: episode.pattern,
              alternatives: (episode.alternatives ?? []).map((alt) => alt.file.path),
              subtitles: episode.subtitles,
            });
          }
        }
      }
    }

    // Remove rows for files and items that no longer exist on disk. Progress
    // rows cascade, which is correct: the file is gone.
    const staleVideos = db.prepare('SELECT id FROM videos').all()
      .filter((row) => !seenVideos.has(row.id));
    const deleteVideo = db.prepare('DELETE FROM videos WHERE id = ?');
    for (const row of staleVideos) deleteVideo.run(row.id);

    const staleItems = db.prepare('SELECT id FROM items').all()
      .filter((row) => !seenItems.has(row.id));
    const deleteItem = db.prepare('DELETE FROM items WHERE id = ?');
    for (const row of staleItems) deleteItem.run(row.id);

    /*
     * Seasons and shows that no longer hold a single file.
     *
     * Deleting a folder leaves the rows describing it behind: the videos go,
     * because they were not seen, but the season survives and the title keeps
     * offering "Season 4 (0)" — a tab that opens on nothing. A show whose every
     * file has gone should not be in the library at all.
     *
     * After the stale videos above, not before, or the counts would still
     * include files that are on their way out.
     */
    const emptySeasons = db.prepare(`
      SELECT s.id FROM seasons s
      WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.season_id = s.id)
        AND NOT EXISTS (
          SELECT 1 FROM videos v WHERE v.item_id = s.item_id AND v.season = s.number
        )
    `).all();
    const deleteSeason = db.prepare('DELETE FROM seasons WHERE id = ?');
    for (const row of emptySeasons) deleteSeason.run(row.id);

    const emptyItems = db.prepare(
      'SELECT id FROM items WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.item_id = items.id)',
    ).all();
    for (const row of emptyItems) deleteItem.run(row.id);

    db.prepare('DELETE FROM suggestions WHERE resolved = 0').run();
    const insertSuggestion = db.prepare(
      'INSERT OR REPLACE INTO suggestions (id, kind, payload, confidence, created_at) VALUES (?,?,?,?,?)',
    );
    for (const suggestion of suggestions) {
      insertSuggestion.run(
        stableId('suggestion', suggestion.shows.join('|')),
        'merge',
        JSON.stringify(suggestion),
        suggestion.confidence,
        timestamp,
      );
    }

    const stats = {
      movies: movieCount,
      shows: showCount,
      videos: videoCount,
      removedVideos: staleVideos.length,
      removedItems: staleItems.length,
      suggestions: suggestions.length,
    };

    db.prepare('INSERT OR REPLACE INTO scans (id, started_at, finished_at, stats) VALUES (?,?,?,?)')
      .run(scanId, startedAt, timestamp, JSON.stringify(stats));

    return stats;
  });
}
