/**
 * Reading a section's own folders.
 *
 * The main scan exists to work out what a film is: it parses names, asks a
 * metadata provider, merges what it finds and argues with itself about which
 * of three rips is the real one. None of that applies here. These are your own
 * files — a holiday, a folder of pictures — and nobody wants them matched
 * against a film database and renamed after whatever it guessed.
 *
 * So this is deliberately simple, and everything it knows it learns from the
 * disk. The folders are the arrangement, because that is how the files were
 * already arranged by the person who put them there. A file's name is its
 * title. Nothing is looked up anywhere.
 *
 * Videos are written as ordinary items and videos, which is the whole reason
 * they can be played, resumed, favourited and set aside without a line of new
 * code — they are films as far as the rest of the library is concerned, only
 * filed under a different section. Pictures have nowhere sensible to go in a
 * shape built for films, so they have a small table of their own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb, stableId, sortTitle, now } from '../db.js';
import { config } from '../config.js';
import { VIDEO_EXTENSIONS } from '../scan/parse.js';
import { sectionInfo } from '../sections.js';

/** What counts as a picture. Deliberately the ones a browser will draw. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp',
]);

/** Where a section keeps its files. */
export function rootsFor(section) {
  if (section === 'family') return config.familyRoots ?? [];
  if (section === 'artwork') return config.artworkRoots ?? [];
  if (section === 'comics') return config.comicRoots ?? [];
  return [];
}

/** A readable title from a file name: no extension, no underscores. */
function titleFrom(file) {
  return path.basename(file, path.extname(file))
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || path.basename(file);
}

/**
 * Every file under a folder, with the folder it sits in.
 *
 * Depth is capped rather than unbounded: a section pointed at a whole drive by
 * accident should come back with something wrong-looking, not walk for an hour.
 */
function walk(root, depth = 0, found = []) {
  if (depth > 8) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;   // unreadable, or gone since the folder was added
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * Read one section's folders and record what is in them.
 *
 * Everything is keyed on the file's own path, so scanning twice changes
 * nothing and a file that has moved is treated as a new one — which is the
 * honest answer, since nothing here has an identity beyond where it lives.
 *
 * @param {'family'|'artwork'} section
 */
export function scanSection(section) {
  const info = sectionInfo(section);
  if (!info?.folders) throw new Error('There is no folder-backed section called "' + section + '".');

  const db = getDb();
  const roots = rootsFor(section).filter((root) => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  });

  const wantsVideo = info.media.includes('video');
  const wantsImage = info.media.includes('image');
  const stamp = now();

  const folderId = (dir) => stableId(section + ':folder:' + dir);
  const seenFolders = new Set();
  const seenItems = new Set();
  const seenImages = new Set();

  const upsertFolder = db.prepare(`
    INSERT INTO section_folders (id, section, kind, path, name, added_at)
    VALUES (?,?,?,?,'',?)
    ON CONFLICT(section, kind, path) DO NOTHING
  `);
  const upsertItem = db.prepare(`
    INSERT INTO items (
      id, kind, title, sort_title, scan_key, source_folders,
      section, folder_id, confidence, added_at, updated_at
    ) VALUES (?, 'movie', ?, ?, ?, ?, ?, ?, 1.0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, sort_title = excluded.sort_title,
      section = excluded.section, folder_id = excluded.folder_id,
      updated_at = excluded.updated_at
  `);
  const upsertVideo = db.prepare(`
    INSERT INTO videos (id, item_id, title, path, size, extension, added_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      item_id = excluded.item_id, title = excluded.title,
      size = excluded.size, updated_at = excluded.updated_at
  `);
  const upsertImage = db.prepare(`
    INSERT INTO section_images (id, section, folder_id, path, name, size, added_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      section = excluded.section, folder_id = excluded.folder_id,
      name = excluded.name, size = excluded.size
  `);

  let videos = 0;
  let images = 0;

  db.exec('BEGIN');
  try {
    for (const root of roots) {
      for (const file of walk(root)) {
        const ext = path.extname(file).toLowerCase();
        const isVideo = wantsVideo && VIDEO_EXTENSIONS.has(ext);
        const isImage = wantsImage && IMAGE_EXTENSIONS.has(ext);
        if (!isVideo && !isImage) continue;

        /*
         * The folder a file sits in is its group — unless that is the root
         * itself, in which case it belongs to the root and not to nothing.
         */
        const dir = path.dirname(file);
        const kind = isVideo ? 'video' : 'image';
        const id = folderId(kind + ':' + dir);
        if (!seenFolders.has(id)) {
          upsertFolder.run(id, section, kind, dir, stamp);
          seenFolders.add(id);
        }

        let size = 0;
        try { size = fs.statSync(file).size; } catch { /* vanished mid-scan */ }

        if (isVideo) {
          const itemId = stableId(section + ':item:' + file);
          upsertItem.run(
            itemId, titleFrom(file), sortTitle(titleFrom(file)),
            section + ':' + file, JSON.stringify([dir]),
            section, id, stamp, stamp,
          );
          upsertVideo.run(
            stableId(section + ':video:' + file), itemId,
            titleFrom(file), file, size, ext.replace('.', ''), stamp, stamp,
          );
          seenItems.add(itemId);
          videos += 1;
        } else {
          upsertImage.run(
            stableId(section + ':image:' + file), section, id,
            file, titleFrom(file), size, stamp,
          );
          seenImages.add(file);
          images += 1;
        }
      }
    }

    /*
     * Anything no longer on the disk goes.
     *
     * Only within this section: a scan of the family folders has nothing to
     * say about the film library, and must never be able to delete from it.
     */
    const gone = { items: 0, images: 0, folders: 0 };
    for (const row of db.prepare('SELECT id FROM items WHERE section = ?').all(section)) {
      if (seenItems.has(row.id)) continue;
      db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
      gone.items += 1;
    }
    for (const row of db.prepare('SELECT id, path FROM section_images WHERE section = ?').all(section)) {
      if (seenImages.has(row.path)) continue;
      db.prepare('DELETE FROM section_images WHERE id = ?').run(row.id);
      gone.images += 1;
    }
    for (const row of db.prepare('SELECT id FROM section_folders WHERE section = ?').all(section)) {
      if (seenFolders.has(row.id)) continue;
      /* A name given by hand is worth keeping if the folder comes back, but a
         folder with nothing in it is not worth showing, so it goes. */
      db.prepare('DELETE FROM section_folders WHERE id = ?').run(row.id);
      gone.folders += 1;
    }

    db.exec('COMMIT');
    return { section, videos, images, folders: seenFolders.size, removed: gone };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
