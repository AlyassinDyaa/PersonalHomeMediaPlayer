import React, { useCallback, useState } from 'react';

/**
 * How the shelves on a screen are laid out.
 *
 * One rail per shelf is right for three or four of them and wrong for a dozen:
 * the rails push everything else below the fold, and finding the shelf you
 * want becomes a scroll rather than a glance. But a grid of shelf covers is
 * wrong when there are only two, and a list is wrong whenever the artwork is
 * what you are recognising them by.
 *
 * None of those is the correct answer, so the choice belongs to whoever is
 * looking, and it is remembered — a household that thinks in shelves and one
 * that thinks in titles want opposite things every time they open the screen.
 *
 * The same three views on Films, TV Shows and Comics, because a person who has
 * decided how they like to see their shelves has not decided it once per tab.
 */

const REMEMBERED = 'shelfView';

/** The views, in the order they are offered, with what each is for. */
export const SHELF_VIEWS = [
  ['rows', 'Rows', 'One rail per collection, with the covers'],
  ['grid', 'Grid', 'Every collection as a tile'],
  ['list', 'List', 'One line each, for a long list'],
];

const KNOWN = new Set(SHELF_VIEWS.map(([id]) => id));

function remembered() {
  try {
    const stored = window.localStorage.getItem(REMEMBERED);
    return KNOWN.has(stored) ? stored : 'rows';
  } catch {
    // Private windows and locked-down profiles refuse storage outright.
    return 'rows';
  }
}

/**
 * The chosen layout, and a way to change it.
 *
 * Shared rather than per-screen so the choice carries across the tabs, which
 * is what somebody who has just made it expects.
 */
export function useShelfView(allowed = null) {
  const [view, setView] = useState(remembered);

  /*
   * A layout the owner has taken away is not one anybody can be left in.
   *
   * Somebody who chose tiles and then had tiles removed would otherwise be
   * stuck looking at a screen with no shelves on it and no button to bring
   * them back. Their choice is remembered either way, so putting the layout
   * back puts them where they were.
   */
  const offered = Array.isArray(allowed) && allowed.length
    ? SHELF_VIEWS.filter(([id]) => allowed.includes(id))
    : SHELF_VIEWS;
  const inUse = offered.some(([id]) => id === view) ? view : (offered[0]?.[0] ?? 'rows');

  const choose = useCallback((next) => {
    if (!KNOWN.has(next)) return;
    setView(next);
    try {
      window.localStorage.setItem(REMEMBERED, next);
    } catch {
      // Not remembering it is not worth interrupting anybody for.
    }
  }, []);

  return [inUse, choose, offered];
}

/** The three buttons, in the shape the episode layout already uses. */
export function ShelfViewToggle({ view, onChoose, offered = SHELF_VIEWS, label = 'Collection layout' }) {
  // One layout is not a choice, so it is not drawn as one.
  if (offered.length < 2) return null;

  return (
    <div className="view-toggle" role="group" aria-label={label}>
      {offered.map(([id, name, hint]) => (
        <button
          key={id}
          type="button"
          className={view === id ? 'view-btn active' : 'view-btn'}
          aria-pressed={view === id}
          title={hint}
          onClick={() => onChoose(id)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/**
 * A shelf as a tile, for the grid.
 *
 * The badge if it has one, and otherwise the first few covers on it laid over
 * each other — a shelf is recognised by what is on it, and a shelf of films
 * with no badge would otherwise be a grey square with a word in it.
 */
export function ShelfTile({ name, count, badge, covers = [], onOpen }) {
  return (
    <button type="button" className="shelf-tile" onClick={onOpen}>
      <span className="shelf-tile-art">
        {badge
          ? <img className="shelf-tile-badge" src={badge} alt="" loading="lazy" />
          : covers.slice(0, 3).map((cover, index) => (
            <img
              key={cover ?? index}
              className={'shelf-tile-cover at-' + index}
              src={cover}
              alt=""
              loading="lazy"
            />
          ))}
        {!badge && covers.length === 0 && (
          <span className="shelf-tile-letter">{(name ?? '?').charAt(0)}</span>
        )}
      </span>
      <span className="shelf-tile-name">{name}</span>
      <span className="shelf-tile-count">{count}</span>
    </button>
  );
}

/** A shelf as one line, for the list. */
export function ShelfLine({ name, count, badge, onOpen }) {
  return (
    <button type="button" className="shelf-line" onClick={onOpen}>
      {badge
        ? <img className="shelf-line-badge" src={badge} alt="" loading="lazy" />
        : <span className="shelf-line-badge blank" aria-hidden="true">{(name ?? '?').charAt(0)}</span>}
      <span className="shelf-line-name">{name}</span>
      <span className="shelf-line-count">{count}</span>
      <span className="shelf-line-more" aria-hidden="true">›</span>
    </button>
  );
}

export default useShelfView;

/* --------------------------------------------------------- their order --- */

/*
 * The ordering itself lives in a plain module so it can be tested without a
 * browser; only the control that draws it needs React.
 */
export {
  SHELF_ORDERS, SHELF_ORDERS_BY_NAME, sortShelves, sortShelfItems,
} from '../shelfOrder.js';

import { SHELF_ORDERS, SHELF_ORDERS_KNOWN } from '../shelfOrder.js';

const REMEMBERED_ORDER = 'shelfOrder';

function rememberedOrder() {
  try {
    const stored = window.localStorage.getItem(REMEMBERED_ORDER);
    return SHELF_ORDERS_KNOWN.has(stored) ? stored : 'arranged';
  } catch {
    // Private windows and locked-down profiles refuse storage outright.
    return 'arranged';
  }
}

/** The chosen order, and a way to change it. Shared across the tabs. */
export function useShelfOrder() {
  const [order, setOrder] = useState(rememberedOrder);

  const choose = useCallback((next) => {
    if (!SHELF_ORDERS_KNOWN.has(next)) return;
    setOrder(next);
    try {
      window.localStorage.setItem(REMEMBERED_ORDER, next);
    } catch {
      // Not remembering it is not worth interrupting anybody for.
    }
  }, []);

  return [order, choose];
}

/**
 * The order picker: one small control, in the shape the genre sort uses.
 *
 * `offered` narrows the list for a screen that cannot honour all of it —
 * shelves built from folders on disk have no date they were made, and an
 * option that silently does nothing is worse than one that is not there.
 */
export function ShelfOrderPicker({ order, onChoose, offered = SHELF_ORDERS }) {
  const orders = offered.length ? offered : SHELF_ORDERS;
  const inUse = orders.some(([id]) => id === order) ? order : orders[0][0];

  return (
    <label className="chip-select shelf-order-pick">
      <span className="shelf-order-word">Sort</span>
      <select
        value={inUse}
        aria-label="Order the collections are shown in"
        onChange={(event) => onChoose(event.target.value)}
      >
        {orders.map(([id, name]) => (
          <option key={id} value={id}>{name}</option>
        ))}
      </select>
    </label>
  );
}
