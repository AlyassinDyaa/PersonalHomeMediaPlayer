/** Checks the rules that decide what a browser can be given. */

import assert from 'node:assert';
import { planDelivery, hlsArguments } from '../server/src/stream/plan.js';

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

const probe = (container, video, audio) => ({
  format: { format_name: container },
  streams: [
    video ? { codec_type: 'video', ...video } : null,
    audio ? { codec_type: 'audio', ...audio } : null,
  ].filter(Boolean),
});

/** A probe that also carries the numbers the bitrate rules read. */
const sized = ({ container = 'matroska,webm', bitrate, video = {}, audio = { codec_name: 'aac' } }) => ({
  format: { format_name: container, bit_rate: bitrate == null ? undefined : String(bitrate) },
  streams: [
    { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', ...video },
    audio ? { codec_type: 'audio', ...audio } : null,
  ].filter(Boolean),
});

check('an MP4 of H.264 and AAC is handed over untouched', () => {
  const plan = planDelivery(probe('mov,mp4,m4a,3gp,3g2,mj2',
    { codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'aac' }));
  assert.strictEqual(plan.mode, 'direct');
});

check('H.264 in Matroska is repackaged, never re-encoded', () => {
  // The bulk of the library. Re-encoding these would be hours of work for no
  // gain, so this is the case that matters most.
  const plan = planDelivery(probe('matroska,webm',
    { codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'eac3' }));
  assert.strictEqual(plan.mode, 'remux');
  assert.strictEqual(plan.video, 'copy', 'the picture is kept');
  assert.strictEqual(plan.audio, 'encode', 'only the sound is converted');
});

check('10-bit HEVC is kept as it is', () => {
  // Apple hardware decodes HEVC Main 10; re-encoding it would be wasteful.
  const plan = planDelivery(probe('matroska,webm',
    { codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le' }, { codec_name: 'eac3' }));
  assert.strictEqual(plan.video, 'copy');
});

check('10-bit H.264 is re-encoded', () => {
  // Unlike HEVC, no Apple device decodes this in hardware.
  const plan = planDelivery(probe('matroska,webm',
    { codec_name: 'h264', pix_fmt: 'yuv420p10le' }, { codec_name: 'aac' }));
  assert.strictEqual(plan.mode, 'encode');
});

check('an old AVI cartoon is re-encoded', () => {
  const plan = planDelivery(probe('avi',
    { codec_name: 'msmpeg4v3', pix_fmt: 'yuv420p' }, { codec_name: 'mp3' }));
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.audio, 'encode');
});

check('AAC in Matroska still only needs repackaging', () => {
  const plan = planDelivery(probe('matroska,webm',
    { codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'aac' }));
  assert.strictEqual(plan.mode, 'remux');
  assert.strictEqual(plan.audio, 'copy');
});

check('cover art is not mistaken for the picture', () => {
  // Music-style attached images appear as video streams and would otherwise
  // be chosen as the thing to play.
  const plan = planDelivery({
    format: { format_name: 'matroska,webm' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });
  assert.strictEqual(plan.video, 'copy');
  assert.strictEqual(plan.mode, 'remux');
});

check('a file with no video stream is refused rather than half-played', () => {
  const plan = planDelivery(probe('matroska,webm', null, { codec_name: 'aac' }));
  assert.strictEqual(plan.mode, 'encode');
  assert.match(plan.reason, /no video/);
});

check('a file with no sound still plays', () => {
  const plan = planDelivery(probe('matroska,webm', { codec_name: 'h264', pix_fmt: 'yuv420p' }, null));
  assert.strictEqual(plan.video, 'copy');
});

// --- bitrate and picture size --------------------------------------------

check('a Blu-ray remux is sent smaller rather than stalling the tablet', () => {
  // The bug this exists for: H.264 in Matroska, so the codec rules say copy it,
  // but thirty megabits a second is more than household Wi-Fi carries and the
  // player buffers forever while looking, by every other measure, fine.
  const plan = planDelivery(sized({ bitrate: 30_000_000, video: { height: 1080 } }));
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.targetBitrate, 8_000_000);
  assert.match(plan.reason, /faster than the network/);
});

check('an ordinary 1080p rip is still repackaged, never re-encoded', () => {
  // The common case, and the one that must not regress: re-encoding these
  // would be hours of work for no gain.
  const plan = planDelivery(sized({ bitrate: 5_000_000, video: { height: 1080 } }));
  assert.strictEqual(plan.mode, 'remux');
  assert.strictEqual(plan.video, 'copy');
});

check('4K is scaled down to something a tablet can receive', () => {
  const plan = planDelivery(sized({
    bitrate: 40_000_000,
    video: { codec_name: 'hevc', height: 2160 },
  }));
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.targetHeight, 1080);
});

check('a file whose bitrate cannot be read is left alone', () => {
  // Guessing would mean re-encoding files that never needed it, which is the
  // more expensive mistake of the two.
  const plan = planDelivery(sized({ bitrate: null, video: { height: 1080 } }));
  assert.strictEqual(plan.mode, 'remux');
  assert.strictEqual(plan.video, 'copy');
});

check('bitrate is worked out from the file size when nothing states it', () => {
  const plan = planDelivery({
    format: { format_name: 'matroska,webm', size: String(30 * 1024 ** 3), duration: '3600' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', height: 1080 },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });
  // Thirty gigabytes in an hour is about seventy megabits a second.
  assert.strictEqual(plan.mode, 'encode');
});

check('a small cartoon is never blown up to fill the budget', () => {
  const plan = planDelivery(sized({
    bitrate: 900_000,
    video: { pix_fmt: 'yuv420p10le', height: 480 },
  }));
  assert.strictEqual(plan.mode, 'encode', '10-bit H.264 has to be re-encoded');
  assert.strictEqual(plan.targetHeight, null, 'no scaling, so no upscaling');
});

check('the re-encode never costs more than the original did', () => {
  const plan = planDelivery(sized({
    bitrate: 900_000,
    video: { codec_name: 'msmpeg4v3', height: 480 },
    audio: { codec_name: 'mp3' },
  }));
  assert.strictEqual(plan.targetBitrate, 900_000);
});

check('a tighter ceiling picks a smaller rung', () => {
  const plan = planDelivery(
    sized({ bitrate: 5_000_000, video: { height: 1080 } }),
    { maxBitrate: 2_000_000 },
  );
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.targetHeight, 360);
});

check('a device asking for a smaller picture gets one', () => {
  const plan = planDelivery(
    sized({ bitrate: 5_000_000, video: { height: 1080 } }),
    { maxHeight: 720 },
  );
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.targetHeight, 720);
});

check('sound already in AAC is kept even when the picture is re-encoded', () => {
  // Re-encoding the picture says nothing about the sound, and converting AAC
  // to AAC is work done for nothing.
  const plan = planDelivery(sized({
    bitrate: 30_000_000,
    video: { height: 1080 },
    audio: { codec_name: 'aac' },
  }));
  assert.strictEqual(plan.video, 'encode');
  assert.strictEqual(plan.audio, 'copy');
});

check('a file that does not say how large it is keeps its own size', () => {
  // Scaling "to the rung" on an unknown height would blow a 480p cartoon up to
  // 1080p and charge the bitrate for it.
  const plan = planDelivery(sized({
    bitrate: 900_000,
    video: { codec_name: 'msmpeg4v3' },
    audio: { codec_name: 'mp3' },
  }));
  assert.strictEqual(plan.mode, 'encode');
  assert.strictEqual(plan.targetHeight, null);
});

// --- which audio track ----------------------------------------------------

check('the track the file marks as default wins over the first one', () => {
  // Discs routinely put a commentary or a dub first, and starting on it is
  // indistinguishable from the app having chosen the wrong file.
  const plan = planDelivery({
    format: { format_name: 'matroska,webm' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'eac3', disposition: {} },
      { codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
    ],
  });
  assert.strictEqual(plan.audioOrdinal, 1);
  assert.strictEqual(plan.audio, 'copy', 'the chosen track is the one judged');
});

check('a commentary track is not started on', () => {
  const plan = planDelivery({
    format: { format_name: 'matroska,webm' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac', disposition: { comment: 1 } },
      { codec_type: 'audio', codec_name: 'aac', disposition: {} },
    ],
  });
  assert.strictEqual(plan.audioOrdinal, 1);
});

// --- the ffmpeg command line ---------------------------------------------

const options = {
  input: 'E:/Movies/film.mkv',
  startSeconds: 0,
  playlist: 'C:/tmp/s/index.m3u8',
  segmentPattern: 'C:/tmp/s/seg%05d.m4s',
  initFile: 'init.mp4',
  segmentSeconds: 6,
};

check('a repackaging run copies the picture and writes fragmented MP4', () => {
  const args = hlsArguments({ video: 'copy', audio: 'encode' }, options);
  const joined = args.join(' ');
  assert.match(joined, /-c:v copy/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-hls_segment_type fmp4/, 'MPEG-TS cannot carry HEVC for Safari');
  assert.match(joined, /-hls_playlist_type event/, 'playback must start before the file is finished');
});

check('seeking is done before the input, not after', () => {
  // After the input, ffmpeg decodes its way to the offset — minutes on a long
  // film rather than an instant jump.
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, { ...options, startSeconds: 900 });
  const ss = args.indexOf('-ss');
  const input = args.indexOf('-i');
  assert.ok(ss !== -1 && ss < input, 'the seek must come first');
  assert.strictEqual(args[ss + 1], '900');
});

check('no seek argument is added when starting at the beginning', () => {
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, options);
  assert.strictEqual(args.includes('-ss'), false);
});

check('an encoding run pins keyframes to the segment length', () => {
  const args = hlsArguments({ video: 'encode', audio: 'encode' }, options);
  const joined = args.join(' ');
  assert.match(joined, /-c:v libx264/);
  assert.match(joined, /-g 144/, 'a keyframe every six seconds at 24fps');
  assert.match(joined, /-pix_fmt yuv420p/, '10-bit output would defeat the purpose');
});

check('only the first video and audio stream are taken', () => {
  // Subtitle and attachment streams make ffmpeg fail rather than skip them.
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, options);
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('0:a:0?'), 'the audio is optional, so a silent file still plays');
});

