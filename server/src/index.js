/**
 * Local HTTP API.
 *
 * Bound to loopback only. It is a private service for the desktop UI, not
 * something to expose to a network without adding authentication first.
 */

import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs, hasTmdb, saveSettings, settingsView, listDirectories } from './config.js';
import { getDb } from './db.js';
import {
  runScan, setOverride, listMerges, clearMerge, rememberSeparate,
} from './scan/index.js';
import * as library from './library.js';
import * as collections from './collections.js';
import { walkLibrary } from './scan/walk.js';
import { artworkStats, prefetchArtwork } from './meta/artwork.js';
import { tmdbGet, searchTitles } from './meta/tmdb.js';
import { startAutoScan } from './scan/autoscan.js';
import { segmentPlan, buildPlaylist, ensureSegment, clearAllSegments } from './stream/vod.js';
import * as comics from './comics/library.js';
import { scanComics } from './comics/scan.js';
import {
  requireAuth, requestAuthorised, isLocalRequest, passcodeMatches, issueToken,
  setSessionCookie, clearSessionCookie, loginBlockedFor, recordFailure, recordSuccess,
  sessionProfileId,
} from './auth.js';
import {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  defaultProfileId, pinMatches,
} from './profiles.js';
import { openSession, touchSession, clearStreamCache, closeAllSessions } from './stream/sessions.js';
import { ffmpegAvailable, probeFile, ffmpegPaths } from './stream/ffmpeg.js';
import { planDelivery } from './stream/plan.js';
import {
  canPrepare, prepare, preparedPath, preparedState, preparedStats,
} from './stream/prepared.js';
import { webAppDir, loginPage } from './webapp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/*
 * Let the development renderer talk to this server.
 *
 * In development the interface is served by Vite on another port, which makes
 * every API call cross-origin; without this the browser refuses them all and
 * `npm run dev` shows an empty library with CORS errors in the console. A
 * packaged build serves the interface from this same server and never takes
 * this path.
 *
 * Deliberately narrow: only localhost origins, only when a development server
 * announced itself through the environment. Nothing here widens what a machine
 * on the network can reach — that is still decided by the passcode and by
 * requireAuth below.
 */
const DEV_ORIGIN = process.env.VITE_DEV_SERVER_URL
  ? process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '')
  : null;

if (DEV_ORIGIN) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  console.log('Development renderer allowed from ' + DEV_ORIGIN);
}

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
app.get([
  '/icon-180.png', '/icon-512.png', '/manifest.webmanifest',
  // The worker that speaks when this server cannot, and the page it shows.
  // Both have to be fetchable before anybody has signed in: the worker is
  // installed on first visit and must already hold that page by the time it
  // is needed, which is precisely when nothing here can be reached.
  '/sw.js', '/offline.html',
], (req, res, next) => {
  const file = path.join(webAppDir(), path.basename(req.path));
  if (!fs.existsSync(file)) {
    next();
    return;
  }

  /*
   * The worker itself is never cached for long. It is the piece that decides
   * what everything else does, so a stale copy is the one kind of stale copy
   * that cannot be corrected by a later update.
   */
  res.setHeader(
    'Cache-Control',
    req.path === '/sw.js' ? 'no-cache' : 'public, max-age=86400',
  );
  res.sendFile(file);
});

// Everything past this point needs to be either local or signed in.
app.use(requireAuth);

/**
 * Which of the household this request is speaking for.
 *
 * A browser carries it in the signed session cookie, put there when a profile
 * was chosen. The desktop app cannot: it is loaded from disk and talks to this
 * server across origins, so no cookie rides along. It sends a header instead,
 * which is safe precisely here — a request from the machine the server runs on
 * has already been let through without a passcode, because whoever sent it
 * could have opened the files directly. The header grants nothing that
 * loopback did not already grant.
 *
 * An unknown or deleted profile falls back to the owner rather than failing.
 * Nobody should be locked out of their own library because a cookie outlived
 * the profile it named.
 */
