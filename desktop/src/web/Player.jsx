import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBaseUrl, displayTitle } from '../api.js';

/** How often the position is sent back, so the computer stays in step. */
const PROGRESS_INTERVAL_MS = 5000;

/**
 * Full-screen playback in a browser.
 *
 * Safari plays HLS natively, so there is no player library here — the video
 * element is given a playlist and left to do its job, which also means AirPlay,
 * picture-in-picture and the lock-screen controls all work without help.
 *
 * The position is reported back to the same endpoint the desktop player uses,
 * so a film paused on the television is picked up here, and the other way
 * round, with no syncing to arrange.
 */
export function Player({ video, item, onClose }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('preparing');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);

  // Where the current stream begins within the film. Everything the video
  // element reports is relative to this.
  const offsetRef = useRef(0);
  const lastSentRef = useRef(0);
  const durationRef = useRef(video.duration ?? null);

  /** The position within the film, as opposed to within the stream. */
  const absoluteTime = useCallback(() => {
    const element = videoRef.current;
    if (!element) return offsetRef.current;
    return offsetRef.current + (element.currentTime || 0);
  }, []);

  const report = useCallback((force) => {
    const now = Date.now();
    if (!force && now - lastSentRef.current < PROGRESS_INTERVAL_MS) return;
    lastSentRef.current = now;

    const position = absoluteTime();
    if (!Number.isFinite(position) || position <= 0) return;
    api.saveProgress({
      videoId: video.id,
      position,
      duration: durationRef.current ?? undefined,
    }).catch(() => {
      // A missed progress write is not worth interrupting playback for.
    });
  }, [absoluteTime, video.id]);

  /** Point the video element at a stream that begins at `startSeconds`. */
  const load = useCallback(async (startSeconds) => {
    setStatus('preparing');
    setError(null);

    try {
      const info = await api.streamInfo(video.id);
      durationRef.current = info.duration ?? durationRef.current;

      if (info.mode === 'direct' && startSeconds === 0) {
        // Already in a shape the browser understands: hand the file over and
        // let it seek natively, which is better than anything we can arrange.
        offsetRef.current = 0;
        setDetail('Playing the original file');
        videoRef.current.src = apiBaseUrl() + '/api/stream/' + video.id + '/direct';
      } else {
        setDetail(info.mode === 'encode'
          ? 'Converting for this device'
          : 'Repackaging for this device');
        const session = await api.streamStart(video.id, startSeconds);
        offsetRef.current = session.startSeconds ?? startSeconds;
        videoRef.current.src = apiBaseUrl() + session.playlistUrl;
      }

      videoRef.current.load();
      await videoRef.current.play().catch(() => {
        // Autoplay can be refused until the viewer touches something; the
        // controls are visible, so this is not an error worth showing.
      });
      setStatus('playing');
    } catch (failure) {
      setError(failure.message);
      setStatus('failed');
    }
  }, [video.id]);

  // Start where the film was left, wherever it was left.
  useEffect(() => {
    const resumeAt = video.position > 30 ? Math.floor(video.position) : 0;
    load(resumeAt);

    return () => {
      // One last position on the way out, so closing the tab still counts.
      report(true);
    };
    // Only ever run for the video this player was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Seeking past what has been prepared.
   *
   * The stream is produced from its starting point onwards, so a jump beyond
   * the end of it cannot be served by the current one. A new stream is started
   * at that point instead, which takes a second or two.
   */
  const onSeeking = useCallback(() => {
    const element = videoRef.current;
    if (!element || status === 'preparing') return;

    const seekable = element.seekable;
    if (!seekable || seekable.length === 0) return;

    const wanted = element.currentTime;
    const furthest = seekable.end(seekable.length - 1);
    const earliest = seekable.start(0);

    // A little tolerance: the very edge of the range is normal seeking.
    if (wanted > furthest + 1 || wanted < earliest - 1) {
      load(Math.floor(offsetRef.current + wanted));
    }
  }, [load, status]);

  const title = displayTitle(item, video);

  return (
    <div className="player">
      <div className="player-bar">
        <button className="player-close" onClick={() => { report(true); onClose(); }}>
          ‹ Back
        </button>
        <span className="player-title">{title}</span>
      </div>

      <video
        ref={videoRef}
        className="player-video"
        controls
        autoPlay
        playsInline
        preload="auto"
        onTimeUpdate={() => report(false)}
        onPause={() => report(true)}
        onSeeking={onSeeking}
        onError={() => {
          if (status !== 'preparing') setError('The video stopped unexpectedly');
        }}
      />

      {status === 'preparing' && (
        <div className="player-note">
          <div className="spinner" />
          <p>{detail || 'Preparing…'}</p>
        </div>
      )}

      {error && (
        <div className="player-note">
          <p className="player-error">{error}</p>
          <button className="btn" onClick={() => load(Math.floor(absoluteTime()))}>Try again</button>
          <button className="btn ghost" onClick={onClose}>Back</button>
        </div>
      )}
    </div>
  );
}

export default Player;
