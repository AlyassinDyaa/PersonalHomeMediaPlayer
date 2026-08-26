import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBaseUrl, displayTitle, formatDuration } from '../api.js';
import {
  PlayIcon, PauseIcon, Back10Icon, Forward10Icon, BackIcon, ExpandIcon, CompressIcon, ScreenIcon,
} from '../overlay/Icons.jsx';

/** How often the position is sent back, so the computer stays in step. */
const PROGRESS_INTERVAL_MS = 5000;
/** How often a paused player says it is still open, so its stream is kept. */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** How long the picture may be frozen before the computer is asked what is wrong. */
const STALL_GRACE_MS = 12_000;
const SKIP_SECONDS = 10;
const CONTROLS_HIDE_MS = 3500;
const QUALITY_KEY = 'library.streamQuality';

/**
 * What the viewer may ask for.
 *
 * Auto sends no ceiling and lets the computer apply its own, which is set to
 * survive an ordinary house network. The rest are for the cases the computer
 * cannot see from where it sits: a tablet at the far end of the garden, or a
 * connection someone is paying for by the megabyte.
 */
const QUALITIES = [
  { id: 'auto', label: 'Automatic', limits: null },
  { id: 'high', label: 'Best picture', limits: { maxHeight: 1080, maxBitrate: 20_000_000 } },
  { id: 'medium', label: 'Balanced', limits: { maxHeight: 720, maxBitrate: 4_500_000 } },
  { id: 'low', label: 'Save data', limits: { maxHeight: 480, maxBitrate: 2_000_000 } },
];

