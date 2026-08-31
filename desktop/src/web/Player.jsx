import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBaseUrl, displayTitle } from '../api.js';

/** How often the position is sent back, so the computer stays in step. */
const PROGRESS_INTERVAL_MS = 5000;

/** How long the controls stay up after being summoned. */
const CHROME_HIDE_MS = 4000;

/**
 * Full-screen playback in a browser.
 *
 * Safari plays HLS natively, so there is no player library here — the video
 * element is given a playlist and left to do its job, which also means AirPlay,
 * picture-in-picture, the lock-screen controls and the subtitle menu all work
 * without help.
 *
 * The playlist describes the whole film rather than the part produced so far,
 * so the clock reads the real position, the scrubber covers the real length,
 * and seeking lands wherever it is dropped. Resuming is therefore an ordinary
 * seek rather than a differently-built stream.
 *
 * The position is reported back to the same endpoint the desktop player uses,
 * so a film paused on the television is picked up here, and the other way
 * round, with no syncing to arrange.
 */
export function Player({ video, item, onClose }) {
  const videoRef = useRef(null);
  const [current, setCurrent] = useState(video);
  const [status, setStatus] = useState('preparing');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);
  const [tracks, setTracks] = useState({ audio: [], subtitles: [] });
  const [audioTrack, setAudioTrack] = useState(0);
  const [chrome, setChrome] = useState(true);
  /** Every episode of this show in order, for stepping between them. */
  const [episodes, setEpisodes] = useState([]);

  const lastSentRef = useRef(0);
  /**
   * What to add to the element's clock to get the position in the film.
   *
   * The stream begins where watching resumed, so its own timeline starts at
   * zero there; this puts the two back in step for progress reporting.
   */
  const offsetRef = useRef(0);
  const durationRef = useRef(current.duration ?? null);
  /** Where to jump to once the browser knows how long the film is. */
  const resumeToRef = useRef(0);
  const hideTimer = useRef(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  /** Show the controls, and take them away again after a while. */
  const wakeChrome = useCallback(() => {
    setChrome(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChrome(false), CHROME_HIDE_MS);
  }, []);

  const report = useCallback((force) => {
    const now = Date.now();
    if (!force && now - lastSentRef.current < PROGRESS_INTERVAL_MS) return;
    lastSentRef.current = now;

    const position = offsetRef.current + (videoRef.current?.currentTime ?? 0);
    if (!Number.isFinite(position) || position <= 0) return;
    api.saveProgress({
      videoId: currentRef.current.id,
      position,
      duration: durationRef.current ?? undefined,
    }).catch(() => {
      // A missed progress write is not worth interrupting playback for.
    });
  }, []);

  /** Point the video element at a video, optionally on a different sound track. */
  const load = useCallback(async (target, wantedAudio, startAt) => {
    setStatus('preparing');
    setError(null);
    resumeToRef.current = startAt ?? 0;

    try {
      const info = await api.streamInfo(target.id);
      durationRef.current = info.duration ?? target.duration ?? null;
      setTracks({
        audio: info.audioTracks ?? [],
        subtitles: info.subtitleTracks ?? [],
      });

      if (info.mode === 'direct') {
        // Already in a shape the browser understands: hand the file over and
        // let it seek natively, which is better than anything we can arrange.
        offsetRef.current = 0;
        setDetail('Playing the original file');
        videoRef.current.src = apiBaseUrl() + '/api/stream/' + target.id + '/direct';
      } else {
        /*
         * One stream produced from the point being watched.
         *
         * A playlist describing the whole file was tried instead, to make the
         * clock read the real position and seeking land anywhere. It could not
         * be made to hold: the segment boundaries are chosen from a keyframe
         * index, but ffmpeg's seek does not land on those keyframes — measured
         * two seconds early and three seconds long on a segment declared as
         * six. Safari checks that a segment matches what the playlist promised
         * and refuses the stream when it does not, which is why nothing played
         * on the iPad at all. This path is the one that plays.
         */
        setDetail(info.mode === 'encode'
          ? 'Converting for this device'
          : 'Repackaging for this device');
        const session = await api.streamStart(target.id, startAt ?? 0, wantedAudio);
        offsetRef.current = session.startSeconds ?? startAt ?? 0;
        // The stream starts there, so there is nothing left to seek to.
        resumeToRef.current = 0;
        videoRef.current.src = apiBaseUrl() + session.playlistUrl;
      }

      videoRef.current.load();
      await videoRef.current.play().catch(() => {
        // Autoplay can be refused until the viewer touches something; the
        // controls are visible, so this is not an error worth showing.
      });
      setStatus('playing');
      // Arms the countdown that takes the controls away again. Doing this only
      // from playback events was not enough: a browser that refuses to start
      // playing on its own never fires one, and the controls then sat over the
      // picture for good.
      wakeChrome();
    } catch (failure) {
      setError(failure.message);
      setStatus('failed');
    }
  }, [wakeChrome]);

  // Start where the film was left, wherever it was left.
  useEffect(() => {
    load(video, 0, video.position > 30 ? Math.floor(video.position) : 0);
    return () => {
      // One last position on the way out, so closing the tab still counts.
      report(true);
      clearTimeout(hideTimer.current);
    };
    // Only ever run for the video this player was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The rest of the series, so the next episode is one press away rather than
  // several levels back through the library.
  useEffect(() => {
    if (item?.kind !== 'show') return;
    let cancelled = false;
    api.item(item.id)
      .then((full) => {
        if (cancelled) return;
        setEpisodes((full.seasons ?? []).flatMap((season) => season.episodes ?? []));
      })
      .catch(() => { /* stepping is a convenience; without it the player still works */ });
    return () => { cancelled = true; };
  }, [item]);

  const position = useMemo(
    () => episodes.findIndex((entry) => entry.id === current.id),
    [episodes, current.id],
  );
  const previous = position > 0 ? episodes[position - 1] : null;
  const next = position >= 0 && position < episodes.length - 1 ? episodes[position + 1] : null;

  /** Move to another episode of the same show. */
  const goTo = useCallback((target) => {
    if (!target) return;
    report(true);
    setCurrent(target);
    setAudioTrack(0);
    wakeChrome();
    load(target, 0, target.position > 30 ? Math.floor(target.position) : 0);
  }, [load, report, wakeChrome]);

  /**
   * Jump to the resume point once the film's length is known.
   *
   * Seeking before that is ignored by the browser, which has nothing to seek
   * within yet.
   */
  const onLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (Number.isFinite(element.duration) && element.duration > 0) {
      durationRef.current = element.duration;
    }
    const wanted = resumeToRef.current;
    if (wanted > 0 && Number.isFinite(element.duration) && wanted < element.duration - 5) {
      element.currentTime = wanted;
    }
    resumeToRef.current = 0;
  }, []);

  /**
   * Seeking past what has been prepared.
   *
   * The stream is produced from its starting point onwards, so a jump beyond
   * the end of it cannot be served by the one already running. A new stream
   * is started at that point instead, which takes a second or two.
   */
  const onSeeking = useCallback(() => {
    const element = videoRef.current;
    if (!element || status === "preparing") return;

    const seekable = element.seekable;
    if (!seekable || seekable.length === 0) return;

    const wanted = element.currentTime;
    const furthest = seekable.end(seekable.length - 1);
    const earliest = seekable.start(0);

    // A little tolerance: the very edge of the range is ordinary seeking.
    if (wanted > furthest + 1 || wanted < earliest - 1) {
      load(currentRef.current, audioTrack, Math.floor(offsetRef.current + wanted));
    }
  }, [load, status, audioTrack]);

  /**
   * Put the video full screen.
   *
   * Safari draws its own full-screen button inside the picture, but on a
   * tablet it sits in the bottom corner where the home indicator and the
   * browser chrome crowd it, and it was reported unreachable. This one is
   * in a bar we place ourselves, so it can always be pressed.
   *
   * iOS only honours the call on the video element itself; the standard
   * request on a container is ignored there, so it is tried second.
   */
  const goFullscreen = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    wakeChrome();
    if (typeof element.webkitEnterFullscreen === "function") {
      element.webkitEnterFullscreen();
    } else if (typeof element.requestFullscreen === "function") {
      element.requestFullscreen().catch(() => {});
    } else if (typeof element.webkitRequestFullscreen === "function") {
      element.webkitRequestFullscreen();
    }
  }, [wakeChrome]);

  /** Switch sound track: the picture is the same, so only the source changes. */
  const chooseAudio = useCallback((index) => {
    const at = videoRef.current?.currentTime ?? 0;
    setAudioTrack(index);
    load(currentRef.current, index, Math.floor(at));
  }, [load]);

  /*
   * Keep the player the size of what is actually visible.
   *
   * iOS changes the visible height as its toolbars come and go, and again when
   * the app is left and returned to. A player laid out against the window
   * rather than against what can be seen ends up with its controls below the
   * bottom of the screen — which is how the buttons came to be cut off, and
   * why the ones still on screen did nothing: they were not where they looked.
   */
  useEffect(() => {
    const applyViewport = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--player-height', height + 'px');
    };
    applyViewport();

    const onReturn = () => {
      applyViewport();
      // Coming back from the background can leave the video paused with its
      // layout stale; a second pass after the browser settles catches that.
      setTimeout(applyViewport, 250);
      wakeChrome();
    };

    window.visualViewport?.addEventListener('resize', applyViewport);
    window.addEventListener('orientationchange', onReturn);
    window.addEventListener('pageshow', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.visualViewport?.removeEventListener('resize', applyViewport);
      window.removeEventListener('orientationchange', onReturn);
      window.removeEventListener('pageshow', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      document.documentElement.style.removeProperty('--player-height');
    };
  }, [wakeChrome]);

  const title = displayTitle(item, current);
  const subtitleUrl = (index) =>
    apiBaseUrl() + '/api/stream/' + current.id + '/subtitles/' + index + '.vtt';

  return (
    <div className="player" onPointerDown={wakeChrome}>
      {/*
        * Floating over the picture rather than a bar of its own, and summoned
        * by a touch anywhere. Before this it appeared only while paused, so
        * once something was playing there was no way back out of it.
        */}
      <div className={chrome ? 'player-chrome' : 'player-chrome hidden'}>
        <button className="player-close" onClick={() => { report(true); onClose(); }}>
          ‹ Back
        </button>
        <span className="player-title">{title}</span>

        <div className="player-actions">
          <button className="player-step" onClick={goFullscreen}>
            Full screen
          </button>
          {previous && (
            <button className="player-step" onClick={() => goTo(previous)}>
              ‹ Previous
            </button>
          )}
          {next && (
            <button className="player-step" onClick={() => goTo(next)}>
              Next ›
            </button>
          )}

          {tracks.audio.length > 1 && (
            <label className="player-pick">
              Audio
              <select
                value={audioTrack}
                onChange={(event) => chooseAudio(Number(event.target.value))}
              >
                {tracks.audio.map((track) => (
                  <option key={track.index} value={track.index}>{track.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <video
        ref={videoRef}
        className="player-video"
        controls
        autoPlay
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onSeeking={onSeeking}
        onTimeUpdate={() => report(false)}
        onPause={() => { report(true); wakeChrome(); }}
        onPlaying={() => wakeChrome()}
        onEnded={() => { report(true); if (next) goTo(next); }}
        onError={() => {
          if (status !== 'preparing') setError('The video stopped unexpectedly');
        }}
      >
        {/*
          * Subtitles the file already carries, converted on request. Safari
          * puts these behind its own CC button, so they are available in full
          * screen and over AirPlay as well as in the page.
          */}
        {tracks.subtitles.map((track, index) => (
          <track
            key={track.index}
            kind="subtitles"
            label={track.label}
            srcLang={track.language ?? 'und'}
            src={subtitleUrl(track.index)}
            default={index === 0 && tracks.subtitles.length === 1}
          />
        ))}
      </video>

      {status === 'preparing' && (
        <div className="player-note">
          <div className="spinner" />
          <p>{detail || 'Preparing…'}</p>
        </div>
      )}

      {error && (
        <div className="player-note">
          <p className="player-error">{error}</p>
          <button className="btn" onClick={() => load(current, audioTrack, 0)}>Try again</button>
          <button className="btn ghost" onClick={onClose}>Back</button>
        </div>
      )}
    </div>
  );
}

export default Player;
