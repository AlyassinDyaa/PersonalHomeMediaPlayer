import React, { useCallback, useEffect, useRef, useState } from 'react';

const HIDE_AFTER_MS = 3200;

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
 * The window is click-through by default so the video behaves normally; it
 * becomes interactive only while the pointer is over the control bar. That is
 * what lets a floating overlay coexist with a separate video window.
 */
export function Overlay() {
  const [state, setState] = useState({
    title: '', position: 0, duration: null, paused: false, volume: 100,
    subtitles: [], audioTracks: [], subtitleId: null, audioId: null,
  });
  const [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [menu, setMenu] = useState(null);

  const hideTimer = useRef(null);
  const barRef = useRef(null);

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

  // Hand mouse events back to mpv unless the pointer is over the controls.
  useEffect(() => {
    const onMove = (event) => {
      wake();
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const overControls = visible && event.clientY >= rect.top;
      player?.setInteractive(overControls || Boolean(menu));
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [player, wake, visible, menu]);

  // Controls that are hidden must never swallow clicks.
  useEffect(() => {
    if (!visible) player?.setInteractive(false);
  }, [visible, player]);

  const duration = state.duration ?? 0;
  const position = scrubbing ? scrubValue : state.position;
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const command = (args) => player?.command(args);
  const seekTo = (seconds) => command(['seek', seconds, 'absolute']);

  const onTrackPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  return (
    <div className={visible ? 'overlay visible' : 'overlay'}>
      <div className="overlay-top">
        <button className="icon-btn" title="Back to library" onClick={() => player?.stop()}>
          ←
        </button>
        <span className="overlay-title">{state.title}</span>
      </div>

      <div className="overlay-bar" ref={barRef}>
        <div
          className="seek"
          onMouseDown={(event) => {
            setScrubbing(true);
            setScrubValue(onTrackPointer(event));
          }}
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

        <div className="overlay-times">
          <span>{formatTime(position)}</span>
          <span>{duration ? '-' + formatTime(duration - position) : ''}</span>
        </div>

        <div className="overlay-controls">
          <button className="icon-btn big" onClick={() => command(['cycle', 'pause'])}>
            {state.paused ? '▶' : '❚❚'}
          </button>
          <button className="icon-btn" title="Back 10s" onClick={() => command(['seek', -10, 'relative'])}>
            ⏪
          </button>
          <button className="icon-btn" title="Forward 10s" onClick={() => command(['seek', 10, 'relative'])}>
            ⏩
          </button>

          <div className="volume">
            <button
              className="icon-btn"
              onClick={() => command(['cycle', 'mute'])}
              title="Mute"
            >
              🔊
            </button>
            <input
              type="range"
              min="0"
              max="130"
              value={state.volume}
              onChange={(event) => command(['set_property', 'volume', Number(event.target.value)])}
            />
          </div>

          <span className="overlay-spacer" />

          {state.subtitles.length > 0 && (
            <button
              className={menu === 'subs' ? 'icon-btn active' : 'icon-btn'}
              title="Subtitles"
              onClick={() => setMenu(menu === 'subs' ? null : 'subs')}
            >
              CC
            </button>
          )}
          {state.audioTracks.length > 1 && (
            <button
              className={menu === 'audio' ? 'icon-btn active' : 'icon-btn'}
              title="Audio track"
              onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
            >
              🎧
            </button>
          )}
        </div>

        {menu === 'subs' && (
          <TrackMenu
            title="Subtitles"
            tracks={[{ id: null, label: 'Off' }, ...state.subtitles]}
            activeId={state.subtitleId}
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

function TrackMenu({ title, tracks, activeId, onPick }) {
  return (
    <div className="track-menu">
      <div className="track-menu-title">{title}</div>
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