function storedQuality() {
  try {
    const saved = window.localStorage.getItem(QUALITY_KEY);
    if (QUALITIES.some((q) => q.id === saved)) return saved;
  } catch {
    // Private browsing, or storage switched off. The default is fine.
  }
  return 'auto';
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/**
 * Full-screen playback in a browser.
 *
 * Safari plays HLS natively, so there is no player library here — the video
 * element is given a playlist and left to do the decoding, which also means
 * AirPlay, picture-in-picture and the lock-screen controls all work without
 * help.
 *
 * The controls, however, are ours rather than Safari's. They have to be. A
 * stream is produced from the point being watched onwards and grows as ffmpeg
 * works, so the video element believes an episode resumed at twenty minutes is
 * a video that is nought seconds long and getting longer — which is exactly
 * what a viewer sees as "it only played part of the show". Everything below
 * therefore works in absolute time within the film, and translates to the
 * stream's own clock only at the point of touching the element.
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
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(video.duration ?? 0);
  const [scrubbing, setScrubbing] = useState(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [quality, setQuality] = useState(storedQuality);

  // Where the current stream begins within the film. Everything the video
  // element reports is relative to this.
  const offsetRef = useRef(0);
  const sessionRef = useRef(null);
  const lastSentRef = useRef(0);
  const durationRef = useRef(video.duration ?? null);
  const qualityRef = useRef(quality);
  // A seek to apply once the new stream has enough metadata to accept one.
  const pendingSeekRef = useRef(0);
  // Set when the computer has forgotten our stream while we were paused.
  const staleRef = useRef(false);
  const hideTimerRef = useRef(null);
  // What the chrome was doing when a tap began. State alone cannot answer this:
  // by the time the tap finishes, React has already re-rendered.
  const chromeVisibleRef = useRef(true);
  const stallTimerRef = useRef(null);
  const closedRef = useRef(false);

  /** The position within the film, as opposed to within the stream. */
  const absoluteTime = useCallback(() => {
    const element = videoRef.current;
    if (!element) return offsetRef.current;
    return offsetRef.current + (element.currentTime || 0);
  }, []);

  const report = useCallback((force) => {
    const moment = Date.now();
    if (!force && moment - lastSentRef.current < PROGRESS_INTERVAL_MS) return;
    lastSentRef.current = moment;

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

  /** Point the video element at a stream that plays the film from `startSeconds`. */
  const load = useCallback(async (startSeconds) => {
    const element = videoRef.current;
    if (!element) return;

    setStatus('preparing');
    setError(null);
    setBuffering(false);
    staleRef.current = false;

    const wanted = Math.max(0, Math.floor(startSeconds || 0));
    // Show the wanted position straight away. Waiting for the element to report
    // it leaves the timeline sitting at zero while the stream is prepared,
    // which reads as having lost the viewer's place.
    setNow(wanted);

    const chosen = QUALITIES.find((q) => q.id === qualityRef.current)?.limits ?? null;

    try {
      const info = await api.streamInfo(video.id, chosen);
      if (closedRef.current) return;
      if (info.duration) {
        durationRef.current = info.duration;
        setDuration(info.duration);
      }

      if (info.mode === 'direct' && wanted === 0) {
        // Already in a shape the browser understands: hand the file over and
        // let it seek natively, which is better than anything we can arrange.
        offsetRef.current = 0;
        sessionRef.current = null;
        pendingSeekRef.current = 0;
        setDetail('Playing the original file');
        element.src = apiBaseUrl() + '/api/stream/' + video.id + '/direct';
      } else {
        setDetail(info.mode === 'encode'
          ? 'Converting for this device'
          : 'Repackaging for this device');
        const session = await api.streamStart(video.id, wanted, chosen);
        if (closedRef.current) return;
        offsetRef.current = session.startSeconds ?? wanted;
        sessionRef.current = session.id;
        // A stream already running may begin earlier than the point asked for,
        // in which case it is joined and skipped forward rather than a second
        // one being started for the sake of a few seconds.
        pendingSeekRef.current = Math.max(0, wanted - (session.startSeconds ?? wanted));
        element.src = apiBaseUrl() + session.playlistUrl;
      }

      element.load();
      await element.play().catch(() => {
        // Autoplay can be refused until the viewer touches something; the
        // controls are visible, so this is not an error worth showing.
      });
      if (closedRef.current) return;
      setStatus('playing');
    } catch (failure) {
      if (closedRef.current) return;
      setError(failure.message);
      setStatus('failed');
    }
  }, [video.id]);

  /**
   * Go to a point in the film.
   *
   * Within what the current stream covers this is an ordinary seek and is
   * instant. Beyond it, there is nothing to seek to — the stream simply does
   * not contain that part of the film yet — so a stream is started there
   * instead, which takes a second or two.
   */
  const seekTo = useCallback((absolute) => {
    const element = videoRef.current;
    const total = durationRef.current;
    const target = clamp(absolute, 0, total ? total - 1 : absolute);
    const local = target - offsetRef.current;

    const seekable = element?.seekable;
    const covered = element && seekable && seekable.length > 0
      && local >= seekable.start(0) - 1
      && local <= seekable.end(seekable.length - 1) - 1;

    setNow(target);
    if (covered) {
      element.currentTime = local;
      report(true);
      return;
    }
    load(target);
  }, [load, report]);

  const skip = useCallback((seconds) => seekTo(absoluteTime() + seconds), [absoluteTime, seekTo]);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) {
      // A stream the computer swept up while we were paused cannot be resumed;
      // an equivalent one is started at the same point instead.
      if (staleRef.current) {
        load(absoluteTime());
        return;
      }
      element.play().catch(() => {
        // Refused, and there is nothing useful to say about it.
      });
    } else {
      element.pause();
    }
  }, [absoluteTime, load]);

  // ------------------------------------------------------------- chrome ---

  /** Show the controls, and start the clock that hides them again. */
  const wake = useCallback(() => {
    chromeVisibleRef.current = true;
    setChromeVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const element = videoRef.current;
      // Never hide the controls over a paused or stopped picture: there would
      // be nothing on screen at all, and no clue how to get them back.
      if (element && !element.paused) {
        chromeVisibleRef.current = false;
        setChromeVisible(false);
      }
    }, CONTROLS_HIDE_MS);
  }, []);

  /**
   * What touching the picture does.
   *
   * On a touch screen the controls have to be summoned before they can be used,
   * so the first tap shows them and the next one puts them away — which is what
   * every other video on the device does. A mouse has no such problem and a
   * click means play or pause, as it does everywhere else.
   */
  const onPictureTap = useCallback((event) => {
    if (event.pointerType !== 'touch') {
      togglePlay();
      return;
    }
    if (!chromeVisibleRef.current) {
      wake();
      return;
    }
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    chromeVisibleRef.current = false;
    setChromeVisible(false);
  }, [togglePlay, wake]);

  const toggleFullscreen = useCallback(() => {
    const element = videoRef.current;
    const surface = element?.closest('.player');
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    if (surface?.requestFullscreen) {
      surface.requestFullscreen().catch(() => {
        // Refused; the iPhone path below is the fallback.
      });
      return;
    }
    // iPhone gives no fullscreen to elements other than the video itself.
    element?.webkitEnterFullscreen?.();
  }, []);

  const showAirPlay = useCallback(() => {
    videoRef.current?.webkitShowPlaybackTargetPicker?.();
  }, []);

  // -------------------------------------------------------------- effects ---

  // Start where the film was left, wherever it was left.
  useEffect(() => {
    const resumeAt = video.position > 30 ? Math.floor(video.position) : 0;
    load(resumeAt);

    return () => {
      closedRef.current = true;
      // One last position on the way out, so closing the tab still counts.
      report(true);
    };
    // Only ever run for the video this player was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the stream alive while it is being watched, and — the case this
  // exists for — while it is paused and asking for nothing.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = sessionRef.current;
      if (!id) return;
      api.streamKeepAlive(id).catch(() => {
        // The computer no longer has this stream. Nothing to do until the
        // viewer presses play, at which point an equivalent one is started.
        staleRef.current = true;
      });
    }, KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Remember the chosen quality, and re-open the stream at the same point when
  // it changes.
  useEffect(() => {
    const previous = qualityRef.current;
    qualityRef.current = quality;
    try {
      window.localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      // Not being able to remember it is not worth mentioning.
    }
    if (previous !== quality) load(absoluteTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keyboard control, for anyone watching on a laptop browser.
  useEffect(() => {
    const onKey = (event) => {
      if (event.target instanceof HTMLInputElement) return;
      const handled = {
        ' ': () => togglePlay(),
        k: () => togglePlay(),
        ArrowLeft: () => skip(-SKIP_SECONDS),
        ArrowRight: () => skip(SKIP_SECONDS),
        f: () => toggleFullscreen(),
        Escape: () => { if (!document.fullscreenElement) onClose(); },
      }[event.key];
      if (!handled) return;
      event.preventDefault();
      wake();
      handled();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, skip, toggleFullscreen, togglePlay, wake]);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
  }, []);

  // What the lock screen and the headphone buttons control.
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return undefined;
    try {
      session.metadata = new window.MediaMetadata({
        title: video.title || item?.title || 'Now playing',
        artist: item?.title ?? '',
      });
    } catch {
      // Not every browser has MediaMetadata even when it has mediaSession.
    }
    session.setActionHandler('play', () => togglePlay());
    session.setActionHandler('pause', () => togglePlay());
    session.setActionHandler('seekbackward', () => skip(-SKIP_SECONDS));
    session.setActionHandler('seekforward', () => skip(SKIP_SECONDS));
    return () => {
      for (const action of ['play', 'pause', 'seekbackward', 'seekforward']) {
        try { session.setActionHandler(action, null); } catch { /* already gone */ }
      }
    };
  }, [item, skip, togglePlay, video.title]);

  // ---------------------------------------------------------- diagnosis ---

  /**
   * Work out why the picture stopped, and say so.
   *
   * The three reasons a video element stops look identical from the outside:
   * the film ended, the computer is still converting and we have caught up with
   * it, or ffmpeg died. Only the computer knows which, so it is asked.
   */
  const diagnose = useCallback(async (whenEnded) => {
    const id = sessionRef.current;
    if (!id) {
      if (!whenEnded) setError('The video stopped unexpectedly');
      return;
    }
    try {
      const state = await api.streamStatus(id);
      if (closedRef.current) return;

      if (state.failed) {
        setError('The computer stopped preparing this: ' + state.failed);
        setStatus('failed');
        return;
      }
      if (whenEnded) {
        const total = durationRef.current;
        // Reaching the end of a stream that is still being produced is not the
        // end of the film — it is having watched faster than the computer can
        // convert. Rejoining at the same point picks up the rest.
        if (!state.finished && total && absoluteTime() < total - 5) {
          setDetail('Waiting for the computer to catch up');
          load(absoluteTime());
        }
        return;
      }
      if (!state.finished) setDetail('Waiting for the computer to catch up');
    } catch {
      if (closedRef.current) return;
      // The stream is gone entirely; starting an equivalent one is the only
      // useful response, and it is the one the viewer wants.
      staleRef.current = true;
      if (!whenEnded) load(absoluteTime());
    }
  }, [absoluteTime, load]);

  /** Nothing has arrived for a while — find out whether anything is coming. */
  const watchForStall = useCallback(() => {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => diagnose(false), STALL_GRACE_MS);
  }, [diagnose]);

  const clearStallWatch = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  // ------------------------------------------------------------- render ---

  const title = displayTitle(item, video);
  const total = duration || durationRef.current || 0;
  const shown = scrubbing ?? now;
  const remaining = total ? Math.max(0, total - shown) : null;
  const busy = status === 'preparing' || buffering;

  return (
    <div
      className={'player' + (chromeVisible || paused ? '' : ' player-idle')}
      onMouseMove={wake}
    >
      <video
        ref={videoRef}
        className="player-video"
        autoPlay
        playsInline
        preload="auto"
        onPointerUp={onPictureTap}
        onLoadedMetadata={() => {
          const element = videoRef.current;
          const jump = pendingSeekRef.current;
          pendingSeekRef.current = 0;
          if (element && jump > 0) element.currentTime = jump;
        }}
        onTimeUpdate={() => {
          // While a stream is being swapped the element still reports the old
          // one's clock against the new one's offset, which makes the timeline
          // lurch. It is authoritative again once playback resumes.
          if (status === 'preparing') return;
          if (scrubbing == null) setNow(absoluteTime());
          report(false);
        }}
        onPlay={() => { setPaused(false); wake(); }}
        onPause={() => { setPaused(true); wake(); report(true); }}
        onPlaying={() => { setBuffering(false); setStatus('playing'); clearStallWatch(); }}
        onCanPlay={() => { setBuffering(false); clearStallWatch(); }}
        onWaiting={() => { setBuffering(true); watchForStall(); }}
        onStalled={watchForStall}
        onEnded={() => { report(true); diagnose(true); }}
        onError={() => {
          if (status !== 'preparing') diagnose(false);
        }}
      />

      <div className="player-chrome" onPointerDown={wake}>
        <div className="player-bar">
          <button className="player-close" onClick={() => { report(true); onClose(); }}>
            <BackIcon size={20} />
            <span>Back</span>
          </button>
          <span className="player-title">{title}</span>
          <label className="player-quality">
            <span className="visually-hidden">Picture quality</span>
            <select value={quality} onChange={(event) => setQuality(event.target.value)}>
              {QUALITIES.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="player-controls">
          <div className="player-scrub">
            <span className="player-time">{formatDuration(shown) ?? '0:00'}</span>
            <input
              className="player-seek"
              type="range"
              min={0}
              max={Math.max(1, Math.floor(total))}
              step={1}
              value={Math.floor(clamp(shown, 0, Math.max(1, total)))}
              disabled={!total}
              onChange={(event) => setScrubbing(Number(event.target.value))}
              onPointerUp={() => {
                if (scrubbing != null) seekTo(scrubbing);
                setScrubbing(null);
              }}
              onKeyUp={() => {
                if (scrubbing != null) seekTo(scrubbing);
                setScrubbing(null);
              }}
              aria-label="Position"
            />
            <span className="player-time">
              {remaining == null ? '--:--' : '-' + formatDuration(remaining)}
            </span>
          </div>

          <div className="player-buttons">
            <button onClick={() => skip(-SKIP_SECONDS)} aria-label="Back ten seconds">
              <Back10Icon size={26} />
            </button>
            <button
              className="player-play"
              onClick={togglePlay}
              aria-label={paused ? 'Play' : 'Pause'}
            >
              {paused ? <PlayIcon size={30} /> : <PauseIcon size={30} />}
            </button>
            <button onClick={() => skip(SKIP_SECONDS)} aria-label="Forward ten seconds">
              <Forward10Icon size={26} />
            </button>
            <span className="player-spacer" />
            <button onClick={showAirPlay} aria-label="Play on another screen">
              <ScreenIcon size={22} />
            </button>
            <button onClick={toggleFullscreen} aria-label="Full screen">
              {fullscreen ? <CompressIcon size={22} /> : <ExpandIcon size={22} />}
            </button>
          </div>
        </div>
      </div>

      {busy && !error && (
        <div className="player-note player-note-quiet">
          <div className="spinner" />
          <p>{detail || 'Preparing…'}</p>
        </div>
      )}

      {error && (
        <div className="player-note">
          <p className="player-error">{error}</p>
          <button className="btn" onClick={() => load(absoluteTime())}>Try again</button>
          <button className="btn ghost" onClick={onClose}>Back</button>
        </div>
      )}
    </div>
  );
}

export default Player;
