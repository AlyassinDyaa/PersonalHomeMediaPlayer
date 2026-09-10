/**
 * How a row of covers is drawn.
 *
 * Every shelf in the library — the collections somebody arranged and the
 * genres the library worked out for itself — is a rail of posters, and until
 * now there was one way to draw one: the posters, a little apart, on nothing.
 * That is fine, and it is also what every other app looks like.
 *
 * Two choices, made separately, because they answer different questions and
 * any answer to one goes with any answer to the other: what each cover looks
 * like, and what the row sits on. Prints on a shelf, glass in a spotlight,
 * neon on nothing at all — none of them moves a cover or changes its size,
 * which is what lets them be swapped with a class on the body and nothing
 * else, and what keeps a choice made for looks from ever costing a title.
 */

/** Each cover, in the order offered, with what each is for. */
export const SHELF_STYLES = [
  ['plain', 'Plain', 'The covers on their own, as they were'],
  ['glass', 'Glass', 'Every cover set in a pane of frosted glass'],
  ['prints', 'Prints', 'White-bordered prints, pinned up a little askew'],
  ['tiles', 'Tiles', 'Each cover on its own soft tile'],
  ['neon', 'Neon', 'Each cover outlined in the glow of its own colours'],
  ['spines', 'Spines', 'Covers stood on end, the way a shelf of discs looks'],
];

/** What the row sits on, in the order offered. */
export const SHELF_ROWS = [
  ['none', 'Nothing', 'The covers float, as they did'],
  ['ledge', 'Shelf', 'Every row stands on a ledge, like discs on a shelf'],
  ['spotlight', 'Spotlight', 'A wash of the library colour behind every row'],
  ['panel', 'Panel', 'Each row in its own quiet frame'],
  ['band', 'Band', 'A ribbon of colour running behind the covers'],
  ['underglow', 'Underglow', 'Light spilling out from beneath the covers'],
];

/** The designs whose strength can be set; the rest are all or nothing. */
export const SHELF_ROWS_WITH_STRENGTH = new Set(['spotlight', 'panel', 'band', 'underglow']);

/**
 * Colours offered for the shelf, beyond following the artwork.
 *
 * Two woods first, because a shelf that looks like a shelf is what most
 * people mean by one; then the same quiet set the backdrop offers, so the
 * two can be matched.
 */
export const SHELF_COLOURS = [
  ['', 'Follow the artwork'],
  ['#a8773f', 'Oak'],
  ['#5b3a24', 'Walnut'],
  ['#7d8aa0', 'Slate'],
  ['#19c2a8', 'Teal'],
  ['#3b6ea5', 'Blue'],
  ['#6b4fa0', 'Violet'],
  ['#a8536b', 'Rose'],
  ['#4a7a4e', 'Moss'],
];

const COVERS = new Set(SHELF_STYLES.map(([id]) => id));
const ROWS = new Set(SHELF_ROWS.map(([id]) => id));

/** The class the page wears for a cover style, or none for the plain one. */
export function shelfStyleClass(id) {
  return COVERS.has(id) && id !== 'plain' ? 'shelf-' + id : '';
}

/** The class the page wears for what the row sits on, or none. */
export function shelfRowClass(id) {
  return ROWS.has(id) && id !== 'none' ? 'shelf-' + id : '';
}

/**
 * Dress the shelves.
 *
 * On the body, like the backdrop, so it holds across every screen and the
 * player — which covers everything — never sees it.
 */
/** How large the covers are drawn, in the order offered. */
export const CARD_SIZES = [
  ['small', 'Small', 'More of the library at once'],
  ['medium', 'Medium', 'As it was'],
  ['large', 'Large', 'Fewer covers, seen properly'],
];

/** Put the chosen size on the page; medium is the plain one. */
export function applyCardSize(id) {
  if (typeof document === 'undefined') return;
  const body = document.body;
  for (const [name] of CARD_SIZES) body.classList.remove('cards-' + name);
  if (id && id !== 'medium') body.classList.add('cards-' + id);
}

export function applyShelfStyle(cover, row = 'none', colour = '', strength = 50) {
  if (typeof document === 'undefined') return;
  const body = document.body;
  /* A fraction, for the sheet to use as an opacity. */
  const amount = Math.min(100, Math.max(10, Number(strength) || 50)) / 100;
  body.style.setProperty('--shelf-strength', String(amount));
  /* Unset when following the artwork, so the sheet falls through to the
     accent each page already sets from the poster in front of you. */
  if (colour) body.style.setProperty('--shelf-tint', colour);
  else body.style.removeProperty('--shelf-tint');
  for (const [name] of SHELF_STYLES) body.classList.remove('shelf-' + name);
  for (const [name] of SHELF_ROWS) body.classList.remove('shelf-' + name);
  const chosen = shelfStyleClass(cover);
  if (chosen) body.classList.add(chosen);
  const under = shelfRowClass(row);
  if (under) body.classList.add(under);
}
