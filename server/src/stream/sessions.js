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
 * Seeking backwards is free — every segment is kept. Seeking forwards lands
 * inside what has already been produced far more often than not, so a session
 * is reused whenever it already covers the wanted point, and only a jump past
 * the end of it starts a new one. Sessions are therefore keyed by where they
 * begin, but found by what they cover.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ffmpegPaths, probeFile } from './ffmpeg.js';
import { planDelivery, hlsArguments } from './plan.js';
import { selectEncoder } from './encoders.js';

/**
 * Seconds of silence before a session is considered abandoned.
 *
 * Generous on purpose. This used to be ninety seconds, measured from the last
 * segment request — which meant pausing an episode to answer the door ended the
 * stream and deleted its segments, and pressing play again produced an error
 * rather than the rest of the episode. A paused player now says so (see
 * keepAlive), and anything genuinely abandoned is still swept up within ten
 * minutes.
 */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * A session touched this recently is someone actively watching, and is not a
 * candidate for eviction while a quieter one exists.
 */
const PROTECTED_MS = 60_000;

/** How long to wait for ffmpeg to produce a playlist worth serving. */
const PLAYLIST_TIMEOUT_MS = 30_000;
/** More than this many at once would thrash the disk rather than serve anyone. */
const MAX_SESSIONS = 6;
const SEGMENT_SECONDS = 6;

/**
 * How close to the end of what has been produced a seek may land and still be
 * served by an existing session. Seeking to the very edge stalls until the next
 * segment appears, which looks like a hang, so the last few seconds do not count
 * as covered.
 */
const COVERAGE_MARGIN_SECONDS = 4;

/** id -> session */
const sessions = new Map();
let sweeper = null;

function streamRoot() {
  return path.join(config.dataDir, 'stream');
}

function keyFor(videoId, startSeconds, maxHeight) {
  // The picture size is part of the identity: a session encoded down for a
  // phone is not a substitute for one at full size, and vice versa.
  return videoId + '@' + Math.max(0, Math.floor(startSeconds)) + '#' + (maxHeight ?? 'auto');
}

/**
 * How much of the file a session has actually produced, read from its playlist.
 *
 * The playlist is the only honest source: ffmpeg lists a segment once it is
 * complete, so the sum of the durations in it is exactly what can be served
 * right now.
 *
 * @returns {Promise<{seconds: number, finished: boolean, hasSegments: boolean}>}
 */
