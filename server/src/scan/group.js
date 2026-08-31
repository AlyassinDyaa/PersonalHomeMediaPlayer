/**
 * Turn a flat list of media files into library items: movies, and shows with
 * seasons and episodes.
 *
 * The two hard problems this solves for real-world libraries:
 *   1. Deciding whether a folder holds a movie or a series.
 *   2. Merging one series that has been split across several top-level folders
 *      ("Ben 10 2005 S01", "Ben 10 2005 S02", "Ben 10 S04" are one show).
 *
 * Every item carries a confidence score and the reasons behind it, so the UI
 * can surface the handful of guesses worth a human glance.
 */

import path from 'node:path';
import {
  parseEpisodeFile, parseTitle, parseSeasonFolder, parseSeasonRange, seriesKey,
  stripExtension,
} from './parse.js';

/** A folder is treated as a series once this fraction of its videos parse as episodes. */
const EPISODE_RATIO_THRESHOLD = 0.6;

/**
 * Episode markers strong enough to identify a series from a single file.
 *
 * "S01E01", "1x01" and "Season 1 Episode 2" say what they are and mean nothing
 * else; no film is named that way. The weaker patterns are excluded on purpose:
 * a bare "E01", or three digits read as season-and-episode, appear often enough
 * in ordinary titles that one of them alone proves nothing.
 */
const STRONG_EPISODE_PATTERNS = new Set(['SxxExx', 'NxNN', 'verbose']);

/**
 * Resolve the season for an episode file whose name did not carry one, by
 * looking at the folder chain from nearest parent outward.
 * @param {string[]} chain
 * @param {string} topFolder
 */
function seasonFromFolders(chain, topFolder) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const season = parseSeasonFolder(chain[i]);
    if (season !== null) return season;
  }
  const fromTop = parseSeasonFolder(topFolder);
  if (fromTop !== null) return fromTop;
  const range = parseSeasonRange(topFolder);
  if (range) return range[0];
  return null;
}

/** Most frequently occurring value, ties broken by first appearance. */
function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

/**
 * Classify one top-level folder's videos and emit either a movie list or a
 * series-folder record.
 */
function classifyFolder(topFolder, videos) {
  const parsed = videos.map((video) => {
    const fallbackSeason = seasonFromFolders(video.chain, video.topFolder);
    const episode = parseEpisodeFile(video.name, { fallbackSeason });
    return { video, episode };
  });

  const episodeCount = parsed.filter((p) => p.episode !== null).length;
  const ratio = videos.length ? episodeCount / videos.length : 0;
  const folderSaysSeries =
    parseSeasonFolder(topFolder) !== null || parseSeasonRange(topFolder) !== null;

  const strongCount = parsed
    .filter((p) => p.episode && STRONG_EPISODE_PATTERNS.has(p.episode.pattern)).length;

  /*
   * Two episodes normally have to agree before a folder counts as a series,
   * which is what stops a stray number in a film's name from turning it into a
   * show. One unmistakable marker is enough on its own, though: a folder
   * holding only "Lanterns.2026.S01E01.mkv" — the first episode of a series
   * still airing — is a show with one episode, not a film. Without this it was
   * searched for among films and came back as an unrelated title.
   *
   * The ratio still has to hold, so a single oddly-named file among a folder of
   * films cannot drag the whole folder across.
   */
  const isSeries =
    (ratio >= EPISODE_RATIO_THRESHOLD && (episodeCount >= 2 || strongCount >= 1)) ||
    (folderSaysSeries && episodeCount >= 1);

  return { parsed, ratio, episodeCount, strongCount, isSeries, folderSaysSeries };
}

/**
 * Build series-folder records from one top-level folder.
 *
 * Returns an array because a single folder can legitimately hold more than one
 * show — "Justice League Animted Series" contains both Justice League and
 * Justice League Unlimited. Episodes are therefore grouped by the series title
 * parsed from the *files*, not by the folder they happen to sit in.
 */