check('the chosen audio track is the one mapped', () => {
  const args = hlsArguments({ video: 'copy', audio: 'copy', audioOrdinal: 2 }, options);
  assert.ok(args.includes('0:a:2?'));
});

check('subtitle and data streams are excluded outright', () => {
  // Relying on -map alone left attachment streams reaching the muxer, which
  // fails several minutes in and reads to a viewer as the video stopping.
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, options);
  assert.ok(args.includes('-sn'));
  assert.ok(args.includes('-dn'));
});

check('a segment is never served half-written', () => {
  const joined = hlsArguments({ video: 'copy', audio: 'copy' }, options).join(' ');
  assert.match(joined, /-hls_flags \S*temp_file/);
});

check('copied timestamps are rebased to zero', () => {
  // Without this the first segment of a stream started mid-film is dated in
  // the future, and Safari waits for a time that never arrives.
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, { ...options, startSeconds: 900 });
  assert.ok(args.includes('-avoid_negative_ts'));
});

check("keyframes follow the file's own frame rate", () => {
  // A fixed figure gave a 60fps source segments less than half the length
  // asked for, and stuttered at every segment change.
  const args = hlsArguments({ video: 'encode', audio: 'encode', fps: 60 }, options);
  assert.match(args.join(' '), /-g 360/);
});

