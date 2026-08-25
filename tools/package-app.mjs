/**
 * Build a portable Windows app folder.
 *
 * Uses @electron/packager rather than electron-builder because building an
 * installer on Windows pulls in a code-signing bundle whose macOS symlinks
 * cannot be extracted without Developer Mode or administrator rights. This
 * path has no such requirement and produces a folder that runs anywhere.
 */

import { packager } from '@electron/packager';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');

/** Everything the app does not need at runtime. */
const IGNORE = [
  /^\/release($|\/)/,
  /^\/data($|\/)/,
  /^\/tools($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.env$/,
  /^\/config\.local\.json$/,
  /^\/desktop\/src($|\/)/,
  /^\/desktop\/index\.html$/,
  /^\/desktop\/overlay\.html$/,
  /^\/desktop\/vite\.config\.js$/,
  /^\/desktop\/scripts($|\/)/,
  // Build-time only dependencies; large and never loaded at runtime.
  /^\/node_modules\/(electron|@electron|electron-builder|app-builder-lib|vite|@vitejs|esbuild|@esbuild|rollup|@rollup|7zip-bin|dmg-license|builder-util.*|electron-publish|app-builder-bin)($|\/)/,
];

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Electron is a dependency of the desktop workspace, not the root, so its
// version is read directly rather than inferred from the root package.json.
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8'),
).version;

console.log('Packaging Personal Home Media Player ' + version + '…');

const [appPath] = await packager({
  dir: ROOT,
  out: OUT,
  name: 'Personal Home Media Player',
  executableName: 'MediaLibrary',
  appVersion: version,
  platform: 'win32',
  electronVersion,
  arch: 'x64',
  overwrite: true,
  asar: {
    // The server runs under a real Node process, which cannot read an asar
    // archive. Its sources, its dependencies and the config it loads all have
    // to exist as ordinary files on disk.
    unpack: '{**/server/**/*,**/node_modules/**/*,**/config.json}',
  },
  prune: false,
  ignore: IGNORE,
  win32metadata: {
    CompanyName: 'AlyassinDyaa',
    FileDescription: 'Personal Home Media Player',
    ProductName: 'Personal Home Media Player',
  },
});

// A README beside the app, since the server needs a Node runtime present.
const notes = [
  'Personal Home Media Player ' + version,
  '',
  'Run MediaLibrary.exe to start.',
  '',
  'Requirements',
  '  * Node.js 22 or newer must be installed (nodejs.org). The media server',
  '    runs as a separate process and uses Node\'s built-in SQLite, which',
  '    Electron does not yet bundle.',
  '  * mpv must be installed for playback (winget install shinchiro.mpv).',
  '',
  'On first run, open the Library tab, add the folder holding your movies and',
  'shows, and press Scan. Settings and the database are stored per-user under',
  '%APPDATA%\\Personal Home Media Player.',
  '',
].join('\r\n');

await fsp.writeFile(path.join(appPath, 'README.txt'), notes, 'utf8');

const size = await folderSize(appPath);
console.log('\nBuilt: ' + appPath);
console.log('Size:  ' + (size / 1024 / 1024).toFixed(0) + ' MB');
console.log('\nZip that folder to share it, or run MediaLibrary.exe directly.');

async function folderSize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else total += (await fsp.stat(full)).size;
  }
  return total;
}
