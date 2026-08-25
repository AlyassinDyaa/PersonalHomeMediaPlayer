#!/usr/bin/env node
/** Command-line entry point for a library scan. */

import { runScan } from '../scan/index.js';
import { config, hasTmdb } from '../config.js';
import { closeDb } from '../db.js';

const startedAt = Date.now();
let lastLine = '';

function write(line) {
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r' + line);
    lastLine = line;
  } else {
    console.log(line);
  }
}

function finishLine() {
  if (process.stdout.isTTY && lastLine) {
    process.stdout.write('\n');
    lastLine = '';
  }
}

console.log('Library roots: ' + (config.libraryRoots.join(', ') || '(none configured)'));
console.log('Metadata:      ' + (hasTmdb() ? 'TMDB enabled' : 'disabled (no API key)'));
console.log('Database:      ' + config.databasePath);
console.log('');

try {
  const stats = await runScan({
    onProgress: (event) => {
      if (event.phase === 'metadata' && event.total) {
        write('  [' + event.done + '/' + event.total + '] ' + event.message.slice(0, 60));
      } else {
        finishLine();
        console.log('  ' + event.message);
      }
    },
  });
  finishLine();

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log('Done in ' + seconds + 's');
  console.log('  ' + stats.movies + ' movies, ' + stats.shows + ' shows, ' + stats.videos + ' playable files');
  console.log('  ' + stats.walked + ' files walked, ' + stats.skipped + ' skipped as junk');
  if (stats.removedItems || stats.removedVideos) {
    console.log('  removed ' + stats.removedItems + ' items and ' + stats.removedVideos + ' files no longer on disk');
  }
  if (stats.suggestions) {
    console.log('  ' + stats.suggestions + ' grouping suggestions await confirmation');
  }
  if (stats.missingRoots.length) {
    console.log('  unavailable roots: ' + stats.missingRoots.join(', '));
  }
} catch (error) {
  finishLine();
  console.error('Scan failed:', error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  closeDb();
}
