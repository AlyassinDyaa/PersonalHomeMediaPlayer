/**
 * Read queries over the scanned comics, and the page cache behind them.
 *
 * Mirrors what library.js does for video, kept separate for the same reason
 * the tables are: the questions are different. A comic has shelves, series and
 * issues, and the thing a reader resumes is a page rather than a timestamp.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { pageFile, readPages, coverWidth, shrinkTo } from './archive.js';

/** Where unpacked pages and covers live, beside the artwork cache. */
export function comicsCacheDir() {
  return path.join(config.dataDir, 'comics');
}

function issueCacheDir(issueId) {
  return path.join(comicsCacheDir(), 'pages', issueId);
}

function coverFile(issueId) {
  return path.join(comicsCacheDir(), 'covers', issueId + '.jpg');
}

/**
 * How much unpacked comic to keep on disk.
 *
 * Every comic opened leaves its pages behind so it opens instantly next time.
 * That is worth having and it accumulates: one 1,118 page compendium alone
 * costs 717MB, and a library read end to end would run to tens of gigabytes
 * beside the originals. Past this, the comics read longest ago are thrown away
 * — they cost only the seconds to unpack again, and only if they are opened.
 */
const CACHE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Throw away the least recently read comics until the cache fits.
 *
 * Judged by when a comic was last read rather than when it was unpacked: the
 * one being worked through over a fortnight should outlive the one opened once
 * out of curiosity.
 */
export async function pruneCache(limit = CACHE_LIMIT_BYTES) {
  const root = path.join(comicsCacheDir(), 'pages');
  if (!fs.existsSync(root)) return { removed: 0, freed: 0 };

  const folders = [];
  for (const name of await fsp.readdir(root)) {
    const directory = path.join(root, name);
    try {
      let size = 0;
      let touched = 0;
      for (const file of await fsp.readdir(directory)) {
        const info = await fsp.stat(path.join(directory, file));
        size += info.size;
        touched = Math.max(touched, info.mtimeMs);
      }
      folders.push({ id: name, directory, size, touched });
    } catch {
      // Being written, or already gone; either way not ours to tidy now.
    }
  }

  let total = folders.reduce((sum, folder) => sum + folder.size, 0);
  if (total <= limit) return { removed: 0, freed: 0 };

  /*
   * Only a comic being unpacked this moment is spared.
   *
   * An earlier version also spared everything with a place saved in it, which
   * sounds protective and is useless: every comic ever opened keeps its marker,
   * so within a week nothing could be thrown away and the limit meant nothing —
   * measured at 869MB held against a 300MB limit, with all four survivors
   * "in use".
   *
   * Nothing is lost by removing any of them. The page a reader stopped on is a
   * row in the database; these folders are only the pictures, and they cost
   * seconds to make again, and only if the comic is opened again.
   */
  const candidates = folders
    .filter((folder) => !unpacking.has(folder.id))
    .sort((a, b) => a.touched - b.touched);

  let removed = 0;
  let freed = 0;
  for (const folder of candidates) {
    if (total <= limit) break;
    await fsp.rm(folder.directory, { recursive: true, force: true }).catch(() => {});
    total -= folder.size;
    freed += folder.size;
    removed++;
  }
  return { removed, freed };
}

function shapeIssue(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    title: row.title,
    number: row.number,
    year: row.year,
    format: row.format,
    size: row.size,
    pages: row.pages ?? null,
    page: row.page ?? 0,
    finished: Boolean(row.finished),
  };
}

/**
 * The shelves, each with the series standing on it.
 *
 * A shelf is the first folder below a comics root — the "DC" in
 * `COMICS/DC/Action Comics 1019 - 1049`. Series kept loose in the root have no
 * shelf and are gathered under one of their own at the end.
 */
