/**
 * Pictures people choose for their own profile.
 *
 * Kept as files beside the database rather than inside it: they are images,
 * they are read far more often than they are written, and a database that has
 * to be copied for every backup is better off without them.
 *
 * The browser sends one already shrunk and encoded — a canvas can do that
 * before uploading, which keeps a phone-camera photograph from arriving at
 * eight megapixels to be shown thirty pixels wide. This module therefore only
 * has to check that what arrived really is a small image, and write it down.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';

/** Generous for a 320px JPEG, far below anything worth worrying about. */
const MAX_BYTES = 400 * 1024;
/** The picture the crop was taken from, scaled down but not to a thumbnail. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Only formats every browser both produces and displays. */
const TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function avatarDir() {
  return path.join(config.dataDir, 'avatars');
}

/**
 * The file for a profile, whatever type it was saved as.
 *
 * @param {string} profileId
 * @param {'face'|'source'} which The square shown everywhere, or the picture it
 *   was cut from — kept so the crop can be adjusted later without asking for
 *   the photograph again.
 */
export function avatarFile(profileId, which = 'face') {
  const suffix = which === 'source' ? '.source' : '';
  for (const extension of TYPES.values()) {
    const full = path.join(avatarDir(), profileId + suffix + extension);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Decode a data URL into bytes and a file extension. */
function decode(dataUrl, limit) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('That does not look like an image');

  const [, type, encoded] = match;
  const extension = TYPES.get(type.toLowerCase());
  if (!extension) throw new Error('Pictures have to be JPEG, PNG or WebP');

  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new Error('That picture is empty');
  if (bytes.length > limit) throw new Error('That picture is too large');
  return { bytes, extension };
}

/**
 * Store a picture sent as a data URL.
 *
 * @param {string} profileId
 * @param {string} dataUrl e.g. "data:image/jpeg;base64,…"
 * @returns {Promise<number>} when it was stored
 */
export async function saveAvatar(profileId, dataUrl, sourceDataUrl = null) {
  const face = decode(dataUrl, MAX_BYTES);
  // Larger allowance: this one is kept so the crop can be redone, and is
  // still only a picture scaled down to a thousand pixels or so.
  const source = sourceDataUrl ? decode(sourceDataUrl, MAX_SOURCE_BYTES) : null;

  await fsp.mkdir(avatarDir(), { recursive: true });

  /*
   * Clear the old face, and the old source only when a new one is coming.
   *
   * Adjusting a crop sends a face but no source, because it was cut from the
   * source already stored. Clearing both here would delete that picture and
   * make the crop adjustable exactly once — after which there would be nothing
   * left to adjust.
   */
  await clearFaceFiles(profileId);
  if (source) await clearSourceFiles(profileId);

  const write = async (name, bytes) => {
    const target = path.join(avatarDir(), name);
    const temp = target + '.part';
    await fsp.writeFile(temp, bytes);
    await fsp.rename(temp, target);
  };

  await write(profileId + face.extension, face.bytes);
  if (source) await write(profileId + '.source' + source.extension, source.bytes);

  const at = Date.now();
  getDb().prepare('UPDATE profiles SET avatar_at = ? WHERE id = ?').run(at, profileId);
  return at;
}

async function clearFaceFiles(profileId) {
  for (const extension of TYPES.values()) {
    await fsp.rm(path.join(avatarDir(), profileId + extension), { force: true });
  }
}

async function clearSourceFiles(profileId) {
  for (const extension of TYPES.values()) {
    await fsp.rm(path.join(avatarDir(), profileId + '.source' + extension), { force: true });
  }
}

/** Remove a profile's picture, falling back to its initial and colour. */
export async function clearAvatar(profileId, { keepRow = false } = {}) {
  await clearFaceFiles(profileId);
  await clearSourceFiles(profileId);
  if (!keepRow) {
    getDb().prepare('UPDATE profiles SET avatar_at = NULL WHERE id = ?').run(profileId);
  }
}
