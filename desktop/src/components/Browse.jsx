import React, { useMemo, useState } from 'react';
import Card from './Card.jsx';
import Row from './Row.jsx';

/**
 * Browse screen for Movies or TV Shows.
 *
 * Defaults to grouping by genre, which is how a large library actually gets
 * navigated. A local filter box and genre chips narrow it down, and either
 * switches the layout to a flat grid, because once a set is small a grid shows
 * more of it at once than a row does.
 */
export function Browse({ title, items, onSelect, renderLabel }) {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState(null);
  const [flat, setFlat] = useState(false);

  const trimmed = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    let result = items;
    if (genre) result = result.filter((item) => item.genres?.includes(genre));
    if (trimmed) result = result.filter((item) => item.title.toLowerCase().includes(trimmed));
    return result;
  }, [items, genre, trimmed]);

  /** Genres present in this collection, most populous first. */
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

  const ungrouped = useMemo(
    () => filtered.filter((item) => !item.genres?.length),
    [filtered],
  );

  // A flat grid is the right layout when the set is already narrow.
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
      </div>

      <div className="browse-controls">
        <div className="search-box browse-search">
          <span style={{ opacity: 0.5 }}>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={'Search ' + title.toLowerCase()}
            spellCheck={false}
          />
          {query && (
            <button className="clear-btn" onClick={() => setQuery('')} aria-label="Clear">×</button>
          )}
        </div>

        <button
          className={flat ? 'chip active' : 'chip'}
          onClick={() => { setFlat(!flat); setGenre(null); }}
        >
          {flat ? 'Grouped by genre' : 'Show all A–Z'}
        </button>
      </div>

      <div className="genre-chips">
        <button
          className={genre === null ? 'chip active' : 'chip'}
          onClick={() => setGenre(null)}
        >
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
              <Card
                key={item.id}
                item={item}
                onClick={() => onSelect(item)}
                label={renderLabel(item)}
              />
            ))}
        </div>
      )}

      {!showGrid && filtered.length > 0 && (
        <div className="rows">
          {genres.map((entry) => {
            const inGenre = filtered.filter((item) => item.genres?.includes(entry.name));
            if (inGenre.length === 0) return null;
            return (
              <Row
                key={entry.name}
                title={entry.name}
                items={inGenre}
                onSelect={onSelect}
                renderLabel={renderLabel}
              />
            );
          })}

          {ungrouped.length > 0 && (
            <Row
              title="Uncategorised"
              items={ungrouped}
              onSelect={onSelect}
              renderLabel={renderLabel}
            />
          )}
        </div>
      )}
    </>
  );
}

export default Browse;
