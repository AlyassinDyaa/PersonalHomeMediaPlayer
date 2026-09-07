/**
 * Finding ffmpeg, and asking it what is inside a file.
 *
 * A portable build carries its own copy beside the executable so nothing has to
 * be installed; a development checkout uses the one in vendor/. An explicit
 * path in the settings wins over both, for anyone who already has a build they
 * prefer.
 */

import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Places a bundled ffmpeg may sit, nearest first. */
function candidates(name) {
  const found = [];
  const configured = config.ffmpegDir;
  if (configured) found.push(path.join(configured, name + EXE));
  // Beside the packaged application.
  if (process.env.MEDIA_INSTALL_DIR) {
    found.push(path.join(process.env.MEDIA_INSTALL_DIR, 'ffmpeg', name + EXE));
  }
  found.push(path.join(PROJECT_ROOT, 'vendor', 'ffmpeg', name + EXE));
  return found;
}

let resolved = null;

/**
 * Paths to ffmpeg and ffprobe, or nulls when neither can be found.
 * Resolved once: this is asked on every stream request.
 */
export function ffmpegPaths() {
  if (resolved) return resolved;

  const pick = (name) => {
    for (const candidate of candidates(name)) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // An unreadable candidate is simply not the one.
      }
    }
    // Fall back to whatever is on PATH; spawning will fail clearly if absent.
    return null;
  };

  resolved = { ffmpeg: pick('ffmpeg'), ffprobe: pick('ffprobe') };
  return resolved;
}

/** Whether streaming to a browser is possible at all. */
export function ffmpegAvailable() {
  const { ffmpeg, ffprobe } = ffmpegPaths();
  return Boolean(ffmpeg && ffprobe);
}

// Probing costs a process launch and a disk seek, and the answer cannot change
// while the file is what it is, so it is remembered.
const probeCache = new Map();
const PROBE_CACHE_LIMIT = 500;

/**
 * What ffprobe reports about a file: its container, and its streams.
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export function probeFile(filePath) {
  const cached = probeCache.get(filePath);
  if (cached) return Promise.resolve(cached);

  const { ffprobe } = ffmpegPaths();
  if (!ffprobe) return Promise.reject(new Error('ffprobe was not found'));

  const args = [
    '-v', 'error',
    '-show_entries',
    /*
     * The language of each track, which nothing was asking for.
     *
     * Without it every soundtrack came back anonymous — "Audio 1", "Audio 2" —
     * so neither the picker nor anything choosing on your behalf could tell
     * English from anything else. A dual-audio film then played whichever
     * track the packager happened to put first, and looked like a bad
     * download.
     */
    'format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,channels,disposition:stream_tags=language,title',
    '-of', 'json',
    filePath,
  ];

  return new Promise((resolve, reject) => {
    execFile(ffprobe, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        /*
         * What went wrong, not how it was asked.
         *
         * This used to hand back the whole failed command — the path to
         * ffprobe, every argument, the file's full location — and the player
         * put it on screen. Across a phone in the dark that is a wall of text
         * with the answer buried in the last two words, and it tells anybody
         * holding the phone exactly how the drive is laid out.
         *
         * The cause worth distinguishing is a file that is there but unusable:
         * a download that stopped halfway, or a drive that has started to
         * fail. That reads as "damaged", which is a thing somebody can act on.
         */
        const name = path.basename(filePath);
        const complaint = String(error.message ?? '');
        const damaged = /invalid (data|argument)|moov atom not found|end of file/i.test(complaint);
        let size = null;
        try { size = fs.statSync(filePath).size; } catch { /* gone, or unreadable */ }

        const why = size === 0
          ? 'the file is empty'
          : damaged
            ? 'the file is damaged or unfinished'
            : 'the file could not be read';
        reject(new Error('“' + name + '” cannot be played — ' + why + '.'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error('ffprobe returned something unreadable'));
        return;
      }

      if (probeCache.size >= PROBE_CACHE_LIMIT) {
        probeCache.delete(probeCache.keys().next().value);
      }
      probeCache.set(filePath, parsed);
      resolve(parsed);
    });
  });
}

/**
 * The best H.264 encoder this machine actually has.
 *
 * Re-encoding on the processor is what makes "converting for this device" a
 * wait: a graphics card does the same work many times faster and leaves the
 * processor free for everything else the library is doing. Asked of ffmpeg
 * once and remembered, because the answer cannot change while it runs, and
 * because the question costs a process launch.
 *
 * Falls back to libx264, which is always present — a build without hardware
 * support, or a machine without the card, still plays, just more slowly.
 */
let cachedEncoder;

