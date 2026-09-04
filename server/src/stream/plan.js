/**
 * What has to happen to a file before a browser can play it.
 *
 * Safari is the target, because the iPad is: it plays H.264 and HEVC in an MP4
 * or HLS container, and nothing at all in a Matroska or AVI one. Most of this
 * library is H.264 inside .mkv, which needs no re-encoding — only repackaging,
 * which is cheap and fast. The old cartoons in .avi are the exception and have
 * to be encoded properly.
 *
 * Kept as a pure function so the rules can be checked without ffmpeg, a file,
 * or a network.
 */

import { hardwareEncoder } from './ffmpeg.js';

/** Video codecs Safari decodes, given an acceptable container. */
const PLAYABLE_VIDEO = new Set(['h264', 'hevc']);

/**
 * Audio codecs worth passing through untouched.
 *
 * Only AAC. E-AC-3 and AC-3 play on some Apple hardware and not others, DTS and
 * TrueHD on none of it, and re-encoding audio is cheap enough that guessing is
 * not worth it — a wrong guess is silence, which reads as a broken player.
 */
const PLAYABLE_AUDIO = new Set(['aac']);

/** Containers a browser will open directly. */
const PLAYABLE_CONTAINER = /(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)/;

/** 10-bit H.264 is not hardware-decodable on Apple devices; HEVC 10-bit is. */
function videoNeedsEncoding(video) {
  if (!video) return true;
  if (!PLAYABLE_VIDEO.has(video.codec_name)) return true;
  const tenBit = /10le|10be/.test(video.pix_fmt ?? '');
  if (tenBit && video.codec_name === 'h264') return true;
  return false;
}

function audioNeedsEncoding(audio) {
  if (!audio) return true;
  return !PLAYABLE_AUDIO.has(audio.codec_name);
}

/**
 * Decide how to deliver a file.
 *
 * @param {{format?: object, streams?: Array}} probed ffprobe output
 * @returns {{mode: 'direct'|'remux'|'encode', video: 'copy'|'encode',
 *   audio: 'copy'|'encode', reason: string}}
 *   direct — hand the file over as it is
 *   remux  — repackage without touching the picture
 *   encode — the picture has to be re-encoded, which is the expensive one
 */
export function planDelivery(probed) {
  const streams = probed?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');

  const encodeVideo = videoNeedsEncoding(video);
  const encodeAudio = audioNeedsEncoding(audio);
  const container = probed?.format?.format_name ?? '';

  if (!video) {
    return {
      mode: 'encode',
      video: 'encode',
      audio: 'encode',
      reason: 'no video stream was found',
    };
  }

  if (!encodeVideo && !encodeAudio && PLAYABLE_CONTAINER.test(container)) {
    return {
      mode: 'direct',
      video: 'copy',
      audio: 'copy',
      reason: 'already in a container and codecs the browser accepts',
    };
  }

  if (encodeVideo) {
    return {
      mode: 'encode',
      video: 'encode',
      audio: encodeAudio ? 'encode' : 'copy',
      reason: video.codec_name
        ? video.codec_name + ' cannot be played, so the picture must be re-encoded'
        : 'the picture must be re-encoded',
    };
  }

  return {
    mode: 'remux',
    video: 'copy',
    audio: encodeAudio ? 'encode' : 'copy',
    reason: encodeAudio
      ? 'the picture is kept as it is; only the sound is converted'
      : 'repackaged without touching either stream',
  };
}

/**
 * The ffmpeg arguments that carry out a plan, as an HLS stream.
 *
 * Segments are fragmented MP4 rather than MPEG-TS, because HEVC is not carried
 * by the transport stream Safari expects and because fMP4 lets the picture be
 * copied rather than re-encoded.
 *
 * @param {object} plan from planDelivery
 * @param {{input: string, startSeconds: number, playlist: string, segmentPattern: string,
 *   segmentSeconds: number, initFile: string}} options
 */
