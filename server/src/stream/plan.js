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
  } = options;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  // Seeking before the input is the fast form: ffmpeg jumps rather than
  // decoding its way there, which matters on a two hour file.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', input);

  // First video and audio stream only. Subtitle and attachment streams have no
  // place in an HLS fragment and make ffmpeg fail rather than skip them.
  args.push('-map', '0:v:0', '-map', '0:a:' + audioTrack + '?');

  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '21',
      // A cap keeps an old cartoon from being encoded at a bitrate no home
      // network benefits from.
      '-maxrate', '6M',
      '-bufsize', '12M',
      '-pix_fmt', 'yuv420p',
      // Keyframes on segment boundaries, so every segment stands alone.
      '-g', String(segmentSeconds * 24),
      '-keyint_min', String(segmentSeconds * 24),
      '-sc_threshold', '0',
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
    // An event playlist grows as segments appear, so playback can start long
    // before the whole file has been through ffmpeg.
    '-hls_playlist_type', 'event',
    playlist,
  );

  return args;
}

export const _internals = { PLAYABLE_VIDEO, PLAYABLE_AUDIO, videoNeedsEncoding, audioNeedsEncoding };
