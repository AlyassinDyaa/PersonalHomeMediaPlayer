/**
 * Whole-file HLS: a playlist that describes the entire video before any of it
 * has been produced, with the pieces made only when they are asked for.
 *
 * The previous approach ran one ffmpeg from the point being watched and let it
 * write a growing "event" playlist. That plays, but such a playlist can only
 * ever describe the part already produced, and it carries no end marker while
 * ffmpeg is still running — so Safari reads it as a live broadcast. On an iPad
 * that meant a LIVE badge, no scrubber, no skip buttons and a remaining time of
 * -107:55:07. Seeking was not slow, it was absent: a live stream has nowhere to
 * seek to.
 *
 * Here the playlist is written from a keyframe index instead — every segment,
 * its exact duration, and an end marker, all before a single frame is produced.
 * The player therefore knows the real length, allows seeking anywhere, and asks
 * for whichever segment it lands on. Measured on a 23 minute REMUX: 1859
 * keyframes, about one a second, indexed in 1.6s and then kept, so cuts land on
 * real keyframes and the picture is still copied rather than re-encoded.
 *
 * Segments are MPEG-TS rather than fragmented MP4 deliberately: a TS segment
 * stands alone, so there is no shared initialisation segment whose codec
 * parameters would have to agree across pieces produced separately, minutes
 * apart, by different ffmpeg runs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ffmpegPaths } from './ffmpeg.js';

/** Segments this long, give or take wherever the next keyframe falls. */
const TARGET_SEGMENT_SECONDS = 6;

/** Indexes are small and asked for constantly while something is being watched. */
const indexCache = new Map();
/** Segments being produced right now, so two requests never run ffmpeg twice. */
const inFlight = new Map();

function segmentRoot() {
  return path.join(config.dataDir, 'stream');
}

function segmentDir(videoId) {
  return path.join(segmentRoot(), videoId);
}

/**
 * Every keyframe time in the video, in seconds.
 *
 * Read from the container rather than assumed: a cut anywhere else would need
 * the picture re-encoded, which is the expensive thing this design avoids.
 */
async function keyframeTimes(filePath) {
  const { ffprobe } = ffmpegPaths();
  if (!ffprobe) throw new Error('ffprobe was not found, so browsers cannot be served');

  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    filePath,
  ];

  const text = await new Promise((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error('ffprobe failed: ' + err.trim().split('\n').pop()));
    });
  });

  const times = [];
  for (const line of text.split('\n')) {
    // Lines read "12.345000,K__"; only keyframes, and only ones with a time.
    if (!line.includes(',K')) continue;
    const seconds = Number(line.slice(0, line.indexOf(',')));
    if (Number.isFinite(seconds)) times.push(seconds);
  }
  times.sort((a, b) => a - b);
  return times;
}

/**
 * Group keyframes into segments of roughly the target length.
 *
 * @returns {{segments: Array<{index: number, start: number, duration: number}>,
 *   duration: number}}
 */
function planSegments(keyframes, duration) {
  const segments = [];
  if (!duration || duration <= 0) return { segments, duration: 0 };

  // A file whose keyframes could not be read still has to be playable, so it
  // falls back to even cuts; the caller then re-encodes rather than copies,
  // because an arbitrary cut is not something a copy can honour.
  const cuts = keyframes.length > 1 ? keyframes : [0];

  let start = 0;
  let cursor = 0;
  while (start < duration - 0.1) {
    let next = duration;
    while (cursor < cuts.length && cuts[cursor] <= start + 0.001) cursor++;
    for (let i = cursor; i < cuts.length; i++) {
      if (cuts[i] >= start + TARGET_SEGMENT_SECONDS) {
        next = Math.min(cuts[i], duration);
        break;
      }
    }
    segments.push({ index: segments.length, start, duration: Math.max(0.1, next - start) });
    start = next;
    // A guard no real media reaches; a malformed index must not spin forever.
    if (segments.length > 20000) break;
  }
  return { segments, duration };
}

/** The segment plan for a video, worked out once and kept. */
export async function segmentPlan(videoId, filePath, duration) {
  const cached = indexCache.get(videoId);
  if (cached) return cached;

  let keyframes = [];
  try {
    keyframes = await keyframeTimes(filePath);
  } catch {
    // An unreadable index is not fatal; it only costs a re-encode.
  }
  const plan = planSegments(keyframes, duration);
  plan.keyframeAligned = keyframes.length > 1;
  indexCache.set(videoId, plan);
  return plan;
}

/** The playlist a player reads: every segment, its length, and an end marker. */
export function buildPlaylist(plan, segmentUrlBase) {
  const longest = plan.segments.reduce((max, s) => Math.max(max, s.duration), 0);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + Math.ceil(longest),
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const segment of plan.segments) {
    lines.push('#EXTINF:' + segment.duration.toFixed(6) + ',');
    lines.push(segmentUrlBase + '/' + segment.index + '.ts');
  }
  // Without this the player treats the stream as still growing, which is
  // exactly the bug this replaces.
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * Produce one segment, or hand back the one already made.
 *
 * @returns {Promise<string>} Path to the segment on disk.
 */
export async function ensureSegment({
  videoId, filePath, plan, index, delivery, audioTrack = 0,
}) {
  const segment = plan.segments[index];
  if (!segment) throw new Error('no such segment');

  // Kept per audio track, since choosing a different language changes the sound
  // but not the picture, and both versions are worth keeping once made.
  const dir = path.join(segmentDir(videoId), 'a' + audioTrack);
  const file = path.join(dir, index + '.ts');
  if (fs.existsSync(file)) return file;

  const running = inFlight.get(file);
  if (running) return running;

  const work = (async () => {
    const { ffmpeg } = ffmpegPaths();
    if (!ffmpeg) throw new Error('ffmpeg was not found, so browsers cannot be served');
    await fsp.mkdir(dir, { recursive: true });

    const partial = file + '.part';
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      // Seeking before the input is the fast form, and these boundaries are
      // real keyframes, so it lands exactly where the playlist promised.
      '-ss', String(segment.start),
      '-i', filePath,
      '-t', String(segment.duration),
      '-map', '0:v:0',
      '-map', '0:a:' + audioTrack + '?',
    ];

    if (delivery.video === 'copy' && plan.keyframeAligned) {
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p',
        // A keyframe at the start of the segment, so it stands alone.
        '-force_key_frames', 'expr:gte(t,0)',
      );
    }

    if (delivery.audio === 'copy') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

    args.push(
      // The segment's timestamps continue from where it sits in the film, so
      // the pieces join seamlessly and the player's clock reads the true
      // position. This is right here precisely because the playlist describes
      // the whole file; the same flag over a partial playlist is what cost the
      // iPad its scrubber.
      '-output_ts_offset', String(segment.start),
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-f', 'mpegts',
      partial,
    );

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-1000); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim().split('\n').pop() || ('ffmpeg exited ' + code)));
      });
    });

    // Renamed only once complete, so a half-written segment is never served.
    await fsp.rename(partial, file);
    return file;
  })().finally(() => inFlight.delete(file));

  inFlight.set(file, work);
  return work;
}

/** Forget a video's produced segments. */
export async function clearSegments(videoId) {
  indexCache.delete(videoId);
  await fsp.rm(segmentDir(videoId), { recursive: true, force: true }).catch(() => {});
}

/** Remove everything left behind by a previous run. */
export async function clearAllSegments() {
  await fsp.rm(segmentRoot(), { recursive: true, force: true }).catch(() => {});
}
