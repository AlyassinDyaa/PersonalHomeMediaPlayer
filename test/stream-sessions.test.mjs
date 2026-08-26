/** Checks how a running stream is measured and identified. */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _internals } from '../server/src/stream/sessions.js';

const { keyFor, readProgress, COVERAGE_MARGIN_SECONDS, IDLE_TIMEOUT_MS } = _internals;

let passed = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtest-'));
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));

/** A session-shaped object pointing at a playlist written for the test. */
function sessionWith(text, name) {
  const playlistPath = path.join(sandbox, name + '.m3u8');
  if (text != null) fs.writeFileSync(playlistPath, text, 'utf8');
  return { playlistPath, producedSeconds: 0, finished: false };
}

const HEAD = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXT-X-MAP:URI="init.mp4"',
].join('\n');

const segments = (count) => Array.from({ length: count }, (_, index) => (
  '#EXTINF:6.000000,\nseg' + String(index).padStart(5, '0') + '.m4s'
)).join('\n');

await check('what a stream can serve is the sum of the segments it has written', async () => {
  // The playlist is the only honest source: ffmpeg lists a segment once it is
  // complete, so this is exactly what can be handed over right now.
  const session = sessionWith(HEAD + '\n' + segments(5) + '\n', 'growing');
  const progress = await readProgress(session);
  assert.strictEqual(progress.seconds, 30);
  assert.strictEqual(progress.hasSegments, true);
  assert.strictEqual(progress.finished, false);
});

await check('a finished stream says so', async () => {
  const session = sessionWith(HEAD + '\n' + segments(2) + '\n#EXT-X-ENDLIST\n', 'done');
  const progress = await readProgress(session);
  assert.strictEqual(progress.finished, true);
  assert.strictEqual(session.finished, true, 'the session remembers it');
});

await check('a playlist with no segments yet is not mistaken for an empty film', async () => {
  const session = sessionWith(HEAD + '\n', 'empty');
  const progress = await readProgress(session);
  assert.strictEqual(progress.hasSegments, false);
  assert.strictEqual(progress.seconds, 0);
});

await check('a playlist that does not exist yet reads as nothing, not as an error', async () => {
  const session = sessionWith(null, 'missing');
  const progress = await readProgress(session);
  assert.deepStrictEqual(progress, { seconds: 0, finished: false, hasSegments: false });
});

await check('an odd final segment is counted at its real length', async () => {
  // The last segment of a file is whatever is left over, not a round six
  // seconds, and counting it as one would claim coverage that is not there.
  const session = sessionWith(
    HEAD + '\n' + segments(2) + '\n#EXTINF:2.480000,\nseg00002.m4s\n',
    'ragged',
  );
  const progress = await readProgress(session);
  assert.strictEqual(Math.round(progress.seconds * 100) / 100, 14.48);
});

await check('the point a stream reaches is where it began plus what it has produced', async () => {
  const session = sessionWith(HEAD + '\n' + segments(10) + '\n', 'offset');
  const { seconds } = await readProgress(session);
  const startSeconds = 1200;
  // A seek within this is served by the running stream; one past it needs a
  // new one, which is the whole reason the figure is wanted.
  assert.strictEqual(startSeconds + seconds, 1260);
  assert.ok(1250 <= startSeconds + seconds - COVERAGE_MARGIN_SECONDS, 'covered');
  assert.ok(!(1258 <= startSeconds + seconds - COVERAGE_MARGIN_SECONDS), 'too near the edge');
});

await check('two picture sizes of the same moment are different streams', async () => {
  // Handing a session encoded down for a phone to a laptop asking for full
  // size would silently give the laptop the small one.
  assert.notStrictEqual(keyFor('v1', 60, 480), keyFor('v1', 60, 1080));
  assert.strictEqual(keyFor('v1', 60, null), keyFor('v1', 60, null));
});

await check('a start time is rounded down to a whole second, never below zero', async () => {
  assert.strictEqual(keyFor('v1', 60.7, null), keyFor('v1', 60, null));
  assert.strictEqual(keyFor('v1', -5, null), keyFor('v1', 0, null));
});

await check('a paused episode outlives an advert break', async () => {
  // This was ninety seconds, measured from the last segment request, so
  // pausing to answer the door ended the stream and deleted its segments.
  assert.ok(IDLE_TIMEOUT_MS >= 5 * 60_000, 'a pause must not end the stream');
});

console.log('\npassed ' + passed + ' of ' + total);
