/**
 * Live HLS sessions: one running ffmpeg per thing being watched.
 *
 * Converting a whole film before playback starts was measured at five minutes
 * for a two hour file, which is not a "press play" experience. So ffmpeg is
 * started at the point being watched and writes segments into a folder while
 * the browser reads them. Playback begins within a few seconds, and because
 * repackaging runs about twenty times faster than watching, the rest of the
 * file is ready long before the viewer reaches it.
 *
 * Seeking backwards is free — every segment is kept. Seeking forwards past what
 * has been produced starts a new session at that point, which is why sessions
 * are keyed by their starting offset.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ffmpegPaths, probeFile } from './ffmpeg.js';
import { planDelivery, hlsArguments } from './plan.js';

/** Seconds of no requests before a session is considered abandoned. */
const IDLE_TIMEOUT_MS = 90_000;
/** How long to wait for ffmpeg to produce a playlist worth serving. */
const PLAYLIST_TIMEOUT_MS = 30_000;
/** More than this many at once would thrash the disk rather than serve anyone. */
const MAX_SESSIONS = 4;
const SEGMENT_SECONDS = 6;

/** id -> session */
const sessions = new Map();
let sweeper = null;

function streamRoot() {
  return path.join(config.dataDir, 'stream');
}

function keyFor(videoId, startSeconds) {
  return videoId + '@' + Math.max(0, Math.floor(startSeconds));
}

/** Remove a session's process and its segments. */
async function destroySession(session, reason) {
  sessions.delete(session.key);
  session.stopped = true;

  if (session.child && !session.child.killed) {
    try { session.child.kill(); } catch { /* already gone */ }
  }
  try {
    await fsp.rm(session.dir, { recursive: true, force: true });
  } catch {
    // A locked segment file will be swept up next time round.
  }
  console.log('stream: ended ' + session.key + ' (' + reason + ')');
}

/** Close sessions nobody has asked about for a while. */
function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.touchedAt > IDLE_TIMEOUT_MS) {
        destroySession(session, 'idle');
      }
    }
    if (sessions.size === 0) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 15_000);
  // The sweeper must never be the reason the process stays alive.
  if (sweeper.unref) sweeper.unref();
}

/** Wait until the playlist holds at least one segment, or give up. */
async function waitForPlaylist(session) {
  const deadline = Date.now() + PLAYLIST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (session.stopped) throw new Error('the stream stopped before it started');
    if (session.failed) throw new Error(session.failed);

    try {
      const text = await fsp.readFile(session.playlistPath, 'utf8');
      if (/\.m4s|\.ts/.test(text)) return text;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the video could not be prepared in time');
}

/**
 * Start, or re-join, a session for a video at an offset.
 *
 * @param {{videoId: string, filePath: string, startSeconds?: number}} request
 * @returns {Promise<{id: string, plan: object, playlist: string}>}
 */
export async function openSession(request) {
  const { videoId, filePath } = request;
  const startSeconds = Math.max(0, Math.floor(request.startSeconds ?? 0));
  const key = keyFor(videoId, startSeconds);

  const existing = sessions.get(key);
  if (existing && !existing.stopped) {
    existing.touchedAt = Date.now();
    const playlist = await waitForPlaylist(existing);
    return { id: existing.id, plan: existing.plan, playlist };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('That file is not where the library expects it');
  }

  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) throw new Error('ffmpeg was not found, so browsers cannot be served');

  // Make room rather than pile up: the oldest is the least likely to be watched.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
    if (!oldest) break;
    await destroySession(oldest, 'making room');
  }

  const probed = await probeFile(filePath);
  const plan = planDelivery(probed);

  const id = key.replace(/[^a-zA-Z0-9@]/g, '') + '-' + Date.now().toString(36);
  const dir = path.join(streamRoot(), id);
  await fsp.mkdir(dir, { recursive: true });

  const playlistPath = path.join(dir, 'index.m3u8');
  const args = hlsArguments(plan, {
    input: filePath,
    startSeconds,
    playlist: playlistPath,
    segmentPattern: path.join(dir, 'seg%05d.m4s'),
    initFile: 'init.mp4',
    segmentSeconds: SEGMENT_SECONDS,
  });

  // Run inside the session's own folder. The name of the init segment is
  // written into the playlist exactly as it is given to ffmpeg, so it has to
  // stay a bare filename — which means ffmpeg resolves it against its working
  // directory. Left at the default that put every session's init segment in one
  // shared place, where concurrent viewers overwrote each other's.
  const child = spawn(ffmpeg, args, {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  const session = {
    id, key, dir, playlistPath, plan, startSeconds, child,
    touchedAt: Date.now(), stopped: false, failed: null, errorText: '',
  };
  sessions.set(key, session);
  startSweeper();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // Keep only the tail: a failure message is at the end, and a long run can
    // otherwise accumulate megabytes of warnings.
    session.errorText = (session.errorText + chunk).slice(-2000);
  });

  child.on('error', (error) => {
    session.failed = 'ffmpeg could not be started: ' + error.message;
  });

  child.on('exit', (code) => {
    session.child = null;
    // Exit code 0 means the file finished converting, which is success. A
    // non-zero code before any segment appeared is a real failure.
    if (code !== 0 && code !== null && code !== 255) {
      session.failed = session.errorText.trim().split('\n').pop()
        || ('ffmpeg stopped with code ' + code);
      console.warn('stream: ffmpeg failed for ' + key + ': ' + session.failed);
    }
  });

  console.log('stream: started ' + key + ' (' + plan.mode + ': ' + plan.reason + ')');

  try {
    const playlist = await waitForPlaylist(session);
    return { id, plan, playlist };
  } catch (error) {
    await destroySession(session, 'failed to start');
    throw error;
  }
}

/** A session by id, marked as still wanted. */
export function touchSession(id) {
  for (const session of sessions.values()) {
    if (session.id === id) {
      session.touchedAt = Date.now();
      return session;
    }
  }
  return null;
}

/** Close every session; used when the server is shutting down. */
export async function closeAllSessions() {
  await Promise.all([...sessions.values()].map((s) => destroySession(s, 'shutting down')));
}

/**
 * Delete anything left behind by a previous run.
 *
 * A crash leaves segment folders on disk, and they can be gigabytes.
 */
export async function clearStreamCache() {
  try {
    await fsp.rm(streamRoot(), { recursive: true, force: true });
  } catch {
    // Nothing there, or in use; either way it is not worth failing startup.
  }
}

export const _internals = { keyFor, IDLE_TIMEOUT_MS, MAX_SESSIONS, SEGMENT_SECONDS };