function buildSeriesFolders(topFolder, classification) {
  const { parsed, ratio, folderSaysSeries } = classification;

  const withEpisode = parsed.filter((p) => p.episode);
  const unparsed = parsed.filter((p) => !p.episode).map((p) => p.video);

  // Bucket by the series identity each filename claims.
  const buckets = new Map();
  for (const item of withEpisode) {
    const key = seriesKey(item.episode.seriesTitle);
    if (!buckets.has(key)) buckets.set(key, { key, title: item.episode.seriesTitle, items: [] });
    buckets.get(key).items.push(item);
  }

  const ordered = [...buckets.values()].sort((a, b) => b.items.length - a.items.length);
  if (ordered.length === 0) return [];

  // Fold away tiny buckets: they are almost always one oddly-named file rather
  // than a genuine second show sharing the folder.
  const dominant = ordered[0];
  const kept = [dominant];
  for (const bucket of ordered.slice(1)) {
    const isNoise = bucket.items.length < 3 && bucket.items.length < dominant.items.length * 0.15;
    if (isNoise) dominant.items.push(...bucket.items);
    else kept.push(bucket);
  }

  // Within one folder, buckets whose titles are prefix-related and whose
  // seasons do not overlap are the same show under inconsistent naming —
  // "x-men" (S1, named "1x01") and "X-Men TAS" (S2-S5, named "201").
  // Overlapping seasons mean the opposite: two distinct shows that happen to
  // share a folder, such as Justice League and Justice League Unlimited.
  const seasonsOf = (bucket) => new Set(bucket.items.map((p) => p.episode.season ?? 1));
  for (let i = kept.length - 1; i > 0; i--) {
    for (let j = 0; j < i; j++) {
      const [a, b] = [kept[i], kept[j]];
      const [shorter, longer] = a.key.length <= b.key.length ? [a, b] : [b, a];
      if (!longer.key.startsWith(`${shorter.key} `)) continue;

      const seasonsA = seasonsOf(a);
      const overlaps = [...seasonsOf(b)].some((season) => seasonsA.has(season));
      if (overlaps) continue;

      // Fold into whichever bucket has more episodes; its title is better attested.
      const [into, from] = a.items.length >= b.items.length ? [a, b] : [b, a];
      into.items.push(...from.items);
      kept.splice(kept.indexOf(from), 1);
      break;
    }
  }

  // Strip season markers out of the folder name before reading a title from it.
  const folderWithoutSeason = topFolder
    .replace(/\bS\d{1,2}\s?[-+–]\s?S?\d{1,2}\b/gi, ' ')
    .replace(/\bS\d{1,2}\b/gi, ' ')
    .replace(/\bseasons?\s*[\d\s-]+\b/gi, ' ')
    .replace(/\ball\s+seasons?\b/gi, ' ');
  const folderParsed = parseTitle(folderWithoutSeason);

  // When the folder holds several shows its own name describes the collection,
  // not any one series, so it must not contribute a title or a year.
  const folderDescribesOneShow = kept.length === 1;

  return kept.map((bucket, index) => {
    const title = bucket.title || (folderDescribesOneShow ? folderParsed.title : null) || topFolder;
    const years = bucket.items.map((p) => p.episode.seriesYear).filter(Boolean);
    const year = (folderDescribesOneShow ? folderParsed.year : null) ?? mostCommon(years);

    const episodes = bucket.items.map(({ video, episode }) => ({
      season: episode.season ?? 1,
      episode: episode.episode,
      episodeEnd: episode.episodeEnd,
      title: episode.episodeTitle,
      pattern: episode.pattern,
      file: video,
    }));

    return {
      kind: 'series-folder',
      topFolder,
      root: bucket.items[0].video.root,
      title,
      titleCandidates: [
        ...new Set([bucket.title, folderDescribesOneShow ? folderParsed.title : null].filter(Boolean)),
      ],
      year,
      key: seriesKey(title),
      episodes,
      // Unattributable files follow the dominant show in the folder.
      unparsed: index === 0 ? unparsed : [],
      signals: {
        episodeRatio: ratio,
        folderSaysSeries,
        sharedFolder: kept.length > 1,
      },
    };
  });
}

/**
 * Build movie records from a folder that did not look like a series. A folder
 * may legitimately contain more than one film ("Rebel Moon Part One & Two").
 */
function buildMovies(topFolder, videos) {
  const multiple = videos.length > 1;

  return videos.map((video) => {
    const deepestFolder = video.chain.length ? video.chain[video.chain.length - 1] : topFolder;

    // Candidate names, best first. With several films in one folder the
    // filename is authoritative; with one, the folder name is usually cleaner.
    const candidates = multiple
      ? [
          { name: video.name, isFile: true, source: 'file' },
          { name: deepestFolder, isFile: false, source: 'folder' },
          { name: topFolder, isFile: false, source: 'topFolder' },
        ]
      : [
          { name: deepestFolder, isFile: false, source: 'folder' },
          { name: topFolder, isFile: false, source: 'topFolder' },
          { name: video.name, isFile: true, source: 'file' },
        ];

    const parsedCandidates = candidates.map((c) => ({
      ...c,
      ...parseTitle(c.name, { isFile: c.isFile }),
    }));

    // Prefer a candidate that yielded a year — that is the strongest signal
    // that we cleanly separated title from release metadata.
    const chosen =
      parsedCandidates.find((c) => c.year !== null && c.title) ??
      parsedCandidates.find((c) => c.title) ??
      parsedCandidates[0];

    return {
      kind: 'movie',
      title: chosen.title || stripExtension(video.name),
      year: chosen.year,
      titleSource: chosen.source,
      topFolder,
      root: video.root,
      file: video,
      signals: { multipleInFolder: multiple, hadYear: chosen.year !== null },
    };
  });
}

