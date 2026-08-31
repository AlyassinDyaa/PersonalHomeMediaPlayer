/**
 * Filename / folder-name parsing for scene-style media libraries.
 *
 * Everything here is pure: strings in, plain objects out. That keeps it
 * directly testable against the real library without touching the disk.
 */

/**
 * Container formats to treat as playable.
 *
 * Deliberately broad: playback is handled by mpv, which decodes essentially
 * anything, so the scanner should not be the component that decides a file is
 * unsupported. Anything mpv can open belongs in the library.
 */
export const VIDEO_EXTENSIONS = new Set([
  // Mainstream
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.webm', '.flv', '.ogv',
  // MPEG family and broadcast transport streams
  '.mpg', '.mpeg', '.mpe', '.m1v', '.m2v', '.mpv', '.ts', '.m2ts', '.mts',
  '.tp', '.trp', '.m2p', '.vob',
  // Matroska / QuickTime variants
  '.mk3d', '.qt',
  // Windows and legacy formats
  '.asf', '.asx', '.wm', '.wmp', '.wtv', '.dvr-ms', '.divx', '.f4v', '.amv',
  // RealMedia
  '.rm', '.rmvb', '.rv',
  // Mobile and misc
  '.3gp', '.3g2', '.mxf', '.nsv', '.roq', '.yuv', '.ogm', '.ogx', '.bik', '.smk',
  // Disc images mpv can open directly
  '.iso',
]);

/**
 * Extensions that are audio-only. Kept separate so a music file sitting beside
 * a movie is not mistaken for the feature.
 */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wav', '.wma', '.ac3', '.dts', '.eac3',
]);

export const SUBTITLE_EXTENSIONS = new Set([
  '.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.sup', '.pgs', '.smi', '.sami',
  '.mpl2', '.dfxp', '.ttml', '.lrc',
]);

/**
 * Release metadata tokens. Stripped from the tail of a title once the year and
 * episode markers have been located. Order matters only for multi-word tokens,
 * which must be tried before their single-word components.
 */
const RELEASE_TOKENS = [
  // Multi-word first
  'web dl', 'web rip', 'blu ray', 'dts hd ma', 'dts hd', 'dts es', 'dd p', 'h 264', 'h 265',
  'x 264', 'x 265', 'aac2 0', 'ddp5 1', 'dd5 1', 'dd 5 1', 'ddp 5 1', 'aac 2 0', 'dts ma',
  'true hd', 'bd rip', 'br rip', 'hd rip', 'dvd rip', 'dvd scr', 'hdtv rip', 'multi audio',
  '2 audio', '10 bit', 'ma 2 0', 'ma 5 1', 'dd 2 0',
  // Resolutions / sources
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hdtv', 'webrip', 'webdl',
  'bluray', 'brrip', 'bdrip', 'dvdrip', 'dvdscr', 'hdrip', 'remux', 'web', 'bd', 'br', 'dvd',
  // Codecs
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'vc1', 'xvid', 'divx', '10bit', '8bit', '10 bit',
  // Audio
  'aac', 'ac3', 'eac3', 'dts', 'ddp', 'dd', 'atmos', 'truehd', 'flac', 'mp3', 'opus', 'ma',
  '5 1', '7 1', '2 0', '6ch', '2ch',
  // HDR
  'hdr', 'hdr10', 'dv', 'dolby vision', 'sdr', 'imax', 'hlg',
  // Streaming services
  'nf', 'netflix', 'amzn', 'amazon', 'dsnp', 'disney', 'hulu', 'max', 'hmax', 'atvp', 'pcok',
  'stan', 'crav', 'itunes', 'ma',
  // Edition / status
  'proper', 'repack', 'internal', 'limited', 'extended', 'unrated', 'uncut', 'remastered',
  'directors cut', 'dc', 'theatrical', 'complete', 'multi', 'subs', 'sub', 'dubbed', 'dual',
  'retail', 'custom', 'readnfo', 'rerip',
];

