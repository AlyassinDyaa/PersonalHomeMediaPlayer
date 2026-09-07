/**
 * Checks that one folder on disk comes out as one show.
 *
 * A season folder is only ever named by whoever ripped it, and the four
 * seasons of one children's series sitting side by side under one folder had
 * been named four different ways: a scene release that spells the show out, a
 * disc rip that adds the studio's name, and two store rips that say nothing
 * but the numbers. The library showed that as two shows, one of them matching
 * nothing in any database, and lost a whole season on the way — twenty-four
 * files that no rule could see an episode number in.
 *
 * These are the shapes that have to survive, and the shapes that must still be
 * kept apart: a folder holding two genuinely different shows is not a naming
 * accident, and two files claiming the same episode are not one show.
 */

import assert from 'node:assert';
import { groupLibrary } from '../server/src/scan/group.js';
import { parseEpisodeFile } from '../server/src/scan/parse.js';

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

/** A walked file, as the scanner hands it over. */
function file(topFolder, chain, name) {
  return {
    path: ['G:', topFolder, ...chain, name].join('/'),
    name,
    ext: name.slice(name.lastIndexOf('.')),
    size: 700 * 1024 * 1024,
    root: 'G:/',
    topFolder,
    chain,
  };
}

function group(videos) {
  return groupLibrary({ videos, subtitles: [] });
}

// ------------------------------------------------ the number in the name ---

check('a number the ripper set off with a dash is the episode', () => {
  const parsed = parseEpisodeFile('Care Bears Dic 01 - Camp.avi', { fallbackSeason: 1 });
  assert.strictEqual(parsed.season, 1);
  assert.strictEqual(parsed.episode, 1);
  assert.strictEqual(parsed.seriesTitle, 'Care Bears Dic');
  assert.strictEqual(parsed.episodeTitle, 'Camp');
});

check('the intro and the credits that come with the rip are not episodes', () => {
  assert.strictEqual(parseEpisodeFile('Care Bears Dic 00a - Intro.avi', { fallbackSeason: 1 }), null);
  assert.strictEqual(parseEpisodeFile('Care Bears Dic 00b - Credit.avi', { fallbackSeason: 1 }), null);
});

check('a number that is part of the title is not an episode', () => {
  // No dash sets it off, so nothing here says the 10 is a number of anything.
  assert.strictEqual(parseEpisodeFile('Ben 10 Secrets.mkv', { fallbackSeason: 1 }), null);
});

check('a season nobody says out loud is still not guessed at', () => {
  assert.strictEqual(parseEpisodeFile('Care Bears Dic 01 - Camp.avi', {}), null);
});

// ------------------------------------------------------- one show, or two ---

check('four seasons named four ways are one show', () => {
  const top = 'The.Care.Bears.S01-S04.DVDRip.Webrip';
  const videos = [
    // A disc rip: the studio's name, then a number set off with a dash.
    ...Array.from({ length: 22 }, (_, i) =>
      file(top, ['The.Care.Bears.S01.DVDRip.Xvid-NOGRP'], 'Care Bears Dic ' + String(i + 1).padStart(2, '0') + ' - Episode.avi')),
    // A scene release: the show spelled out.
    ...Array.from({ length: 16 }, (_, i) =>
      file(top, ['Care.Bears.Season.2.1986.COMPLETE.DVDRip.XviD-EiGHTiES'], 'Care.Bears.S02E' + String(i + 1).padStart(2, '0') + ' - Episode.avi')),
    // A store rip: the numbers and nothing else.
    ...Array.from({ length: 12 }, (_, i) =>
      file(top, ['The.Care.Bears.S03.1987.AMZN.WEBRip.X264'], 'S03E' + String(i + 1).padStart(2, '0') + ' - Episode.mkv')),
    ...Array.from({ length: 27 }, (_, i) =>
      file(top, ['The.Care.Bears.S04.1988.AMZN.WEBRip.X264'], 'S04E' + String(i + 1).padStart(2, '0') + ' - Episode.mkv')),
  ];

  const { shows, movies } = group(videos);
  assert.strictEqual(movies.length, 0);
  assert.strictEqual(shows.length, 1, 'one folder, one show');

  const [show] = shows;
  assert.strictEqual(show.key, 'care bears', 'the name a database has heard of');
  assert.strictEqual(show.title, 'Care Bears');
  assert.deepStrictEqual(show.seasons.map((s) => s.number), [1, 2, 3, 4]);
  assert.deepStrictEqual(show.seasons.map((s) => s.episodes.length), [22, 16, 12, 27]);
  // The studio's spelling is remembered, in case the lookup does better with it.
  assert.ok(show.titleCandidates.includes('Care Bears Dic'));
});

check('files that name no show join the one the folder names', () => {
  const top = 'Show.Complete';
  const videos = [
    ...Array.from({ length: 10 }, (_, i) =>
      file(top, ['Season 1'], 'The.Owl.House.S01E' + String(i + 1).padStart(2, '0') + '.mkv')),
    ...Array.from({ length: 10 }, (_, i) =>
      file(top, ['Season 2'], 'S02E' + String(i + 1).padStart(2, '0') + ' - Episode.mkv')),
  ];

  const { shows } = group(videos);
  assert.strictEqual(shows.length, 1);
  assert.strictEqual(shows[0].key, 'owl house');
  assert.deepStrictEqual(shows[0].seasons.map((s) => s.episodes.length), [10, 10]);
});

check('nameless files claiming episodes already taken stay apart', () => {
  // Both sets are season 1, episodes 1-10: two shows sharing a folder, not one
  // show named twice. Folding them would lose ten episodes to conflicts.
  const top = 'Two.Shows';
  const videos = [
    ...Array.from({ length: 10 }, (_, i) =>
      file(top, ['A'], 'Justice.League.S01E' + String(i + 1).padStart(2, '0') + '.mkv')),
    ...Array.from({ length: 10 }, (_, i) =>
      file(top, ['B'], 'S01E' + String(i + 1).padStart(2, '0') + ' - Episode.mkv')),
  ];

  assert.strictEqual(group(videos).shows.length, 2);
});

check('two different shows in one folder are still two shows', () => {
  const top = 'DC.Animated';
  const videos = [
    ...Array.from({ length: 12 }, (_, i) =>
      file(top, [], 'Justice.League.S01E' + String(i + 1).padStart(2, '0') + '.mkv')),
    ...Array.from({ length: 12 }, (_, i) =>
      file(top, [], 'Justice.League.Unlimited.S01E' + String(i + 1).padStart(2, '0') + '.mkv')),
  ];

  const { shows } = group(videos);
  assert.strictEqual(shows.length, 2, 'Unlimited is its own series');
});

console.log('\npassed ' + passed + ' of ' + total);