/**
 * Merge series folders that describe the same show.
 *
 * Merging is deliberately conservative: only an exact normalised-title match
 * merges automatically. Near-matches ("Marvels Avengers Assemble" vs
 * "Marvels Avengers Assemble Black Panthers Quest") become *suggestions* for
 * the UI, because prefix similarity alone would wrongly fuse genuinely
 * different shows such as "Justice League" and "Justice League Unlimited".
 */
function mergeSeriesFolders(seriesFolders) {
  const byKey = new Map();
  for (const folder of seriesFolders) {
    if (!byKey.has(folder.key)) byKey.set(folder.key, []);
    byKey.get(folder.key).push(folder);
  }

  const shows = [];
  for (const [key, folders] of byKey) {
    const seasons = new Map();
    const conflicts = [];

    for (const folder of folders) {
      for (const episode of folder.episodes) {
        if (!seasons.has(episode.season)) seasons.set(episode.season, new Map());
        const bucket = seasons.get(episode.season);
        const existing = bucket.get(episode.episode);
        if (existing) {
          // The same episode exists twice (e.g. a 720p rip and a REMUX).
          // Keep the larger file and remember the alternative.
          const [keep, drop] =
            episode.file.size >= existing.file.size ? [episode, existing] : [existing, episode];
          keep.alternatives = [...(keep.alternatives ?? []), ...(drop.alternatives ?? []), drop];
          bucket.set(episode.episode, keep);
          conflicts.push({ season: episode.season, episode: episode.episode });
        } else {
          bucket.set(episode.episode, episode);
        }
      }
    }

    const title = folders.map((f) => f.title).sort((a, b) => b.length - a.length)[0];
    const year = folders.map((f) => f.year).find((y) => y != null) ?? null;

    shows.push({
      kind: 'show',
      key,
      title,
      year,
      sourceFolders: folders.map((f) => f.topFolder),
      root: folders[0].root,
      seasons: [...seasons.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([number, bucket]) => ({
          number,
          episodes: [...bucket.values()].sort((a, b) => a.episode - b.episode),
        })),
      conflicts,
      signals: {
        mergedFolders: folders.length,
        episodeRatio: Math.min(...folders.map((f) => f.signals.episodeRatio)),
      },
    });
  }

  return shows;
}

/** A stable name for a pair of shows, whichever order they arrive in. */
export function pairKey(shows) {
  return [...shows].sort().join('|');
}

/**
 * Find shows whose titles are near-misses of one another. Returned as
 * suggestions rather than applied, for the user to accept or reject.
 */
function findMergeSuggestions(shows) {
  const suggestions = [];
  for (let i = 0; i < shows.length; i++) {
    for (let j = i + 1; j < shows.length; j++) {
      const a = shows[i];
      const b = shows[j];
      const [shorter, longer] = a.key.length <= b.key.length ? [a, b] : [b, a];
      if (!longer.key.startsWith(`${shorter.key} `)) continue;

      // Seasons that overlap mean these are probably distinct shows.
      const aSeasons = new Set(a.seasons.map((s) => s.number));
      const overlap = b.seasons.some((s) => aSeasons.has(s.number));

      suggestions.push({
        shows: [a.key, b.key],
        titles: [a.title, b.title],
        reason: overlap
          ? 'similar titles, but their seasons overlap — likely separate shows'
          : 'similar titles with non-overlapping seasons — likely one show split across folders',
        confidence: overlap ? 0.25 : 0.7,
      });
    }
  }
  return suggestions;
}