app.use((req, res, next) => {
  /*
   * The query parameter is for addresses a tag loads rather than fetch does:
   * an <img> or a <video> cannot be given a header, and the desktop window has
   * no cookie to fall back on. Honoured only from this machine, for the same
   * reason the header is.
   */
  const named = isLocalRequest(req)
    ? (req.get('X-Profile-Id') || req.query.profile || sessionProfileId(req))
    : sessionProfileId(req);

  req.profile = getProfile(named) ?? getProfile(defaultProfileId());
  next();
});

/**
 * The guard on everything that decides where the library's files come from.
 *
 * Scanning, the folder picker, the roots themselves: all of it belongs to the
 * one profile that owns the library. Sharing the passcode with somebody in
 * another city is meant to share the films, not the drives they sit on, and a
 * profile that cannot see a path also cannot point the library at a new one.
 */
function requireOwner(req, res, next) {
  if (req.profile?.isOwner) {
    next();
    return;
  }
  res.status(403).json({ error: 'Only the owner of this library can change that' });
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    tmdb: hasTmdb(),
    // Where the films live is the owner's business alone.
    ...(req.profile?.isOwner ? { roots: config.libraryRoots } : {}),
  });
});

// ----------------------------------------------------------- profiles ---

/**
 * Everyone may see who the profiles are: a picker that hid them would have
 * nothing to pick from. Nothing secret is in the list — a name, a colour, and
 * whether a PIN will be asked for.
 */
app.get('/api/profiles', (req, res) => {
  res.json({ profiles: listProfiles(), current: req.profile });
});

/**
 * Become one of them.
 *
 * Wrong PINs are counted against the address by the same lockout that guards
 * the passcode. A PIN is four digits and a patient guesser has all evening.
 */
app.post('/api/profiles/switch', (req, res) => {
  const address = req.socket?.remoteAddress ?? 'unknown';
  const blockedFor = loginBlockedFor(address);
  if (blockedFor > 0) {
    return res.status(429).json({ error: 'Too many attempts. Try again in ' + blockedFor + 's.' });
  }

  const wanted = getProfile(req.body?.profileId);
  if (!wanted) return res.status(404).json({ error: 'No such profile' });

  if (!pinMatches(wanted.id, req.body?.pin)) {
    recordFailure(address);
    return res.status(401).json({ error: 'That PIN is not right' });
  }
  recordSuccess(address);

  /*
   * A browser gets a fresh cookie naming the profile. The desktop app is
   * handed the profile back and repeats it in a header from then on, because
   * a cookie set here would never reach it.
   */
  if (!isLocalRequest(req)) setSessionCookie(res, issueToken(wanted.id));
  res.json(wanted);
});

