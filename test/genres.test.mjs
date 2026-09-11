/**
 * How the library is filed under genre headings.
 *
 * This has been got wrong three times, each time on reasoning that sounded
 * right until it met an actual library, so the failures are pinned down here
 * as cases rather than left as prose in a comment.
 *
 * What a heading has to be: recognisable, true of what is under it, and worth
 * the space. A heading over one film is none of those.
 */

import assert from 'node:assert';
import { shelveByGenre, CATCH_ALL } from '../desktop/src/genres.js';

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

/** A title is its name and the genres it carries, in the order given. */
const t = (title, ...genres) => ({ id: title, title, genres });

const where = (shelves, title) => shelves.find((s) => s.entries.some((e) => e.title === title))?.name;
const named = (shelves) => shelves.map((s) => s.name);

check('a title goes under exactly one heading', () => {
  const items = [
    t('Arcane', 'Animation', 'Action', 'Adventure'),
    t('Ben 10', 'Animation', 'Action', 'Adventure'),
    t('Avatar', 'Animation', 'Action', 'Adventure'),
  ];
  const shelves = shelveByGenre(items);
  const seen = shelves.flatMap((s) => s.entries.map((e) => e.title));
  assert.strictEqual(seen.length, new Set(seen).size, 'nothing filed twice');
  assert.strictEqual(seen.length, items.length, 'and nothing dropped');
});

check('the leading genre is used where it gathers a shelf', () => {
  const items = [
    t('Arcane', 'Animation', 'Action'),
    t('Ben 10', 'Animation', 'Action'),
    t('Avatar', 'Animation', 'Action'),
  ];
  assert.strictEqual(where(shelveByGenre(items), 'Arcane'), 'Animation');
});

check('a leading genre only one title carries does not get a heading', () => {
  /*
   * The case that prompted this: Bruce Almighty leads with Fantasy and was
   * given a shelf of its own, under a word that does not describe it.
   */
  const items = [
    t('Bruce Almighty', 'Fantasy', 'Comedy'),
    t('Argylle', 'Comedy', 'Action'),
    t('Back to the Future', 'Comedy', 'Adventure'),
    t('Guns Up', 'Comedy', 'Action'),
  ];
  const shelves = shelveByGenre(items);
  assert.ok(!named(shelves).includes('Fantasy'), 'no Fantasy shelf for one film');
  assert.strictEqual(where(shelves, 'Bruce Almighty'), 'Comedy', 'it joins the comedies');
});

check('and neither does Science Fiction over a single romance', () => {
  const items = [
    t('Eternal Sunshine', 'Science Fiction', 'Drama', 'Romance'),
    t('Fight Club', 'Drama', 'Thriller'),
    t('Good Will Hunting', 'Drama'),
    t('Hacksaw Ridge', 'Drama', 'War'),
  ];
  assert.strictEqual(where(shelveByGenre(items), 'Eternal Sunshine'), 'Drama');
});

check('two titles leading with the same genre still make it between them', () => {
  // Cowboy Bebop and Halo both lead with Science Fiction; at a minimum of two
  // that is a shelf, and neither should be swept into Action.
  const items = [
    t('Cowboy Bebop', 'Science Fiction', 'Action'),
    t('Halo', 'Science Fiction', 'Action'),
    t('Transformers', 'Action', 'Adventure'),
    t('Jackie Chan', 'Action', 'Adventure'),
  ];
  const shelves = shelveByGenre(items, { minimum: 2 });
  assert.strictEqual(where(shelves, 'Cowboy Bebop'), 'Science Fiction');
  assert.strictEqual(where(shelves, 'Halo'), 'Science Fiction');
});

check('what is left over gathers under one heading, not several', () => {
  const items = [
    t('A', 'Drama'), t('B', 'Drama'), t('C', 'Drama'),
    t('Lonely Western', 'Western'),
    t('Lonely Musical', 'Music'),
    t('Lonely Doc', 'Documentary'),
  ];
  const shelves = shelveByGenre(items);
  assert.deepStrictEqual(named(shelves), ['Drama', CATCH_ALL]);
  assert.strictEqual(shelves[1].entries.length, 3, 'all three strays together');
});

check('the leftovers sit last however many they are', () => {
  const items = [
    t('A', 'Drama'), t('B', 'Drama'), t('C', 'Drama'),
    t('W', 'Western'), t('X', 'Music'), t('Y', 'Documentary'), t('Z', 'History'),
  ];
  const shelves = shelveByGenre(items);
  assert.strictEqual(shelves[shelves.length - 1].name, CATCH_ALL);
  assert.ok(shelves[shelves.length - 1].entries.length > shelves[0].entries.length,
    'even when it is the biggest of them');
});

check('a title with no genres at all is still filed somewhere', () => {
  const items = [t('Mystery File'), t('A', 'Drama'), t('B', 'Drama'), t('C', 'Drama')];
  const shelves = shelveByGenre(items);
  assert.strictEqual(where(shelves, 'Mystery File'), CATCH_ALL);
});

check('an empty library produces no headings rather than falling over', () => {
  assert.deepStrictEqual(shelveByGenre([]), []);
});

check('the order titles arrive in does not change where they land', () => {
  const items = [
    t('Bruce Almighty', 'Fantasy', 'Comedy'),
    t('Argylle', 'Comedy', 'Action'),
    t('Back to the Future', 'Comedy', 'Adventure'),
    t('Guns Up', 'Comedy', 'Action'),
  ];
  const forwards = shelveByGenre(items);
  const backwards = shelveByGenre([...items].reverse());
  for (const item of items) {
    assert.strictEqual(where(forwards, item.title), where(backwards, item.title), item.title);
  }
});

console.log('\npassed ' + passed + ' of ' + total);