/** Attach sidecar subtitle files to the video they belong to. */
function attachSubtitles(items, subtitles) {
  const byDir = new Map();
  for (const sub of subtitles) {
    const dir = path.dirname(sub.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(sub);
  }

  /** Subtitles sitting in a `Subs/` folder belong to the video one level up. */
  const forVideo = (video) => {
    const dir = path.dirname(video.path);
    const base = stripExtension(video.name).toLowerCase();
    const candidates = [
      ...(byDir.get(dir) ?? []),
      ...(byDir.get(path.join(dir, 'Subs')) ?? []),
      ...(byDir.get(path.join(dir, 'subs')) ?? []),
      ...(byDir.get(path.join(dir, 'Subtitles')) ?? []),
    ];

    // In a shared folder, only take subtitles whose name matches this video.
    const siblingVideos = candidates.length > 0;
    if (!siblingVideos) return [];

    return candidates
      .filter((sub) => {
        const subBase = stripExtension(sub.name).toLowerCase();
        const inSubsFolder = /[\\/]subs?[\\/]/i.test(sub.path);
        if (inSubsFolder) return true;
        return subBase.startsWith(base) || base.startsWith(subBase.split('.')[0]);
      })
      .map((sub) => ({ path: sub.path, name: sub.name, language: languageOf(sub.name) }));
  };

  for (const item of items) {
    if (item.kind === 'movie') {
      item.subtitles = forVideo(item.file);
    } else {
      for (const season of item.seasons) {
        for (const episode of season.episodes) {
          episode.subtitles = forVideo(episode.file);
        }
      }
    }
  }
}

/** Guess a subtitle's language from conventional filename suffixes. */
function languageOf(name) {
  const base = stripExtension(name);
  const suffix = base.match(/\.([a-z]{2,3})(\.(hi|sdh|forced|cc))?$/i);
  if (suffix) return suffix[1].toLowerCase();
  const spelled = base.match(/\b(english|spanish|french|german|italian|arabic|portuguese|dutch|danish|swedish|norwegian|finnish|polish|turkish|russian|japanese|korean|chinese)\b/i);
  if (spelled) return spelled[1].toLowerCase().slice(0, 3);
  return null;
}

/**
 * Group a walked library into movies and shows.
 * @param {{videos: import('./walk.js').MediaFile[], subtitles: import('./walk.js').MediaFile[]}} walked
 */
/**
 * Group a walked library into movies and shows.
 *
 * `mergeInto` maps a series key onto the key it should be folded into, which
 * is how an accepted "these are one show" suggestion survives every later
 * scan. Without it the scanner would re-ask the same question every time,
 * because nothing about the folders on disk has changed.
 *
 * @param {{videos: import('./walk.js').MediaFile[], subtitles: import('./walk.js').MediaFile[]}} walked
 * @param {{mergeInto?: Record<string, string>}} [options]
 */
export function groupLibrary(
  { videos, subtitles = [] },
  { mergeInto = {}, keepApart = new Set() } = {},
) {
  // Keyed on the folder's absolute path so names containing spaces or
  // separators cannot collide.
  const byFolder = new Map();
  for (const video of videos) {
    const folderKey = path.join(video.root, video.topFolder);
    if (!byFolder.has(folderKey)) {
      byFolder.set(folderKey, { topFolder: video.topFolder, videos: [] });
    }
    byFolder.get(folderKey).videos.push(video);
  }

  const movies = [];
  const seriesFolders = [];

  for (const { topFolder, videos: folderVideos } of byFolder.values()) {
    const classification = classifyFolder(topFolder, folderVideos);
    if (classification.isSeries) {
      seriesFolders.push(...buildSeriesFolders(topFolder, classification));
    } else {
      movies.push(...buildMovies(topFolder, folderVideos));
    }
  }

  /*
   * Applied before merging rather than after, so folded-together folders share
   * one key and go through the same episode-conflict handling as a series that
   * was split across folders in the first place.
   */
  for (const folder of seriesFolders) {
    const target = mergeInto[folder.key];
    if (target && target !== folder.key) folder.key = target;
  }

  const shows = mergeSeriesFolders(seriesFolders);
  /*
   * A pair already decided upon must not be raised again — in either
   * direction.
   *
   * Answering "keep separate" used to be forgotten at the next scan, because
   * the suggestion was rebuilt from the folders and nothing recorded the
   * answer. The question came back every time, and one stray press turned two
   * series into one with no way back. Now both answers are remembered.
   */
  const suggestions = findMergeSuggestions(shows)
    .filter((entry) => !entry.shows.some((key) => mergeInto[key]))
    .filter((entry) => !keepApart.has(pairKey(entry.shows)));

  attachSubtitles([...movies, ...shows], subtitles);

  return { movies, shows, suggestions };
}
