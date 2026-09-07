import { useEffect } from 'react';

/**
 * Driving the library with five buttons.
 *
 * A television stick sends arrows, an OK and a back — nothing else. There is
 * no pointer to aim, so the only question that matters is which thing is
 * highlighted and what lies in each direction from it.
 *
 * Rather than keeping a map of what sits beside what, which would have to be
 * rewritten every time a row is added, the nearest thing in the direction
 * pressed is found by geometry. That stays true however the page is
 * rearranged, and it works on the pages nobody thought about at the time.
 *
 * Nothing is drawn until an arrow is actually pressed. A ring around whatever
 * the mouse last touched would be noise on a desktop, so the stylesheet only
 * shows it once the page has been told a remote is in use.
 */

const DIRECTIONS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Things a person can land on. Cards carry a role and a tabindex of their own. */
const REACHABLE = 'button, [role="button"], a[href], input, select, textarea, [tabindex="0"]';

/** Where typing means typing, and the arrows belong to the field. */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function reachable() {
  return [...document.querySelectorAll(REACHABLE)].filter((element) => {
    if (element.disabled) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
}

/**
 * The nearest thing that way.
 *
 * Distance along the direction pressed counts once, distance across it counts
 * double — so a card directly below wins over one that is nearer in a straight
 * line but two columns over, which is what a person means by "down".
 */
function nextInDirection(current, direction) {
  const from = current.getBoundingClientRect();
  const fromX = from.left + from.width / 2;
  const fromY = from.top + from.height / 2;

  let best = null;
  for (const element of reachable()) {
    if (element === current) continue;
    const box = element.getBoundingClientRect();
    const dx = box.left + box.width / 2 - fromX;
    const dy = box.top + box.height / 2 - fromY;

    const along = direction === 'left' ? -dx
      : direction === 'right' ? dx
      : direction === 'up' ? -dy : dy;
    if (along < 6) continue;

    const across = Math.abs(direction === 'left' || direction === 'right' ? dy : dx);
    // A generous cone, widening with distance, so a row that is not perfectly
    // aligned is still reachable.
    if (across > along * 2.5 + 60) continue;

    const cost = along + across * 2;
    if (!best || cost < best.cost) best = { element, cost };
  }
  return best?.element ?? null;
}

export function useRemote({ onBack } = {}) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const active = document.activeElement;
      const typing = active && TYPING.has(active.tagName);

      if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
        if (typing) return;
        if (onBack?.()) event.preventDefault();
        return;
      }

      const direction = DIRECTIONS[event.key];
      if (!direction || typing) return;

      // From here on the page is being driven rather than scrolled, so the
      // ring appears and the browser's own scrolling gets out of the way.
      document.body.classList.add('by-remote');
      event.preventDefault();

      const all = reachable();
      if (!all.length) return;

      const current = all.includes(active) ? active : null;
      const target = current ? nextInDirection(current, direction) : all[0];
      if (!target) return;

      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    };

    // A pointer means the ring is no longer wanted.
    const onPointer = () => document.body.classList.remove('by-remote');

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [onBack]);
}

export default useRemote;
