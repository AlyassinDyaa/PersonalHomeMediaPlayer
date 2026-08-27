/**
 * Checks that saved settings survive a restart.
 *
 * Configuration is resolved once, when the module is first imported, so each
 * case that needs a different environment runs in its own process against its
 * own throwaway settings folder. The real settings file is never touched.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_MODULE = path.resolve(HERE, '..', 'server', 'src', 'config.js');

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

const sandboxes = [];
process.on('exit', () => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

/** A settings folder holding the given config.local.json. */
function sandboxWith(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settingstest-'));
  sandboxes.push(dir);
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local, null, 2), 'utf8');
  return dir;
}

/**
 * Load the configuration in a fresh process and report back.
 *
 * @param {string} dir settings folder
 * @param {object} env extra environment variables
 * @param {string} [body] extra statements to run before reporting
 */
function resolveConfig(dir, env = {}, body = '') {
  const script = `
    const { config, settingsView, saveSettings } = await import(${JSON.stringify(CONFIG_MODULE)});
    ${body}
    process.stdout.write(JSON.stringify({
      tmdbApiKey: config.tmdbApiKey,
      libraryRoots: config.libraryRoots,
      mpvPath: config.mpvPath,
      tmdbLanguage: config.tmdbLanguage,
      view: settingsView(),
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      MEDIA_CONFIG_DIR: dir,
      MEDIA_DATA_DIR: path.join(dir, 'data'),
      ...env,
    },
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

// --- the bug that made a saved key look like it was never saved -----------

check('a saved API key is still there on the next run', () => {
  const dir = sandboxWith({ tmdbApiKey: 'saved-key-1234' });
  assert.strictEqual(resolveConfig(dir).tmdbApiKey, 'saved-key-1234');
});

check('a blank environment variable does not mask the saved key', () => {
  // This is what made the key appear to vanish on every restart: an empty
  // string is neither null nor undefined, so it won the ?? chain, every time,
  // however many times the key was entered again.
  const dir = sandboxWith({ tmdbApiKey: 'saved-key-1234' });
  const resolved = resolveConfig(dir, { TMDB_API_KEY: '' });
  assert.strictEqual(resolved.tmdbApiKey, 'saved-key-1234');
  assert.strictEqual(resolved.view.tmdbConfigured, true);
});

check('a whitespace-only environment variable is no better than a blank one', () => {
  const dir = sandboxWith({ tmdbApiKey: 'saved-key-1234' });
  assert.strictEqual(resolveConfig(dir, { TMDB_API_KEY: '   ' }).tmdbApiKey, 'saved-key-1234');
});

check('an environment variable that says something still wins', () => {
  // The precedence itself is deliberate and must not be lost in the fixing.
  const dir = sandboxWith({ tmdbApiKey: 'saved-key-1234' });
  assert.strictEqual(resolveConfig(dir, { TMDB_API_KEY: 'from-env' }).tmdbApiKey, 'from-env');
});

check('a blank variable does not empty the library either', () => {
  // The same fault in a different place: an empty array is not nullish, so a
  // blank MEDIA_LIBRARY_ROOTS wiped the configured folders.
  const dir = sandboxWith({ libraryRoots: ['E:/Movies&Shows'] });
  const resolved = resolveConfig(dir, { MEDIA_LIBRARY_ROOTS: '' });
  assert.deepStrictEqual(resolved.libraryRoots, ['E:/Movies&Shows']);
});

check('a blank variable does not erase the mpv path', () => {
  const dir = sandboxWith({ mpvPath: 'D:/mpv/mpv.exe' });
  assert.strictEqual(resolveConfig(dir, { MPV_PATH: '' }).mpvPath, 'D:/mpv/mpv.exe');
});

check('a blank language falls back to the default rather than to nothing', () => {
  const dir = sandboxWith({});
  assert.strictEqual(resolveConfig(dir, { TMDB_LANGUAGE: '' }).tmdbLanguage, 'en-US');
});

// --- storing and clearing --------------------------------------------------

check('a key saved through the settings survives into the next run', () => {
  const dir = sandboxWith({});
  resolveConfig(dir, {}, "saveSettings({ tmdbApiKey: 'entered-once-9876' });");
  assert.strictEqual(resolveConfig(dir).tmdbApiKey, 'entered-once-9876');
});

check('a key is stored trimmed, so a pasted space does not break it', () => {
  const dir = sandboxWith({});
  resolveConfig(dir, {}, "saveSettings({ tmdbApiKey: '  spaced-key-5555\\n' });");
  assert.strictEqual(resolveConfig(dir).tmdbApiKey, 'spaced-key-5555');
});

check('an empty value removes the key rather than storing a blank one', () => {
  // A blank string would be a setting that reads as present and behaves as
  // absent, which is the same confusion in a new place.
  const dir = sandboxWith({ tmdbApiKey: 'saved-key-1234' });
  const after = resolveConfig(dir, {}, "saveSettings({ tmdbApiKey: '' });");
  assert.strictEqual(after.view.tmdbConfigured, false);
  assert.strictEqual(resolveConfig(dir).tmdbApiKey, null);
});

// --- staying awake ---------------------------------------------------------

check('the computer is kept awake while sharing unless told otherwise', () => {
  // A sleeping computer serves nobody, so this defaults on rather than off.
  const dir = sandboxWith({});
  assert.strictEqual(resolveConfig(dir).view.keepAwakeWhileSharing, true);
});

check('turning off keep-awake sticks', () => {
  const dir = sandboxWith({});
  resolveConfig(dir, {}, 'saveSettings({ keepAwakeWhileSharing: false });');
  assert.strictEqual(resolveConfig(dir).view.keepAwakeWhileSharing, false);
});

check('keep-awake can be turned back on', () => {
  const dir = sandboxWith({ keepAwakeWhileSharing: false });
  resolveConfig(dir, {}, 'saveSettings({ keepAwakeWhileSharing: true });');
  assert.strictEqual(resolveConfig(dir).view.keepAwakeWhileSharing, true);
});

check('anything that is not a yes or no is ignored rather than stored', () => {
  const dir = sandboxWith({});
  resolveConfig(dir, {}, "saveSettings({ keepAwakeWhileSharing: 'yes please' });");
  assert.strictEqual(resolveConfig(dir).view.keepAwakeWhileSharing, true);
});

// --- what the interface is allowed to see ---------------------------------

check('the interface is shown enough of the key to recognise it', () => {
  const dir = sandboxWith({ tmdbApiKey: 'abcdef0123456789' });
  const { view } = resolveConfig(dir);
  assert.strictEqual(view.tmdbKeyHint, '••••6789');
});

check('the key itself is never sent to the interface', () => {
  const dir = sandboxWith({ tmdbApiKey: 'abcdef0123456789' });
  const { view } = resolveConfig(dir);
  assert.strictEqual(JSON.stringify(view).includes('abcdef0123456789'), false);
  assert.strictEqual(view.tmdbApiKey, undefined);
});

check('a short key is not padded out into something recognisable', () => {
  const dir = sandboxWith({ tmdbApiKey: 'abc' });
  assert.strictEqual(resolveConfig(dir).view.tmdbKeyHint, '••••');
});

check('no key at all shows no hint', () => {
  const dir = sandboxWith({});
  assert.strictEqual(resolveConfig(dir).view.tmdbKeyHint, null);
});

console.log('\npassed ' + passed + ' of ' + total);
