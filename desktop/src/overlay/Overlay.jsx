import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PlayIcon, PauseIcon, NextIcon, PrevIcon, Back10Icon, Forward10Icon,
  VolumeIcon, MuteIcon, SubtitlesIcon, AudioIcon, CloseIcon, BackIcon, ScreenIcon,
  ExpandIcon, CompressIcon, GripIcon,
} from './Icons.jsx';

const HIDE_AFTER_MS = 3600;

/** Seconds shown before the next episode starts on its own. */
const NEXT_EPISODE_SECONDS = 12;

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

/**
 * Transparent playback controls drawn over mpv.
 *
 * The window is click-through by default and becomes interactive only while the
 * pointer is within the control bands, which is what lets a floating overlay
 * coexist with a separate video window.
 */
export function Overlay() {
  const [state, setState] = useState({
    title: '', position: 0, duration: null, paused: false, volume: 100, muted: false,
    subtitles: [], audioTracks: [], subtitleId: null, audioId: null,
    hasNext: false, hasPrev: false, nextTitle: null, skip: { intro: null, outro: null },
    fullscreen: true,
  });
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [menu, setMenu] = useState(null);
  const [countdown, setCountdown] = useState(null);

  const hideTimer = useRef(null);
  const interactiveRef = useRef(null);
  const cancelledRef = useRef(null);
  const gestureRef = useRef(null);

  const player = typeof window !== 'undefined' ? window.player : null;

  /** Reveal the controls and restart the inactivity countdown. */
  const wake = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      setMenu(null);
    }, HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    if (!player) return undefined;
    const unsubscribe = player.onState((next) => {
      setState((previous) => ({ ...previous, ...next }));
    });
    player.ready();
    wake();
    return () => { unsubscribe?.(); clearTimeout(hideTimer.current); };
  }, [player, wake]);

  /**
   * Move and resize the video window from these controls.
   *
   * The video is a separate borderless window with no title bar of its own, so
   * this bar becomes its title bar: the main process applies one rectangle to
   * the video and to this window together, which is what stops them drifting
   * apart the way they used to.
   *
   * Screen coordinates are sent rather than deltas, because this window is
   * being moved out from under the pointer while the drag is in progress.
   */
  const onGestureDown = useCallback((kind) => (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gestureRef.current = kind;
    player?.gestureStart(kind, { x: event.screenX, y: event.screenY });
  }, [player]);

  const onGestureMove = useCallback((event) => {
    if (!gestureRef.current) return;
    player?.gestureMove({ x: event.screenX, y: event.screenY });
  }, [player]);

  const onGestureUp = useCallback((event) => {
    if (!gestureRef.current) return;
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    player?.gestureEnd({ x: event.screenX, y: event.screenY });
  }, [player]);

  const toggleFullscreen = useCallback(() => {
    wake();
    player?.toggleFullscreen();
  }, [player, wake]);

  /** Only tell the main process when the value actually changes. */
  const setInteractive = useCallback((next) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    player?.setInteractive(next);
  }, [player]);

  /**
   * The window accepts mouse input for exactly as long as the controls are on
   * screen, and is click-through the rest of the time.
   *
   * An earlier version toggled this per-pointer-position against the bar's
   * region. That raced against the show/hide animation — the window could be
   * click-through at the instant of a click that visually landed on a button —
   * and made the controls feel dead. Tying it to visibility removes the race
   * entirely; clicks on the video area are handled here instead.
   */
  useEffect(() => {
    setInteractive(visible || Boolean(menu));
  }, [visible, menu, setInteractive]);

  // Any pointer movement brings the controls back. Movement is reported by the
  // main process, because a click-through window does not reliably see it.
  useEffect(() => {
    const onMove = () => wake();
    window.addEventListener('mousemove', onMove);
    const unsubscribe = player?.onWake?.(onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      unsubscribe?.();
    };
  }, [wake, player]);

  // A new file starting counts as activity, so the controls introduce it.
  useEffect(() => { if (state.title) wake(); }, [state.title, wake]);

  // Keyboard works whether focus sits with mpv or with this window.
  useEffect(() => {
    const onKey = (event) => {
      const keys = {
        ' ': ['cycle', 'pause'],
        k: ['cycle', 'pause'],
        ArrowRight: ['seek', 5, 'relative'],
        ArrowLeft: ['seek', -5, 'relative'],
        ArrowUp: ['add', 'volume', 5],
        ArrowDown: ['add', 'volume', -5],
        m: ['cycle', 'mute'],
        j: ['seek', -10, 'relative'],
        l: ['seek', 10, 'relative'],
      };
      // Escape leaves fullscreen first, the way it does in a browser, and
      // only closes the player once the video is already windowed.
      if (event.key === 'Escape') {
        if (state.fullscreen) player?.setFullscreen(false);
        else player?.stop();
        return;
      }
      if (event.key === 'f' || event.key === 'F11') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      const command = keys[event.key];
      if (!command) return;
      event.preventDefault();
      wake();
      player?.command(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, wake, toggleFullscreen, state.fullscreen]);

  const duration = state.duration ?? 0;
  const position = scrubbing ? scrubValue : state.position;
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const command = (args) => player?.command(args);
  const seekTo = (seconds) => command(['seek', Math.max(0, seconds), 'absolute']);

  const onTrackPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  // Skip prompts only appear while they are actually relevant.
  const intro = state.skip?.intro;
  const outro = state.skip?.outro;
  const showSkipIntro = Boolean(intro) && position >= intro.from && position < intro.to;
  const showOutro = Boolean(outro) && duration > 0 && position >= outro.from;

  /**
   * Counts down to the next episode once the closing minutes are reached, and
   * plays it when it hits zero. Cancelling leaves the card in place so the
   * episode can still be started by hand.
   */
  useEffect(() => {
    if (!showOutro || !state.hasNext) { setCountdown(null); return undefined; }
    // Only arm once per episode; cancelling sets it to null and must stick.
    if (cancelledRef.current === state.title) return undefined;

    setCountdown((current) => (current === null ? NEXT_EPISODE_SECONDS : current));

    const timer = setInterval(() => {
      setCountdown((current) => {
        if (current === null) return null;
        if (current <= 1) {
          clearInterval(timer);
          player?.next();
          return null;
        }
        return current - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [showOutro, state.hasNext, state.title, player]);

  // Remember a cancellation against the current episode so re-entering the
  // outro window does not immediately re-arm the countdown.
  useEffect(() => {
    if (countdown === null && showOutro) cancelledRef.current = state.title;
    if (!showOutro) cancelledRef.current = null;
  }, [countdown, showOutro, state.title]);

  return (
    <div
      className={visible ? 'overlay visible' : 'overlay'}
      onClick={(event) => {
        // Only a click on empty space counts; buttons stop propagation naturally.
        if (event.target !== event.currentTarget) return;
        command(['cycle', 'pause']);
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        // A double-click arrives after a click that has already toggled pause,
        // so undo that: sizing the picture should not also stop it.
        command(['cycle', 'pause']);
        toggleFullscreen();
      }}
    >
      <div className="overlay-top">
        <button className="icon-btn" data-tip="Back to library (Esc)" onClick={() => player?.stop()}>
          <BackIcon />
        </button>
        {/* The draggable region. Double-clicking it toggles fullscreen, the
            same gesture a title bar answers to everywhere else in Windows. */}
        <div
          className="overlay-drag"
          data-tip="Drag to move · double-click for fullscreen"
          onPointerDown={onGestureDown('move')}
          onPointerMove={onGestureMove}
          onPointerUp={onGestureUp}
          onPointerCancel={onGestureUp}
          onDoubleClick={toggleFullscreen}
        >
          <span className="overlay-title">{state.title}</span>
        </div>
        {state.displayCount > 1 && (
          <button
            className="icon-btn"
            data-tip="Move to next screen"
            onClick={() => player?.moveScreen()}
          >
            <ScreenIcon />
          </button>
        )}
        <button
          className="icon-btn"
          data-tip={state.fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
          onClick={toggleFullscreen}
        >
          {state.fullscreen ? <CompressIcon /> : <ExpandIcon />}
        </button>
        <button className="icon-btn close" data-tip="Close" onClick={() => player?.stop()}>
          <CloseIcon />
        </button>
      </div>

      {/* Floating prompts, positioned clear of the bar like a streaming app. */}
      <div className="overlay-prompts">
        {showSkipIntro && (
          <button className="prompt-btn" onClick={() => seekTo(intro.to)}>
            {/* When the point came from a convention rather than a chapter
                marker, show where it lands so the jump is never a surprise. */}
            {intro.approximate ? 'Skip Intro → ' + formatTime(intro.to) : 'Skip Intro'}
          </button>
        )}

        {showOutro && state.hasNext && (
          <div className="next-card">
            <div className="next-card-label">
              {countdown === null ? 'Up next' : 'Next episode in ' + countdown}
            </div>
            <div className="next-card-title">{state.nextTitle ?? 'Next episode'}</div>
            <div className="next-card-actions">
              <button className="prompt-btn primary" onClick={() => player?.next()}>
                Play now
              </button>
              {countdown !== null && (
                <button className="prompt-btn" onClick={() => setCountdown(null)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="overlay-bar">
        <div
          className="seek"
          onMouseDown={(event) => { setScrubbing(true); setScrubValue(onTrackPointer(event)); }}
          onMouseMove={(event) => { if (scrubbing) setScrubValue(onTrackPointer(event)); }}
          onMouseUp={(event) => {
            const target = onTrackPointer(event);
            setScrubbing(false);
            seekTo(target);
          }}
          onMouseLeave={() => { if (scrubbing) { setScrubbing(false); seekTo(scrubValue); } }}
        >
          <div className="seek-track">
            <div className="seek-fill" style={{ width: percent + '%' }} />
            <div className="seek-knob" style={{ left: percent + '%' }} />
          </div>
        </div>

        <div className="overlay-controls">
          <button className="icon-btn primary" data-tip="Play / pause (space)" onClick={() => command(['cycle', 'pause'])}>
            {state.paused ? <PlayIcon size={34} /> : <PauseIcon size={34} />}
          </button>

          <button className="icon-btn" data-tip="Back 10s (j)" onClick={() => command(['seek', -10, 'relative'])}>
            <Back10Icon size={28} />
          </button>
          <button className="icon-btn" data-tip="Forward 10s (l)" onClick={() => command(['seek', 10, 'relative'])}>
            <Forward10Icon size={28} />
          </button>

          {state.hasPrev && (
            <button className="icon-btn" data-tip="Previous episode" onClick={() => player?.previous()}>
              <PrevIcon size={26} />
            </button>
          )}
          {state.hasNext && (
            <button className="icon-btn" data-tip="Next episode" onClick={() => player?.next()}>
              <NextIcon size={26} />
            </button>
          )}

          <div className="volume">
            <button className="icon-btn" data-tip="Mute (m)" onClick={() => command(['cycle', 'mute'])}>
              {state.muted ? <MuteIcon size={26} /> : <VolumeIcon size={26} />}
            </button>
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="130"
              value={state.muted ? 0 : state.volume}
              onChange={(event) => {
                if (state.muted) command(['set_property', 'mute', false]);
                command(['set_property', 'volume', Number(event.target.value)]);
              }}
            />
          </div>

          <span className="overlay-spacer" />

          <span className="overlay-clock">
            {formatTime(position)}<span className="clock-sep">/</span>{formatTime(duration)}
          </span>

          <button
            className={menu === 'subs' ? 'icon-btn active' : 'icon-btn'}
            data-tip="Subtitles"
            onClick={() => setMenu(menu === 'subs' ? null : 'subs')}
          >
            <SubtitlesIcon size={26} />
          </button>
          {state.audioTracks.length > 1 && (
            <button
              className={menu === 'audio' ? 'icon-btn active' : 'icon-btn'}
              data-tip="Audio"
              onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
            >
              <AudioIcon size={26} />
            </button>
          )}

          <button
            className="icon-btn"
            data-tip={state.fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
            onClick={toggleFullscreen}
          >
            {state.fullscreen ? <CompressIcon size={26} /> : <ExpandIcon size={26} />}
          </button>
        </div>

        {menu === 'subs' && (
          <TrackMenu
            data-tip="Subtitles"
            tracks={[{ id: null, label: 'Off' }, ...state.subtitles]}
            activeId={state.subtitleId}
            emptyNote="This file has no subtitles"
            onPick={(id) => {
              command(['set_property', 'sid', id === null ? 'no' : id]);
              setMenu(null);
            }}
          />
        )}

        {menu === 'audio' && (
          <TrackMenu
            title="Audio"
            tracks={state.audioTracks}
            activeId={state.audioId}
            onPick={(id) => { command(['set_property', 'aid', id]); setMenu(null); }}
          />
        )}
      </div>

      {/* Only a window can be resized; fullscreen has nowhere to grow into. */}
      {!state.fullscreen && (
        <div
          className="resize-grip"
          data-tip="Drag to resize"
          onPointerDown={onGestureDown('resize')}
          onPointerMove={onGestureMove}
          onPointerUp={onGestureUp}
          onPointerCancel={onGestureUp}
        >
          <GripIcon size={18} />
        </div>
      )}
    </div>
  );
}

function TrackMenu({ title, tracks, activeId, onPick, emptyNote }) {
  const real = tracks.filter((track) => track.id !== null);
  return (
    <div className="track-menu">
      <div className="track-menu-title">{title}</div>
      {real.length === 0 && emptyNote && <div className="track-empty">{emptyNote}</div>}
      {tracks.map((track) => (
        <button
          key={String(track.id)}
          className={track.id === activeId ? 'track-item active' : 'track-item'}
          onClick={() => onPick(track.id)}
        >
          {track.label}
        </button>
      ))}
    </div>
  );
}

export default Overlay;
