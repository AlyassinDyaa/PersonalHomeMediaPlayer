import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBaseUrl, displayTitle } from '../api.js';

/** How often the position is sent back, so the computer stays in step. */
const PROGRESS_INTERVAL_MS = 5000;

/** Seconds as h:mm:ss, or m:ss for anything under an hour. */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = String(whole % 60).padStart(2, "0");
  return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}

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
  const boxRef = useRef(null);
  const [current, setCurrent] = useState(video);
  const [status, setStatus] = useState('preparing');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);
  const [tracks, setTracks] = useState({ audio: [], subtitles: [] });
  const [audioTrack, setAudioTrack] = useState(0);
  const [chrome, setChrome] = useState(true);
  const [paused, setPaused] = useState(false);
  /** Position within the whole film, in seconds. */
  const [at, setAt] = useState(0);
  /** How long the film is, from the file itself rather than the stream. */
  const [length, setLength] = useState(video.duration ?? 0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubTo, setScrubTo] = useState(0);
  const [subtitleTrack, setSubtitleTrack] = useState(-1);
  const [full, setFull] = useState(false);
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
  /** The playlist of the stream now running, so a jump can re-read it. */
  const playlistRef = useRef(null);
  /** Set below; held in a ref so declaration order cannot bite again. */
  const producedSecondsRef = useRef(async () => 0);
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
    // Said before anything is awaited: reading a large file on a busy drive can
    // take a while, and an unexplained spinner is indistinguishable from a
    // stuck one.
    setDetail('Looking at the file');
    resumeToRef.current = startAt ?? 0;

    try {
      const info = await api.streamInfo(target.id);
      durationRef.current = info.duration ?? target.duration ?? null;
      if (durationRef.current) setLength(durationRef.current);
      setTracks({
        audio: info.audioTracks ?? [],
        subtitles: info.subtitleTracks ?? [],
      });

      /*
       * A repacked copy beats every streaming path.
       *
       * It is the same picture in a container the browser understands, served
       * as a plain file, so seeking is native and instant and nothing runs on
       * the server while it plays. The server makes one in the background the
       * first time a film is opened, so this is the second viewing onwards.
       */
      if (info.prepared === 'ready') {
        offsetRef.current = 0;
        playlistRef.current = null;
        setDetail('Playing the prepared copy');
        videoRef.current.src = apiBaseUrl() + '/api/stream/' + target.id + '/prepared';
      } else if (info.mode === 'direct') {
        // Already in a shape the browser understands: hand the file over and
        // let it seek natively, which is better than anything we can arrange.
        offsetRef.current = 0;
        setDetail('Playing the original file');
        playlistRef.current = null;
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
        playlistRef.current = apiBaseUrl() + session.playlistUrl;
        videoRef.current.src = playlistRef.current;
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
   * How much of the film the running stream has actually produced.
   *
   * The player's own idea of what it can seek to comes from the copy of the
   * playlist it last read, and it does not re-read one on demand. Meanwhile
   * ffmpeg runs many times faster than playback, so within a minute or two the
   * whole film is usually sitting on disk — the part being jumped to is
   * already there, and the player simply does not know yet.
   *
   * @returns {Promise<number>} seconds covered, from the stream's own start.
   */
  /**
   * Wait briefly for the stream to reach a point, rather than restarting.
   *
   * ffmpeg runs many times faster than playback, so a jump slightly past what
   * it has written is usually a second or two from being covered. Restarting
   * at that moment throws away everything already produced and makes the
   * viewer sit through "preparing" for a part of the film that was about to
   * arrive on its own.
   *
   * @returns {Promise<boolean>} whether the point is now covered.
   */
  const waitForPoint = useCallback(async (withinSeconds, attempts = 6) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const produced = await producedSecondsRef.current();
      if (produced > withinSeconds + 1) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }, []);

  const producedSeconds = useCallback(async () => {
    if (!playlistRef.current) return 0;
    try {
      const response = await fetch(playlistRef.current, { cache: 'no-store' });
      if (!response.ok) return 0;
      const text = await response.text();
      let total = 0;
      for (const match of text.matchAll(/#EXTINF:([0-9.]+)/g)) total += Number(match[1]) || 0;
      return total;
    } catch {
      return 0;
    }
  }, []);

  /**
   * Point the player at the same stream again, then jump.
   *
   * Re-reading a playlist that has grown costs one small request; starting a
   * fresh stream costs an ffmpeg launch and a wait. Both land in the same
   * place, so this is worth trying first whenever the segments already exist.
   */
  useEffect(() => { producedSecondsRef.current = producedSeconds; }, [producedSeconds]);

  const rereadAndSeek = useCallback((withinSeconds) => {
    const element = videoRef.current;
    if (!element || !playlistRef.current) return;
    resumeToRef.current = withinSeconds;
    element.src = playlistRef.current;
    element.load();
    element.play().catch(() => {
      // Autoplay refusals are not worth a message; the controls are up.
    });
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
      // Same reasoning as seekTo: the stream has usually run far ahead of what
      // the player has read, so check before restarting anything.
      waitForPoint(wanted).then((covered) => {
        if (covered) rereadAndSeek(wanted);
        else load(currentRef.current, audioTrack, Math.floor(offsetRef.current + wanted));
      });
    }
  }, [load, status, audioTrack, waitForPoint, rereadAndSeek]);

  /** Where the film is now, as opposed to where the stream is. */
  const filmTime = useCallback(
    () => offsetRef.current + (videoRef.current?.currentTime ?? 0),
    [],
  );

  /**
   * Move to a point in the film.
   *
   * Within what the running stream covers this is an ordinary seek. Beyond
   * it, the stream itself has to be restarted from that point, because it is
   * only ever produced forwards from where it began.
   */
  const seekTo = useCallback((seconds) => {
    const element = videoRef.current;
    if (!element) return;
    const target = Math.max(0, Math.min(seconds, (durationRef.current ?? seconds) - 1));
    const within = target - offsetRef.current;
    const seekable = element.seekable;
    const covered = seekable && seekable.length > 0
      && within >= seekable.start(0) - 1
      && within <= seekable.end(seekable.length - 1) + 0.5;

    if (covered) {
      element.currentTime = Math.max(0, within);
      setAt(target);
    } else {
      /*
       * Outside what the player thinks it has — but very often inside what the
       * stream has actually written. Ask the playlist before paying for a new
       * one: re-reading it is a single small request, where restarting means
       * launching ffmpeg again and waiting through "preparing" for a part of
       * the film that was already sitting on disk.
       */
      setAt(target);
      waitForPoint(within).then((covered) => {
        if (covered) rereadAndSeek(Math.max(0, within));
        else load(currentRef.current, audioTrack, Math.floor(target));
      });
      return;
    }
    wakeChrome();
  }, [load, audioTrack, wakeChrome, waitForPoint, rereadAndSeek]);

  /*
   * Finish a scrub wherever the finger happens to lift.
   *
   * Listening on the bar itself missed releases outside it, which is most of
   * them on a touch screen: a finger drags past the end of the bar, or off the
   * bottom of the screen, and the release lands on the page. The bar was then
   * left believing it was still being dragged — the clock frozen, playback
   * carrying on underneath, and no seek ever made.
   */
  useEffect(() => {
    if (!scrubbing) return undefined;

    const finish = () => { setScrubbing(false); seekTo(scrubTo); };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [scrubbing, scrubTo, seekTo]);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) element.play().catch(() => {});
    else element.pause();
    wakeChrome();
  }, [wakeChrome]);

  /** Turn a subtitle track on, or all of them off. */
  const chooseSubtitles = useCallback((index) => {
    const element = videoRef.current;
    if (!element) return;
    for (let i = 0; i < element.textTracks.length; i++) {
      element.textTracks[i].mode = i === index ? "showing" : "disabled";
    }
    setSubtitleTrack(index);
    wakeChrome();
  }, [wakeChrome]);
  /**
   * Full screen, with our own controls still on top.
   *
   * Never by handing the video element to iOS. That gives Apple's player,
   * whose controls are built from the playlist — the LIVE badge, no skip
   * buttons, and a remaining time of -114:07:48 — which is the whole reason
   * this bar exists. An earlier version fell back to it the moment the
   * standard request was refused, so on an iPad the button reliably produced
   * the broken player rather than the fixed one.
   *
   * The prefixed call is tried after the standard one rather than instead of
   * it: Safari on an iPad honours the prefixed form on an ordinary element,
   * and that keeps the picture and these controls together.
   *
   * Where neither is allowed the player already covers the window, so
   * nothing happens and nothing breaks — opening the library from its Home
   * Screen icon gives a screen with no browser furniture at all.
   */
  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    wakeChrome();

    const current = document.fullscreenElement || document.webkitFullscreenElement;
    if (current) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (!box) return;

    const prefixed = () => {
      if (typeof box.webkitRequestFullscreen === "function") box.webkitRequestFullscreen();
    };

    if (typeof box.requestFullscreen === "function") {
      // The promise rejects on a device that only accepts the prefixed form,
      // which is the case worth catching rather than giving up on.
      box.requestFullscreen().catch(prefixed);
    } else {
      prefixed();
    }
  }, [wakeChrome]);

  // Follow full screen however it was entered or left, including the Escape
  // key and the system gesture, so the button always says the right thing.
  useEffect(() => {
    const sync = () => {
      setFull(Boolean(document.fullscreenElement || document.webkitFullscreenElement));
      wakeChrome();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
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
    <div
      className="player"
      ref={boxRef}
      onPointerDown={wakeChrome}
      // A trackpad or mouse should reveal the controls by moving, not only by
      // pressing; a finger has no hover, which is what the press covers.
      onMouseMove={wakeChrome}
    >
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
          <button className="player-step" onClick={toggleFullscreen}>
            {full ? "Exit full screen" : "Full screen"}
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
        autoPlay
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onSeeking={onSeeking}
        onTimeUpdate={() => { report(false); if (!scrubbing) setAt(filmTime()); }}
        onPlay={() => setPaused(false)}
        onPause={() => { report(true); setPaused(true); wakeChrome(); }}
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


      {/*
        * The transport, drawn here rather than left to the browser.
        *
        * Safari builds its controls from the playlist, and the playlist
        * honestly describes a stream still being produced from the point
        * being watched — so it showed a LIVE badge, no scrubber and a
        * remaining time of -135:56:28. These read the position and the length
        * of the film instead, which are known regardless of how much of the
        * stream exists yet.
        */}
      {/*
        * The transport, over the picture.
        *
        * A finger reaches the middle of a tablet far more easily than a strip
        * along the bottom edge, and these are the three controls wanted while
        * watching. They appear and leave with the rest of the chrome, and the
        * small versions stay in the bar below for a mouse.
        */}
      <div className={chrome ? "player-touch" : "player-touch hidden"} aria-hidden={!chrome}>
        <button
          className="touch-key back"
          onClick={() => seekTo(at - 10)}
          aria-label="Back 10 seconds"
          tabIndex={chrome ? 0 : -1}
        >
          <span className="touch-glyph">↺</span>
          <span className="touch-num">10</span>
        </button>

        <button
          className="touch-key play"
          onClick={togglePlay}
          aria-label={paused ? "Play" : "Pause"}
          tabIndex={chrome ? 0 : -1}
        >
          <span className="touch-glyph big">{paused ? "▶" : "❚❚"}</span>
        </button>

        <button
          className="touch-key forward"
          onClick={() => seekTo(at + 10)}
          aria-label="Forward 10 seconds"
          tabIndex={chrome ? 0 : -1}
        >
          <span className="touch-glyph">↻</span>
          <span className="touch-num">10</span>
        </button>
      </div>

      <div className={chrome ? "player-bar" : "player-bar hidden"}>
        <button className="player-key" onClick={togglePlay} aria-label={paused ? "Play" : "Pause"}>
          {paused ? "▶" : "❚❚"}
        </button>
        <button className="player-key" onClick={() => seekTo(at - 10)} aria-label="Back 10 seconds">
          ↺10
        </button>
        <button className="player-key" onClick={() => seekTo(at + 10)} aria-label="Forward 10 seconds">
          10↻
        </button>

        <span className="player-time">{formatTime(scrubbing ? scrubTo : at)}</span>
        <input
          className="player-seek"
          type="range"
          min={0}
          max={Math.max(1, Math.floor(length))}
          step={1}
          value={Math.floor(scrubbing ? scrubTo : at)}
          /* Paints the part already played; see the stylesheet. */
          style={{ '--played': (length > 0 ? ((scrubbing ? scrubTo : at) / length) * 100 : 0) + '%' }}
          onPointerDown={() => { setScrubTo(at); setScrubbing(true); }}
          onChange={(event) => { setScrubbing(true); setScrubTo(Number(event.target.value)); }}
          onKeyUp={() => { if (scrubbing) { setScrubbing(false); seekTo(scrubTo); } }}
          aria-label="Position"
        />
        <span className="player-time">{formatTime(length)}</span>

        {tracks.subtitles.length > 0 && (
          <label className="player-pick">
            CC
            <select
              value={subtitleTrack}
              onChange={(event) => chooseSubtitles(Number(event.target.value))}
            >
              <option value={-1}>Off</option>
              {tracks.subtitles.map((track, index) => (
                <option key={track.index} value={index}>{track.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

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
