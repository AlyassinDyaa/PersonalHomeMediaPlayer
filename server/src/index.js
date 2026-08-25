/**
 * Local HTTP API.
 *
 * Bound to loopback only. It is a private service for the desktop UI, not
 * something to expose to a network without adding authentication first.
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs, hasTmdb, saveSettings, settingsView, listDirectories } from './config.js';
import { getDb } from './db.js';
import { runScan, setOverride } from './scan/index.js';
import * as library from './library.js';
import { walkLibrary } from './scan/walk.js';
import { artworkStats, prefetchArtwork } from './meta/artwork.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * Begin a server-sent event response and return a send(event, data) function.
 * @param {import('express').Response} res
 */
function openEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (event, data) => {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tmdb: hasTmdb(), roots: config.libraryRoots });
});

app.get('/api/stats', (req, res) => {
  res.json(library.libraryStats());
});

app.get('/api/items', (req, res) => {
  const { kind, sort } = req.query;
  res.json(library.listItems({
    kind: kind === 'movie' || kind === 'show' ? kind : null,
    sort: typeof sort === 'string' ? sort : 'title',
  }));
});

app.get('/api/items/:id', (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});

app.get('/api/videos/:id', (req, res) => {
  const video = library.getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'not found' });
  res.json(video);
});

app.get('/api/continue', (req, res) => {
  res.json(library.continueWatching(Number(req.query.limit) || 20));
});

app.get('/api/genres', (req, res) => {
  res.json(library.listGenres());
});

app.get('/api/genres/:name', (req, res) => {
  res.json(library.listByGenre(req.params.name));
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.json([]);
  res.json(library.search(query));
});

app.get('/api/suggestions', (req, res) => {
  res.json(library.listSuggestions());
});

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------

app.post('/api/progress', (req, res) => {
  const { videoId, position, duration } = req.body ?? {};
  if (!videoId || typeof position !== 'number') {
    return res.status(400).json({ error: 'videoId and position are required' });
  }
  const saved = library.saveProgress({ videoId, position, duration });
  if (!saved) return res.status(404).json({ error: 'video not found' });
  res.json(saved);
});

app.post('/api/videos/:id/watched', (req, res) => {
  const result = library.setWatched(req.params.id, req.body?.watched !== false);
  if (!result) return res.status(404).json({ error: 'video not found' });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/** Force an item to a specific TMDB id; survives rescans. */
app.post('/api/items/:id/match', (req, res) => {
  const { tmdbId } = req.body ?? {};
  const row = getDb().prepare('SELECT scan_key FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  setOverride('tmdb', row.scan_key, tmdbId);
  res.json({ ok: true, scanKey: row.scan_key, tmdbId, note: 'applied on next scan' });
});

app.post('/api/suggestions/:id/resolve', (req, res) => {
  getDb().prepare('UPDATE suggestions SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings: library locations, browsing the filesystem to choose them
// ---------------------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  res.json(settingsView());
});

app.put('/api/settings', (req, res) => {
  try {
    res.json(saveSettings(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Directory listing used by the in-app folder picker. Restricted to directory
 * names only — it never exposes file contents.
 */
app.get('/api/browse', (req, res) => {
  const target = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
  try {
    res.json(listDirectories(target));
  } catch (error) {
    res.status(400).json({ error: 'Cannot read that folder: ' + error.message });
  }
});

/** Count media files under a folder, so the picker can preview what it will find. */
app.get('/api/browse/preview', (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : '';
  if (!target) return res.status(400).json({ error: 'path is required' });
  try {
    const result = walkLibrary([target]);
    res.json({
      path: target,
      videos: result.videos.length,
      subtitles: result.subtitles.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/artwork/stats', (req, res) => {
  res.json(artworkStats());
});

/** Warm the whole image cache, streaming progress. */
app.get('/api/artwork/prefetch', async (req, res) => {
  const send = openEventStream(res);
  try {
    const result = await prefetchArtwork({
      onProgress: (p) => send('progress', {
        ...p,
        percent: p.total ? Math.round(100 * (p.done / p.total)) : 0,
      }),
    });
    send('done', result);
  } catch (error) {
    send('error', { message: error.message });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Artwork: fetched once from TMDB, then served from disk
// ---------------------------------------------------------------------------

const VALID_SIZES = new Set(['w200', 'w300', 'w500', 'w780', 'w1280', 'original']);

app.get('/artwork/:size/:file', async (req, res) => {
  const { size, file } = req.params;
  if (!VALID_SIZES.has(size) || !/^[\w.-]+\.(jpg|png|svg)$/i.test(file)) {
    return res.status(400).end();
  }

  const cacheDir = path.join(config.artworkDir, size);
  const cachePath = path.join(cacheDir, file);

  if (fs.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  try {
    const upstream = await fetch('https://image.tmdb.org/t/p/' + size + '/' + file);
    if (!upstream.ok) return res.status(upstream.status).end();

    const buffer = Buffer.from(await upstream.arrayBuffer());
    await fsp.mkdir(cacheDir, { recursive: true });
    // Write to a temp name first so a crash cannot leave a truncated image
    // that would then be served forever from cache.
    const temp = cachePath + '.part';
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, cachePath);

    res.type(path.extname(file)).send(buffer);
  } catch (error) {
    res.status(502).json({ error: 'artwork fetch failed: ' + error.message });
  }
});

// ---------------------------------------------------------------------------
// Scanning, with progress streamed as server-sent events
// ---------------------------------------------------------------------------

let scanning = false;

app.get('/api/scan/stream', async (req, res) => {
  if (scanning) return res.status(409).json({ error: 'a scan is already running' });

  const send = openEventStream(res);

  /**
   * Map a phase onto an overall percentage. Metadata lookup dominates the
   * runtime, so it gets most of the bar; the rest are near-instant checkpoints
   * that would otherwise make the bar appear stuck.
   */
  const percentFor = (event) => {
    switch (event.phase) {
      case 'walk': return 5;
      case 'group': return 15;
      case 'metadata':
        return event.total ? 20 + Math.round(55 * (event.done / event.total)) : 20;
      case 'merge': return 78;
      case 'persist': return 82;
      case 'artwork':
        return event.total ? 84 + Math.round(16 * (event.done / event.total)) : 84;
      default: return null;
    }
  };

  scanning = true;
  try {
    const stats = await runScan({
      onProgress: (event) => send('progress', { ...event, percent: percentFor(event) }),
    });
    send('done', { ...stats, percent: 100 });
  } catch (error) {
    send('error', { message: error.message });
  } finally {
    scanning = false;
    res.end();
  }
});

app.post('/api/scan', async (req, res) => {
  if (scanning) return res.status(409).json({ error: 'a scan is already running' });
  scanning = true;
  try {
    res.json(await runScan());
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    scanning = false;
  }
});

// ---------------------------------------------------------------------------

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

export function startServer(port = config.port) {
  ensureDataDirs();
  getDb();
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log('Media server listening on http://127.0.0.1:' + port);
      resolve(server);
    });
  });
}

export { app };

// Start automatically when run as a script, but not when imported.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  });
}
