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
  /*
   * Either encoder is correct. Which one is chosen depends on the machine —
   * a card with an NVIDIA encoder gets h264_nvenc, everything else libx264 —
   * so pinning the name made this test pass or fail on the hardware rather
   * than on the code.
   */
  assert.match(joined, /-c:v (?:libx264|h264_nvenc)/);
  assert.match(joined, /-g 144/, 'a keyframe every six seconds at 24fps');
  assert.match(joined, /-pix_fmt yuv420p/, '10-bit output would defeat the purpose');
});

check('only the first video and audio stream are taken', () => {
  // Subtitle and attachment streams make ffmpeg fail rather than skip them.
  const args = hlsArguments({ video: 'copy', audio: 'copy' }, options);
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('0:a:0?'), 'the audio is optional, so a silent file still plays');
});

console.log('\npassed ' + passed + ' of ' + total);
