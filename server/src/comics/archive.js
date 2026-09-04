/**
 * Reading the inside of a comic.
 *
 * A comic is an archive of images, one per page, and the only thing that
 * differs between the two common kinds is how the bytes are packed: .cbz is a
 * Zip, .cbr is a Rar. Both are read here so that nothing above this file has to
 * know which it was given.
 *
 * Rar is handled by a WebAssembly build of unrar rather than a native module or
 * a bundled executable, for the same reason the database uses Node's own
 * SQLite: an addon compiled against the wrong ABI is the kind of failure that
 * only shows up on someone else's machine. Zip is read here directly, because
 * a Zip of stored or deflated files is a couple of dozen lines against Node's
 * own zlib and not worth a dependency.
 *
 * Pages come out in the order a reader expects, which is the order the names
 * sort in — but sorted the way a person reads numbers, so page 2 comes before
 * page 10.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { ffmpegPaths } from '../stream/ffmpeg.js';

/** Image types that turn up as pages. */
const PAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

/** Files an archive carries that are not pages. */
function isPage(name) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Directory entries, macOS resource forks and metadata sidecars.
  if (!base || base.startsWith('.') || name.includes('__MACOSX')) return false;
  return PAGE_TYPES.has(path.extname(base).toLowerCase());
}

/**
 * Compare names the way a reader would.
 *
 * Plain string order puts "page10" before "page2", which shuffles a comic into
 * nonsense. Numbers inside the name are compared as numbers.
 */
export function naturalOrder(a, b) {
  const chunk = /(\d+)|(\D+)/g;
  const left = String(a).toLowerCase().match(chunk) ?? [];
  const right = String(b).toLowerCase().match(chunk) ?? [];

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    const bothNumbers = /^\d/.test(x) && /^\d/.test(y);
    if (bothNumbers) {
      const difference = Number(x) - Number(y);
      if (difference) return difference;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/** What kind of archive a file is, from its name. */
export function formatOf(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.cbz' || extension === '.zip') return 'cbz';
  if (extension === '.cbr' || extension === '.rar') return 'cbr';
  if (extension === '.pdf') return 'pdf';
  return null;
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

/**
 * Read a Zip's central directory.
 *
 * Only what a comic needs: where each entry's data begins, how it is packed,
 * and how big it is. Written against the format rather than pulled in as a
 * dependency, because that is the whole of it.
 */
function readZipDirectory(buffer) {
  // The end-of-directory record sits at the tail, after an optional comment,
  // so it is found by scanning backwards for its signature.
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end === -1) throw new Error('this file is not a Zip archive');

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one Zip entry, following its local header. */
function readZipEntry(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged Zip entry');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const packed = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return packed;            // stored
  if (entry.method === 8) return zlib.inflateRawSync(packed);
  throw new Error('unsupported compression in this Zip (method ' + entry.method + ')');
}

// ---------------------------------------------------------------------------
// Reading a comic
// ---------------------------------------------------------------------------

/**
 * Every page of a comic, in reading order.
 *
 * @returns {Promise<Array<{name: string, read: () => Promise<Buffer>}>>}
 */
export async function readPages(file) {
  const format = formatOf(file);
  if (format === 'cbz') return readZipPages(file);
  if (format === 'cbr') return readRarPages(file);
  if (format === 'pdf') {
    // A PDF is pages of its own kind, not images in an archive, and turning one
    // into pictures needs a renderer this does not carry. It is listed in the
    // library and can be opened outside; it just cannot be paged through here.
    throw new Error('PDFs cannot be read page by page yet — open it outside the app');
  }
  throw new Error('this is not a kind of comic the library can read');
}

async function readZipPages(file) {
  const buffer = await fsp.readFile(file);
  const entries = readZipDirectory(buffer)
    .filter((entry) => isPage(entry.name))
    .sort((a, b) => naturalOrder(a.name, b.name));

  return entries.map((entry) => ({
    name: entry.name,
    read: async () => readZipEntry(buffer, entry),
  }));
}

async function readRarPages(file) {
  // Loaded here rather than at the top so a library with no .cbr in it never
  // pays for the WebAssembly module at all.
  const { createExtractorFromData } = await import('node-unrar-js');
  const data = await fsp.readFile(file);
  const extractor = await createExtractorFromData({ data: Uint8Array.from(data).buffer });

  const headers = [...extractor.getFileList().fileHeaders]
    .filter((header) => !header.flags.directory && isPage(header.name))
    .sort((a, b) => naturalOrder(a.name, b.name));

  return headers.map((header) => ({
    name: header.name,
    read: async () => {
      const extracted = extractor.extract({ files: [header.name] });
      const first = [...extracted.files][0];
      if (!first?.extraction) throw new Error('could not read ' + header.name);
      return Buffer.from(first.extraction);
    },
  }));
}

/**
 * A page, shrunk to something a screen can actually use.
 *
 * Scans in this library run four to seven megabytes a page at print
 * resolution. Unpacked as they are, one issue costs the better part of two
 * hundred megabytes on disk and a second or two a page over Wi-Fi, for detail
 * no tablet can show. ffmpeg is already carried for video, so it does this
 * too; the original is never touched.
 *
 * Anything already smaller than the target is copied rather than re-encoded,
 * which keeps a page that was published small from being softened.
 */
const PAGE_WIDTH = 1600;

/** Covers are drawn small and many at a time, so they are made smaller still. */
export const coverWidth = 500;

export async function shrinkTo(bytes, target, width = PAGE_WIDTH) {
  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) {
    await fsp.writeFile(target, bytes);
    return;
  }

  await new Promise((resolve) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', 'pipe:0',
      // Only ever downwards: min() leaves a smaller page at its own size.
      // The comma inside min() must reach ffmpeg escaped, or it reads as the
      // separator between two filters and refuses the whole expression — which
      // it does silently enough that the fallback below just writes the
      // original page and the cache quietly stays the size of the archive.
      '-vf', 'scale=min(' + width + '\\,iw):-1',
      '-q:v', '4',
      '-f', 'mjpeg', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });

    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(fsp.writeFile(target, bytes)));
    child.on('exit', (code) => {
      const output = Buffer.concat(chunks);
      // A failed conversion must not lose the page; the original will do.
      resolve(fsp.writeFile(target, code === 0 && output.length > 0 ? output : bytes));
    });
    child.stdin.on('error', () => { /* closed early; the exit handler copes */ });
    child.stdin.end(bytes);
  });
}

