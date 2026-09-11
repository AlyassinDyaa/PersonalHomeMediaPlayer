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

/** How many titles in a set carry each genre. */
export function genreFrequency(items) {
  const counts = new Map();
  for (const item of items) {
    for (const name of item.genres ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * One shelf per title: the genre it leads with.
 *
 * A title carries several genres in the order the metadata gives them, and
 * that order is a ranking — the first is what the thing mostly is. Cowboy
 * Bebop lists Science Fiction before Crime, Transformers leads with Action,
 * Arcane with Animation. Taking the first is taking the strongest theme, and
 * nothing is filed twice.
 *
 * Two other arrangements were tried here and both were worse.
 *
 * Listing a title under every genre it carries produced three consecutive
 * identical rows — Action, Adventure and Animation, the same cartoons each
 * time — because in a library like this those three travel together.
 *
 * Filing under the *rarest* genre in the set came next, on the reasoning that
 * where everything is Action, being Action says nothing. It reads well as an
 * argument and badly as a library: measured on this one it left thirteen
 * Action series with no Action shelf at all, put Cowboy Bebop under Crime,
 * Halo under Fantasy and Transformers under Family, and gave Drama a single
 * title out of the ten that carried it. Every heading was a surprise, which
 * is the opposite of what a heading is for.
 *
 * The cost of leading-genre is that a big genre stays big — a cartoon library
 * gets a large Animation shelf. That is the honest shape of such a library,
 * and a shelf of your own is the answer to wanting a different one.
 *
 * @param {Array} items
 * @returns {Array<{name: string, entries: Array}>} Largest shelf first.
 */
export function shelveByGenre(items) {
  const buckets = new Map();

  for (const item of items) {
    const shelf = item.genres?.length ? item.genres[0] : 'Other';
    if (!buckets.has(shelf)) buckets.set(shelf, []);
    buckets.get(shelf).push(item);
  }

  return [...buckets.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}
