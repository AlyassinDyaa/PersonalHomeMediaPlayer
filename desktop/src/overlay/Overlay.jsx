import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PlayIcon, PauseIcon, NextIcon, PrevIcon, Back10Icon, Forward10Icon,
  VolumeIcon, MuteIcon, SubtitlesIcon, AudioIcon, CloseIcon, BackIcon, ScreenIcon,
} from './Icons.jsx';

const HIDE_AFTER_MS = 3600;

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
  });
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [menu, setMenu] = useState(null);

  const hideTimer = useRef(null);
  const interactiveRef = useRef(null);

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
      if (event.key === 'Escape') { player?.stop(); return; }
      const command = keys[event.key];
      if (!command) return;
      event.preventDefault();
      wake();
      player?.command(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, wake]);

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

  return (
    <div
      className={visible ? 'overlay visible' : 'overlay'}
      onClick={(event) => {
        // Only a click on empty space counts; buttons stop propagation naturally.
        if (event.target !== event.currentTarget) return;
        command(['cycle', 'pause']);
      }}
    >
      <div className="overlay-top">
        <button className="icon-btn" title="Back to library (Esc)" onClick={() => player?.stop()}>
          <BackIcon />
        </button>
        <span className="overlay-title">{state.title}</span>
        <span className="overlay-spacer" />
        {state.displayCount > 1 && (
          <button
            className="icon-btn"
            title="Move to the next screen"
            onClick={() => player?.moveScreen()}
          >
            <ScreenIcon />
          </button>
        )}
        <button className="icon-btn close" title="Close player (Esc)" onClick={() => player?.stop()}>
          <CloseIcon />
        </button>
      </div>

      {/* Floating prompts, positioned clear of the bar like a streaming app. */}
      <div className="overlay-prompts">
        {showSkipIntro && (
          <button className="prompt-btn" onClick={() => seekTo(intro.to)}>
            Skip Intro
          </button>
        )}
        {showOutro && state.hasNext && (
          <button className="prompt-btn primary" onClick={() => player?.next()}>
            Next Episode{state.nextTitle ? ' · ' + state.nextTitle : ''}
          </button>
        )}
        {showOutro && !state.hasNext && outro.from < duration && (
          <button className="prompt-btn" onClick={() => seekTo(duration - 1)}>
            Skip Outro
          </button>
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
          <button className="icon-btn primary" title="Play/pause (space)" onClick={() => command(['cycle', 'pause'])}>
            {state.paused ? <PlayIcon size={26} /> : <PauseIcon size={26} />}
          </button>

          <button className="icon-btn" title="Back 10 seconds (j)" onClick={() => command(['seek', -10, 'relative'])}>
            <Back10Icon />
          </button>
          <button className="icon-btn" title="Forward 10 seconds (l)" onClick={() => command(['seek', 10, 'relative'])}>
            <Forward10Icon />
          </button>

          {state.hasPrev && (
            <button className="icon-btn" title="Previous episode" onClick={() => player?.previous()}>
              <PrevIcon />
            </button>
          )}
          {state.hasNext && (
            <button className="icon-btn" title="Next episode" onClick={() => player?.next()}>
              <NextIcon />
            </button>
          )}

          <div className="volume">
            <button className="icon-btn" title="Mute (m)" onClick={() => command(['cycle', 'mute'])}>
              {state.muted ? <MuteIcon /> : <VolumeIcon />}
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
            title="Subtitles"
            onClick={() => setMenu(menu === 'subs' ? null : 'subs')}
          >
            <SubtitlesIcon />
          </button>
          {state.audioTracks.length > 1 && (
            <button
              className={menu === 'audio' ? 'icon-btn active' : 'icon-btn'}
              title="Audio track"
              onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
            >
              <AudioIcon />
            </button>
          )}
        </div>

        {menu === 'subs' && (
          <TrackMenu
            title="Subtitles"
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
