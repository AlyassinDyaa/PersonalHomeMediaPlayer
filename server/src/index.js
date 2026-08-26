/**
 * Local HTTP API.
 *
 * Bound to loopback only. It is a private service for the desktop UI, not
 * something to expose to a network without adding authentication first.
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs, hasTmdb, saveSettings, settingsView, listDirectories } from './config.js';
import { getDb } from './db.js';
import { runScan, setOverride } from './scan/index.js';
import * as library from './library.js';
import { walkLibrary } from './scan/walk.js';
import { artworkStats, prefetchArtwork } from './meta/artwork.js';
import {
  requireAuth, requestAuthorised, isLocalRequest, passcodeMatches, issueToken,
  setSessionCookie, clearSessionCookie, loginBlockedFor, recordFailure, recordSuccess,
} from './auth.js';
import { openSession, touchSession, clearStreamCache, closeAllSessions } from './stream/sessions.js';
import { ffmpegAvailable, probeFile } from './stream/ffmpeg.js';
import { planDelivery } from './stream/plan.js';
import { webAppDir, loginPage } from './webapp.js';

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

// ------------------------------------------------------------ signing in ---
// These have to sit above the guard, or there would be no way through it.

app.get('/login', (req, res) => {
  if (requestAuthorised(req)) {
    res.redirect('/');
    return;
  }
  res.type('html').send(loginPage({ configured: config.remoteAccess }));
});

app.post('/api/login', (req, res) => {
  const address = req.socket?.remoteAddress ?? 'unknown';

  const blockedFor = loginBlockedFor(address);
  if (blockedFor > 0) {
    res.status(429).json({ error: 'Too many attempts. Try again in ' + blockedFor + 's.' });
    return;
  }

  if (!config.remoteAccess) {
    res.status(403).json({ error: 'This library is not shared on the network' });
    return;
  }

  if (!passcodeMatches(req.body?.passcode)) {
    recordFailure(address);
    res.status(401).json({ error: 'That passcode is not right' });
    return;
  }

  recordSuccess(address);
  setSessionCookie(res, issueToken());
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/*
 * The icon and the manifest are served to anyone who asks.
 *
 * They sit behind nothing because they reveal nothing — a red triangle and an
 * application name — and because they are needed before signing in: the login
 * page shows the icon, and adding the library to a Home Screen fetches it.
 */
app.get(['/icon-180.png', '/icon-512.png', '/manifest.webmanifest'], (req, res, next) => {
  const file = path.join(webAppDir(), path.basename(req.path));
  if (!fs.existsSync(file)) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// Everything past this point needs to be either local or signed in.
app.use(requireAuth);

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

/**
 * Settings, plus the address other devices would use.
 *
 * The address is worked out here rather than stored, because it changes with
 * the network the machine is on and a remembered one would send people to a
 * dead link.
 */
function settingsWithNetwork() {
  const view = settingsView();
  const address = lanAddress();
  return {
    ...view,
    networkUrl: config.remoteAccess && address
      ? 'http://' + address + ':' + config.port
      : null,
    // Whether a browser could be served at all, so the interface can explain
    // rather than simply failing when someone presses play.
    streamingReady: ffmpegAvailable(),
  };
}

app.get('/api/settings', (req, res) => {
  res.json(settingsWithNetwork());
});

app.put('/api/settings', (req, res) => {
  try {
    saveSettings(req.body ?? {});
    res.json(settingsWithNetwork());
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

// -------------------------------------------------------------- streaming ---

/**
 * Whether a browser can be served at all, and what this file would take.
 * Asked before playing so the interface can say what is about to happen rather
 * than simply stalling.
 */
app.get('/api/stream/:videoId/info', async (req, res) => {
  const video = library.getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'No such video' });
    return;
  }
  if (!ffmpegAvailable()) {
    res.status(503).json({ error: 'ffmpeg is not installed, so browsers cannot be served' });
    return;
  }

  try {
    const plan = planDelivery(await probeFile(video.path));
    res.json({ ...plan, duration: video.duration ?? null, position: video.position ?? 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start (or re-join) a stream and hand back its playlist.
 *
 * The offset is part of the session: seeking past what has been produced starts
 * a new one rather than waiting for ffmpeg to catch up.
 */
app.get('/api/stream/:videoId/start', async (req, res) => {
  const video = library.getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'No such video' });
    return;
  }

  const startSeconds = Number(req.query.start ?? 0) || 0;
  try {
    const session = await openSession({
      videoId: video.id,
      filePath: video.path,
      startSeconds,
    });
    res.json({
      id: session.id,
      plan: session.plan,
      startSeconds,
      playlistUrl: '/api/stream/session/' + session.id + '/index.m3u8',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** The playlist and its segments, read straight from the session's folder. */
app.get('/api/stream/session/:id/:file', (req, res) => {
  const session = touchSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'That stream has ended' });
    return;
  }

  // Only files this session produced: the name is never allowed to walk out of
  // the folder it belongs to.
  const name = path.basename(req.params.file);
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: 'Bad file name' });
    return;
  }

  const target = path.join(session.dir, name);
  if (!target.startsWith(session.dir)) {
    res.status(400).json({ error: 'Bad file name' });
    return;
  }

  if (name.endsWith('.m3u8')) {
    res.type('application/vnd.apple.mpegurl');
    // A playlist that is still growing must never be cached.
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.type('video/iso.segment');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  res.sendFile(target, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

/** A file the browser can play as it is, served with range support. */
app.get('/api/stream/:videoId/direct', (req, res) => {
  const video = library.getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'No such video' });
    return;
  }
  res.sendFile(video.path, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

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

/*
 * The browser interface. Last, so it never shadows an API route.
 *
 * Everything but the entry page is named with a hash of its contents and can be
 * kept for good. The entry page cannot be cached at all: it is what names those
 * files, so a stale copy pins a tablet to the previous build — which is exactly
 * what happened after the first rebuild.
 */
app.use(express.static(webAppDir(), {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Anything else that is not an API call is the single-page app being deep-linked.
app.get(/^\/(?!api\/|artwork\/).*/, (req, res, next) => {
  const index = path.join(webAppDir(), 'index.html');
  if (!fs.existsSync(index)) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(index);
});

// ---------------------------------------------------------------------------

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

/** The address on this machine that other devices would use to reach it. */
export function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

export function startServer(port = config.port) {
  ensureDataDirs();
  getDb();
  // Segments from a previous run can be gigabytes, and none of them are useful.
  clearStreamCache();

  // Listening on every interface is what sharing means, so it follows the
  // setting rather than being on by default — and never happens without a
  // passcode, however the settings file came to say otherwise.
  const sharing = config.remoteAccess && Boolean(config.passcodeHash);
  if (config.remoteAccess && !sharing) {
    console.warn('Sharing is switched on but no passcode is set, so it stays off.');
  }
  const host = sharing ? '0.0.0.0' : '127.0.0.1';

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log('Media server listening on http://127.0.0.1:' + port);
      if (sharing) {
        const address = lanAddress();
        console.log('Shared on the network at http://' + (address ?? '<this machine>') + ':' + port);
      }
      resolve(server);
    });

    server.on('close', () => { closeAllSessions(); });
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
