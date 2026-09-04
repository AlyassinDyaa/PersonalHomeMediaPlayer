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
/*
 * How long a session survives with nobody asking for segments.
 *
 * Was ninety seconds, which is shorter than a browser's read-ahead: ffmpeg
 * runs several times faster than playback, so a viewer can be twenty minutes
 * buffered and ask for nothing at all for a while. The session was then swept
 * up underneath them and the next segment came back missing, which shows as a
 * stall and a fresh "preparing" screen mid-episode.
 */
const IDLE_TIMEOUT_MS = 600_000;
/**
 * How long to wait for ffmpeg to produce a playlist worth serving.
 *
 * Thirty seconds was enough on an idle machine, where the first segment of a
 * remux appears in about two. It was not enough for a large file on a drive
 * that is also being copied from and scanned: ffmpeg was still reading when
 * the wait gave up, the session was killed, and a tablet sat on "Preparing…"
 * with nothing said about why. Waiting longer costs nothing when the stream is
 * going to arrive, and the viewer is told what is happening either way.
 */
const PLAYLIST_TIMEOUT_MS = 120_000;
/** More than this many at once would thrash the disk rather than serve anyone. */
const MAX_SESSIONS = 4;
/*
 * How much video is in one segment.
 *
 * A player buffers a few segments before it will start, so segment length sets
 * how much has to arrive before the first frame appears — six seconds meant
 * roughly eighteen seconds of video, around eight megabytes, downloaded before
 * anything happened. Two seconds asks for about a third of that. The source's
 * keyframes are ten seconds apart and ffmpeg was already splitting between
 * them rather than on them, so nothing here depends on the source cooperating.
 */
const SEGMENT_SECONDS = 2;

/** id -> session */
const sessions = new Map();
let sweeper = null;

function streamRoot() {
  return path.join(config.dataDir, 'stream');
}

/**
 * Clear out session folders left by a previous run.
 *
 * A session is only known about while the process that made it is alive, so a
 * server that was killed mid-stream leaves its folders behind with nothing to
 * ever remove them — three gigabytes had collected this way, and the count of
 * folders on disk had drifted past the limit the code believes it enforces.
 * Runs once, in the background, because nothing depends on the outcome.
 */
let sweptOnce = false;

function sweepOrphans() {
  if (sweptOnce) return;
  sweptOnce = true;

  fsp.readdir(streamRoot(), { withFileTypes: true })
    .then(async (entries) => {
      const live = new Set([...sessions.values()].map((session) => path.basename(session.dir)));
      for (const entry of entries) {
        if (!entry.isDirectory() || live.has(entry.name)) continue;
        await fsp.rm(path.join(streamRoot(), entry.name), { recursive: true, force: true })
          .catch(() => {});
      }
    })
    .catch(() => {
      // No folder yet, which is the same as nothing to clear.
    });
}

function keyFor(videoId, startSeconds, audioTrack) {
  return videoId + '@' + Math.max(0, Math.floor(startSeconds)) + '#a' + audioTrack;
}

/** Remove a session's process and its segments. */
async function destroySession(session, reason) {
  sessions.delete(session.key);
  session.stopped = true;

  if (session.child && !session.child.killed) {
    try { session.child.kill(); } catch { /* already gone */ }
  }
  /*
   * Delete the folder afterwards, not before the next video starts.
   *
   * A session holds a segment every two seconds, so an hour of film is well
   * over a thousand small files and the better part of a gigabyte; removing
   * one takes around half a second. Making room for a new stream awaited
   * several of those in turn, which a viewer experienced as the delay before
   * anything played. Nothing waits on the outcome: the session is already out
   * of the map and its ffmpeg already stopped, so the folder is just bytes
   * nobody is looking at.
   */
  fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {
    // A locked segment file will be swept up when the server next starts.
  });
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

  /*
   * Say what ffmpeg was complaining about, if anything.
   *
   * Giving up silently left the same message whether the drive was busy, the
   * file was unreadable or the codec was refused, and the only way to tell
   * them apart was to read the log on the computer — which is exactly what
   * somebody holding a tablet cannot do.
   */
  const tail = session.errorText.trim().split('\n').filter(Boolean).pop();
  console.warn('stream: gave up waiting for ' + session.key
    + (tail ? ' — ffmpeg said: ' + tail : ' — ffmpeg said nothing'));
  throw new Error(tail
    ? 'The video could not be prepared: ' + tail
    : 'The video could not be prepared in time. The drive may be busy.');
}

/**
 * Start, or re-join, a session for a video at an offset.
 *
 * @param {{videoId: string, filePath: string, startSeconds?: number}} request
 * @returns {Promise<{id: string, plan: object, playlist: string}>}
 */
export async function openSession(request) {
  sweepOrphans();

  const { videoId, filePath } = request;
  const startSeconds = Math.max(0, Math.floor(request.startSeconds ?? 0));
  const audioTrack = Math.max(0, Number(request.audioTrack ?? 0) || 0);
  const key = keyFor(videoId, startSeconds, audioTrack);

  const existing = sessions.get(key);
  if (existing && !existing.stopped) {
    existing.touchedAt = Date.now();
    const playlist = await waitForPlaylist(existing);
    return { id: existing.id, plan: existing.plan, playlist };
  }

  /*
   * Stop any other stream of the same video first.
   *
   * Seeking starts a stream from the new point, and the one it replaced was
   * being left to run: each transcodes the whole film as fast as the disk
   * allows, so a few jumps through a movie left seven of them racing over one
   * drive. The film being watched then arrived slower than it played, which is
   * the stall. Nobody is reading the old ones — the player has already moved
   * on — so they are simply stopped.
   */
  for (const other of [...sessions.values()]) {
    if (other.key !== key && other.key.startsWith(videoId + '@')) {
      await destroySession(other, 'replaced by a new position');
    }
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
    audioTrack,
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