export function hlsArguments(plan, options) {
  const {
    input, startSeconds, playlist, segmentPattern, initFile, segmentSeconds = 6,
    audioTrack = 0,
    /**
     * Tallest picture to send, or null to send it as it is.
     *
     * Watching from outside the house is limited by the upload the house has,
     * not by the disk — a 4K film at source bitrate simply will not fit down
     * it. Sending fewer lines is the only thing that helps, and a tablet
     * cannot show 2160 of them anyway.
     */
    maxHeight = null,
    /** Height of the source, so shrinking can be decided here rather than by ffmpeg. */
    sourceHeight = null,
  } = options;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  /*
   * Decode on the graphics card too, not just encode.
   *
   * Measured on an AV1 film: encoding on the card alone moved 2.6x real time
   * to 2.9x, because the wait was never the encoding — it was unpacking AV1 in
   * software. Decoding on the card as well took the same file to 10x. The card
   * has to do both halves before it is worth anything.
   *
   * Only when the picture is actually being re-encoded: a copied stream is
   * never decoded, so this would ask the card to open a file for no reason.
   * Plain -hwaccel (rather than pinning the frames to card memory) falls back
   * to software by itself for a codec the card cannot read, which keeps an
   * unusual file playing instead of failing.
   */
  if (plan.video === 'encode') {
    const decoders = {
      h264_nvenc: 'cuda',
      h264_qsv: 'qsv',
      h264_amf: 'd3d11va',
    };
    const hwaccel = decoders[hardwareEncoder()];
    if (hwaccel) args.push('-hwaccel', hwaccel);
  }

  /*
   * Run ahead of the viewer, but not flat out.
   *
   * Left uncapped, one stream reads a film as fast as the disk will go — over
   * forty times playback speed — and a second stream on the same drive halves
   * both. Measured on an external drive: alone it managed 46x, but with
   * several running the one being watched fell to 0.4x, slower than playback,
   * which is a stall. Ten times playback builds a comfortable buffer and still
   * leaves the drive with room to spare.
   *
   * The burst is what keeps starting quick: the opening minute is read as fast
   * as possible, so the first segments appear immediately and the cap only
   * applies once there is already something to watch.
   */
  args.push('-readrate', '10', '-readrate_initial_burst', '60');

  // Seeking before the input is the fast form: ffmpeg jumps rather than
  // decoding its way there, which matters on a two hour file.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', input);

  // First video and audio stream only. Subtitle and attachment streams have no
  // place in an HLS fragment and make ffmpeg fail rather than skip them.
  args.push('-map', '0:v:0', '-map', '0:a:' + audioTrack + '?');

  /*
   * Decided here, not in a filter expression.
   *
   * The obvious form is scale=-2:min(720,ih), which leaves ffmpeg to avoid
   * enlarging a smaller source — but the comma inside it separates filters
   * unless escaped, and the escaping survives neither JavaScript nor a shell
   * intact. Comparing two numbers in JavaScript has no such problem: if the
   * source is already short enough, no filter is added at all.
   */
  const shrinking = Number.isFinite(maxHeight) && maxHeight > 0
    && (!Number.isFinite(sourceHeight) || sourceHeight > maxHeight);

  if (plan.video === 'copy' && !shrinking) {
    args.push('-c:v', 'copy');
  } else {
    /*
     * Re-encode on the graphics card where there is one.
     *
     * Quality is asked for differently by each: x264 takes -crf, NVIDIA and
     * AMD take their own constant-quality knob, and Intel takes a global
     * quality. Passing the wrong one is not ignored — ffmpeg refuses to start,
     * which would be a video that never plays rather than one that plays
     * slowly, so each gets its own flags rather than a shared guess.
     */
    const encoder = hardwareEncoder();
    args.push('-c:v', encoder);

    if (encoder === 'h264_nvenc') {
      args.push('-preset', 'p4', '-rc', 'vbr', '-cq', '23');
    } else if (encoder === 'h264_qsv') {
      args.push('-global_quality', '23');
    } else if (encoder === 'h264_amf') {
      args.push('-quality', 'balanced', '-rc', 'vbr_peak');
    } else {
      // libx264: scene-cut detection has to be off or keyframes wander off the
      // segment boundaries.
      args.push('-preset', 'veryfast', '-crf', '21', '-sc_threshold', '0');
    }

    // -2 keeps the aspect ratio and rounds the width to something the encoder
    // will accept; whether to shrink at all was settled above.
    if (shrinking) args.push('-vf', 'scale=-2:' + maxHeight);

    // Roughly what each height needs; a cap rather than a target, so a simple
    // cartoon still uses less than this.
    const ceiling = shrinking && maxHeight <= 480 ? '1.5M'
      : shrinking && maxHeight <= 720 ? '3M'
      : shrinking && maxHeight <= 1080 ? '5M'
      : '6M';

    args.push(
      // A cap keeps an old cartoon from being encoded at a bitrate no home
      // network benefits from.
      '-maxrate', ceiling,
      '-bufsize', String(parseFloat(ceiling) * 2) + 'M',
      '-pix_fmt', 'yuv420p',
      // Keyframes on segment boundaries, so every segment stands alone.
      '-g', String(segmentSeconds * 24),
      '-keyint_min', String(segmentSeconds * 24),
    );
  }

  if (plan.audio === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  /*
   * The output timeline deliberately starts at zero.
   *
   * Stamping the fragments with their real position in the film (via
   * -output_ts_offset) makes the elapsed time read correctly, and was tried:
   * it cost every control on the iPad. Safari could no longer work out a
   * duration or a seekable range from a playlist whose media clock starts
   * three quarters of an hour in, so it treated the stream as live — no
   * scrubber, no timestamp, no skip buttons — and the shifted audio drifted
   * out of step with the picture.
   *
   * Working controls over a fragment beat a correct clock over none. Making
   * the clock right as well needs the playlist to describe the whole file
   * rather than the part being served, which is a different design.
   */
  args.push(
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    // Every segment is kept: the viewer must be able to seek back.
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', initFile,
    '-hls_segment_filename', segmentPattern,
    /*
     * Cut on time, not only on keyframes.
     *
     * With the picture copied rather than re-encoded, ffmpeg can only end a
     * segment where the source already has a keyframe — and a Blu-ray rip puts
     * those ten seconds apart. Segments came out at 10.4s against the 6s asked
     * for, and a player wants two or three of them before it will start, so
     * the wait to begin watching was twenty to thirty seconds of video rather
     * than twelve.
     *
     * Splitting by time gives segments the length they were asked for, which
     * is most of that wait back.
     */
    '-hls_flags', 'split_by_time+independent_segments',
    // An event playlist grows as segments appear, so playback can start long
    // before the whole file has been through ffmpeg.
    '-hls_playlist_type', 'event',
    playlist,
  );

  return args;
}

export const _internals = { PLAYABLE_VIDEO, PLAYABLE_AUDIO, videoNeedsEncoding, audioNeedsEncoding };
