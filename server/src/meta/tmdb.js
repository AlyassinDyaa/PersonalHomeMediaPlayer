/**
 * TMDB client: cached, rate-limited, and scored.
 *
 * Responses are cached in SQLite so a rescan of an unchanged library costs no
 * network calls. Matching returns a confidence score rather than blindly
 * trusting the first search hit, because scene titles are frequently mangled
 * ("KPop Demon Hunters", "Marvels Avengers Assemble").
 */

import { getDb, now } from '../db.js';
import { config } from '../config.js';
import { levenshtein } from '../scan/parse.js';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** TMDB permits ~50 requests/second; stay well under it. */
const MAX_CONCURRENT = 8;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

let inFlight = 0;
const queue = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {{allowStale?: boolean}} [options] When stale entries are allowed the
 *   TTL is ignored. Used as an offline fallback: out-of-date metadata is far
 *   better than none, which would otherwise strip a title of its identity.
 */
function cacheGet(url, { allowStale = false } = {}) {
  const row = getDb()
    .prepare('SELECT body, fetched_at FROM tmdb_cache WHERE url = ?')
    .get(url);
  if (!row) return null;
  if (!allowStale && now() - Number(row.fetched_at) > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
}

function cachePut(url, body) {
  getDb()
    .prepare('INSERT OR REPLACE INTO tmdb_cache (url, body, fetched_at) VALUES (?, ?, ?)')
    .run(url, JSON.stringify(body), now());
}

/**
 * Whether a key actually works, asked before it is trusted.
 *
 * A mistyped or revoked key saves perfectly happily and then produces no
 * artwork and no descriptions, with nothing anywhere saying why. That is
 * indistinguishable from the key not having been saved, and the natural
 * response is to enter it again — so it is worth one request to find out.
 *
 * Deliberately outside the cache and the queue: this is testing a candidate,
 * not fetching anything, and it must not be answered from a previous key's
 * results.
 *
 * No connection is not a bad key. A library on an isolated network has no way
 * to reach TMDB and must still be able to store a key for the next time it is
 * plugged in, so an unreachable service is reported as unknown rather than as
 * a rejection.
 *
 * @param {string} key
 * @returns {Promise<{ok: boolean|null, reachable: boolean, error?: string}>}
 */
export async function verifyApiKey(key) {
  const candidate = String(key ?? '').trim();
  if (!candidate) return { ok: false, reachable: true, error: 'No key was given' };

  try {
    const response = await fetch(
      BASE + '/configuration?api_key=' + encodeURIComponent(candidate),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (response.ok) return { ok: true, reachable: true };
    if (response.status === 401) {
      return { ok: false, reachable: true, error: 'TMDB did not recognise that key' };
    }
    return { ok: false, reachable: true, error: 'TMDB answered ' + response.status };
  } catch {
    return { ok: null, reachable: false };
  }
}

/**
 * GET a TMDB path with caching, concurrency limiting and retries.
 * @param {string} path Path beginning with "/", may include a query string.
 * @returns {Promise<any|null>} Parsed body, or null for 404 / permanent failure.
 */
export async function tmdbGet(path) {
  if (!config.tmdbApiKey) throw new Error('TMDB API key is not configured');

  const separator = path.includes('?') ? '&' : '?';
  const url = BASE + path + separator + 'api_key=' + config.tmdbApiKey
    + '&language=' + encodeURIComponent(config.tmdbLanguage);
  const cacheKey = path;

  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  await acquire();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url);

        if (response.status === 404) {
          cachePut(cacheKey, null);
          return null;
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after') ?? 1);
          await sleep((retryAfter + 0.5) * 1000);
          continue;
        }
        if (response.status >= 500) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        if (!response.ok) {
          throw new Error('TMDB ' + response.status + ' for ' + path);
        }

        const body = await response.json();
        cachePut(cacheKey, body);
        return body;
      } catch (error) {
        // Network blips are common on large scans; retry with backoff.
        if (attempt === 3) {
          // Offline, or TMDB unreachable. Fall back to a stale cache entry so a
          // rescan without a connection keeps every title's existing identity
          // instead of silently un-matching the whole library.
          const stale = cacheGet(cacheKey, { allowStale: true });
          if (stale !== null) return stale;
          throw error;
        }
        await sleep(2 ** attempt * 500);
      }
    }
    return null;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 0..1 similarity between two titles. */
export function titleSimilarity(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const distance = levenshtein(left, right);
  const base = 1 - distance / Math.max(left.length, right.length);

  // Containment is a strong signal: "Marvels Avengers Assemble Black Panthers
  // Quest" genuinely is "Marvel's Avengers".
  if (left.startsWith(right) || right.startsWith(left)) {
    return Math.max(base, 0.9);
  }
  if (left.includes(right) || right.includes(left)) {
    return Math.max(base, 0.8);
  }
  return Math.max(0, base);
}

/**
 * Score a TMDB search result against what the scanner parsed.
 * Title similarity dominates; year agreement adjusts, and popularity only
 * breaks ties.
 */
