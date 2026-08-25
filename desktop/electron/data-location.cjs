/**
 * Moving the library's own files to a folder the user chooses.
 *
 * The database and artwork are not the user's media — they are what this app
 * builds from it — but a full scan represents real time, so changing where they
 * live copies them across rather than starting over.
 *
 * Kept apart from the main process so the rules can be exercised directly: the
 * checks here are the difference between moving a library and losing one.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Whether `target` can be used as the data folder, given where it is now.
 *
 * @param {string} source the folder in use
 * @param {string} target the folder the user picked
 * @returns {{ok: boolean, error?: string, destination?: string, sameFolder?: boolean}}
 */
function validateTarget(source, target) {
  if (!target || typeof target !== 'string' || !target.trim()) {
    return { ok: false, error: 'No folder chosen' };
  }

  const destination = path.resolve(target.trim());
  const from = path.resolve(source);

  if (from === destination) return { ok: true, destination, sameFolder: true };

  // A folder inside the current one would be copied into itself.
  const inside = path.relative(from, destination);
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
    return { ok: false, error: 'Choose a folder outside the current one' };
  }

  try {
    fs.mkdirSync(destination, { recursive: true });
    const probe = path.join(destination, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
  } catch (error) {
    return { ok: false, error: 'That folder cannot be written to: ' + error.message };
  }

  return { ok: true, destination };
}

/**
 * Copy an existing library across, unless the target already holds one.
 *
 * Refusing to overwrite matters: pointing the app at a folder that already has
 * a library should adopt it, not replace it with the one being left behind.
 *
 * @returns {{copied: boolean, adopted: boolean}}
 */
function copyLibrary(source, destination) {
  if (!fs.existsSync(source)) return { copied: false, adopted: false };
  if (fs.existsSync(path.join(destination, 'library.db'))) {
    return { copied: false, adopted: true };
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
  return { copied: true, adopted: false };
}

/**
 * Record the choice where both the desktop app and the server will read it.
 * Forward slashes throughout, matching how paths are stored elsewhere.
 */
function saveDataDir(configDir, destination) {
  const configPath = path.join(configDir, 'config.local.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // An unreadable file is replaced rather than allowed to block the change.
    saved = {};
  }
  saved.dataDir = destination.replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(saved, null, 2) + '\n', 'utf8');
  return configPath;
}

module.exports = { validateTarget, copyLibrary, saveDataDir };
