/**
 * Choosing an H.264 encoder.
 *
 * Software encoding is the reason a re-encoded film stalls. libx264 at 1080p on
 * a laptop runs at roughly half real time, so the viewer watches faster than
 * ffmpeg can produce, and the player rebuffers every few seconds for the whole
 * film. Every machine this app is likely to run on has a hardware encoder
 * sitting idle — Intel Quick Sync, an NVIDIA card, or Apple's VideoToolbox —
 * and any of them will do the same job several times faster than real time.
 *
 * Being listed by ffmpeg is not the same as working: a build advertises
 * h264_nvenc whether or not there is an NVIDIA card in the machine, and asking
 * it to encode is the only way to find out. So each candidate is made to encode
 * a fraction of a second of black before it is trusted. That costs a few
 * hundred milliseconds, once, at startup.
 */

import { execFile } from 'node:child_process';
import { ffmpegPaths } from './ffmpeg.js';

/**
 * Candidates in the order they are worth having, per platform.
 *
 * Quality settings differ per encoder because the options are not shared: NVENC
 * counts quality with -cq, Quick Sync with -global_quality, and VideoToolbox
 * only really understands a bitrate. All of them are additionally capped by the
 * -maxrate the plan sets, so the figures here decide how the budget is spent
 * rather than how large it is.
 *
 * VA-API is deliberately absent. It cannot accept frames from an ordinary
 * software decoder without an explicit upload step, which means a filter graph
 * this pipeline does not build, so offering it would only produce a confusing
 * failure on the machines that advertise it.
 */
const CANDIDATES = [
  {
    name: 'h264_nvenc',
    hardware: true,
    label: 'NVIDIA',
    platforms: ['win32', 'linux'],
    quality: (bitrate) => ['-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', String(bitrate)],
  },
  {
    name: 'h264_qsv',
    hardware: true,
    label: 'Intel Quick Sync',
    platforms: ['win32', 'linux'],
    quality: (bitrate) => ['-preset', 'veryfast', '-global_quality', '23', '-b:v', String(bitrate)],
  },
  {
    name: 'h264_videotoolbox',
    hardware: true,
    label: 'Apple VideoToolbox',
    platforms: ['darwin'],
    quality: (bitrate) => ['-b:v', String(bitrate), '-realtime', '1'],
  },
  {
    name: 'h264_amf',
    hardware: true,
    label: 'AMD',
    platforms: ['win32'],
    quality: (bitrate) => ['-quality', 'speed', '-rc', 'vbr_peak', '-b:v', String(bitrate)],
  },
];

/** Always available, always correct, merely slow. */
export const SOFTWARE = {
  name: 'libx264',
  hardware: false,
  label: 'software',
  quality: () => ['-preset', 'veryfast', '-crf', '21'],
};

/** How long a candidate gets to prove itself before being passed over. */
const PROBE_TIMEOUT_MS = 10_000;

/** Ask ffmpeg whether an encoder can actually run on this machine. */
function canEncode(ffmpeg, encoder) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      // A fraction of a second of black is enough to make the encoder open a
      // device and admit whether it exists.
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25',
      '-t', '0.2',
      '-c:v', encoder.name,
      '-f', 'null', '-',
    ];
    execFile(ffmpeg, args, { timeout: PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });
}

let chosen = null;
let pending = null;

/**
 * The best encoder this machine can use, found once and remembered.
 *
 * Never rejects: a machine with no working hardware encoder gets libx264, which
 * is slow but always right.
 *
 * @returns {Promise<{name: string, hardware: boolean, label: string, quality: Function}>}
 */
export function selectEncoder() {
  if (chosen) return Promise.resolve(chosen);
  if (pending) return pending;

  pending = (async () => {
    const { ffmpeg } = ffmpegPaths();
    if (!ffmpeg) return SOFTWARE;

    const viable = CANDIDATES.filter((c) => c.platforms.includes(process.platform));
    for (const candidate of viable) {
      // Sequential on purpose: the first that works is the one wanted, and
      // opening several graphics devices at once to ask is impolite.
      if (await canEncode(ffmpeg, candidate)) {
        console.log('stream: encoding with ' + candidate.label + ' (' + candidate.name + ')');
        return candidate;
      }
    }
    console.log('stream: no hardware encoder available, falling back to software');
    return SOFTWARE;
  })().then((encoder) => {
    chosen = encoder;
    pending = null;
    return encoder;
  });

  return pending;
}

/** Start the search in the background, so the first play does not pay for it. */
export function warmUpEncoder() {
  selectEncoder().catch(() => {
    // Falling back to software is the failure mode, and it is already handled.
  });
}

export const _internals = { CANDIDATES, canEncode };
