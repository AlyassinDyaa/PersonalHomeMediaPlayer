/**
 * The order collections are shown in, and the titles standing on them.
 *
 * Kept apart from the components that draw them so it can be tested without a
 * browser. That is not tidiness: this went out ordering the shelves and not
 * their contents, which looks from the outside exactly like a control that
 * does nothing, and nothing in the build could have caught it.
 */

/**
 * The orders offered, in the order they are offered.
 *
 * "As arranged" is first and is the default, because the owner puts these in a
 * deliberate order with the Earlier and Later buttons — defaulting to
 * alphabetical would quietly throw that away with no obvious way back.
 */
export const SHELF_ORDERS = [
  ['arranged', 'As arranged'],
  ['az', 'A–Z'],
  ['za', 'Z–A'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
];

/** The orders that need nothing but a name, for shelves with no date. */
export const SHELF_ORDERS_BY_NAME = SHELF_ORDERS.filter(
  ([id]) => id === 'arranged' || id === 'az' || id === 'za',
);

export const SHELF_ORDERS_KNOWN = new Set(SHELF_ORDERS.map(([id]) => id));

/*
 * Names are compared with the browser's own collator rather than by code
 * point, so "Édition" files under E and "Star Wars 2" comes before
 * "Star Wars 10" instead of after it.
 */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A title, whether it arrived bare or wrapped with progress beside it. */
const of = (entry) => entry?.item ?? entry ?? {};

/**
 * The titles standing on one shelf.
 *
 * A shelf with no date sorts last either way rather than pretending to be the
 * oldest thing in the library, which is what a missing value would mean once
 * it became a zero.
 */
export function sortShelfItems(items, order) {
  const list = [...(items ?? [])];

  switch (order) {
    case 'az':
      return list.sort((a, b) => byName.compare(of(a).title ?? '', of(b).title ?? ''));
    case 'za':
      return list.sort((a, b) => byName.compare(of(b).title ?? '', of(a).title ?? ''));
    case 'newest':
      return list.sort((a, b) => (of(b).addedAt ?? -Infinity) - (of(a).addedAt ?? -Infinity));
    case 'oldest':
      return list.sort((a, b) => (of(a).addedAt ?? Infinity) - (of(b).addedAt ?? Infinity));
    default:
      return list;
  }
}

/**
 * The shelves in the chosen order, each carrying its own contents in that same
 * order.
 *
 * Copied rather than sorted in place, contents included: these objects came
 * from whoever called this, and a screen that rewrites its own props is a bug
 * waiting for a second reader.
 */
export function sortShelves(shelves, order) {
  /*
   * The collections keep the order the owner put them in. Always.
   *
   * This used to reorder them as well, and that was wrong: the arrangement is
   * a decision somebody made deliberately with the Earlier and Later buttons,
   * and a sort control on the screen is not an instruction to throw it away.
   * What the control is for is the titles inside — a shelf of forty films is
   * a list you want alphabetical; the shelves themselves are five things in a
   * chosen order.
   *
   * So the order flows into each shelf's contents and stops there.
   */
  return (shelves ?? []).map((shelf) => {
    if (shelf?.items) return { ...shelf, items: sortShelfItems(shelf.items, order) };
    // Comics shelves hold series rather than titles, and are otherwise the same.
    if (shelf?.series) return { ...shelf, series: sortShelfItems(shelf.series, order) };
    return shelf;
  });
}
