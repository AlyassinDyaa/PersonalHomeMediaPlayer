/**
 * What has to happen to a file before a browser can play it.
 *
 * Safari is the target, because the iPad is: it plays H.264 and HEVC in an MP4
 * or HLS container, and nothing at all in a Matroska or AVI one. Most of this
 * library is H.264 inside .mkv, which needs no re-encoding — only repackaging,
 * which is cheap and fast. The old cartoons in .avi are the exception and have
 * to be encoded properly.
 *
 * Codec is not the whole question, though. A Blu-ray remux is H.264 and could
 * be copied byte for byte, but it is also thirty megabits a second, which no
 * tablet on household Wi-Fi can pull down in real time. Copying it produces a
 * player that spins forever while appearing, by every other measure, to be
 * working. So bitrate and picture size are weighed alongside codec, and a file
 * too large for the link is re-encoded down to something that fits.
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

/**
 * Picture sizes to aim at, and what each is worth spending on.
 *
 * Ordinary streaming-service figures rather than anything clever: enough that
 * the result looks like the source on a tablet held at arm's length, and low
 * enough to survive a house with one router and several walls.
 */
const LADDER = [
  { height: 2160, bitrate: 25_000_000, label: '4K' },
  { height: 1080, bitrate: 8_000_000, label: '1080p' },
  { height: 720, bitrate: 4_500_000, label: '720p' },
  { height: 480, bitrate: 2_500_000, label: '480p' },
  { height: 360, bitrate: 1_200_000, label: '360p' },
];

/**
 * What a stream is allowed to cost by default.
 *
 * Twelve megabits is chosen to be survivable rather than ideal: it is roughly
 * what a tablet two rooms from the router manages without stalling, including
 * the ones that quietly join on 2.4GHz. Anything comfortably below it is left
 * alone, so the common case — a normal 1080p rip at four or five megabits — is
 * still copied rather than re-encoded.
 */
const DEFAULT_MAX_BITRATE = 12_000_000;
const DEFAULT_MAX_HEIGHT = 1080;

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
 * The audio track a viewer actually wants.
 *
 * Not simply the first one. Discs routinely carry a commentary or a dub ahead
 * of the feature audio, and the first track is then several hours of someone
 * discussing the film. The container's own default flag is the closest thing to
 * an answer, so it wins where it exists.
 */
function chooseAudio(streams) {
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (audio.length === 0) return { stream: null, ordinal: 0 };

  const preferred = audio.find((s) => s.disposition?.default === 1)
    // A commentary track is usually flagged as such; never start on one.
    ?? audio.find((s) => s.disposition?.comment !== 1)
    ?? audio[0];

  return { stream: preferred, ordinal: audio.indexOf(preferred) };
}

/** Frames per second as a number, from ffprobe's "24000/1001" form. */
function frameRate(video) {
  const raw = video?.avg_frame_rate || video?.r_frame_rate || '';
  const [top, bottom] = String(raw).split('/');
  const value = Number(top) / (Number(bottom) || 1);
  if (!Number.isFinite(value) || value <= 0 || value > 240) return null;
  return value;
}

/**
 * How many bits a second the picture costs.
 *
 * The video stream's own figure is best but is missing from Matroska more often
 * than not, because the container does not have to record it. The whole file's
 * rate is the next best thing — it overstates the picture by whatever the sound
 * costs, which is small enough not to change any decision. Failing both, size
 * over duration is arithmetic that always works.
 */
function videoBitrate(video, format) {
  const own = Number(video?.bit_rate);
  if (Number.isFinite(own) && own > 0) return own;

  const whole = Number(format?.bit_rate);
  if (Number.isFinite(whole) && whole > 0) return whole;

  const size = Number(format?.size);
  const duration = Number(format?.duration);
  if (Number.isFinite(size) && Number.isFinite(duration) && duration > 0) {
    return (size * 8) / duration;
  }
  return null;
}

/**
 * The largest rung that fits both the link and the source.
 *
 * Never upscales: a 480p cartoon stays 480p rather than being blown up to 1080p
 * and charged the bitrate for it.
 */
