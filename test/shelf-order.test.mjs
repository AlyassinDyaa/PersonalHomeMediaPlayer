/**
 * Checks that the Sort control on the collections header sorts something.
 *
 * It shipped ordering the shelves and not the titles standing on them, which
 * from the outside is indistinguishable from a control that does nothing: the
 * collections rearranged quietly above the fold while the grid of covers
 * everybody was looking at stayed exactly where it was.
 *
 * So the cases here are mostly about the contents, not the shelves.
 */

import assert from 'node:assert';
import {
  sortShelves, sortShelfItems, SHELF_ORDERS, SHELF_ORDERS_BY_NAME,
} from '../desktop/src/shelfOrder.js';

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + (error.stack ?? error.message));
    process.exitCode = 1;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const shelves = () => [
  {
    id: 'a',
    name: 'Marvel',
    createdAt: 3 * DAY,
    items: [
      { id: '1', title: 'Thor', addedAt: 5 * DAY },
      { id: '2', title: 'Ant-Man', addedAt: 1 * DAY },
      { id: '3', title: 'Iron Man 10', addedAt: 9 * DAY },
      { id: '4', title: 'Iron Man 2', addedAt: 2 * DAY },
    ],
  },
  { id: 'b', name: 'DC', createdAt: 1 * DAY, items: [{ id: '5', title: 'Batman' }] },
  { id: 'c', name: 'star wars', createdAt: 2 * DAY, items: [{ id: '6', title: 'Andor' }] },
];

const names = (list) => list.map((shelf) => shelf.name);
const titles = (list) => list.map((entry) => (entry.item ?? entry).title);

// ------------------------------------------------------------- the shelves ---

/*
 * The arrangement is the owner's and the control does not touch it.
 *
 * Putting the collections in a deliberate order is what the Earlier and Later
 * buttons are for; a sort control on the screen is not permission to discard
 * that. The control exists for the titles standing on each shelf.
 */
check('the collections keep the owner\'s order, whatever is chosen', () => {
  const chosen = ['Marvel', 'DC', 'star wars'];
  for (const order of ['arranged', 'az', 'za', 'newest', 'oldest']) {
    assert.deepStrictEqual(
      names(sortShelves(shelves(), order)),
      chosen,
      order + ' must not reorder the collections',
    );
  }
});

// ------------------------------------------- the titles standing on them ---

check('the titles inside a shelf are ordered too, not just the shelves', () => {
  // The whole point: this is what was missing.
  const [marvel] = sortShelves(shelves(), 'az').filter((shelf) => shelf.name === 'Marvel');
  assert.deepStrictEqual(titles(marvel.items), ['Ant-Man', 'Iron Man 2', 'Iron Man 10', 'Thor']);
});

check('numbers in titles read as numbers', () => {
  const sorted = sortShelfItems(
    [{ title: 'Iron Man 10' }, { title: 'Iron Man 2' }], 'az',
  );
  assert.deepStrictEqual(titles(sorted), ['Iron Man 2', 'Iron Man 10'], '2 comes before 10');
});

check('titles order by when they arrived', () => {
  const marvel = shelves()[0];
  assert.deepStrictEqual(
    titles(sortShelfItems(marvel.items, 'newest')),
    ['Iron Man 10', 'Thor', 'Iron Man 2', 'Ant-Man'],
  );
  assert.deepStrictEqual(
    titles(sortShelfItems(marvel.items, 'oldest')),
    ['Ant-Man', 'Iron Man 2', 'Thor', 'Iron Man 10'],
  );
});

check('a title wrapped with its progress sorts by the title inside', () => {
  const wrapped = [
    { item: { title: 'Zodiac' }, progressPercent: 12 },
    { item: { title: 'Amelie' }, progressPercent: 40 },
  ];
  assert.deepStrictEqual(titles(sortShelfItems(wrapped, 'az')), ['Amelie', 'Zodiac']);
});

check('anything without a date sorts last, either way round', () => {
  const list = [{ title: 'B' }, { title: 'A', addedAt: 5 }];
  assert.deepStrictEqual(titles(sortShelfItems(list, 'newest')), ['A', 'B']);
  assert.deepStrictEqual(titles(sortShelfItems(list, 'oldest')), ['A', 'B']);
});

// ------------------------------------------------------------- the rules ---

check('what came in is never rearranged in place', () => {
  const original = shelves();
  const before = names(original);
  const beforeItems = titles(original[0].items);
  sortShelves(original, 'az');
  assert.deepStrictEqual(names(original), before, 'the array of shelves is untouched');
  assert.deepStrictEqual(titles(original[0].items), beforeItems, 'and so are its contents');
});

check('comics shelves hold series, and those are ordered as well', () => {
  const comics = [{ name: 'DC', series: [{ title: 'Watchmen' }, { title: 'Batman' }] }];
  const [shelf] = sortShelves(comics, 'az');
  assert.deepStrictEqual(titles(shelf.series), ['Batman', 'Watchmen']);
});

check('the narrowed list offers only what a dateless shelf can honour', () => {
  assert.deepStrictEqual(SHELF_ORDERS_BY_NAME.map(([id]) => id), ['arranged', 'az', 'za']);
  assert.ok(SHELF_ORDERS.length > SHELF_ORDERS_BY_NAME.length);
});

check('nothing falls over on an empty or absent list', () => {
  assert.deepStrictEqual(sortShelves(undefined, 'az'), []);
  assert.deepStrictEqual(sortShelfItems(null, 'newest'), []);
  assert.deepStrictEqual(sortShelves([{ name: 'A' }], 'az'), [{ name: 'A' }]);
});

console.log('\npassed ' + passed + ' of ' + total);
