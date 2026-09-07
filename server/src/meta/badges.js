/**
 * A mark for every shelf, without anybody having to go and find one.
 *
 * A shelf called DC or MARVEL is named after something with a logo everybody
 * already recognises, and a wall of shelves showing only their names is a wall
 * of text where it could be a row of marks. The badge could always be chosen
 * by hand — that is what the search in the shelf's own sheet is for — but
 * nobody does it ten times, so the shelves stayed bare.
 *
 * Two sources, in order of how much they can be trusted.
 *
 * The studios and publishers the metadata provider knows about: "DC" is a
 * company and its logo is the DC logo, which is exactly right. But the search
 * will answer almost anything with something, so a name has to match closely
 * to be believed — "DC Movies" coming back as "BH Movies" is worse than no
 * badge at all, and that is a real answer it gave.
 *
 * A handful of shelves are named after a thing rather than after whoever makes
 * it — STAR WARS is not a company — so those are mapped to the studio that owns
 * them. Anything still unmatched gets no badge, and its tile shows the covers
 * of what is on it instead, which is honest where a borrowed wordmark is not.
 *
 * Never guesses twice at the same shelf, and never touches one somebody has
 * already given a badge to.
 */

import { getDb } from '../db.js';
import { tmdbGet } from './tmdb.js';

/** Reduce a name to the letters that carry it, for comparing. */
function plain(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Words that describe a shelf rather than name it.
 *
 * "DC Movies" is the DC shelf; "Marvel AU" is Marvel. Trimming these is what
 * lets both find the mark their parent name would, instead of matching some
 * unrelated company whose name happens to contain the same filler.
 */
const FILLER = new Set([
  'movies', 'films', 'film', 'shows', 'tv', 'series', 'collection', 'collections',
  'au', 'universe', 'animated', 'the', 'and', 'my',
]);

/*
 * Shelves named after a thing rather than after whoever makes it.
 *
 * "Star Wars" is not a company and the search knows nothing by that name, but
 * everybody knows the mark that belongs on that shelf. These are the handful
 * where the name people use and the name the provider files it under are
 * different — not a general solution, and not meant to be: anything not here
 * falls through to the ordinary search and then to no badge at all.
 */
const OWNED_BY = new Map(Object.entries({
  'star wars': 'Lucasfilm',
  'mcu': 'Marvel Studios',
  'marvel': 'Marvel Studios',
  'dcau': 'DC',
  'dceu': 'DC',
  'pixar': 'Pixar',
  'ghibli': 'Studio Ghibli',
  'studio ghibli': 'Studio Ghibli',
  'looney tunes': 'Warner Bros. Animation',
  'nickelodeon': 'Nickelodeon',
  'cartoon network': 'Cartoon Network',
  'disney': 'Walt Disney Pictures',
}));

function withoutFiller(name) {
  const words = plain(name).split(' ').filter((word) => word && !FILLER.has(word));
  return words.join(' ');
}

/**
 * How well a company's name answers to a shelf's.
 *
 * @returns {number} 0 for no, higher for better.
 */
function closeness(shelfName, companyName) {
  const shelf = plain(shelfName);
  const trimmed = withoutFiller(shelfName);
  const company = plain(companyName);
  if (!shelf || !company) return 0;

  if (company === shelf) return 100;
  if (trimmed && company === trimmed) return 90;
  // "Marvel Studios" for a shelf called Marvel: the shelf's name, then more.
  if (trimmed && company.startsWith(trimmed + ' ')) return 70;
  if (company.startsWith(shelf + ' ')) return 65;
  /*
   * A company whose name merely contains the shelf's is not a match.
   *
   * "GKIDS" contains "kids" and is not the Kids shelf; "BH Movies" contains
   * "movies". Every wrong answer this ever gave was of that shape, so the
   * containment case is refused outright rather than scored low.
   */
  return 0;
}

/** Below this, no badge is better than the badge on offer. */
const GOOD_ENOUGH = 65;

/** The best company logo for a name, or null when nothing is close enough. */
async function companyBadge(name) {
  const trimmed = withoutFiller(name);
  const alias = OWNED_BY.get(plain(name)) ?? OWNED_BY.get(trimmed);
  const tries = [...new Set([alias, name, trimmed].filter(Boolean))];

  let best = null;
  for (const query of tries) {
    let body;
    try {
      body = await tmdbGet('/search/company?query=' + encodeURIComponent(query));
    } catch {
      return null;   // Offline, or no key. Nothing to do and nothing to log.
    }
    for (const entry of body?.results ?? []) {
      if (!entry.logo_path) continue;
      /*
       * A name we supplied ourselves is already the answer, so it is not
       * scored against the shelf's name — "Lucasfilm" would score zero
       * against "Star Wars", which is the whole reason the table exists.
       *
       * Matched loosely at the front, because the provider files companies
       * under their legal names: asking for Lucasfilm gets "Lucasfilm Ltd.",
       * which an exact comparison threw away.
       */
      const named = query === alias
        && (plain(entry.name) === plain(alias)
          || plain(entry.name).startsWith(plain(alias) + ' '));
      const score = named ? 100 : closeness(name, entry.name);
      if (score >= GOOD_ENOUGH && (!best || score > best.score)) {
        best = { score, logo: entry.logo_path, name: entry.name };
      }
    }
    if (best?.score >= 90) break;   // Nothing later can beat an exact match.
  }
  return best;
}

/**
 * Give a badge to every shelf that has not got one.
 *
 * @param {(message: string) => void} onLog
 * @returns {Promise<number>} how many were given one.
 */
export async function badgeCollections(onLog = () => {}) {
  const db = getDb();
  const bare = db.prepare(`
    SELECT id, name FROM collections
    WHERE (logo_path IS NULL OR logo_path = '') AND folder_path IS NULL
  `).all();
  if (!bare.length) return 0;

  const save = db.prepare('UPDATE collections SET logo_path = ? WHERE id = ?');
  let given = 0;

  for (const shelf of bare) {
    /*
     * A company's mark, or none at all.
     *
     * Borrowing the wordmark of one title on the shelf was tried and is worse
     * than nothing: a shelf called Sitcoms wearing the King of Queens logo
     * reads as though the shelf *is* King of Queens. With no badge the tile
     * shows the covers of what is on it, which says "these are sitcoms"
     * honestly and without claiming to be one of them.
     */
    const company = await companyBadge(shelf.name);
    if (!company) {
      onLog('no company mark for "' + shelf.name + '", so its covers will do');
      continue;
    }
    save.run(company.logo, shelf.id);
    given += 1;
    onLog('"' + shelf.name + '" now wears ' + company.name);
  }

  return given;
}
