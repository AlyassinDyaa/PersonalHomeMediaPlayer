/**
 * The metadata key that ships inside a build.
 *
 * Without this, every fresh copy of the app starts with no artwork and no
 * descriptions until a key is pasted into Settings, which is a poor first
 * five minutes for something meant to just work.
 *
 * The key is written into the built folder by the packaging script and is
 * never committed — the repository is public, and a key in it would be a key
 * published. It is scrambled rather than stored as plain text so it is not
 * readable at a glance by anyone browsing the folder.
 *
 * Scrambling is not encryption. Anyone holding the file and this source can
 * recover the key, and the only real protection is that the file stays off
 * the internet. It is a free, read-only, rate-limited key, so the stake is
 * small; a key worth protecting properly does not belong in a shipped folder
 * at all.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Not a secret; it only makes the stored form unreadable at a glance. */
const SCRAMBLE = 'personal-home-media-player';

/** The file the packaging script writes into the built folder. */
export const KEY_FILENAME = 'metadata.key';

/**
 * Reversible byte-wise scramble. Running it twice returns the original, so the
 * same function both writes and reads.
 */
function scramble(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    out.push(String.fromCharCode(
      text.charCodeAt(i) ^ SCRAMBLE.charCodeAt(i % SCRAMBLE.length),
    ));
  }
  return out.join('');
}

/** Turn a key into the form stored on disk. */
export function encodeKey(key) {
  return Buffer.from(scramble(String(key)), 'binary').toString('base64');
}

/** Recover a key from its stored form, or null if it is not readable. */
export function decodeKey(stored) {
  try {
    const raw = Buffer.from(String(stored).trim(), 'base64').toString('binary');
    const key = scramble(raw);
    // A TMDB key is 32 hexadecimal characters. Anything else means the file was
    // damaged or is not a key at all, and a wrong key is worse than none: it
    // fails every request instead of falling back to asking for one.
    return /^[0-9a-f]{32}$/i.test(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * The key shipped with this build, if there is one.
 * Looked for beside the executable, which is where the packaging script puts it.
 */
export function bundledKey(installDir) {
  if (!installDir) return null;
  try {
    const file = path.join(installDir, KEY_FILENAME);
    if (!fs.existsSync(file)) return null;
    return decodeKey(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
