import React, { useEffect, useMemo, useState } from 'react';
import Card from './Card.jsx';
import Row from './Row.jsx';

/**
 * Browse screen for Movies or TV Shows.
 *
 * Searching is handled by the single search box in the header, which scopes
 * itself to whichever tab is open, so this screen deliberately has no search
 * field of its own.
 */
export function Browse({
  title, items, onSelect, renderLabel, query = '', groupByGenre = true,
}) {
  const [genre, setGenre] = useState(null);
  /*
   * Starts from the preference in Settings, and can still be flipped here for
   * a moment without changing it — the chip is a glance, the setting is how
   * the screen normally looks.
   */
  const [flat, setFlat] = useState(!groupByGenre);
  const [sort, setSort] = useState('title');
  const [unwatchedOnly, setUnwatchedOnly] = useState(false);

  // Follow the preference when it is changed in Settings, and when moving
  // between the two screens, which have their own answers.
  useEffect(() => { setFlat(!groupByGenre); }, [groupByGenre]);

  const trimmed = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    let result = items;
    if (genre) result = result.filter((item) => item.genres?.includes(genre));
    if (trimmed) result = result.filter((item) => item.title.toLowerCase().includes(trimmed));
    // A library of whole seasons is mostly things already seen, so "what is
    // left" is a more useful question here than any ordering of everything.
    if (unwatchedOnly) result = result.filter((item) => (item.unwatchedCount ?? 0) > 0);
    return result;
  }, [items, genre, trimmed, unwatchedOnly]);

  /** Comparators for the sort control; the server can order too, but not without a round trip. */
  const sorted = useMemo(() => {
    const compare = {
      title: (a, b) => a.title.localeCompare(b.title),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title),
      rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.title.localeCompare(b.title),
      added: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.title.localeCompare(b.title),
    }[sort] ?? ((a, b) => a.title.localeCompare(b.title));
    return [...filtered].sort(compare);
  }, [filtered, sort]);

  /** How many titles in this tab carry each genre, for deciding which is rare. */
  const genreFrequency = useMemo(() => {
    const counts = new Map();
    for (const item of items) {
      for (const name of item.genres ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  /**
   * One row per title, filed under the genre that says most about it.
   *
   * Two arrangements were tried and both were wrong. Filing by TMDB's *first*
   * genre put X-Men alone under Kids and left nothing under Sci-Fi & Fantasy,
   * because that order means nothing. Listing a title under every genre it
   * carries made the counts honest but produced three consecutive identical
   * rows — Action, Adventure and Animation, the same nineteen cartoons each
   * time — because in a library like this those three travel together.
   *
   * So each title is filed under its *rarest* genre here: the one that
   * distinguishes it from everything else on the shelf. Where everything is
   * Action, being Action says nothing and being a Comedy or a Mystery says a
   * great deal. The arrangement tunes itself to whatever the library holds.
   *
   * The chips above still count every genre a title has, and clicking one
   * shows all of them, so nothing is hidden by the arrangement.
   */
  const rows = useMemo(() => {
    const buckets = new Map();
    for (const item of sorted) {
      const names = item.genres?.length ? item.genres : ['Other'];
      const shelf = [...names].sort((a, b) => (
        (genreFrequency.get(a) ?? 0) - (genreFrequency.get(b) ?? 0)
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
  }, [sorted, genreFrequency]);

  /** Every genre present, for the filter chips. */
  const genres = useMemo(() => {
    const counts = new Map();
    for (const item of items) {
      for (const name of item.genres ?? []) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [items]);

  // A flat grid suits an already-narrow set better than a row does.
  const showGrid = flat || Boolean(trimmed) || Boolean(genre);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <span className="page-sub">
          {filtered.length === items.length
            ? items.length + ' titles'
            : filtered.length + ' of ' + items.length + ' titles'}
        </span>
        {trimmed && <span className="page-sub">matching “{query.trim()}”</span>}
      </div>

      <div className="genre-chips">
        <button className={genre === null ? 'chip active' : 'chip'} onClick={() => setGenre(null)}>
          All
        </button>
        {genres.map((entry) => (
          <button
            key={entry.name}
            className={genre === entry.name ? 'chip active' : 'chip'}
            onClick={() => setGenre(genre === entry.name ? null : entry.name)}
          >
            {entry.name} <span className="chip-count">{entry.count}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          className={unwatchedOnly ? 'chip active' : 'chip'}
          onClick={() => setUnwatchedOnly(!unwatchedOnly)}
        >
          Unwatched
        </button>
        <label className="chip chip-select">
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="title">A–Z</option>
            <option value="year">Newest first</option>
            <option value="rating">Highest rated</option>
            <option value="added">Recently added</option>
          </select>
        </label>
        <button
          className={flat ? 'chip active' : 'chip'}
          onClick={() => { setFlat(!flat); setGenre(null); }}
        >
          {flat ? 'Grouped by genre' : 'Show all A–Z'}
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="center-note" style={{ height: 220 }}>
          <p>Nothing matches “{query.trim() || genre}”.</p>
        </div>
      )}

      {showGrid && sorted.length > 0 && (
        <div className="grid">
          {sorted
            .map((item) => (
              <Card key={item.id} item={item} onClick={() => onSelect(item)} label={renderLabel(item)} />
            ))}
        </div>
      )}

      {!showGrid && filtered.length > 0 && (
        <div className="rows">
          {rows.map((row) => (
            <Row
              key={row.name}
              title={row.name}
              items={row.entries}
              onSelect={onSelect}
              renderLabel={renderLabel}
            />
          ))}
        </div>
      )}
    </>
  );
}

export default Browse;
