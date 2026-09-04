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
// Shared with the server, so the build writes the key in exactly the form the
// server reads.
import { encodeKey, KEY_FILENAME } from '../server/src/bundled-key.js';

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
  /^\/desktop\/vite\.web\.config\.js$/,
  /^\/desktop\/web($|\/)/,
  /^\/desktop\/scripts($|\/)/,
  // ffmpeg is copied beside the executable rather than packed into the archive,
  // where the server process could not read it anyway.
  /^\/vendor($|\/)/,
  /^\/test($|\/)/,
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
    // dist-web is served over HTTP by the server process, which is a plain
    // Node process and cannot read an archive, so it has to be a real folder.
    unpack: '{**/server/**/*,**/node_modules/**/*,**/config.json,**/desktop/dist-web/**/*}',
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

// Carry the metadata key, so a fresh copy shows artwork and descriptions
// straight away instead of asking for a key before it can do anything.
await writeMetadataKey(appPath);

// Carry a Node runtime and mpv so the folder runs on a machine with neither
// installed — the point of putting it on a removable drive.
const bundledNode = await copyBundledNode(appPath);
const bundledMpv = await copyBundledMpv(appPath);
const bundledFfmpeg = await copyBundledFfmpeg(appPath);

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
  bundledFfmpeg
    ? '  * ffmpeg: included, for watching on phones and tablets.'
    : '  * ffmpeg: not included, so only this computer can play video.',
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
  '  Open the Library tab, add the folder holding your movies and shows, then',
  '  press Scan. Artwork and descriptions need no setting up: a metadata key',
  '  comes with this folder. Settings can replace it with your own if you have',
  '  one, and can put the included one back again.',
  '',
  'If Windows blocks the app, that is SmartScreen or Smart App Control warning',
  'about an unsigned program. Choose "More info" then "Run anyway".',
  '',
].join('\r\n');

await fsp.writeFile(path.join(appPath, 'README.txt'), notes, 'utf8');

// Scripts for running the server without the app.
//
// Copied rather than written inline: a rebuild replaces this folder wholesale,
// so anything a person drops in by hand disappears with the next build.
for (const name of ['start-library-server.cmd', 'start-library-hidden.vbs']) {
  await fsp.copyFile(path.join(ROOT, 'tools', 'standalone', name), path.join(appPath, name));
}

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
/**
 * ffmpeg, which is what lets a phone or tablet play a Matroska file: the
 * picture is repackaged rather than re-encoded, so it costs little, but it
 * cannot happen without this.
 */
async function copyBundledFfmpeg(appDir) {
  const source = path.join(ROOT, 'vendor', 'ffmpeg');
  if (!fs.existsSync(path.join(source, 'ffmpeg.exe'))) {
    console.warn('  ! ffmpeg was not found in vendor/, so browsers cannot be served.');
    return null;
  }
  const target = path.join(appDir, 'ffmpeg');
  await fsp.mkdir(target, { recursive: true });
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    await fsp.copyFile(path.join(source, name), path.join(target, name));
  }
  console.log('  + bundled ffmpeg from ' + source);
  return true;
}

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

/**
 * Write the metadata key into the built folder.
 *
 * Taken from this machine's own gitignored configuration, so the key lives in
 * exactly two places — the developer's machine and the folder that gets built —
 * and never in the repository, which is public.
 *
 * A build made without a key still works; the app asks for one in Settings, as
 * it did before.
 */
async function writeMetadataKey(appPath) {
  const key = await findLocalKey();
  if (!key) {
    console.log('  ! no metadata key found, so the build will ask for one');
    return;
  }
  await fsp.writeFile(
    path.join(appPath, KEY_FILENAME),
    encodeKey(key) + '\r\n',
    'utf8',
  );
  console.log('  + metadata key bundled (' + key.slice(0, 4) + '…' + key.slice(-4) + ')');
}

/** The key this machine uses, from the environment or either local config. */
async function findLocalKey() {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY.trim();

  const local = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(local)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(local, 'utf8'));
      if (parsed.tmdbApiKey) return String(parsed.tmdbApiKey).trim();
    } catch {
      // A malformed local config is not this script's problem to report.
    }
  }

  const dotenv = path.join(ROOT, '.env');
  if (fs.existsSync(dotenv)) {
    const match = (await fsp.readFile(dotenv, 'utf8'))
      .match(/^\s*TMDB_API_KEY\s*=\s*(.+?)\s*$/m);
    if (match) return match[1].replace(/^["']|["']$/g, '').trim();
  }

  return null;
}
