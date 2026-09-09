import React, { useEffect, useMemo, useState } from 'react';
import Card from './Card.jsx';
import Row from './Row.jsx';
import { artwork } from '../api.js';
import {
  useShelfView, ShelfViewToggle, ShelfTile, ShelfLine,
  useShelfOrder, ShelfOrderPicker, sortShelves,
} from './ShelfView.jsx';
import { shelveByGenre } from '../genres.js';

/**
 * Browse screen for Movies or TV Shows.
 *
 * Searching is handled by the single search box in the header, which scopes
 * itself to whichever tab is open, so this screen deliberately has no search
 * field of its own.
 */
export function Browse({
  title, items, onSelect, renderLabel, query = '', groupByGenre = true,
  /*
   * Everything on this screen, shelved or not.
   *
   * `items` is what is left once the shelves have taken theirs, which is the
   * right thing to draw underneath them and the wrong thing to search. A title
   * filed onto the DC shelf is still in the library, and somebody typing its
   * name is asking the library, not the leftovers. Given this, a search reads
   * from it instead.
   */
  everything = null,
  /* Shown beside the title when this screen was opened from somewhere. */
  onBack = null,
  /* The owner's own shelves that belong on this screen, above everything. */
  shelves = [],
  /* While gathering titles for a shelf: what is ticked, and how to tick. */
  picking = false,
  ticked = null,
  onTick = null,
  /* Opening one shelf on its own, as a page rather than a rail. */
  onOpenShelf = null,
  /* Which layouts the owner has left switched on. */
  shelfLayouts = null,
}) {
  const [genre, setGenre] = useState(null);
  /* Rails, tiles or lines — remembered, and shared with the other screens. */
  const [shelfView, chooseShelfView, shelfLayoutsOffered] = useShelfView(shelfLayouts);
  const [shelfOrder, chooseShelfOrder] = useShelfOrder();

  /*
   * The shelves in whichever order was asked for.
   *
   * Sorted once here rather than in each of the three layouts below, so the
   * rails, the tiles and the lines cannot drift apart — the order is a
   * property of the screen, not of how it happens to be drawn.
   */
  const ordered = useMemo(() => sortShelves(shelves, shelfOrder), [shelves, shelfOrder]);
  /*
   * Shelves unfolded into a grid where they stand.
   *
   * Per shelf rather than a mode for the screen: somebody wants everything on
   * one shelf and a rail for the rest, which is the whole reason for asking.
   */
  const [stacked, setStacked] = useState(() => new Set());
  const unfold = (id) => setStacked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
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

  /* Searching asks the whole screen; browsing asks what the shelves left. */
  const pool = trimmed && everything ? everything : items;

  const filtered = useMemo(() => {
    let result = pool;
    if (genre) result = result.filter((item) => item.genres?.includes(genre));
    if (trimmed) result = result.filter((item) => item.title.toLowerCase().includes(trimmed));
    // A library of whole seasons is mostly things already seen, so "what is
    // left" is a more useful question here than any ordering of everything.
    if (unwatchedOnly) result = result.filter((item) => (item.unwatchedCount ?? 0) > 0);
    return result;
  }, [pool, genre, trimmed, unwatchedOnly]);

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

  /**
   * One row per title, filed under the genre that says most about it.
   *
   * The home page arranges its genre rails the same way, from the same
   * helper, so a title cannot sit under Action here and Adventure there.
   *
   * The chips above still count every genre a title has, and clicking one
   * shows all of them, so nothing is hidden by the arrangement.
   */
  const rows = useMemo(() => shelveByGenre(sorted), [sorted]);

  /** Every genre present, for the filter chips. */
  const genres = useMemo(() => {
    const counts = new Map();
    for (const item of pool) {
      for (const name of item.genres ?? []) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [pool]);

  // A flat grid suits an already-narrow set better than a row does.
  const showGrid = flat || Boolean(trimmed) || Boolean(genre);

  return (
    <>
      <div className="page-header">
        {onBack && (
          <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1 className="page-title">{title}</h1>
        <span className="page-sub">
          {filtered.length === pool.length
            ? pool.length + ' titles'
            : filtered.length + ' of ' + pool.length + ' titles'}
        </span>
        {trimmed && <span className="page-sub">matching “{query.trim()}”</span>}
      </div>

      {/*
        * The shelves somebody arranged, before anything the library worked out.
        *
        * They sit above the genre controls rather than below the grid, because
        * a shelf is the answer to "what do we have" and the grid is the answer
        * to "show me everything" — and the first question is the one people
        * arrive with. Hidden while searching or filtering, when the screen is
        * answering a narrower question than the shelves can.
        */}
      {shelves.length > 0 && !trimmed && !genre && !unwatchedOnly && (
        <div className="browse-shelves">
          {/*
            * Which layout, offered only where there is enough to lay out.
            * With one shelf the three buttons are furniture around a single
            * rail, and the question is not worth asking.
            */}
          {shelves.length > 1 && !picking && (
            <div className="browse-shelves-head">
              <span className="browse-shelves-label">Collections</span>
              <div className="browse-shelves-tools">
                <ShelfOrderPicker order={shelfOrder} onChoose={chooseShelfOrder} />
                <ShelfViewToggle
                  view={shelfView}
                  onChoose={chooseShelfView}
                  offered={shelfLayoutsOffered}
                />
              </div>
            </div>
          )}

          {/*
            * Rails while picking, whatever was chosen.
            *
            * Gathering titles for a shelf means ticking covers, and a tile or
            * a line has no covers to tick — the choice would silently take the
            * ability to do the thing being done.
            */}
          {(shelfView === 'rows' || picking) && ordered.map((shelf) => (
            stacked.has(shelf.id) && !picking ? (
              <section className="row shelf-stack" key={shelf.id}>
                <div className="row-header">
                  <h2 className="row-title">{shelf.name}</h2>
                  <span className="row-count">{(shelf.items ?? []).length}</span>
                  <div className="row-actions">
                    <button className="chip" onClick={() => unfold(shelf.id)}>Show less</button>
                    {onOpenShelf && (
                      <button className="chip" onClick={() => onOpenShelf(shelf)}>Open</button>
                    )}
                  </div>
                </div>
                <div className="grid">
                  {(shelf.items ?? []).map((entry) => {
                    const item = entry.item ?? entry;
                    return (
                      <Card
                        key={item.id}
                        item={item}
                        label={renderLabel ? renderLabel(entry) : null}
                        onClick={(event) => onSelect(entry, event)}
                      />
                    );
                  })}
                </div>
              </section>
            ) : (
              <Row
                key={shelf.id}
                title={shelf.name}
                items={shelf.items}
                picking={picking}
                ticked={ticked}
                onSelect={picking ? ((entry) => onTick?.((entry.item ?? entry).id)) : onSelect}
                onStack={picking ? null : () => unfold(shelf.id)}
                onSeeAll={onOpenShelf ? () => onOpenShelf(shelf) : null}
                renderLabel={renderLabel}
              />
            )
          ))}

          {shelfView === 'grid' && !picking && (
            <div className="shelf-grid">
              {ordered.map((shelf) => (
                <ShelfTile
                  key={shelf.id}
                  name={shelf.name}
                  count={(shelf.items ?? []).length}
                  badge={shelf.logo ? artwork(shelf.logo, 'w300') : null}
                  covers={(shelf.items ?? [])
                    .map((entry) => artwork((entry.item ?? entry).poster, 'w200'))
                    .filter(Boolean)}
                  onOpen={() => onOpenShelf?.(shelf)}
                />
              ))}
            </div>
          )}

          {shelfView === 'list' && !picking && (
            <div className="shelf-lines">
              {ordered.map((shelf) => (
                <ShelfLine
                  key={shelf.id}
                  name={shelf.name}
                  count={(shelf.items ?? []).length}
                  badge={shelf.logo ? artwork(shelf.logo, 'w300') : null}
                  onOpen={() => onOpenShelf?.(shelf)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        * The same choice twice, for two widths.
        *
        * A dozen genres as chips is a glance on a monitor and a wall of
        * wrapped buttons on a phone, where they pushed the titles themselves
        * below the fold. The stylesheet shows whichever suits the width; both
        * read and write the same state, so switching between them mid-session
        * keeps whatever was chosen.
        */}
      <div className="genre-picker">
        <label className="chip-select">
          Genre
          <select
            value={genre ?? ''}
            onChange={(event) => setGenre(event.target.value || null)}
          >
            <option value="">All genres</option>
            {genres.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} ({entry.count})
              </option>
            ))}
          </select>
        </label>
        <button
          className={unwatchedOnly ? 'chip active' : 'chip'}
          onClick={() => setUnwatchedOnly(!unwatchedOnly)}
        >
          Unwatched
        </button>
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
              <Card
                key={item.id}
                item={item}
                picking={picking}
                ticked={Boolean(ticked?.has(item.id))}
                onClick={() => (picking ? onTick?.(item.id) : onSelect(item))}
                label={renderLabel(item)}
              />
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
              picking={picking}
              ticked={ticked}
              onSelect={picking ? ((entry) => onTick?.((entry.item ?? entry).id)) : onSelect}
              renderLabel={renderLabel}
            />
          ))}
        </div>
      )}
    </>
  );
}

export default Browse;