export function listShelves(profileId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM comic_issues i WHERE i.series_id = s.id) AS issues,
           (SELECT i.id FROM comic_issues i WHERE i.series_id = s.id
             ORDER BY i.number IS NULL, i.number, i.title LIMIT 1) AS cover_issue,
           (SELECT COUNT(*) FROM comic_issues i
              JOIN comic_progress p ON p.issue_id = i.id AND p.profile_id = ?
             WHERE i.series_id = s.id AND p.finished = 1) AS read_issues
    FROM comic_series s
    ORDER BY s.shelf, s.sort_title
  `).all(profileId);

  const shelves = new Map();
  for (const row of rows) {
    const name = row.shelf || 'Other';
    if (!shelves.has(name)) shelves.set(name, []);
    shelves.get(name).push({
      id: row.id,
      title: row.title,
      shelf: row.shelf,
      path: row.path,
      issues: row.issues,
      readIssues: row.read_issues,
      coverIssue: row.cover_issue,
    });
  }

  return [...shelves.entries()]
    .map(([name, series]) => ({
      name,
      series,
      issues: series.reduce((total, entry) => total + entry.issues, 0),
    }))
    .sort((a, b) => b.series.length - a.series.length || a.name.localeCompare(b.name));
}

/** One series, with its issues in reading order. */
export function getSeries(id, profileId) {
  const db = getDb();
  const series = db.prepare('SELECT * FROM comic_series WHERE id = ?').get(id);
  if (!series) return null;

  const issues = db.prepare(`
    SELECT i.*, p.page, p.finished
    FROM comic_issues i
    LEFT JOIN comic_progress p ON p.issue_id = i.id AND p.profile_id = ?
    WHERE i.series_id = ?
    ORDER BY i.number IS NULL, i.number, i.title
  `).all(profileId, id).map(shapeIssue);

  return {
    id: series.id,
    title: series.title,
    shelf: series.shelf,
    path: series.path,
    issues,
  };
}

/** One issue, with where it sits among its neighbours. */
export function getIssue(id, profileId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT i.*, p.page, p.finished
    FROM comic_issues i
    LEFT JOIN comic_progress p ON p.issue_id = i.id AND p.profile_id = ?
    WHERE i.id = ?
  `).get(profileId, id);
  if (!row) return null;

  const issue = shapeIssue(row);
  const series = db.prepare('SELECT id, title, shelf FROM comic_series WHERE id = ?')
    .get(row.series_id);

  const siblings = db.prepare(`
    SELECT id FROM comic_issues WHERE series_id = ?
    ORDER BY number IS NULL, number, title
  `).all(row.series_id).map((entry) => entry.id);
  const at = siblings.indexOf(id);

  return {
    ...issue,
    series,
    previousIssue: at > 0 ? siblings[at - 1] : null,
    nextIssue: at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null,
  };
}

/** The file on disk, or null if the row has outlived it. */
export function issuePath(id) {
  const row = getDb().prepare('SELECT path FROM comic_issues WHERE id = ?').get(id);
  return row && fs.existsSync(row.path) ? row.path : null;
}


/**
 * Comics being unpacked right now, so two readers do not unpack the same one
 * twice and a page request can wait on work that is already under way.
 */
const unpacking = new Map();

/** Why an unpack gave up, kept so a page request can say rather than 404. */
const unpackFailures = new Map();

/**
 * Start unpacking a comic, or join the run already under way.
 *
 * Registered before anything is awaited, and that is the whole point. An
 * earlier version checked the map after awaiting the archive index, which is
 * no guard at all: two requests arriving together both found it empty, both
 * started, and the two runs wrote over each other's pages until one threw. The
 * error was swallowed, so the symptom was an issue that simply stopped after
 * three pages.
 */
function startUnpacking(id, file, directory) {
  const running = unpacking.get(id);
  if (running) return running;

  unpackFailures.delete(id);

  // The page count comes from the unpack itself, so nothing else has to open
  // the archive to find it out.
  let announce;
  const total = new Promise((resolve) => { announce = resolve; });

  const work = unpackInWorker(file, directory, (pages) => announce(pages))
    .then(async (pages) => {
      // Tidy after each comic rather than on a timer: this is the moment the
      // cache has just grown, and the only moment it can have gone over.
      await pruneCache().catch(() => {});
      return pages;
    })
    .catch((error) => {
      unpackFailures.set(id, error.message);
      announce(null);
    })
    .finally(() => unpacking.delete(id));

  const entry = { work, total };
  unpacking.set(id, entry);
  return entry;
}

/**
 * Unpack in a process of its own, and let it end.
 *
 * Doing this in the server was measured taking it to 4.4GB on a 1,118 page
 * compendium and keeping every byte afterwards — the WebAssembly heap that
 * reads a Rar grows as pages come out of it and is never handed back. Ending
 * the process is the only thing that reclaims it, so the work is given to one
 * that ends.
 */
function unpackInWorker(file, directory, onTotal) {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'unpack-worker.mjs');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, directory], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let pages = 0;
    let errorText = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        const [word, value] = line.trim().split(' ');
        if (word === 'total') onTotal(Number(value));
        else if (word === 'done') pages = Number(value);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-500); });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(pages);
      else reject(new Error(errorText.trim() || ('the comic could not be opened (' + code + ')')));
    });
  });
}

/**
 * Begin reading: how many pages there are, without waiting for all of them.
 *
 * Counting the pages means indexing the archive, which is quick; extracting
 * and shrinking them is what takes seconds. Waiting for the whole issue before
 * showing anything left the reader on a spinner for five seconds while page one
 * had been ready almost immediately — so the count comes back at once and the
 * unpacking carries on behind it.
 */
export async function beginIssue(id) {
  const file = issuePath(id);
  if (!file) throw new Error('That comic is not where the library expects it');

  const directory = issueCacheDir(id);
  const already = pageCount(directory);
  if (already !== null) return { pages: already, ready: true };

  const total = await startUnpacking(id, file, directory).total;
  if (total === null) {
    throw new Error(unpackFailures.get(id) ?? 'That comic could not be opened');
  }
  getDb().prepare('UPDATE comic_issues SET pages = ?, updated_at = ? WHERE id = ?')
    .run(total, Date.now(), id);

  return { pages: total, ready: false };
}

