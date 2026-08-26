import { useRef } from 'react';

/**
 * Horizontal swipes across a page, for moving between tabs and going back.
 *
 * The hard part is not detecting a swipe but knowing when not to claim one. A
 * finger dragged across a row of posters is scrolling that row, and a finger
 * dragged down the page is scrolling the page — neither should change tab. So a
 * gesture is ignored when it starts inside anything that scrolls sideways
 * itself, and only counts once it has travelled far enough, and mostly
 * sideways, to be unambiguous.
 */

/** How far a finger must travel before it counts as a swipe, in pixels. */
const DISTANCE = 70;
/** How much more horizontal than vertical it has to be. */
const DIRECTNESS = 1.7;
/** A slow drag is someone reading, not someone navigating. */
const MAX_DURATION_MS = 800;

/** Things that handle their own sideways movement. */
const SCROLLS_ITSELF = '.row-scroller, .season-row, .season-tabs, input, textarea, select, video';

export function useSwipe({ onLeft, onRight, enabled = true }) {
  const start = useRef(null);

  if (!enabled) return {};

  return {
    onTouchStart: (event) => {
      if (event.touches.length !== 1) {
        start.current = null;
        return;
      }
      const touch = event.touches[0];
      const target = event.target;
      // A row of posters scrolls sideways on its own; leave it alone.
      if (target?.closest?.(SCROLLS_ITSELF)) {
        start.current = null;
        return;
      }
      start.current = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    },

    onTouchEnd: (event) => {
      const from = start.current;
      start.current = null;
      if (!from) return;

      const touch = event.changedTouches?.[0];
      if (!touch) return;

      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;

      if (Date.now() - from.at > MAX_DURATION_MS) return;
      if (Math.abs(dx) < DISTANCE) return;
      if (Math.abs(dx) < Math.abs(dy) * DIRECTNESS) return;

      if (dx < 0) onLeft?.();
      else onRight?.();
    },
  };
}

export default useSwipe;