/**
 * Unpack a comic's pages into a folder, once.
 *
 * Paging through a comic one request at a time would mean opening and
 * indexing the archive on every page — half a second each for a Rar, which is
 * not what turning a page should cost. Unpacking on the first open makes every
 * page after it an ordinary file read.
 *
 * @returns {Promise<number>} How many pages there are.
 */
export async function unpackTo(file, directory, { onTotal, onProgress } = {}) {
  const done = path.join(directory, 'pages.json');
  if (fs.existsSync(done)) {
    try {
      const { pages } = JSON.parse(await fsp.readFile(done, 'utf8'));
      onTotal?.(pages);
      return pages;
    } catch {
      // A damaged index is rebuilt below.
    }
  }

  await fsp.mkdir(directory, { recursive: true });
  const pages = await readPages(file);

  /*
   * The count is announced from inside here, rather than the caller indexing
   * the archive a second time to learn it.
   *
   * Rar is read by a WebAssembly build that keeps its state in one place, and
   * a second reader opened on the same file while this one is working brought
   * the whole thing down mid-issue — a page would simply fail with "cannot
   * read properties of undefined". One reader per comic, and the number it
   * already knows is passed back out.
   */
  onTotal?.(pages.length);

  let index = 0;
  for (const page of pages) {
    const bytes = await page.read();
    await shrinkTo(bytes, path.join(directory, String(index).padStart(4, '0') + '.jpg'));
    index++;
    onProgress?.(index, pages.length);
  }

  await fsp.writeFile(done, JSON.stringify({ pages: index, unpackedAt: Date.now() }), 'utf8');
  return index;
}
/** The file holding a given page, or null when it has not been unpacked. */
export function pageFile(directory, index) {
  const candidate = path.join(directory, String(index).padStart(4, '0') + '.jpg');
  return fs.existsSync(candidate) ? candidate : null;
}
