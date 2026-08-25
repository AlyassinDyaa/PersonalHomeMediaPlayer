/** Dry-run the walk + group pipeline against the real library and report. */
import { walkLibrary } from '../server/src/scan/walk.js';
import { groupLibrary } from '../server/src/scan/group.js';

const ROOTS = ['E:/Movies&Shows'];

const t0 = Date.now();
const walked = walkLibrary(ROOTS);
const tWalk = Date.now() - t0;

const t1 = Date.now();
const { movies, shows, suggestions } = groupLibrary(walked);
const tGroup = Date.now() - t1;

const pad = (s, n) => String(s).padEnd(n);
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)}G`;

console.log(`walked ${walked.videos.length} videos + ${walked.subtitles.length} subs in ${tWalk}ms`);
console.log(`grouped into ${movies.length} movies and ${shows.length} shows in ${tGroup}ms`);
console.log(`skipped ${walked.skipped.length} junk/sample files`);

console.log('\n' + '='.repeat(112));
console.log(`MOVIES (${movies.length})`);
console.log('='.repeat(112));
for (const m of movies.sort((a, b) => a.title.localeCompare(b.title))) {
  console.log(
    `  ${pad(m.title, 44)} ${pad(m.year ?? '----', 6)} ${pad(gb(m.file.size), 7)} ` +
    `subs=${pad(m.subtitles.length, 4)} src=${m.titleSource}`,
  );
}

console.log('\n' + '='.repeat(112));
console.log(`SHOWS (${shows.length})`);
console.log('='.repeat(112));
for (const s of shows.sort((a, b) => a.title.localeCompare(b.title))) {
  const totalEps = s.seasons.reduce((n, se) => n + se.episodes.length, 0);
  const seasonList = s.seasons.map((se) => `S${se.number}:${se.episodes.length}`).join(' ');
  console.log(`  ${pad(s.title, 40)} ${pad(s.year ?? '----', 6)} ${pad(`${totalEps}ep`, 6)} ${seasonList}`);
  if (s.signals.mergedFolders > 1) {
    console.log(`      merged ${s.signals.mergedFolders} folders: ${s.sourceFolders.map((f) => f.slice(0, 42)).join(' + ')}`);
  }
  if (s.conflicts.length) {
    console.log(`      ${s.conflicts.length} duplicate episodes resolved by file size`);
  }
}

console.log('\n' + '='.repeat(112));
console.log(`MERGE SUGGESTIONS (${suggestions.length}) — for the UI to confirm`);
console.log('='.repeat(112));
for (const sug of suggestions) {
  console.log(`  [${sug.confidence.toFixed(2)}] ${sug.titles.join('  <->  ')}`);
  console.log(`         ${sug.reason}`);
}

// Sanity checks worth eyeballing.
console.log('\n' + '='.repeat(112));
console.log('SANITY CHECKS');
console.log('='.repeat(112));
const gaps = [];
for (const s of shows) {
  for (const se of s.seasons) {
    const nums = se.episodes.map((e) => e.episode);
    const max = Math.max(...nums);
    const missing = [];
    for (let i = 1; i <= max; i++) if (!nums.includes(i)) missing.push(i);
    if (missing.length) gaps.push(`${s.title} S${se.number}: missing ${missing.join(',')} (of ${max})`);
  }
}
console.log(`  episode gaps: ${gaps.length}`);
gaps.slice(0, 15).forEach((g) => console.log(`    ${g}`));

const noYear = movies.filter((m) => !m.year);
console.log(`  movies with no year: ${noYear.length} ${noYear.map((m) => m.title).join(', ') || ''}`);

const season0 = shows.flatMap((s) => s.seasons.filter((se) => se.number === 0).map(() => s.title));
console.log(`  shows with a season 0: ${season0.length} ${season0.join(', ')}`);
