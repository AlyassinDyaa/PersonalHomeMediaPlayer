import React, { useRef } from 'react';
import { artwork } from '../api.js';
import { isRecent } from '../recent.js';

/**
 * Poster tile. Falls back to the title on a plain surface when an item has no
 * artwork, so an unmatched item is still readable rather than a blank box.
 */
/** How long a finger has to rest before it counts as asking for the menu. */
const LONG_PRESS_MS = 480;



export function Card({
  item, onClick, wide = false, label = null, progress = null, image = null,
  /** Shown as a dismiss control in the corner when supplied. */
  onRemove = null, removeLabel = 'Remove',
  /** Position on a numbered rail, drawn large beside the poster. */
  rank = null,
  /** Held down, or right-clicked: the actions for this title. */
  onLongPress = null,
  /** While titles are being gathered for a shelf: whether this one is ticked. */
  picking = false,
  ticked = false,
}) {
  const held = useRef(null);

  /*
   * A press that stays put long enough is a request for the menu.
   *
   * Cancelled by movement, because the same finger scrolling the rail starts
   * exactly the same way — and a menu appearing mid-scroll is worse than no
   * menu at all.
   */
  const startHold = () => {
    if (!onLongPress) return;
    clearTimeout(held.current);
    held.current = setTimeout(() => { held.current = null; onLongPress(); }, LONG_PRESS_MS);
  };
  const cancelHold = () => { clearTimeout(held.current); held.current = null; };
  const src = image ?? artwork(wide ? item.backdrop : item.poster, wide ? 'w780' : 'w500');

  return (
    <div
      className={[
        'card',
        wide ? 'wide' : '',
        /* Everything in it seen. Dimmed rather than hidden: a library is for
           rewatching too, and this only answers "what is left". */
        item.unwatchedCount === 0 ? 'seen' : '',
        picking ? 'picking' : '',
        picking && ticked ? 'ticked' : '',
      ].filter(Boolean).join(' ')}
      onTouchStart={startHold}
      onTouchMove={cancelHold}
      onTouchEnd={cancelHold}
      onTouchCancel={cancelHold}
      onContextMenu={onLongPress ? (event) => { event.preventDefault(); onLongPress(); } : undefined}
      // Whatever inside reaches for the accent — the resume bar, the glow —
      // gets this title's colour rather than the library's.
      style={item.accent ? { '--accent': item.accent } : undefined}
      onClick={(event) => onClick?.(event)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onClick?.(event); }}
    >
      {item.accent && <div className="card-glow" style={{ background: item.accent }} />}
      {rank !== null && <span className="card-rank" aria-hidden="true">{rank}</span>}
      {/*
        * The poster carries the picture twice.
        *
        * Once as itself, shown whole; and once as this background, which the
        * stylesheet blurs to fill whatever the first one does not reach. A
        * picture already the right shape covers the card exactly and the fill
        * never shows, so this costs nothing in the ordinary case.
        */}
      {/*
        * The poster's own colour stands in while the poster loads.
        *
        * A screen of grey rectangles is what the library looked like on every
        * cold start, and over a mesh address that is a real part of using it.
        * Each title already carries a colour taken from its artwork, so the
        * wait can be the right colour rather than no colour.
        */}
      <div
        className="card-poster"
        style={{
          ...(src ? { backgroundImage: 'url("' + src + '")' } : null),
          ...(item.accent ? { '--loading': item.accent } : null),
        }}
      >
        {/* Ticking is the whole interaction while a shelf is being gathered. */}
        {picking && <span className="card-tick">{ticked ? '✓' : ''}</span>}
        {/* Among the handful that arrived most recently; see recent.js. */}
        {isRecent(item) && <span className="card-new">New</span>}
        {src
          ? <img src={src} alt={item.title} loading="lazy" draggable={false} />
          : <div className="card-fallback">{item.title}</div>}
        {progress > 0 && (
          <div className="card-progress"><span style={{ width: Math.min(100, progress) + '%' }} /></div>
        )}
        {onRemove && (
          <button
            type="button"
            className="card-remove"
            /* No `title`: the browser's own tooltip is a white box that lands
               over the next card along. The label stays for screen readers. */
            aria-label={removeLabel + ' ' + item.title}
            // The card itself starts playback, so the press must not reach it.
            onClick={(event) => { event.stopPropagation(); onRemove(); }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            ×
          </button>
        )}
      </div>
      {label && <div className="card-label">{label}</div>}
    </div>
  );
}

export default Card;
