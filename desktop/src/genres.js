/**
 * Arranging a library under genre headings.
 *
 * Shared between the Movies and TV Shows screens and the home page, so the two
 * cannot drift into disagreeing about where a title belongs.
 *
 * These headings only ever hold what is not on a shelf of your own. A
 * collection takes its titles out of the list underneath it, so the genres are
 * the arrangement for everything nobody has filed by hand — which is the only
 * place an automatic arrangement is worth having.
 */

/** Below this, a genre is not a shelf — it is a heading over one film. */
const MIN_SHELF = 3;

/** Where everything that would otherwise stand alone ends up. */
export const CATCH_ALL = 'More';

/** How many titles in a set carry each genre. */
export function genreFrequency(items) {
  const counts = new Map();
  for (const item of items) {
    for (const name of item.genres ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * One shelf per title, and no shelf holding almost nothing.
 *
 * Three arrangements were tried before this one and each failed differently,
 * which is worth recording because each sounded right first.
 *
 * Listing a title under every genre it carries gave three consecutive
 * identical rows — Action, Adventure and Animation, the same cartoons each
 * time — because in a library like this those travel together.
 *
 * Filing under the *rarest* genre came next: where everything is Action,
 * being Action says nothing. It left thirteen Action series with no Action
 * shelf, and put Cowboy Bebop under Crime and Halo under Fantasy.
 *
 * Filing under the genre a title *leads* with fixed those, since that order
 * is the provider's own ranking — but a leading genre only one title carries
 * makes a heading over a single film. Bruce Almighty leads with Fantasy and
 * Eternal Sunshine with Science Fiction, and each got a shelf of its own,
 * under a word that describes neither.
 *
 * So: the leading genre where it gathers enough titles to be a shelf, and
 * otherwise the largest shelf that title also belongs to. Bruce Almighty is
 * Fantasy and Comedy, so it joins the comedies; Eternal Sunshine is Science
 * Fiction and Drama, so it joins the dramas; Cowboy Bebop and Halo are both
 * led by Science Fiction, so between them they make one. Whatever is left
 * over after that gathers under one last heading rather than several.
 *
 * @param {Array} items
 * @param {{minimum?: number}} [options]
 * @returns {Array<{name: string, entries: Array}>} Largest first, the
 *   leftovers last.
 */
export function shelveByGenre(items, { minimum = MIN_SHELF } = {}) {
  /* What each title leads with, and how big that would make each shelf. */
  const leads = new Map();
  const size = new Map();
  for (const item of items) {
    const lead = item.genres?.length ? item.genres[0] : CATCH_ALL;
    leads.set(item, lead);
    size.set(lead, (size.get(lead) ?? 0) + 1);
  }

  /*
   * A title whose leading genre gathers too few joins the biggest shelf it
   * also belongs to — measured against the same tentative sizes, so the
   * answer does not depend on the order titles are read in.
   */
  const buckets = new Map();
  const put = (name, item) => {
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(item);
  };

  for (const item of items) {
    const lead = leads.get(item);
    if ((size.get(lead) ?? 0) >= minimum) { put(lead, item); continue; }

    const next = (item.genres ?? [])
      .filter((name) => name !== lead)
      .sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || a.localeCompare(b))[0];

    put(next && (size.get(next) ?? 0) >= minimum ? next : lead, item);
  }

  /* Anything still too small to be worth a heading of its own. */
  const rest = [];
  for (const [name, entries] of [...buckets]) {
    if (name !== CATCH_ALL && entries.length < minimum) {
      rest.push(...entries);
      buckets.delete(name);
    }
  }
  for (const item of rest) put(CATCH_ALL, item);

  return [...buckets.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => {
      /* The leftovers sit at the end whatever their size: they are what is
         left rather than a category anybody was looking for. */
      if (a.name === CATCH_ALL) return 1;
      if (b.name === CATCH_ALL) return -1;
      return b.entries.length - a.entries.length || a.name.localeCompare(b.name);
    });
}
