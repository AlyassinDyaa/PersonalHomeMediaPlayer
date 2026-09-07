/**
 * Put the current source into a built app folder, completely.
 *
 * There are two front-end bundles and they are easy to confuse. `dist-web` is
 * served over HTTP to phones and browsers and lives unpacked, so it can be
 * copied in place. `dist` is the desktop window's own copy and lives inside
 * app.asar, which is a sealed archive — the only way to change it is to
 * package again.
 *
 * Deploying the first and forgetting the second is a silent failure: the app
 * keeps running yesterday's interface while every check against the server
 * passes, and the only symptom is a person saying "I don't see the change".
 * That happened twice in one day, which is why this exists rather than a
 * remembered sequence of commands.
 *
 *   node tools/deploy-to.mjs release5
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_FOLDER = 'Personal Home Media Player-win32-x64';

const target = process.argv[2];
if (!target) {
  console.error('which build folder? e.g. node tools/deploy-to.mjs release5');
  process.exit(1);
}

const destination = path.join(ROOT, target, APP_FOLDER);
if (!fs.existsSync(destination)) {
  console.error('no such build: ' + destination);
  process.exit(1);
}

const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: ROOT, stdio: 'inherit', ...options });

/** Nothing may hold the archive open while it is replaced. */
console.log('closing the app…');
try {
  run('powershell', ['-NoProfile', '-Command',
    "Get-Process -Name 'MediaLibrary' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 3"]);
} catch {
  // Not running is the normal case and not a failure.
}

console.log('packaging…');
/*
 * A fresh folder each time, rather than one reused name.
 *
 * The packager writes an asar of a few hundred megabytes, and something on
 * Windows — the indexer, or a scanner — keeps a handle on it for a while
 * afterwards. Deleting it then fails with 'device or resource busy' and the
 * whole deploy stops on a temporary file nobody cares about. So each run gets
 * its own, and the old ones are swept up when they are no longer held.
 */
const staging = path.join(ROOT, 'build-deploy-' + Date.now().toString(36));
// shell: true, because npm on Windows is a script rather than an executable.
run('npm', ['run', 'package'], {
  shell: true,
  env: { ...process.env, PACKAGE_OUT: staging },
});

/*
 * Only `resources` is replaced, and it is mirrored rather than merged so a
 * file deleted in the source cannot survive in the build. Everything a person
 * owns — the library, the settings, the passcode, the profiles — sits beside
 * the executable one level up and is never touched.
 */
console.log('copying the app code…');
try {
  run('robocopy', [
    path.join(staging, APP_FOLDER, 'resources'),
    path.join(destination, 'resources'),
    '/MIR', '/R:3', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS',
  ]);
} catch (error) {
  // robocopy uses exit codes below 8 to mean success with detail.
  if ((error.status ?? 0) >= 8) throw error;
}

/** Say plainly whether the desktop window will actually run the new code. */
const built = fs.readdirSync(path.join(ROOT, 'desktop', 'dist', 'assets'))
  .filter((name) => name.startsWith('main-') && name.endsWith('.js'));
/* Quoted: the path holds spaces, and shell:true would otherwise split it. */
const listed = execFileSync('npx', ['@electron/asar', 'list',
  JSON.stringify(path.join(destination, 'resources', 'app.asar'))],
{ encoding: 'utf8', shell: true });

const deployed = listed.split(/\r?\n/)
  .filter((line) => /desktop.dist.assets.main-.*\.js$/.test(line))
  .map((line) => line.split(/[\\/]/).pop());

const same = built.length && built.every((name) => deployed.includes(name));
console.log('\n  built in this source:  ' + built.join(', '));
console.log('  inside the deployed app: ' + deployed.join(', '));
console.log(same
  ? '\nthe desktop window will run the current code.'
  : '\nWARNING: the deployed app does not match the build.');

/* Old staging folders, cleared when whatever was holding them has let go. */
for (const name of fs.readdirSync(ROOT)) {
  if (!/^build-(deploy-|tmp$|new$|asar$|[wxyz]$|d)/.test(name)) continue;
  if (path.join(ROOT, name) === staging) continue;
  try {
    fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
    console.log('  swept ' + name);
  } catch {
    // Still held. It will go on a later run.
  }
}

if (!same) process.exit(1);