/**
 * Tokens that mark a *file* as not-real-content.
 *
 * Deliberately narrow. Words like "dummy", "extras" and "recap" appear in
 * legitimate episode titles ("The.Batman.S01E09.The.Big.Dummy.mkv"), so they
 * are folder-only signals — see JUNK_FOLDERS. Undersized files are caught
 * separately by size-outlier detection, which does not depend on naming.
 */
const JUNK_PATTERNS = [
  /\bsample\b/i,
  /\btrailer\b/i,
  /\bfeaturette\b/i,
  /\bdeleted[\s._-]*scenes?\b/i,
  /\bbehind[\s._-]*the[\s._-]*scenes\b/i,
  /\bbloopers?\b/i,
];

/** Folder names that never contain primary content. */
const JUNK_FOLDERS = [
  /^samples?$/i,
  /^extras?$/i,
  /^featurettes?$/i,
  /^trailers?$/i,
  /^subs?$/i,
  /^subtitles?$/i,
  /^screens?$/i,
  /^proof$/i,
  /^artwork$/i,
  /^covers?$/i,
  /^\.@__thumb$/i,
  /^bdmv$/i,
  /^certificate$/i,
];

const CURRENT_YEAR = 2026;
const EARLIEST_YEAR = 1900;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Levenshtein distance, used for typo-tolerant matching ("SEAOSN" -> "SEASON"). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

export function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Turn scene punctuation into plain spaces so a single set of patterns can
 * handle `Foo.Bar.S01E01`, `Foo_Bar_1x01`, and `Foo Bar - 101`.
 */
export function normalizeSeparators(input) {
  return input
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens that are only release metadata in context. "Max" is a streaming
 * service but also half of "Mad Max"; "Complete" and "Multi" show up in real
 * titles. These are stripped only once an unambiguous release token has
 * already been removed from the same string.
 */
const AMBIGUOUS_TOKENS = new Set([
  'max', 'dv', 'dc', 'dd', 'ma', 'web', 'bd', 'br', 'dvd', 'multi', 'complete',
  'sub', 'subs', 'dual', 'custom', 'retail', 'limited', 'internal', 'extended',
]);

/** Content inside brackets/parens that marks the whole group as release noise. */
const RELEASE_HINT_RE =
  /\d{3,4}[pi]\b|web[\s.-]?dl|web[\s.-]?rip|blu[\s.-]?ray|remux|[xh][\s.-]?26[45]|hevc|avc|dts|dd\+?p?\d|aac|atmos|hdr|10\s?bit|dsnp|amzn|hmax/i;

/**
 * Unambiguous release patterns, removed wherever they appear. Written as
 * patterns rather than word lists because scene naming mangles separators
 * ("DTS-HD MA 5 1", "DD+2 0", "H 264", "AAC2 0").
 */
const RELEASE_PATTERNS = [
  /\b\d{3,4}[pi]\b/gi,                                          // 1080p, 1080i
  /\bweb[\s.-]?dl\b/gi,
  /\bweb[\s.-]?rip\b/gi,
  /\bblu[\s.-]?ray\b/gi,
  /\b(?:bd|br|hd|dvd|hdtv)[\s.-]?rip\b/gi,
  /\b(?:remux|hdtv|dvdscr|webdl|brrip)\b/gi,
  /\b[xh][\s.-]?26[45]\b/gi,                                    // x264, h 265, H.264
  /\b(?:hevc|avc|vc[\s.-]?1|xvid|divx)\b/gi,
  /\b\d{1,2}\s?bit\b/gi,                                        // 10bit, 10 bit
  // Audio: codec plus optional channel layout ("DTS-HD MA 5 1", "AAC2 0", "DD+2 0")
  /\b(?:dts(?:[\s.-]?hd)?(?:[\s.-]?ma)?|true[\s.-]?hd|dd\+?p?\+?|eac3|ac3|aac|flac|atmos|opus)(?:[\s.+-]*\d(?:[\s.]?\d)?)?\b/gi,
  /\b(?:2\s?audio|6ch|2ch|5\s?1|7\s?1)\b/gi,
  /\b(?:hdr10\+?|hdr|dolby[\s.-]?vision|hlg|sdr|imax)\b/gi,
  /\b(?:nf|amzn|dsnp|hmax|hulu|atvp|pcok|stan|crav|netflix|amazon|disney)\b/gi,
  /\b(?:proper|repack|readnfo|rerip|uncut|unrated|remastered|theatrical)\b/gi,
];

/**
 * Remove bracketed noise: [vpc] and {C_P} always, parenthesised groups only
 * when their contents look like release metadata (so "(Final Cut)" survives).
 */
function stripBracketed(input) {
  return input
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (whole, inner) => (RELEASE_HINT_RE.test(inner) ? ' ' : whole))
    .replace(/\s+/g, ' ')
    .trim();
}