function scoreCandidate(candidate, { title, year }, kind) {
  const candidateTitle = kind === 'movie' ? candidate.title : candidate.name;
  const candidateOriginal = kind === 'movie' ? candidate.original_title : candidate.original_name;
  const date = kind === 'movie' ? candidate.release_date : candidate.first_air_date;
  const candidateYear = date ? Number(date.slice(0, 4)) : null;

  const similarity = Math.max(
    titleSimilarity(title, candidateTitle),
    titleSimilarity(title, candidateOriginal),
  );

  let score = similarity;

  if (year && candidateYear) {
    const gap = Math.abs(year - candidateYear);
    if (gap === 0) score += 0.18;
    else if (gap === 1) score += 0.08;
    else if (gap <= 3) score -= 0.05;
    else score -= 0.25;
  } else if (year && !candidateYear) {
    score -= 0.05;
  }

  // Tie-breaker only — never enough to rescue a bad title match.
  score += Math.min(candidate.popularity ?? 0, 100) / 10000;

  return { score: Math.max(0, Math.min(1, score)), similarity, candidateYear, candidateTitle };
}

/**
 * Abbreviations that scene releases use but TMDB does not, so a search for the
 * literal folder name returns nothing at all ("X-Men TAS").
 */
const ABBREVIATIONS = new Map([
  ['tas', 'The Animated Series'],
  ['btas', 'Batman The Animated Series'],
  ['stas', 'Superman The Animated Series'],
  ['tng', 'The Next Generation'],
  ['ds9', 'Deep Space Nine'],
  ['tos', 'The Original Series'],
  ['jlu', 'Justice League Unlimited'],
  ['tmnt', 'Teenage Mutant Ninja Turtles'],
  ['aos', 'Agents of SHIELD'],
  ['emh', "Earth's Mightiest Heroes"],
  ['sac', 'Stand Alone Complex'],
]);

/**
 * Alternative spellings to try when the literal title finds nothing: expand a
 * known abbreviation, and failing that drop a trailing acronym entirely.
 */
function titleVariants(title) {
  const variants = [];
  const words = title.trim().split(/\s+/);
  if (words.length < 2) return variants;

  const last = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const expansion = ABBREVIATIONS.get(last);
  if (expansion) {
    variants.push([...words.slice(0, -1), expansion].join(' '));
  }
  // "X-Men TAS" -> "X-Men": a trailing short all-caps token is release shorthand.
  if (/^[A-Z0-9]{2,5}$/.test(words[words.length - 1])) {
    variants.push(words.slice(0, -1).join(' '));
  }
  return variants;
}

/**
 * Find the best TMDB match.
 * @param {'movie'|'tv'} kind
 * @param {{title: string, year: number|null}} parsed
 * @returns {Promise<{id:number, score:number, similarity:number, raw:object}|null>}
 */
export async function findBestMatch(kind, { title, year }) {
  const yearParam = kind === 'movie' ? 'year' : 'first_air_date_year';
  const search = (text, withYear) =>
    '/search/' + kind + '?query=' + encodeURIComponent(text)
    + (withYear && year ? '&' + yearParam + '=' + year : '');

  const queries = [];
  if (year) queries.push(search(title, true));
  queries.push(search(title, false));

  const seen = new Map();

  for (const query of queries) {
    const body = await tmdbGet(query);
    for (const result of body?.results ?? []) {
      if (!seen.has(result.id)) seen.set(result.id, result);
    }
    // A confident hit from the year-qualified search needs no fallback.
    if (seen.size > 0 && query === queries[0] && queries.length > 1) {
      const best = pickBest([...seen.values()], { title, year }, kind);
      if (best && best.score >= 0.95) return best;
    }
  }

  let best = seen.size ? pickBest([...seen.values()], { title, year }, kind) : null;
  if (best) return best;

  // Nothing matched the literal title. Retry with expanded abbreviations,
  // scoring against the variant so "X-Men The Animated Series" is judged
  // against what we actually asked for.
  for (const variant of titleVariants(title)) {
    const body = await tmdbGet(search(variant, Boolean(year)));
    const results = body?.results ?? [];
    if (!results.length) continue;
    const candidate = pickBest(results, { title: variant, year }, kind);
    if (candidate && (!best || candidate.score > best.score)) {
      best = { ...candidate, matchedVia: variant };
    }
    if (best && best.score >= 0.9) break;
  }

  return best;
}

function pickBest(candidates, parsed, kind) {
  let best = null;
  for (const candidate of candidates) {
    const scored = scoreCandidate(candidate, parsed, kind);
    if (!best || scored.score > best.score) {
      best = { id: candidate.id, ...scored, raw: candidate };
    }
  }
  // Below this the match is worse than no match at all.
  if (!best || best.similarity < 0.5) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export async function getMovie(id) {
  return tmdbGet('/movie/' + id + '?append_to_response=release_dates,images&include_image_language=en,null');
}

export async function getShow(id) {
  return tmdbGet('/tv/' + id + '?append_to_response=content_ratings,images&include_image_language=en,null');
}

export async function getSeason(showId, seasonNumber) {
  return tmdbGet('/tv/' + showId + '/season/' + seasonNumber);
}

/** Build an absolute image URL. `size` follows TMDB's naming, e.g. "w500". */
export function imageUrl(path, size = 'w500') {
  if (!path) return null;
  return IMAGE_BASE + '/' + size + path;
}

/** Pick an English title logo from an appended images response, if present. */
export function pickLogo(details) {
  const logos = details?.images?.logos ?? [];
  const english = logos.filter((logo) => logo.iso_639_1 === 'en');
  const chosen = (english.length ? english : logos)
    .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
  return chosen?.file_path ?? null;
}

/** US certification (PG-13, TV-14) from an appended response. */
export function pickCertification(details, kind) {
  if (kind === 'movie') {
    const us = details?.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
    const withCert = us?.release_dates?.find((r) => r.certification);
    return withCert?.certification ?? null;
  }
  const us = details?.content_ratings?.results?.find((r) => r.iso_3166_1 === 'US');
  return us?.rating ?? null;
}