function chooseRung(sourceHeight, maxBitrate, maxHeight) {
  const ceiling = Math.min(sourceHeight || maxHeight, maxHeight);
  const fits = LADDER.filter((rung) => rung.height <= ceiling && rung.bitrate <= maxBitrate);
  if (fits.length > 0) return fits[0];
  // Nothing fits: take the cheapest rung the source can supply rather than
  // refusing to play. A picture that arrives is better than one that does not.
  const supplied = LADDER.filter((rung) => rung.height <= ceiling);
  return supplied[supplied.length - 1] ?? LADDER[LADDER.length - 1];
}

/**
 * Decide how to deliver a file.
 *
 * @param {{format?: object, streams?: Array}} probed ffprobe output
 * @param {{maxBitrate?: number, maxHeight?: number}} [limits] what the link can carry
 * @returns {{mode: 'direct'|'remux'|'encode', video: 'copy'|'encode',
 *   audio: 'copy'|'encode', audioOrdinal: number, reason: string,
 *   sourceHeight: number|null, sourceBitrate: number|null,
 *   targetHeight: number|null, targetBitrate: number|null, fps: number|null}}
 *   direct — hand the file over as it is
 *   remux  — repackage without touching the picture
 *   encode — the picture has to be re-encoded, which is the expensive one
 */
export function planDelivery(probed, limits = {}) {
  const maxBitrate = Number(limits.maxBitrate) > 0
    ? Number(limits.maxBitrate) : DEFAULT_MAX_BITRATE;
  const maxHeight = Number(limits.maxHeight) > 0
    ? Number(limits.maxHeight) : DEFAULT_MAX_HEIGHT;

  const streams = probed?.streams ?? [];
  const format = probed?.format ?? {};
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const { stream: audio, ordinal: audioOrdinal } = chooseAudio(streams);

  const sourceHeight = Number(video?.height) || null;
  const sourceBitrate = videoBitrate(video, format);
  const fps = frameRate(video);

  const base = {
    audioOrdinal,
    sourceHeight,
    sourceBitrate,
    fps,
    targetHeight: null,
    targetBitrate: null,
  };

  if (!video) {
    return {
      ...base,
      mode: 'encode',
      video: 'encode',
      audio: 'encode',
      reason: 'no video stream was found',
    };
  }

  const encodeVideo = videoNeedsEncoding(video);
  const encodeAudio = audioNeedsEncoding(audio);
  const container = format.format_name ?? '';

  // Only meaningful when the picture would otherwise have been kept: an
  // unknown bitrate is treated as acceptable rather than guessed at, because
  // re-encoding a file that did not need it is the more expensive mistake.
  const tooFast = !encodeVideo
    && sourceBitrate != null
    && sourceBitrate > maxBitrate;
  const tooLarge = !encodeVideo
    && sourceHeight != null
    && sourceHeight > maxHeight;

  if (encodeVideo || tooFast || tooLarge) {
    const rung = chooseRung(sourceHeight, maxBitrate, maxHeight);
    // Never spend more on the re-encode than the source itself cost.
    const targetBitrate = sourceBitrate
      ? Math.min(rung.bitrate, Math.max(Math.round(sourceBitrate), 500_000))
      : rung.bitrate;

    let reason;
    if (encodeVideo) {
      reason = video.codec_name
        ? video.codec_name + ' cannot be played, so the picture must be re-encoded'
        : 'the picture must be re-encoded';
    } else if (tooFast) {
      reason = 'at ' + Math.round(sourceBitrate / 1_000_000)
        + ' Mbps this is faster than the network can carry, so it is being sent smaller';
    } else {
      reason = sourceHeight + 'p is larger than this device needs, so it is being sent smaller';
    }

    return {
      ...base,
      mode: 'encode',
      video: 'encode',
      // Sound that is already AAC costs nothing to keep, whatever is happening
      // to the picture.
      audio: encodeAudio ? 'encode' : 'copy',
      // Only downscale when the source is known to be bigger than the rung. A
      // file that does not say how large it is keeps its own size: scaling it
      // to the rung would blow a 480p cartoon up to 1080p and charge the
      // bitrate for it.
      targetHeight: sourceHeight && sourceHeight > rung.height ? rung.height : null,
      targetBitrate,
      reason,
    };
  }

  if (!encodeAudio && PLAYABLE_CONTAINER.test(container)) {
    return {
      ...base,
      mode: 'direct',
      video: 'copy',
      audio: 'copy',
      reason: 'already in a container and codecs the browser accepts',
    };
  }

  return {
    ...base,
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
 *   segmentSeconds: number, initFile: string, encoder?: object}} options
 */