check('a downscale asks for one, keeping the aspect ratio', () => {
  const args = hlsArguments(
    { video: 'encode', audio: 'encode', targetHeight: 720, targetBitrate: 4_500_000 },
    options,
  );
  assert.match(args.join(' '), /-vf scale=-2:720/);
  assert.match(args.join(' '), /-maxrate 4500000/);
});

check('a picture already small enough is not filtered at all', () => {
  const args = hlsArguments({ video: 'encode', audio: 'encode', targetHeight: null }, options);
  assert.strictEqual(args.includes('-vf'), false);
});

check('a hardware encoder is used when the machine has one', () => {
  const encoder = {
    name: 'h264_nvenc',
    hardware: true,
    quality: (bitrate) => ['-cq', '23', '-b:v', String(bitrate)],
  };
  const joined = hlsArguments(
    { video: 'encode', audio: 'encode', targetBitrate: 6_000_000 },
    { ...options, encoder },
  ).join(' ');
  assert.match(joined, /-c:v h264_nvenc/);
  assert.match(joined, /-hwaccel auto/, 'decoding is the other half of the work');
  assert.doesNotMatch(joined, /-sc_threshold/, 'an x264-only option other encoders refuse');
});

check('software encoding does not ask for hardware decoding', () => {
  const joined = hlsArguments({ video: 'encode', audio: 'encode' }, options).join(' ');
  assert.strictEqual(joined.includes('-hwaccel'), false);
  assert.match(joined, /-sc_threshold 0/);
});

check('copying never asks for a decoder at all', () => {
  const joined = hlsArguments({ video: 'copy', audio: 'copy' }, options).join(' ');
  assert.strictEqual(joined.includes('-hwaccel'), false);
});

console.log('\npassed ' + passed + ' of ' + total);