async function readProgress(session) {
  let text;
  try {
    text = await fsp.readFile(session.playlistPath, 'utf8');
  } catch {
    return { seconds: 0, finished: false, hasSegments: false };
  }

  let seconds = 0;
  for (const match of text.matchAll(/^#EXTINF:([\d.]+)/gm)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) seconds += value;
  }

  const finished = text.includes('#EXT-X-ENDLIST');
  const hasSegments = /\.m4s|\.ts/.test(text);

  session.producedSeconds = seconds;
  if (finished) session.finished = true;
  return { seconds, finished, hasSegments };
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

    const { hasSegments, finished } = await readProgress(session);
    if (hasSegments) return fsp.readFile(session.playlistPath, 'utf8');
    // ffmpeg finishing without producing anything means the file had nothing
    // in it this device can be given. Waiting out the timeout would only
    // delay saying so.
    if (finished || (session.exited && !hasSegments)) {
      throw new Error(session.failed || 'that file produced no video this device can play');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the video could not be prepared in time');
}

/**
 * A session already running that can serve this point in this file.
 *
 * Preferring the latest start that still covers the wanted point: it is the one
 * with the least work between its beginning and where the viewer is going.
 */
async function findCovering(videoId, wanted, maxHeight) {
  const candidates = [...sessions.values()].filter((session) => (
    session.videoId === videoId
    && session.maxHeight === maxHeight
    && !session.stopped
    && !session.failed
    && session.startSeconds <= wanted
  )).sort((a, b) => b.startSeconds - a.startSeconds);

  for (const session of candidates) {
    const { seconds, finished } = await readProgress(session);
    const reach = session.startSeconds + seconds;
    if (finished || wanted <= reach - COVERAGE_MARGIN_SECONDS) return session;
  }
  return null;
}

/** Free a slot, choosing the least likely to be missed. */
async function makeRoom() {
  while (sessions.size >= MAX_SESSIONS) {
    const byAge = [...sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt);
    const now = Date.now();
    // Somebody watching right now keeps their session; only when every one of
    // them is in use does the oldest lose regardless.
    const victim = byAge.find((s) => now - s.touchedAt > PROTECTED_MS) ?? byAge[0];
    if (!victim) break;
    await destroySession(victim, 'making room');
  }
}

/**
 * Start, or re-join, a session for a video at an offset.
 *
 * @param {{videoId: string, filePath: string, startSeconds?: number,
 *   limits?: {maxBitrate?: number, maxHeight?: number}}} request
 * @returns {Promise<{id: string, plan: object, playlist: string,
 *   startSeconds: number, reused: boolean}>}
 */
export async function openSession(request) {
  const { videoId, filePath } = request;
  const wanted = Math.max(0, Math.floor(request.startSeconds ?? 0));
  const limits = request.limits ?? {};
  const maxHeight = limits.maxHeight ?? null;
  const key = keyFor(videoId, wanted, maxHeight);

  const existing = sessions.get(key);
  if (existing && !existing.stopped) {
    existing.touchedAt = Date.now();
    const playlist = await waitForPlaylist(existing);
    return {
      id: existing.id,
      plan: existing.plan,
      playlist,
      startSeconds: existing.startSeconds,
      reused: true,
    };
  }

  // Seeking within a film usually lands inside something already running.
  // Handing that session back costs nothing, where starting another means a
  // fresh ffmpeg, a fresh probe and several seconds of black.
  const covering = await findCovering(videoId, wanted, maxHeight);
  if (covering) {
    covering.touchedAt = Date.now();
    console.log('stream: reusing ' + covering.key + ' for ' + wanted + 's');
    return {
      id: covering.id,
      plan: covering.plan,
      playlist: await fsp.readFile(covering.playlistPath, 'utf8'),
      startSeconds: covering.startSeconds,
      reused: true,
    };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('That file is not where the library expects it');
  }

  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) throw new Error('ffmpeg was not found, so browsers cannot be served');

  await makeRoom();

  const probed = await probeFile(filePath);
  const plan = planDelivery(probed, limits);
  // Only an encode needs one, but asking is cheap after the first time and the
  // answer is wanted before the process is spawned.
  const encoder = plan.video === 'encode' ? await selectEncoder() : null;

  const id = key.replace(/[^a-zA-Z0-9@]/g, '') + '-' + Date.now().toString(36);
  const dir = path.join(streamRoot(), id);
  await fsp.mkdir(dir, { recursive: true });

  const playlistPath = path.join(dir, 'index.m3u8');
  const args = hlsArguments(plan, {
    input: filePath,
    // A copied picture can only begin at a keyframe, so ffmpeg starts at the
    // one before this point rather than exactly on it. That puts the viewer a
    // few seconds earlier than asked, which is the right direction to be wrong
    // in when resuming something.
    startSeconds: wanted,
    playlist: playlistPath,
    segmentPattern: path.join(dir, 'seg%05d.m4s'),
    initFile: 'init.mp4',
    segmentSeconds: SEGMENT_SECONDS,
    encoder,
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
    id, key, dir, playlistPath, plan, videoId, maxHeight, child,
    startSeconds: wanted,
    producedSeconds: 0,
    touchedAt: Date.now(),
    stopped: false,
    exited: false,
    finished: false,
    failed: null,
    errorText: '',
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
    session.exited = true;
    session.failed = 'ffmpeg could not be started: ' + error.message;
  });

  child.on('exit', (code) => {
    session.child = null;
    session.exited = true;
    if (code === 0) {
      // The whole file has been converted; the playlist now carries ENDLIST
      // and everything in it can be served until the session is swept.
      session.finished = true;
      return;
    }
    // 255 is what killing it ourselves looks like, and null means the same.
    if (code !== null && code !== 255) {
      session.failed = session.errorText.trim().split('\n').pop()
        || ('ffmpeg stopped with code ' + code);
      console.warn('stream: ffmpeg failed for ' + key + ': ' + session.failed);
    }
  });

  const how = plan.mode + (encoder ? ' via ' + encoder.label : '');
  console.log('stream: started ' + key + ' (' + how + ': ' + plan.reason + ')');

  try {
    const playlist = await waitForPlaylist(session);
    return { id, plan, playlist, startSeconds: wanted, reused: false };
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

/**
 * Say that a session is still wanted even though nothing is being fetched.
 *
 * A paused player asks for no segments, and used to be indistinguishable from a
 * closed tab. Now it says so every half minute, so the sweeper leaves it alone.
 *
 * @returns {boolean} whether there was still a session to keep
 */
export function keepAlive(id) {
  return Boolean(touchSession(id));
}

/**
 * What a session is doing, for a player that has stopped receiving video.
 *
 * Without this a stream that failed forty minutes in simply stops, with no
 * distinction between "the episode ended", "still converting" and "ffmpeg died"
 * — three things that need three different responses from the viewer.
 *
 * @returns {Promise<object|null>}
 */
export async function sessionStatus(id) {
  const session = touchSession(id);
  if (!session) return null;

  const { seconds, finished } = await readProgress(session);
  return {
    id: session.id,
    startSeconds: session.startSeconds,
    producedSeconds: seconds,
    // Where in the film the stream currently reaches.
    reachesSeconds: session.startSeconds + seconds,
    finished: finished || session.finished,
    failed: session.failed,
    mode: session.plan?.mode ?? null,
  };
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

export const _internals = {
  keyFor,
  readProgress,
  IDLE_TIMEOUT_MS,
  PROTECTED_MS,
  MAX_SESSIONS,
  SEGMENT_SECONDS,
  COVERAGE_MARGIN_SECONDS,
};
