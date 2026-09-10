import React, { useState } from 'react';
import Card from './Card.jsx';
import { comicCover } from '../api.js';

/**
 * The lists somebody keeps: what they love, and what they mean to get to.
 *
 * Favourites came first and lived as a rail on the home screen, which was the
 * wrong place for it — a list is somewhere you go on purpose, not something
 * you scroll past. Here both lists have a page of their own, favourites at the
 * top because that is the one already full.
 *
 * The watchlist takes anything: a film, a series, a run of comics. A comic
 * cannot be "watched", but "the things I mean to get to" is one list in
 * anyone's head, and splitting it by medium would be splitting hairs.
 */
const LISTS = [
  ['favourites', 'Favourites'],
  ['watchlist', 'Watch later'],
];

export function Lists({
  favourites = [],
  watchlist = { items: [], comics: [] },
  onSelect,
  onOpenComic,
  onLongPress = null,
  onRemoveFavourite,
  onRemoveWatch,
  onRemoveComic,
}) {
  const [which, setWhich] = useState('favourites');

  const count = which === 'favourites'
    ? favourites.length
    : watchlist.items.length + watchlist.comics.length;

  return (
    <>
      <div className="page-header lists-header">
        <h1 className="page-title">My Lists</h1>
        <span className="page-sub">{count === 1 ? '1 title' : count + ' titles'}</span>
      </div>

      {/* The two lists, as the same segmented control the season pages use. */}
      <div className="lists-toggle">
        <div className="view-toggle" role="tablist" aria-label="Which list">
          {LISTS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={which === id}
              className={which === id ? 'view-btn active' : 'view-btn'}
              onClick={() => setWhich(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {which === 'favourites' && (
        favourites.length === 0 ? (
          <Empty
            title="Nothing here yet"
            body="Press the ♡ on a film or series, or hold a cover down and choose Add to favourites."
          />
        ) : (
          <div className="grid">
            {favourites.map((item) => (
              <Card
                key={item.id}
                item={item}
                label={<><strong>{item.title}</strong>{item.year ?? ''}</>}
                onClick={(event) => onSelect(item, event)}
                onLongPress={onLongPress ? () => onLongPress(item) : null}
                onRemove={() => onRemoveFavourite(item)}
                removeLabel="Remove from favourites"
              />
            ))}
          </div>
        )
      )}

      {which === 'watchlist' && (
        count === 0 ? (
          <Empty
            title="Nothing to get to yet"
            body="Press the + on a film, series or run of comics, or hold a cover down and choose Watch later."
          />
        ) : (
          <div className="grid">
            {watchlist.items.map((item) => (
              <Card
                key={'item:' + item.id}
                item={item}
                label={<><strong>{item.title}</strong>{item.kind === 'show' ? 'Series' : 'Film'}</>}
                onClick={(event) => onSelect(item, event)}
                onLongPress={onLongPress ? () => onLongPress(item) : null}
                onRemove={() => onRemoveWatch(item)}
                removeLabel="Remove from watch later"
              />
            ))}
            {watchlist.comics.map((series) => (
              <Card
                key={'comic:' + series.id}
                item={{ id: series.id, title: series.title }}
                image={series.coverIssue ? comicCover(series.coverIssue) : null}
                label={<><strong>{series.title}</strong>Comics · {series.issues} issues</>}
                onClick={() => onOpenComic(series.id)}
                onRemove={() => onRemoveComic(series)}
                removeLabel="Remove from watch later"
              />
            ))}
          </div>
        )
      )}
    </>
  );
}

/** A quiet word where a list would be, saying how to fill it. */
function Empty({ title, body }) {
  return (
    <div className="lists-empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export default Lists;
