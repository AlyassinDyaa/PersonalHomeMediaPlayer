import React, { useCallback, useState } from 'react';
import App from '../App.jsx';
import Player from './Player.jsx';

/**
 * The library in a browser.
 *
 * Deliberately thin. The interface is the same App the desktop window runs, so
 * a tablet gets the real thing — the same tabs, rows, artwork and detail pages
 * — rather than a cut-down version that drifts out of step with it. All this
 * adds is the part a browser has to do differently: playing the video in the
 * page instead of handing it to mpv.
 */
export function WebApp({ info }) {
  const [playing, setPlaying] = useState(null);
  // Bumped when the player closes, so what was just watched moves to the front
  // of Continue Watching without reloading the whole page.
  const [watched, setWatched] = useState(0);

  const onPlayVideo = useCallback((video, item) => {
    setPlaying({ video, item });
  }, []);

  const close = useCallback(() => {
    setPlaying(null);
    setWatched((count) => count + 1);
  }, []);

  return (
    <>
      <App info={info} onPlayVideo={onPlayVideo} refreshSignal={watched} />
      {playing && (
        <Player video={playing.video} item={playing.item} onClose={close} />
      )}
    </>
  );
}

export default WebApp;