/** How many pages an unpacked issue has, or null if it has not been unpacked. */
function pageCount(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'pages.json'), 'utf8')).pages;
  } catch {
    return null;
  }
}

/** A page of an issue that has been opened, or null. */
export function issuePageFile(id, index) {
  return pageFile(issueCacheDir(id), index);
}

/**
 * Wait for a page to exist, while it is still being unpacked.
 *
 * Pages are written in order, so a reader moving forwards is never far ahead of
 * the unpacking. Giving up after a while rather than waiting for ever, because
 * a comic that fails to unpack should say so instead of hanging.
 */
export async function waitForPage(id, index, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = issuePageFile(id, index);
    if (file) return file;

    // An unpack that gave up says why, rather than leaving the page looking
    // merely absent.
    const failure = unpackFailures.get(id);
    if (failure) throw new Error(failure);

    if (!unpacking.has(id) || Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * Covers waiting to be drawn, and the few being drawn now.
 *
 * Reaching the first page of a Rar means holding the whole archive in memory,
 * and this library has compendiums past two gigabytes — one of those takes
 * eleven seconds and the memory to match. A shelf asks for a dozen covers at
 * once, so without a queue the machine would try to hold twenty gigabytes of
 * comics at once to draw some thumbnails.
 */
const COVERS_AT_ONCE = 2;
const coverQueue = [];
let coversRunning = 0;

function pumpCoverQueue() {
  while (coversRunning < COVERS_AT_ONCE && coverQueue.length) {
    const job = coverQueue.shift();
    coversRunning++;
    job().finally(() => {
      coversRunning--;
      pumpCoverQueue();
    });
  }
}

/** Run a piece of cover work when there is room for it. */
function queueCover(work) {
  return new Promise((resolve, reject) => {
    coverQueue.push(() => work().then(resolve, reject));
    pumpCoverQueue();
  });
}

/** Covers already being made, so a second request joins rather than repeats. */
const coversInFlight = new Map();

/**
 * The cover, at shelf size.
 *
 * Only the first page is read, because unpacking a whole issue to draw one
 * thumbnail would mean unpacking the entire library to draw a shelf.
 */
export async function coverFor(id) {
  const cached = coverFile(id);
  if (fs.existsSync(cached)) return cached;

  const existing = coversInFlight.get(id);
  if (existing) return existing;

  const work = makeCover(id).finally(() => coversInFlight.delete(id));
  coversInFlight.set(id, work);
  return work;
}

/** Whether a cover is ready without any work at all. */
export function coverReady(id) {
  return fs.existsSync(coverFile(id)) ? coverFile(id) : null;
}

async function makeCover(id) {
  const cached = coverFile(id);
  const file = issuePath(id);
  if (!file) return null;

  return queueCover(async () => {
    // Another request may have finished it while this one waited its turn.
    if (fs.existsSync(cached)) return cached;

    let pages;
    try {
      pages = await readPages(file);
    } catch {
      // A PDF, or something damaged. The shelf falls back to the title rather
      // than showing a broken picture where a cover should be.
      return null;
    }
    if (!pages.length) return null;

    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await shrinkTo(await pages[0].read(), cached, coverWidth);
    return cached;
  });
}

/** Remember where a reader got to. */
export function saveProgress({ issueId, page, pages, finished, profileId }) {
  const db = getDb();
  const issue = db.prepare('SELECT id, series_id FROM comic_issues WHERE id = ?').get(issueId);
  if (!issue) return null;

  db.prepare(`
    INSERT INTO comic_progress
      (profile_id, issue_id, series_id, page, pages, finished, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, issue_id) DO UPDATE SET
      page = excluded.page, pages = excluded.pages,
      finished = excluded.finished, updated_at = excluded.updated_at
  `).run(
    profileId, issueId, issue.series_id, Math.max(0, Math.floor(page ?? 0)),
    pages ?? null, finished ? 1 : 0, Date.now(),
  );
  return { issueId, page, finished: Boolean(finished) };
}

/** Comics part-way through, newest first — the equivalent of Continue Watching. */
export function continueReading(limit = 20, profileId) {
  return getDb().prepare(`
    SELECT i.*, p.page, p.finished, s.title AS series_title
    FROM comic_progress p
    JOIN comic_issues i ON i.id = p.issue_id
    JOIN comic_series s ON s.id = i.series_id
    WHERE p.profile_id = ? AND p.finished = 0 AND p.page > 0
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).all(profileId, limit).map((row) => ({ ...shapeIssue(row), seriesTitle: row.series_title }));
}

/** How much there is, for the settings screen. */
export function comicStats(profileId) {
  const db = getDb();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  return {
    series: one('SELECT COUNT(*) c FROM comic_series').c,
    issues: one('SELECT COUNT(*) c FROM comic_issues').c,
    totalSize: one('SELECT COALESCE(SUM(size), 0) s FROM comic_issues').s,
    // How many this reader has open, not how many the household has.
    reading: one(
      'SELECT COUNT(*) c FROM comic_progress WHERE profile_id = ? AND finished = 0 AND page > 0',
      profileId,
    ).c,
  };
}
