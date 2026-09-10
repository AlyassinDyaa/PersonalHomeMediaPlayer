import React, { useMemo, useState } from 'react';
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
  ['backlog', 'Set aside'],
];

export function Lists({
  favourites = [],
  watchlist = { items: [], comics: [] },
  /* Started and set aside: where you got to, kept off the home screen. */
  backlog = [],
  onSelect,
  onOpenComic,
  onLongPress = null,
  onRemoveFavourite,
  onRemoveWatch,
  onRemoveComic,
  onResume = null,
  onTakeUp = null,
}) {
  const [which, setWhich] = useState('favourites');
  /*
   * Films, series and comics keep one list between them and are told apart
   * here rather than filed apart.
   *
   * A separate list per kind would mean three empty pages for somebody who
   * only keeps films, and would ask them to remember which list a title went
   * on. One list with a way to narrow it asks nothing and answers both.
   */
  const [kind, setKind] = useState('all');
  const [order, setOrder] = useState('added');

  /* Newest first is how each list arrives; by name is the other way anybody
     looks for something they know they put here. */
  const arrange = useMemo(() => (rows, name) => (
    order === 'title'
      ? [...rows].sort((a, b) => name(a).localeCompare(name(b)))
      : rows
  ), [order]);

  const ofKind = useMemo(() => (rows, get) => (
    kind === 'all' ? rows : rows.filter((row) => get(row) === kind)
  ), [kind]);

  /* What each tab is showing, once narrowed and ordered. */
  const shownFavourites = arrange(ofKind(favourites, (item) => item.kind), (item) => item.title);
  const shownWatch = arrange(ofKind(watchlist.items, (item) => item.kind), (item) => item.title);
  const shownComics = kind === 'all' || kind === 'comic' ? watchlist.comics : [];
  const shownBacklog = arrange(ofKind(backlog, (entry) => entry.item.kind), (entry) => entry.item.title);

  const count = which === 'favourites' ? shownFavourites.length
    : which === 'backlog' ? shownBacklog.length
    : shownWatch.length + shownComics.length;

  /*
   * How many of each kind are on the list being looked at.
   *
   * Shown on the chips, and a chip for a kind this list holds none of is not
   * drawn at all — a "Comics 0" on a list of films is a dead end offered as a
   * choice.
   */
  const pool = which === 'favourites' ? favourites
    : which === 'backlog' ? backlog.map((entry) => entry.item)
      : [...watchlist.items, ...watchlist.comics.map(() => ({ kind: 'comic' }))];
  const tally = {
    all: pool.length,
    movie: pool.filter((item) => item.kind === 'movie').length,
    show: pool.filter((item) => item.kind === 'show').length,
    comic: pool.filter((item) => item.kind === 'comic').length,
  };
  const KINDS = [['all', 'All'], ['movie', 'Movies'], ['show', 'TV Shows'], ['comic', 'Comics']];

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

      {/* Narrowing, and ordering: the two things asked of a list long enough
          to need looking through. */}
      {tally.all > 0 && (
        <div className="lists-filters">
          {KINDS.filter(([id]) => id === 'all' || tally[id] > 0).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={kind === id ? 'chip active' : 'chip'}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {label} <span className="chip-count">{tally[id]}</span>
            </button>
          ))}

          <span style={{ flex: 1 }} />

          <label className="chip chip-select">
            Sort
            <select value={order} onChange={(event) => setOrder(event.target.value)}>
              <option value="added">Recently added</option>
              <option value="title">A–Z</option>
            </select>
          </label>
        </div>
      )}

      {which === 'favourites' && (
        shownFavourites.length === 0 ? (
          <Empty
            title={favourites.length ? 'Nothing of that kind' : 'Nothing here yet'}
            body="Press the ♡ on a film or series, or hold a cover down and choose Add to favourites."
          />
        ) : (
          <div className="grid">
            {shownFavourites.map((item) => (
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

      {which === 'backlog' && (
        shownBacklog.length === 0 ? (
          <Empty
            title={backlog.length ? 'Nothing of that kind' : 'Nothing set aside'}
            body="Hold down anything on Continue Watching and choose Set aside for later. It keeps your place and stops the home screen asking about it."
          />
        ) : (
          <div className="grid">
            {shownBacklog.map((entry) => (
              <Card
                key={entry.item.id}
                item={entry.item}
                wide
                progress={entry.progressPercent}
                label={(
                  <>
                    <strong>{entry.item.title}</strong>
                    {entry.video
                      ? (entry.video.episode
                        ? 'Season ' + entry.video.season + ' · Episode ' + entry.video.episode
                        : 'Part way through')
                      : 'Nothing to resume'}
                  </>
                )}
                onClick={() => (onResume ? onResume(entry) : onSelect(entry.item))}
                onLongPress={onLongPress ? () => onLongPress(entry) : null}
                onRemove={onTakeUp ? () => onTakeUp(entry) : null}
                removeLabel="Put back on Continue Watching"
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
            {shownWatch.map((item) => (
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
            {shownComics.map((series) => (
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
