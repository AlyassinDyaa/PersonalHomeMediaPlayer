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
// Overridable so a build can go elsewhere when the previous output is still
// locked by an indexer or a running copy.
const OUT = process.env.PACKAGE_OUT || path.join(ROOT, 'release');

/** Everything the app does not need at runtime. */
const IGNORE = [
  // Any previous build output, so one package never folds into the next.
  /^\/release\d*($|\/)/,
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

// Mark the build as portable, so it keeps its data beside the executable
// rather than under the user's AppData folder.
await fsp.writeFile(
  path.join(appPath, 'portable.txt'),
  'Delete this file to store the library under %APPDATA% instead.\r\n',
  'utf8',
);

// Carry a Node runtime and mpv so the folder runs on a machine with neither
// installed — the point of putting it on a removable drive.
const bundledNode = await copyBundledNode(appPath);
const bundledMpv = await copyBundledMpv(appPath);

// A README beside the app, since the server needs a Node runtime present.
const notes = [
  'Personal Home Media Player ' + version,
  '',
  'Run MediaLibrary.exe to start.',
  '',
  'Requirements',
  bundledNode
    ? '  * Node runtime: included (runtime\\node.exe).'
    : '  * Node.js 22 or newer must be installed (nodejs.org).',
  bundledMpv
    ? '  * mpv player: included (mpv\\mpv.exe).'
    : '  * mpv must be installed (winget install shinchiro.mpv).',
  '',
  'Portable',
  '  This folder is self-contained. Copy it to a USB stick or external SSD and',
  '  run it from there. The library database, artwork cache and settings are',
  '  written to the data folder beside MediaLibrary.exe, so everything travels',
  '  with the drive. Delete portable.txt to store them under %APPDATA% instead.',
  '',
  'First run',
  '  Open the Library tab, add the folder holding your movies and shows, paste',
  '  a TMDB API key for artwork and descriptions, then press Scan.',
  '',
  'If Windows blocks the app, that is SmartScreen or Smart App Control warning',
  'about an unsigned program. Choose "More info" then "Run anyway".',
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

/**
 * Copy the running Node executable into the package.
 *
 * The media server runs under Node rather than inside Electron, because it uses
 * Node's built-in SQLite and Electron still bundles a Node release that
 * predates it. Shipping the runtime keeps the folder self-contained.
 */
async function copyBundledNode(appDir) {
  const source = process.execPath;
  if (!source || !/node(\.exe)?$/i.test(source)) {
    console.warn('  ! Could not identify a Node executable to bundle.');
    return null;
  }
  const target = path.join(appDir, 'runtime');
  await fsp.mkdir(target, { recursive: true });
  await fsp.copyFile(source, path.join(target, 'node.exe'));
  console.log('  + bundled Node runtime from ' + source);
  return true;
}

/** Copy an installed mpv, with the files it needs, into the package. */
async function copyBundledMpv(appDir) {
  const candidates = [
    'C:/Program Files/MPV Player',
    'C:/Program Files/mpv',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/mpv') : null,
  ].filter(Boolean);

  const source = candidates.find((dir) => fs.existsSync(path.join(dir, 'mpv.exe')));
  if (!source) {
    console.warn('  ! mpv was not found locally, so it is not bundled.');
    return null;
  }

  const target = path.join(appDir, 'mpv');
  await fsp.mkdir(target, { recursive: true });

  // Only the player and the libraries beside it; skip installer leftovers and
  // documentation, which are large and useless here.
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/^unins|\.(txt|md|log|dat)$/i.test(entry.name)) continue;
    await fsp.copyFile(path.join(source, entry.name), path.join(target, entry.name));
  }
  console.log('  + bundled mpv from ' + source);
  return true;
}