export function hlsArguments(plan, options) {
  const {
    input, startSeconds, playlist, segmentPattern, initFile, segmentSeconds = 6,
    encoder = null,
  } = options;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  // Let the graphics hardware do the decoding too where it can. This is the
  // half of the work that is easy to forget about: decoding 1080p HEVC in
  // software costs as much as encoding it. "auto" falls back quietly to
  // software when no usable device is present, so it is safe to ask for.
  if (plan.video === 'encode' && encoder?.hardware) {
    args.push('-hwaccel', 'auto');
  }

  // Seeking before the input is the fast form: ffmpeg jumps rather than
  // decoding its way there, which matters on a two hour file.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', input);

  // First video stream and the chosen audio track. Subtitle and attachment
  // streams have no place in an HLS fragment and make ffmpeg fail rather than
  // skip them, so they are excluded rather than left to chance.
  args.push('-map', '0:v:0', '-map', '0:a:' + (plan.audioOrdinal ?? 0) + '?');
  args.push('-sn', '-dn');

  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    const fps = plan.fps && plan.fps > 0 ? plan.fps : 24;
    // A keyframe every segment, so every segment stands alone. Derived from
    // the file's own frame rate: a fixed figure gives a 60fps source segments
    // less than half the length asked for, and a 12fps cartoon segments twice
    // as long as the player expects to wait for.
    const gop = Math.max(1, Math.round(fps * segmentSeconds));
    const bitrate = plan.targetBitrate || 6_000_000;

    args.push('-c:v', encoder?.name ?? 'libx264');
    args.push(...(encoder?.quality?.(bitrate) ?? ['-preset', 'veryfast', '-crf', '21']));
    args.push(
      '-maxrate', String(bitrate),
      '-bufsize', String(bitrate * 2),
      '-pix_fmt', 'yuv420p',
      '-g', String(gop),
      '-keyint_min', String(gop),
      // Belt and braces: some hardware encoders treat -g as a hint. Without a
      // keyframe on the boundary the segmenter runs long and playback stutters
      // at every segment change.
      '-force_key_frames', 'expr:gte(t,n_forced*' + segmentSeconds + ')',
    );
    // A scene-cut keyframe mid-segment is wasted here, but the option is
    // libx264's alone and makes other encoders refuse to start.
    if (!encoder || encoder.name === 'libx264') args.push('-sc_threshold', '0');
    if (plan.targetHeight) {
      // -2 keeps the aspect ratio and rounds to an even width, which every
      // H.264 encoder requires.
      args.push('-vf', 'scale=-2:' + plan.targetHeight);
    }
  }

  if (plan.audio === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  args.push(
    // A long file with an unusual stream layout can otherwise stall the muxer
    // and fail several minutes in, which reads to a viewer as the video simply
    // stopping.
    '-max_muxing_queue_size', '4096',
    // Copied streams carry their original timestamps, which begin at the seek
    // point rather than at zero; without this the first segment is dated in the
    // future and Safari waits for a time that never arrives.
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    // Every segment is kept: the viewer must be able to seek back.
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', initFile,
    '-hls_segment_filename', segmentPattern,
    // Write each segment under a temporary name and rename it when it is
    // complete, so a segment can never be served half-written.
    '-hls_flags', 'temp_file+independent_segments',
    // An event playlist grows as segments appear, so playback can start long
    // before the whole file has been through ffmpeg.
    '-hls_playlist_type', 'event',
    playlist,
  );

  return args;
}

export const _internals = {
  PLAYABLE_VIDEO,
  PLAYABLE_AUDIO,
  LADDER,
  DEFAULT_MAX_BITRATE,
  DEFAULT_MAX_HEIGHT,
  videoNeedsEncoding,
  audioNeedsEncoding,
  chooseAudio,
  chooseRung,
  frameRate,
  videoBitrate,
};
