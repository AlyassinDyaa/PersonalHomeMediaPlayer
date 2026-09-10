/**
 * What the sidebar is made of.
 *
 * It began as a near-solid strip, which is the safe answer and looks like a
 * strip. Glass lets the backdrop show through it, blurred, so the column
 * reads as sitting on the room rather than nailed to its edge; clear takes
 * the strip away altogether and leaves the icons standing on the page.
 *
 * Chosen by looking, like the backdrop, and applied as a class on the body
 * so it holds across every screen.
 */

/** The looks, in the order offered, with what each is for. */
export const RAIL_STYLES = [
  ['solid', 'Solid', 'A dark strip, as it was'],
  ['glass', 'Glass', 'Frosted, with the backdrop showing through'],
  ['clear', 'Clear', 'No strip at all; the icons stand on the page'],
];

const KNOWN = new Set(RAIL_STYLES.map(([id]) => id));

/** The class the page wears, or none for the solid one. */
export function railStyleClass(id) {
  return KNOWN.has(id) && id !== 'solid' ? 'rail-' + id : '';
}

export function applyRailStyle(id, opacity = 45) {
  if (typeof document === 'undefined') return;
  const body = document.body;
  /* The strip's opacity, as a fraction, for whichever look is drawn. */
  const alpha = Math.min(100, Math.max(0, Number(opacity) || 0)) / 100;
  body.style.setProperty('--rail-alpha', String(alpha));
  for (const [name] of RAIL_STYLES) body.classList.remove('rail-' + name);
  const chosen = railStyleClass(id);
  if (chosen) body.classList.add(chosen);
}
