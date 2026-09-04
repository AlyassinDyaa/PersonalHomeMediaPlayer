/**
 * Arranging a library under genre headings.
 *
 * Shared between the Movies and TV Shows screens and the home page, so the two
 * cannot drift into disagreeing about where a title belongs.
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
 * One shelf per title: the genre that says most about it here.
 *
 * Two other arrangements were tried and both were wrong. Filing by TMDB's
 * *first* genre put X-Men alone under Kids and left nothing under Sci-Fi &
 * Fantasy, because that order means nothing. Listing a title under every genre
 * it carries produced three consecutive identical rows — Action, Adventure and
 * Animation, the same nineteen cartoons each time — because in a library like
 * this those three travel together.
 *
 * So each title is filed under its *rarest* genre in the set being arranged:
 * the one that distinguishes it from everything else on the shelf. Where
 * everything is Action, being Action says nothing, and being a Comedy or a
 * Mystery says a great deal. The arrangement tunes itself to whatever the
 * library holds, and nothing appears twice.
 *
 * @param {Array} items
 * @returns {Array<{name: string, entries: Array}>} Largest shelf first.
 */
export function shelveByGenre(items) {
  const frequency = genreFrequency(items);
  const buckets = new Map();

  for (const item of items) {
    const names = item.genres?.length ? item.genres : ['Other'];
    const shelf = [...names].sort((a, b) => (
      (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0)
      // Alphabetical only to break ties, so the arrangement never depends on
      // the order TMDB happened to return.
      || a.localeCompare(b)
    ))[0];
    if (!buckets.has(shelf)) buckets.set(shelf, []);
    buckets.get(shelf).push(item);
  }

  return [...buckets.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
}
