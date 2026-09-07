import { useRef, useState } from 'react';

/**
 * Pull the page down at the top to fetch it again.
 *
 * The gesture every list on a phone has, and the only one people reach for
 * when something looks out of date. Without it the alternatives are closing
 * the app or finding a reload button that a Home Screen app does not have.
 *
 * Deliberately conservative about claiming the gesture: it only begins at the
 * very top of the page, only follows a finger moving downwards, and gives up
 * the moment the movement turns out to be mostly sideways — which is somebody
 * swiping between tabs, and belongs to the other gesture.
 */

/** How far down before it counts, in pixels. */
const TRIGGER = 78;
/** Beyond this the indicator stops following, so it cannot be dragged away. */
const LIMIT = 120;

/** Where the page is scrolled to, whichever element is doing the scrolling. */
function scrolledTo() {
  return window.scrollY
    || document.scrollingElement?.scrollTop
    || document.body.scrollTop
    || 0;
}

export function usePull(onRefresh, { enabled = true } = {}) {
  const start = useRef(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  if (!enabled) return { handlers: {}, distance: 0, refreshing: false, ready: false };

  const handlers = {
    onTouchStart: (event) => {
      if (event.touches.length !== 1 || refreshing) return;
      // Only from the very top; anywhere else the finger is scrolling.
      if (scrolledTo() > 2) { start.current = null; return; }
      const touch = event.touches[0];
      start.current = { x: touch.clientX, y: touch.clientY };
    },

    onTouchMove: (event) => {
      if (!start.current || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const down = touch.clientY - start.current.y;
      const across = Math.abs(touch.clientX - start.current.x);

      // Sideways means the other gesture; upwards means ordinary scrolling.
      if (down <= 0 || across > down) { start.current = null; setDistance(0); return; }

      // Resisted, so it feels like pulling against something rather than
      // dragging a sheet of paper.
      setDistance(Math.min(LIMIT, down * 0.5));
    },

    onTouchEnd: async () => {
      const pulled = distance;
      start.current = null;
      setDistance(0);
      if (pulled < TRIGGER || refreshing) return;

      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    },
  };

  return { handlers, distance, refreshing, ready: distance >= TRIGGER };
}

/**
 * Two sets of touch handlers on one element.
 *
 * Swiping between tabs and pulling to refresh both want the same events, and
 * an object spread would silently keep only the last one — a bug that looks
 * like the gesture simply not working.
 */
export function bothGestures(first, second) {
  const merged = { ...first };
  for (const [name, handler] of Object.entries(second)) {
    const existing = merged[name];
    merged[name] = existing
      ? (event) => { existing(event); handler(event); }
      : handler;
  }
  return merged;
}

export default usePull;
