/** Checks the rules that decide where the library's own files live. */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateTarget, copyLibrary, saveDataDir,
} = require('../desktop/electron/data-location.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'datamove-'));
let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

/** A stand-in for a scanned library: a database and some artwork. */
function makeLibrary(dir, marker) {
  fs.mkdirSync(path.join(dir, 'artwork'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.db'), 'database:' + marker);
  fs.writeFileSync(path.join(dir, 'artwork', 'poster.jpg'), 'image:' + marker);
}

check('an empty choice is refused', () => {
  const result = validateTarget(path.join(root, 'a'), '   ');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /No folder/);
});

check('choosing the folder already in use is a no-op, not a copy', () => {
  const here = path.join(root, 'same');
  fs.mkdirSync(here, { recursive: true });
  const result = validateTarget(here, here);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sameFolder, true);
});

check('a folder inside the current one is refused', () => {
  const from = path.join(root, 'outer');
  fs.mkdirSync(from, { recursive: true });
  const result = validateTarget(from, path.join(from, 'nested'));
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /outside the current one/);
});

check('a sibling folder is accepted and created', () => {
  const from = path.join(root, 'from1');
  const to = path.join(root, 'to1');
  fs.mkdirSync(from, { recursive: true });
  const result = validateTarget(from, to);
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(to), 'the folder was created');
  assert.ok(!fs.existsSync(path.join(to, '.write-test')), 'the probe file was cleaned up');
});

check('a path that cannot be created is refused rather than throwing', () => {
  // A file cannot also be a directory.
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const result = validateTarget(path.join(root, 'from2'), path.join(blocker, 'child'));
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /cannot be written to/);
});

check('an existing library is copied across intact', () => {
  const from = path.join(root, 'from3');
  const to = path.join(root, 'to3');
  makeLibrary(from, 'original');
  fs.mkdirSync(to, { recursive: true });

  const outcome = copyLibrary(from, to);
  assert.strictEqual(outcome.copied, true);
  assert.strictEqual(
    fs.readFileSync(path.join(to, 'library.db'), 'utf8'), 'database:original',
  );
  assert.strictEqual(
    fs.readFileSync(path.join(to, 'artwork', 'poster.jpg'), 'utf8'), 'image:original',
    'artwork came too',
  );
});

check('a library already in the target is adopted, never overwritten', () => {
  const from = path.join(root, 'from4');
  const to = path.join(root, 'to4');
  makeLibrary(from, 'incoming');
  makeLibrary(to, 'already-there');

  const outcome = copyLibrary(from, to);
  assert.strictEqual(outcome.adopted, true);
  assert.strictEqual(outcome.copied, false);
  assert.strictEqual(
    fs.readFileSync(path.join(to, 'library.db'), 'utf8'), 'database:already-there',
    'the existing library survived',
  );
});

check('moving from a folder that does not exist yet is harmless', () => {
  const to = path.join(root, 'to5');
  fs.mkdirSync(to, { recursive: true });
  const outcome = copyLibrary(path.join(root, 'never-scanned'), to);
  assert.strictEqual(outcome.copied, false);
  assert.strictEqual(outcome.adopted, false);
});

check('the choice is written where both processes read it', () => {
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.local.json'),
    JSON.stringify({ libraryName: 'Dyaa', tmdbApiKey: 'secret' }),
  );

  const written = saveDataDir(configDir, 'D:\\Media\\LibraryData');
  const saved = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.strictEqual(saved.dataDir, 'D:/Media/LibraryData', 'stored with forward slashes');
  assert.strictEqual(saved.libraryName, 'Dyaa', 'existing settings kept');
  assert.strictEqual(saved.tmdbApiKey, 'secret', 'the API key was not dropped');
});

check('the choice can be written when no settings file exists yet', () => {
  const configDir = path.join(root, 'fresh-config');
  const written = saveDataDir(configDir, path.join(root, 'somewhere'));
  assert.ok(fs.existsSync(written));
  assert.ok(JSON.parse(fs.readFileSync(written, 'utf8')).dataDir);
});

fs.rmSync(root, { recursive: true, force: true });
console.log('\npassed ' + passed + ' of ' + total);