export function isJunkName(name) {
  return JUNK_PATTERNS.some((re) => re.test(name));
}

export function isJunkFolder(name) {
  return JUNK_FOLDERS.some((re) => re.test(name.trim())) || isJunkName(name);
}

// ---------------------------------------------------------------------------
// Year
// ---------------------------------------------------------------------------

/**
 * Find a release year and where it sits in the string. Prefers a parenthesised
 * year, then the last plausible bare year (last, because titles such as
 * "Blade Runner 2049" put a decoy number at the front).
 */
export function findYear(normalized) {
  const paren = [...normalized.matchAll(/\((\d{4})\)/g)];
  for (const m of paren.reverse()) {
    const year = Number(m[1]);
    if (year >= EARLIEST_YEAR && year <= CURRENT_YEAR + 2) {
      return { year, index: m.index, length: m[0].length };
    }
  }

  // A year has to stand as its own word. Without that, the release group in
  // "All Star Superman 2011 REPACK ... x265-edge2020" supplied the year: 2020
  // was read as the release date, everything before it became the title, and
  // the film went unmatched and unillustrated.
  const bare = [...normalized.matchAll(/(?<![A-Za-z0-9])(\d{4})(?![0-9])/g)];
  for (const m of bare.reverse()) {
    const year = Number(m[1]);
    // A year at index 0 is almost always part of the title ("1917", "2012").
    if (year >= 1920 && year <= CURRENT_YEAR + 2 && m.index > 0) {
      return { year, index: m.index, length: m[0].length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Season / episode
// ---------------------------------------------------------------------------

/**
 * Episode-marker patterns, most specific first. Each returns
 * { season, episode, episodeEnd, index, length }.
 *
 * `index` is where the marker begins, so callers can treat everything before it
 * as the series title and everything after as the episode title.
 */
const EPISODE_MATCHERS = [
  // S01E01E02 / S01E01-E02 / S01E01
  {
    name: 'SxxExx',
    re: /\bS(\d{1,2})\s?E(\d{1,3})(?:\s?[-–]\s?E?(\d{1,3})|\s?E(\d{1,3}))?\b/i,
    build: (m) => ({
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: m[3] ? Number(m[3]) : m[4] ? Number(m[4]) : null,
    }),
  },
  // 1x01 / 01x01
  {
    name: 'NxNN',
    re: /\b(\d{1,2})x(\d{2,3})\b/i,
    build: (m) => ({ season: Number(m[1]), episode: Number(m[2]), episodeEnd: null }),
  },
  // Season 1 Episode 2
  {
    name: 'verbose',
    re: /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/i,
    build: (m) => ({ season: Number(m[1]), episode: Number(m[2]), episodeEnd: null }),
  },
  // " - 101 & 102 - " (combined season+episode, two episodes in one file)
  {
    name: 'combined-range',
    re: /\s[-–]\s(\d)(\d{2})\s*(?:&|and|\+)\s*(\d)(\d{2})\s[-–]\s/i,
    build: (m) => ({
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: Number(m[4]),
    }),
  },
  // " - 103 - " (combined season+episode)
  {
    name: 'combined',
    re: /\s[-–]\s(\d)(\d{2})\s[-–]\s/,
    build: (m) => ({ season: Number(m[1]), episode: Number(m[2]), episodeEnd: null }),
  },
  // Bare E01 — season must come from the containing folder.
  {
    name: 'bare-episode',
    re: /\bE(?:p(?:isode)?)?\s?(\d{1,3})\b/i,
    build: (m) => ({ season: null, episode: Number(m[1]), episodeEnd: null }),
  },
];

/**
 * Parse season/episode out of a filename.
 * @returns {null | {season: number|null, episode: number, episodeEnd: number|null,
 *                   pattern: string, index: number, length: number}}
 */
export function parseEpisodeMarker(rawName) {
  const normalized = normalizeSeparators(stripExtension(rawName));
  for (const matcher of EPISODE_MATCHERS) {
    const m = normalized.match(matcher.re);
    if (!m) continue;
    const parsed = matcher.build(m);
    if (parsed.episode === null || Number.isNaN(parsed.episode)) continue;
    return {
      ...parsed,
      pattern: matcher.name,
      index: m.index,
      length: m[0].length,
      normalized,
    };
  }
  return null;
}

/**
 * Read a season number from a folder name. Tolerates misspellings such as
 * "SEAOSN 1" via edit distance, and handles "S01", "Season 1-5", "Season 1 [vpc]".
 */
export function parseSeasonFolder(folderName) {
  const normalized = stripBracketed(normalizeSeparators(folderName));

  // "S01-S03" / "Season 1-5" describe a *range* — not a single season folder.
  if (/\bS\d{1,2}\s?[-–]\s?S?\d{1,2}\b/i.test(normalized)) return null;
  if (/\bseason\s*\d{1,2}\s?[-–]\s?\d{1,2}\b/i.test(normalized)) return null;

  const words = normalized.split(' ');
  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    // Typo-tolerant "season" (SEASON, SEAOSN, SESON, SAESON...)
    if (word.length >= 5 && word.length <= 8 && levenshtein(word, 'season') <= 2) {
      const next = words[i + 1];
      if (next && /^\d{1,2}$/.test(next)) return Number(next);
    }
    // Attached form: "Season1"
    const attached = word.match(/^([a-z]{5,8})(\d{1,2})$/);
    if (attached && levenshtein(attached[1], 'season') <= 2) return Number(attached[2]);
  }

  // "S01" style, anywhere in the name.
  const short = normalized.match(/\bS(\d{1,2})\b/i);
  if (short) return Number(short[1]);

  // A folder literally named "1" / "01" inside a show directory.
  if (/^\d{1,2}$/.test(normalized)) return Number(normalized);

  return null;
}

/** Detect "S01-S03" / "Season 1-5" spanning folders. Returns [from, to] or null. */
export function parseSeasonRange(folderName) {
  const normalized = normalizeSeparators(folderName);
  const dashed = normalized.match(/\bS(\d{1,2})\s?[-–]\s?S?(\d{1,2})\b/i);
  if (dashed) return [Number(dashed[1]), Number(dashed[2])];
  const verbose = normalized.match(/\bseasons?\s*(\d{1,2})\s?[-–]\s?(\d{1,2})\b/i);
  if (verbose) return [Number(verbose[1]), Number(verbose[2])];
  // "S01+S02"
  const plus = normalized.match(/\bS(\d{1,2})\s?\+\s?S?(\d{1,2})\b/i);
  if (plus) return [Number(plus[1]), Number(plus[2])];
  // "All Seasons 1 2 3 4 5"
  const listed = normalized.match(/\bseasons?\s+((?:\d{1,2}\s+){2,}\d{1,2})\b/i);
  if (listed) {
    const nums = listed[1].split(/\s+/).map(Number);
    return [Math.min(...nums), Math.max(...nums)];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title cleanup
// ---------------------------------------------------------------------------

/**
 * Strip release tokens and a trailing -GROUP suffix from a candidate title.
 * Works right-to-left: once a token is rejected we stop, because real title
 * words can coincide with tokens ("Max", "Dune: Part Two").
 */
/** Compact forms ("web dl" -> "webdl") so separator mangling can't hide a token. */
const COMPACT_TOKENS = new Set(RELEASE_TOKENS.map((t) => t.replace(/[^a-z0-9]/g, '')));

/**
 * Strip release metadata from a candidate title.
 *
 * Runs in three passes: bracketed noise, unambiguous patterns anywhere in the
 * string, then a right-to-left sweep of leftover tokens. The right-to-left
 * sweep stops at the first word it does not recognise, because real title words
 * can coincide with tokens.
 *
 * @param {string} input
 * @param {{allowEmpty?: boolean}} [options] `allowEmpty` permits stripping the
 *   string down to nothing, which is correct for episode titles (many releases
 *   genuinely have none) but not for series/movie titles.
 */
export function stripReleaseTokens(input, { allowEmpty = false } = {}) {
  let text = stripBracketed(input);

  let strippedUnambiguous = false;
  for (const pattern of RELEASE_PATTERNS) {
    const replaced = text.replace(pattern, ' ');
    if (replaced !== text) strippedUnambiguous = true;
    text = replaced;
  }
  text = text.replace(/\s+/g, ' ').trim();

  // Trailing release-group suffix: "-FLUX", "-iT00NZ", "-CtrlSD", "-LAMA"
  text = text.replace(/\s?[-–]\s?[A-Za-z0-9]{2,12}$/g, (match) => {
    const group = match.replace(/^[\s\-–]+/, '');
    // Keep genuine trailing words.
    if (/^(part|the|and|of|a|an|one|two|three|four|five|jr|sr|ii|iii|iv)$/i.test(group)) return match;
    // Release groups are mixed-case, contain digits, or are all-caps.
    if (/[A-Z]/.test(group) && /[a-z0-9]/.test(group)) { strippedUnambiguous = true; return ''; }
    if (/\d/.test(group)) { strippedUnambiguous = true; return ''; }
    if (group === group.toUpperCase() && group.length >= 2) { strippedUnambiguous = true; return ''; }
    return match;
  });

  let words = text.split(' ').filter(Boolean);
  const floor = allowEmpty ? 0 : 1;

  const isToken = (word) => {
    const compact = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!compact) return true; // stray punctuation
    if (/^\d{3,4}[pi]$/.test(compact)) return true;
    if (AMBIGUOUS_TOKENS.has(compact)) return strippedUnambiguous;
    return COMPACT_TOKENS.has(compact);
  };

  while (words.length > floor) {
    const lastTwo = words.slice(-2).join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
    if (words.length - 2 >= floor && COMPACT_TOKENS.has(lastTwo)) {
      words = words.slice(0, -2);
      strippedUnambiguous = true;
      continue;
    }
    if (isToken(words[words.length - 1])) {
      words = words.slice(0, -1);
      continue;
    }
    break;
  }

  return words.join(' ').replace(/[\s\-–_.,]+$/, '').replace(/^[\s\-–_.,]+/, '').trim();
}

/**
 * Parse a movie-ish name (folder or file) into { title, year }.
 */
export function parseTitle(rawName, { isFile = false } = {}) {
  let text = normalizeSeparators(isFile ? stripExtension(rawName) : rawName);

  const year = findYear(text);
  if (year) {
    // Everything before the year is the title; the tail is release metadata.
    text = text.slice(0, year.index);
  }

  const title = stripReleaseTokens(text);
  return {
    title: title || normalizeSeparators(stripExtension(rawName)),
    year: year ? year.year : null,
  };
}

/**
 * Last-resort episode parsing for names carrying a bare combined number with no
 * delimiters at all: "X-Men TAS 201 'Til Death Do Us Part 1of2.avi".
 *
 * A bare three-digit run is far too weak a signal on its own — "H 264" and
 * "720" would both match. It is only trusted when the leading digit agrees with
 * the season the containing folder already told us to expect, which makes a
 * false positive require a coincidence in two independent places.
 *
 * @param {string} rawName
 * @param {number} expectedSeason Season derived from the folder chain.
 */
export function parseContextualEpisodeMarker(rawName, expectedSeason) {
  const normalized = normalizeSeparators(stripExtension(rawName));
  // Bracketed release tags are dropped first so "[dummy]" and friends cannot
  // contribute digits.
  const searchable = stripBracketed(normalized);

  for (const match of searchable.matchAll(/\b(\d)(\d{2})\b/g)) {
    if (Number(match[1]) !== expectedSeason) continue;
    const episode = Number(match[2]);
    if (episode < 1 || episode > 99) continue;
    return {
      season: expectedSeason,
      episode,
      episodeEnd: null,
      pattern: 'contextual-combined',
      index: match.index,
      length: match[0].length,
      normalized: searchable,
    };
  }
  return null;
}

/**
 * Parse an episode file into series title, season, episode and episode title.
 * `fallbackSeason` supplies the season when the filename only carries "E01",
 * and additionally unlocks the contextual bare-number parse above.
 */
export function parseEpisodeFile(rawName, { fallbackSeason = null } = {}) {
  const marker =
    parseEpisodeMarker(rawName) ??
    (fallbackSeason !== null ? parseContextualEpisodeMarker(rawName, fallbackSeason) : null);
  if (!marker) return null;

  const before = marker.normalized.slice(0, marker.index);
  const after = marker.normalized.slice(marker.index + marker.length);

  const seriesRaw = parseTitle(before);
  const episodeTitle = stripReleaseTokens(after, { allowEmpty: true })
    .replace(/^[\s\-–]+/, '')
    .replace(/\s*\(\d+\)\s*$/, '') // trailing "(1)" part markers
    .trim();

  return {
    seriesTitle: seriesRaw.title,
    seriesYear: seriesRaw.year,
    season: marker.season ?? fallbackSeason,
    episode: marker.episode,
    episodeEnd: marker.episodeEnd,
    episodeTitle: episodeTitle || null,
    pattern: marker.pattern,
  };
}

/**
 * A normalised key for grouping folders that describe the same series.
 * Drops punctuation, articles, and year suffixes so "Ben 10 2005 S01" and
 * "Ben 10 S04" collapse together.
 */
export function seriesKey(title) {
  return normalizeSeparators(title)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate an episode title parsed from a filename.
 *
 * Used only when the metadata provider had no title of its own. Scene names
 * frequently leave behind fragments that are not titles at all — "HD",
 * "BR vk007", a bare release group — and showing those is worse than showing
 * nothing, because the UI can fall back to "Episode 4".
 *
 * @returns {string|null} A presentable title, or null if it is not one.
 */
export function cleanEpisodeTitle(raw) {
  if (!raw) return null;

  let text = stripReleaseTokens(String(raw), { allowEmpty: true })
    .replace(/^[\s\-–_.,]+/, '')
    .replace(/[\s\-–_.,]+$/, '')
    .trim();

  if (text.length < 3) return null;
  if (/^(hd|sd|uhd|fhd|web|raw|part|pt)$/i.test(text)) return null;

  const words = text.split(/\s+/);

  // Every word looks like an abbreviation, a numbered tag, or a release group.
  const allJunk = words.every((word) => (
    /^[A-Za-z]{1,3}$/.test(word)
    || /\d{2,}/.test(word)
    || /^[A-Z0-9]{4,}$/.test(word)
  ));
  if (allJunk) return null;

  // A real title contains at least one pronounceable word.
  if (!words.some((word) => /[aeiou]/i.test(word) && word.length >= 3)) return null;

  return text;
}
