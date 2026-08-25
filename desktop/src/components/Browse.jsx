import React, { useMemo, useState } from 'react';
import Card from './Card.jsx';
import Row from './Row.jsx';

/**
 * Browse screen for Movies or TV Shows.
 *
 * Searching is handled by the single search box in the header, which scopes
 * itself to whichever tab is open, so this screen deliberately has no search
 * field of its own.
 */
export function Browse({ title, items, onSelect, renderLabel, query = '' }) {
  const [genre, setGenre] = useState(null);
  const [flat, setFlat] = useState(false);

  const trimmed = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    let result = items;
    if (genre) result = result.filter((item) => item.genres?.includes(genre));
    if (trimmed) result = result.filter((item) => item.title.toLowerCase().includes(trimmed));
    return result;
  }, [items, genre, trimmed]);

  /**
   * Genre rows use only each title's *primary* genre.
   *
   * Listing a title under every genre it carries makes a modest library look
   * duplicated — the same eight posters repeat down the page, because most
   * things are tagged Animation and Sci-Fi and Action all at once. The chips
   * below still filter across every genre a title has.
   */
  const rows = useMemo(() => {
    const buckets = new Map();
    for (const item of filtered) {
      const primary = item.genres?.[0] ?? 'Other';
      if (!buckets.has(primary)) buckets.set(primary, []);
      buckets.get(primary).push(item);
    }
    return [...buckets.entries()]
      .map(([name, entries]) => ({ name, entries }))
      .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name));
  }, [filtered]);

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

      {showGrid && filtered.length > 0 && (
        <div className="grid">
          {[...filtered]
            .sort((a, b) => a.title.localeCompare(b.title))
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