export function hardwareEncoder() {
  if (cachedEncoder !== undefined) return cachedEncoder;

  const { ffmpeg } = ffmpegPaths();
  if (!ffmpeg) {
    cachedEncoder = 'libx264';
    return cachedEncoder;
  }

  try {
    const listed = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    // Order is preference: NVIDIA, then Intel, then AMD.
    for (const candidate of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (listed.includes(candidate)) {
        cachedEncoder = candidate;
        return cachedEncoder;
      }
    }
  } catch {
    // Could not ask. The software encoder is the safe answer.
  }

  cachedEncoder = 'libx264';
  return cachedEncoder;
}

/* ------------------------------------------------- what a file actually is --- */

/**
 * The handful of facts worth putting on a title's page.
 *
 * Kept apart from probeFile because that one is asked before every play and is
 * deliberately narrow — adding fields to it would make every playback pay for
 * something only the detail page reads. This asks for more and is called once
 * per title, when somebody opens it.
 */
const qualityCache = new Map();
const QUALITY_CACHE_LIMIT = 400;

/** 4K, 1080p and so on, from the picture's actual width. */
function resolutionOf(video) {
  const width = Number(video?.width) || 0;
  const height = Number(video?.height) || 0;
  if (!width) return null;
  // Width rather than height: 2.39:1 films are letterboxed and their height
  // lies about them, which is how a 4K scope film reads as 1080p.
  if (width >= 3000) return '4K';
  if (width >= 1800) return '1080p';
  if (width >= 1200) return '720p';
  if (height) return 'SD';
  return null;
}

/**
 * The high-dynamic-range format, if any.
 *
 * Dolby Vision travels as a side channel rather than as a colour property, so
 * it is looked for separately and takes precedence — a file carrying both is
 * a Dolby Vision file with an HDR10 base for players that cannot read it.
 */
function dynamicRangeOf(video) {
  if (!video) return null;
  const sideData = video.side_data_list ?? [];
  if (sideData.some((entry) => /dovi|dolby vision/i.test(entry.side_data_type ?? ''))) {
    return 'Dolby Vision';
  }
  const transfer = video.color_transfer ?? '';
  if (/smpte2084|pq/i.test(transfer)) return 'HDR10';
  if (/arib-std-b67|hlg/i.test(transfer)) return 'HLG';
  return null;
}

/**
 * What the sound is.
 *
 * Atmos is reported by ffprobe in the profile string rather than as a codec of
 * its own, so it is read from there; anything else falls back to the channel
 * count, which is what a person recognises anyway.
 */
function soundOf(audio) {
  if (!audio) return null;
  if (/atmos/i.test(audio.profile ?? '')) return 'Dolby Atmos';

  const channels = Number(audio.channels) || 0;
  if (channels >= 8) return '7.1';
  if (channels >= 6) return '5.1';
  if (channels === 2) return 'Stereo';
  if (channels === 1) return 'Mono';
  return null;
}

/**
 * Probe one file for the badges a detail page shows.
 *
 * Never rejects. This is decoration on a page that is perfectly useful
 * without it, and a title whose file has gone missing should still open —
 * so a failure is an empty answer rather than a broken screen.
 *
 * @returns {Promise<{resolution: string|null, dynamicRange: string|null,
 *   sound: string|null, videoCodec: string|null}>}
 */
export function probeQuality(filePath) {
  const cached = qualityCache.get(filePath);
  if (cached) return Promise.resolve(cached);

  const { ffprobe } = ffmpegPaths();
  const empty = { resolution: null, dynamicRange: null, sound: null, videoCodec: null };
  if (!ffprobe) return Promise.resolve(empty);

  const args = [
    '-v', 'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,profile,width,height,channels,color_transfer,color_primaries',
    '-show_streams',
    '-of', 'json',
    filePath,
  ];

  return new Promise((resolve) => {
    execFile(ffprobe, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(empty);
        return;
      }

      let streams;
      try {
        streams = JSON.parse(stdout).streams ?? [];
      } catch {
        resolve(empty);
        return;
      }

      // Cover art is carried as a video stream and would be measured as the
      // picture, which is how a film reads as 600 pixels wide.
      const video = streams.find(
        (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
      );
      /* The first audio track, which is the one a player starts on. */
      const audio = streams.find((stream) => stream.codec_type === 'audio');

      const answer = {
        resolution: resolutionOf(video),
        dynamicRange: dynamicRangeOf(video),
        sound: soundOf(audio),
        videoCodec: video?.codec_name ?? null,
      };

      if (qualityCache.size >= QUALITY_CACHE_LIMIT) {
        qualityCache.delete(qualityCache.keys().next().value);
      }
      qualityCache.set(filePath, answer);
      resolve(answer);
    });
  });
}
