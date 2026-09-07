import React from 'react';

/**
 * The shape of what is coming, while it is still coming.
 *
 * A spinner over an empty page says only that something is happening. It gives
 * no idea how long, nothing to read, and — worst on a slow connection — no
 * layout, so when the artwork finally lands the whole page jumps and whatever
 * was under the thumb moves out from under it.
 *
 * These are the same blocks the real page is built from, drawn empty. The
 * banner is the size of a banner and the posters are the size of posters, so
 * the page arrives in place rather than assembling itself around you.
 */

/** Enough posters to fill a row on the widest screen this is drawn on. */
const ACROSS = 7;

export function Skeleton({ detail = false }) {
  if (detail) {
    return (
      <div className="skeleton" aria-busy="true" aria-label="Loading">
        <div className="skeleton-banner shimmer" />
        <div className="skeleton-lines">
          <span className="shimmer" style={{ width: '52%', height: 30 }} />
          <span className="shimmer" style={{ width: '34%' }} />
          <span className="shimmer" style={{ width: '88%' }} />
          <span className="shimmer" style={{ width: '76%' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading your library">
      <div className="skeleton-banner shimmer" />
      {[0, 1].map((row) => (
        <div className="skeleton-row" key={row}>
          <span className="skeleton-heading shimmer" />
          <div className="skeleton-posters">
            {Array.from({ length: ACROSS }, (_, index) => (
              <span className="skeleton-poster shimmer" key={index} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