app.post('/api/profiles', requireOwner, (req, res) => {
  try {
    res.json(createProfile(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/profiles/:id', requireOwner, (req, res) => {
  try {
    const updated = updateProfile(req.params.id, req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'No such profile' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/profiles/:id', requireOwner, (req, res) => {
  try {
    const removed = deleteProfile(req.params.id);
    if (!removed) return res.status(404).json({ error: 'No such profile' });
    res.json(removed);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(library.libraryStats());
});

app.get('/api/items', (req, res) => {
  const { kind, sort } = req.query;
  res.json(library.listItems({
    kind: kind === 'movie' || kind === 'show' ? kind : null,
    sort: typeof sort === 'string' ? sort : 'title',
    profile: req.profile,
  }));
});

app.get('/api/items/:id', (req, res) => {
  const item = library.getItem(req.params.id, req.profile);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});

app.get('/api/videos/:id', (req, res) => {
  const video = library.getVideo(req.params.id, req.profile);
  if (!video) return res.status(404).json({ error: 'not found' });
  res.json(video);
});

app.get('/api/continue', (req, res) => {
  res.json(library.continueWatching(Number(req.query.limit) || 20, req.profile));
});

app.get('/api/favourites', (req, res) => {
  res.json(library.listFavourites(req.profile));
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

app.get('/api/collections', (req, res) => {
  res.json(collections.listCollections());
});

/** The rails themselves, titles included, for the home screen. */
app.get('/api/collections/shelves', (req, res) => {
  res.json(collections.collectionShelves());
});

app.get('/api/collections/:id', (req, res) => {
  const items = collections.collectionItems(req.params.id);
  if (!items) return res.status(404).json({ error: 'collection not found' });
  res.json(items);
});

app.post('/api/collections', (req, res) => {
  try {
    res.json(collections.createCollection({
      name: req.body?.name,
      folderPath: req.body?.folderPath ?? null,
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/collections/:id', (req, res) => {
  try {
    if (req.body?.move) {
      const moved = collections.moveCollection(req.params.id, req.body.move);
      if (!moved) return res.status(404).json({ error: 'collection not found' });
      return res.json(moved);
    }
    const updated = collections.updateCollection(req.params.id, req.body ?? {});
    if (!updated) return res.status(404).json({ error: 'collection not found' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/collections/:id', (req, res) => {
  if (!collections.deleteCollection(req.params.id)) {
    return res.status(404).json({ error: 'collection not found' });
  }
  res.json({ removed: true });
});

app.post('/api/collections/:id/items', (req, res) => {
  try {
    const added = collections.addToCollection(req.params.id, req.body?.itemId);
    if (!added) return res.status(404).json({ error: 'collection or item not found' });
    res.json(added);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/collections/:id/items/:itemId', (req, res) => {
  const removed = collections.removeFromCollection(req.params.id, req.params.itemId);
  if (!removed) return res.status(404).json({ error: 'collection not found' });
  res.json(removed);
});

app.get('/api/genres', (req, res) => {
  res.json(library.listGenres(req.profile));
});

app.get('/api/genres/:name', (req, res) => {
  res.json(library.listByGenre(req.params.name, 40, req.profile));
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.json([]);
  res.json(library.search(query, 60, req.profile));
});

/** Shows currently folded together, so a wrong answer can be found again. */
app.get('/api/merges', requireOwner, (req, res) => {
  res.json(listMerges());
});

/**
 * Separate two shows that were joined.
 *
 * The override is what makes the join survive scans, so removing it and
 * scanning again is all it takes; the episodes were never altered, only
 * filed together.
 */
app.delete('/api/merges/:alias', requireOwner, async (req, res) => {
  const joined = listMerges().find((entry) => entry.alias === req.params.alias);
  if (!clearMerge(req.params.alias)) {
    return res.status(404).json({ error: 'those shows are not joined' });
  }
  // Pressing Separate is an answer, not just an undo: without recording it the
  // very next scan would offer to join them again.
  if (joined) rememberSeparate([joined.alias, joined.into]);
  if (scanning) return res.json({ ok: true, rescanned: false });

  scanning = true;
  try {
    const stats = await runScan();
    res.json({ ok: true, rescanned: true, shows: stats.shows });
  } catch (error) {
    res.status(500).json({ error: 'separated, but the rescan failed: ' + error.message });
  } finally {
    scanning = false;
  }
});

app.get('/api/suggestions', requireOwner, (req, res) => {
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
  const saved = library.saveProgress({ videoId, position, duration, profile: req.profile });
  if (!saved) return res.status(404).json({ error: 'video not found' });
  res.json(saved);
});

app.put('/api/items/:id/favourite', (req, res) => {
  const result = library.setFavourite(req.params.id, req.body?.favourite !== false, req.profile);
  if (!result) return res.status(404).json({ error: 'item not found' });
  res.json(result);
});

app.delete('/api/continue/:itemId', (req, res) => {
  const result = library.removeFromContinueWatching(req.params.itemId, req.profile);
  if (!result) return res.status(404).json({ error: 'item not found' });
  res.json(result);
});

app.post('/api/videos/:id/watched', (req, res) => {
  const result = library.setWatched(req.params.id, req.body?.watched !== false, req.profile);
  if (!result) return res.status(404).json({ error: 'video not found' });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/**
 * Search TMDB by hand.
 *
 * Needed because the automatic match is occasionally confident and wrong, and
 * until now there was no way to say so from inside the app.
 */
app.get('/api/tmdb/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  const kind = req.query.kind === 'show' ? 'show' : 'movie';
  if (!query) return res.json([]);
  if (!hasTmdb()) return res.status(400).json({ error: 'No TMDB API key is configured' });
  try {
    res.json(await searchTitles(kind, query));
  } catch (error) {
    res.status(502).json({ error: 'TMDB search failed: ' + error.message });
  }
});

/** Force an item to a specific TMDB id; survives rescans. */
app.post('/api/items/:id/match', requireOwner, (req, res) => {
  const { tmdbId } = req.body ?? {};
  const row = getDb().prepare('SELECT scan_key FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  setOverride('tmdb', row.scan_key, tmdbId);
  res.json({ ok: true, scanKey: row.scan_key, tmdbId, note: 'applied on next scan' });
});

/**
 * Answer a grouping question.
 *
 * "merge" is remembered as an override so the two folders are read as one
 * series by every future scan; "separate" only silences the question, since
 * keeping them apart is already what the scanner does. Either way the
 * suggestion stops being raised.
 */
app.post('/api/suggestions/:id/resolve', requireOwner, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT payload FROM suggestions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  if (req.body?.action === 'merge') {
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* recorded below as no-op */ }
    const [from, into] = payload.shows ?? [];
    // Folded into the longer key, which is the more specific title of the two
    // and therefore the one a viewer is likelier to recognise.
    if (from && into) {
      const [alias, target] = from.length >= into.length ? [from, into] : [into, from];
      setOverride('merge', alias, target);
    }
  }

  if (req.body?.action !== 'merge') {
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* nothing to remember */ }
    if (payload.shows?.length === 2) rememberSeparate(payload.shows);
  }

  db.prepare('UPDATE suggestions SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, applied: req.body?.action === 'merge' ? 'merged' : 'kept separate' });
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

/**
 * Logos to choose from when badging a collection.
 *
 * The metadata provider's company images are the practical source: they cover
 * studios, publishers and networks — DC, Marvel, Pixar, Nickelodeon — which is
 * what people name a shelf after.
 */
app.get('/api/logos/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.json([]);

  try {
    const body = await tmdbGet('/search/company?query=' + encodeURIComponent(query));
    res.json(
      (body?.results ?? [])
        .filter((entry) => entry.logo_path)
        .slice(0, 12)
        .map((entry) => ({ id: entry.id, name: entry.name, logo: entry.logo_path })),
    );
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * What a profile that does not own the library is told about it.
 *
 * The parts that describe how the library looks and behaves, and none of the
 * parts that describe the machine it runs on: no roots, no data directory, no
 * mpv path, no port, nothing about the passcode or the metadata key. A guest
 * profile should not be able to learn that the films sit on G:\Entertainment,
 * let alone point the library somewhere else.
 */
function viewerSettings(full) {
  return {
    libraryName: full.libraryName,
    libraryColor: full.libraryColor,
    skipIntroEnabled: full.skipIntroEnabled,
    skipOutroEnabled: full.skipOutroEnabled,
    showComics: full.showComics,
    groupMoviesByGenre: full.groupMoviesByGenre,
    groupShowsByGenre: full.groupShowsByGenre,
    streamingReady: full.streamingReady,
  };
}

app.get('/api/settings', (req, res) => {
  const full = settingsWithNetwork();
  const owner = Boolean(req.profile?.isOwner);
  res.json({ ...(owner ? full : viewerSettings(full)), isOwner: owner });
});

app.put('/api/settings', requireOwner, (req, res) => {
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
app.get('/api/browse', requireOwner, (req, res) => {
  const target = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
  try {
    res.json(listDirectories(target));
  } catch (error) {
    res.status(400).json({ error: 'Cannot read that folder: ' + error.message });
  }
});

/** Count media files under a folder, so the picker can preview what it will find. */
app.get('/api/browse/preview', requireOwner, (req, res) => {
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

app.get('/api/artwork/stats', requireOwner, (req, res) => {
  res.json(artworkStats());
});

/** Warm the whole image cache, streaming progress. */
app.get('/api/artwork/prefetch', requireOwner, async (req, res) => {
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
  const video = library.getVideo(req.params.videoId, req.profile);
  if (!video) {
    res.status(404).json({ error: 'No such video' });
    return;
  }
  if (!ffmpegAvailable()) {
    res.status(503).json({ error: 'ffmpeg is not installed, so browsers cannot be served' });
    return;
  }

  try {
    const probed = await probeFile(video.path);
    const plan = planDelivery(probed);
    const streams = probed?.streams ?? [];

    /** A stream's own name for itself, falling back to something readable. */
    const describe = (stream, ordinal, kind) => {
      const tags = stream.tags ?? {};
      const parts = [];
      if (tags.language && tags.language !== 'und') parts.push(String(tags.language).toUpperCase());
      if (tags.title) parts.push(tags.title);
      if (!parts.length) parts.push(kind + ' ' + (ordinal + 1));
      return parts.join(' · ');
    };

    const ofType = (type) => streams.filter((s) => s.codec_type === type);

    // The duration on the item is only filled in once something has played it,
    // so the container is the reliable source for a first play.
    const duration = Number(probed?.format?.duration) || video.duration || null;

    /*
     * Repack this film in the background if it would help.
     *
     * Nothing waits for it: this play uses the streaming path as before, and
     * the next one gets a file the browser can seek natively. Only started for
     * films needing no re-encoding, where the work is a straight copy.
     */
    const prepared = preparedState(req.params.videoId);
    if (prepared === 'none' && plan.mode !== 'direct' && canPrepare(probed)) {
      prepare(req.params.videoId, video.path, probed).catch(() => {
        // Surfaced through preparedState; the stream still plays regardless.
      });
    }

    res.json({
      ...plan,
      prepared,
      duration,
      position: video.position ?? 0,
      audioTracks: ofType('audio').map((stream, i) => ({
        index: i,
        label: describe(stream, i, 'Audio'),
        codec: stream.codec_name,
      })),
      subtitleTracks: ofType('subtitle')
        // Only text subtitles convert to something a browser can display;
        // picture-based ones (PGS, VobSub) would need rendering, not converting.
        .map((stream, i) => ({ stream, i }))
        .filter(({ stream }) => /subrip|ass|ssa|mov_text|webvtt|text/.test(stream.codec_name ?? ''))
        .map(({ stream, i }) => ({
          index: i,
          label: describe(stream, i, 'Subtitles'),
          language: stream.tags?.language ?? null,
        })),
    });
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
/**
 * The playlist describing an entire video.
 *
 * Written before anything is produced, so the player knows the real length and
 * can seek anywhere in it.
 */
app.get('/api/stream/:videoId/index.m3u8', async (req, res) => {
  const video = library.getVideo(req.params.videoId, req.profile);
  if (!video) return res.status(404).json({ error: 'No such video' });
  if (!ffmpegAvailable()) {
    return res.status(503).json({ error: 'ffmpeg is not installed, so browsers cannot be served' });
  }

  const audioTrack = Math.max(0, Number(req.query.audio ?? 0) || 0);
  try {
    const probed = await probeFile(video.path);
    const duration = Number(probed?.format?.duration) || video.duration || 0;
    if (!duration) throw new Error('the length of this file could not be read');

    const plan = await segmentPlan(video.id, video.path, duration);
    const base = '/api/stream/' + video.id + '/seg/' + audioTrack;
    res.type('application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buildPlaylist(plan, base));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** One segment, produced on demand the first time it is asked for. */
app.get('/api/stream/:videoId/seg/:audio/:index.ts', async (req, res) => {
  const video = library.getVideo(req.params.videoId, req.profile);
  if (!video) return res.status(404).json({ error: 'No such video' });

  const index = Number(req.params.index);
  const audioTrack = Math.max(0, Number(req.params.audio) || 0);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'bad segment' });
  }

  try {
    const probed = await probeFile(video.path);
    const duration = Number(probed?.format?.duration) || video.duration || 0;
    const plan = await segmentPlan(video.id, video.path, duration);
    const file = await ensureSegment({
      videoId: video.id,
      filePath: video.path,
      plan,
      index,
      delivery: planDelivery(probed),
      audioTrack,
    });
    res.type('video/mp2t');
    // A segment's contents never change, so it can be kept for good.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * One subtitle track, converted to the only format a browser reads.
 *
 * Streamed straight out of ffmpeg rather than kept: a subtitle track is small,
 * and converting it takes less time than deciding where to file it.
 */
app.get('/api/stream/:videoId/subtitles/:index.vtt', async (req, res) => {
  const video = library.getVideo(req.params.videoId, req.profile);
  if (!video) return res.status(404).json({ error: 'No such video' });

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'bad subtitle track' });
  }

  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) return res.status(503).json({ error: 'ffmpeg is not installed' });

  res.type('text/vtt');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', video.path,
    '-map', '0:s:' + index,
    '-f', 'webvtt',
    'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

  child.stdout.pipe(res);
  child.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  res.on('close', () => { try { child.kill(); } catch { /* already gone */ } });
});

app.get('/api/stream/:videoId/start', async (req, res) => {
  const video = library.getVideo(req.params.videoId, req.profile);
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
      audioTrack: Math.max(0, Number(req.query.audio ?? 0) || 0),
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
/**
 * The repacked copy, if there is one.
 *
 * Served as an ordinary file so the browser can ask for byte ranges and seek
 * without anything running on the server.
 */
app.get('/api/stream/:videoId/prepared', (req, res) => {
  if (preparedState(req.params.videoId) !== 'ready') {
    res.status(404).json({ error: 'No prepared copy of that video' });
    return;
  }
  res.type('video/mp4');
  res.sendFile(preparedPath(req.params.videoId), (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/stream/prepared/stats', async (req, res) => {
  res.json(await preparedStats());
});

app.get('/api/stream/:videoId/direct', (req, res) => {
  const video = library.getVideo(req.params.videoId, req.profile);
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
/** The comic scan has its own guard: the two read different folders. */
let comicScanning = false;
/** Stops the library watcher; set once the server is listening. */
let stopAutoScan = null;

/**
 * Scan because the library changed on disk, not because anyone asked.
 *
 * Silent by design apart from a log line: it happens while the app is being
 * used, so it must not interrupt anything. If a scan is already running there
 * is nothing to do — that scan will see the new files anyway.
 */
async function rescanAfterChange() {
  if (scanning) return;
  scanning = true;
  try {
    const stats = await runScan();
    console.log('automatic scan: ' + stats.movies + ' movies, ' + stats.shows + ' shows, '
      + stats.videos + ' files');
  } catch (error) {
    console.warn('automatic scan failed: ' + error.message);
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------------------
// Comics
// ---------------------------------------------------------------------------

/** The shelves, what is on them, and anything part-read. */
app.get('/api/comics', (req, res) => {
  res.json({
    shelves: comics.listShelves(req.profile.id),
    reading: comics.continueReading(20, req.profile.id),
    stats: comics.comicStats(req.profile.id),
  });
});

app.get('/api/comics/series/:id', (req, res) => {
  const series = comics.getSeries(req.params.id, req.profile.id);
  if (!series) return res.status(404).json({ error: 'No such series' });
  res.json(series);
});

app.get('/api/comics/issue/:id', (req, res) => {
  const issue = comics.getIssue(req.params.id, req.profile.id);
  if (!issue) return res.status(404).json({ error: 'No such comic' });
  res.json(issue);
});

/**
 * Make a comic ready to read.
 *
 * The archive is unpacked once, which takes a few seconds, and every page
 * after that is an ordinary file. Asked for explicitly rather than done on
 * the first page request, so the reader can say what it is waiting for.
 */
app.post('/api/comics/issue/:id/open', async (req, res) => {
  try {
    res.json(await comics.beginIssue(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/comics/issue/:id/page/:index', async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'bad page' });

  try {
    let file = comics.issuePageFile(req.params.id, index);
    if (!file) {
      // Either the comic has not been opened at all, or the unpacking has
      // not reached this page yet. Both are waited on rather than refused:
      // pages are written in order, so a reader is never far ahead of it.
      await comics.beginIssue(req.params.id);
      file = await comics.waitForPage(req.params.id, index);
    }
    if (!file) return res.status(404).json({ error: 'No such page' });

    res.type('image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * A cover.
 *
 * Answered at once when it has been drawn before. When it has not, the work
 * is started and this waits only a moment for it: a shelf asks for a dozen
 * covers together, and some of these archives take ten seconds to reach their
 * first page, so holding every one of those requests open would leave the
 * whole shelf blank until the slowest finished. Giving up quickly lets the
 * shelf draw with titles where the pictures are not ready, and they appear on
 * the next visit — by which time the work has finished in the background.
 */
app.get('/api/comics/issue/:id/cover', async (req, res) => {
  const ready = comics.coverReady(req.params.id);
  if (ready) {
    res.type('image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(ready);
  }

  try {
    const drawn = await Promise.race([
      comics.coverFor(req.params.id),
      // Long enough for an ordinary issue, which takes about eighty
      // milliseconds, and far too short for a two gigabyte compendium,
      // which takes eleven seconds. The big ones are drawn in the
      // background and appear when the shelf is next looked at.
      new Promise((resolve) => setTimeout(() => resolve(undefined), 400)),
    ]);

    if (drawn === undefined) {
      // Still being drawn. Not an error, just not yet.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'The cover is still being made' });
    }
    if (!drawn) return res.status(404).json({ error: 'No cover' });

    res.type('image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(drawn);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/comics/progress', (req, res) => {
  const saved = comics.saveProgress({
    issueId: req.body?.issueId,
    page: Number(req.body?.page) || 0,
    pages: req.body?.pages == null ? null : Number(req.body.pages),
    finished: Boolean(req.body?.finished),
    profileId: req.profile.id,
  });
  if (!saved) return res.status(404).json({ error: 'No such comic' });
  res.json(saved);
});

/** Read the comic folders again. Separate from the video scan on purpose. */
app.post('/api/comics/scan', requireOwner, async (req, res) => {
  if (comicScanning) return res.status(409).json({ error: 'a comic scan is already running' });
  comicScanning = true;
  try {
    res.json(await scanComics());
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    comicScanning = false;
  }
});

app.get('/api/scan/stream', requireOwner, async (req, res) => {
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

app.post('/api/scan', requireOwner, async (req, res) => {
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
      // Only once the server is up, so a library that changes during startup
      // cannot trigger a scan before anything can report it.
      stopAutoScan = startAutoScan({
        roots: config.libraryRoots,
        onQuiet: rescanAfterChange,
        onLog: (message) => console.log('[library] ' + message),
      });
      resolve(server);
    });

    server.on('close', () => {
      stopAutoScan?.();
      stopAutoScan = null;
      closeAllSessions();
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
