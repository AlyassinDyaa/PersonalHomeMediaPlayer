import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork, episodeLabel, formatRuntime } from '../api.js';
import { headerPreview, brandColor } from '../branding.js';
import Player from './Player.jsx';

/**
 * The library as a browser sees it.
 *
 * Deliberately not the desktop interface at a smaller size. This is reached by
 * touch, usually one-handed, on a device that is being held rather than sat in
 * front of — so the targets are large, the rows scroll with a finger, and a
 * title opens as a sheet rather than a page that has to be navigated back out
 * of.
 */
export function WebApp() {
  const [items, setItems] = useState([]);
  const [resume, setResume] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [branding, setBranding] = useState({ name: '', colour: '' });

  const [openItem, setOpenItem] = useState(null);   // the sheet
  const [playing, setPlaying] = useState(null);     // { video, item }

  const load = useCallback(async () => {
    try {
      const [allItems, continueWatching, settings] = await Promise.all([
        api.items({ sort: 'title' }),
        api.continueWatching(),
        api.settings().catch(() => ({})),
      ]);
      setItems(allItems);
      setResume(continueWatching);
      setBranding({ name: settings.libraryName ?? '', colour: settings.libraryColor ?? '' });
      setError(null);
    } catch (failure) {
      // A browser that is not signed in is sent to the login page rather than
      // shown an error it can do nothing about.
      if (/not signed in/i.test(failure.message)) {
        window.location.href = '/login';
        return;
      }
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const movies = useMemo(() => items.filter((i) => i.kind === 'movie'), [items]);
  const shows = useMemo(() => items.filter((i) => i.kind === 'show'), [items]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return null;
    return items.filter((i) => i.title.toLowerCase().includes(trimmed));
  }, [items, query]);

  /** Open a title, loading its seasons and episodes. */
  const open = useCallback(async (entry) => {
    const item = entry.item ?? entry;
    setOpenItem({ ...item, loading: true });
    try {
      setOpenItem(await api.item(item.id));
    } catch (failure) {
      setError(failure.message);
      setOpenItem(null);
    }
  }, []);

  const play = useCallback(async (video, item) => {
    try {
      const full = await api.video(video.id);
      setPlaying({ video: { ...video, ...full }, item });
      setOpenItem(null);
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  /** Play a title straight from its tile: a film, or the next episode of a show. */
  const playItem = useCallback(async (entry) => {
    const item = entry.item ?? entry;
    const full = await api.item(item.id);
    const video = full.kind === 'movie' ? full.video : full.nextUp;
    if (video) play(video, full);
    else open(full);
  }, [play, open]);

  const colour = brandColor(branding.colour);

  if (playing) {
    return (
      <Player
        video={playing.video}
        item={playing.item}
        onClose={() => { setPlaying(null); load(); }}
      />
    );
  }

  return (
    <div className="web">
      <header className="web-head" style={{ '--brand': colour }}>
        <h1 style={{ color: colour }}>{headerPreview(branding.name)}</h1>
        <input
          className="web-search"
          type="search"
          value={query}
          placeholder="Search"
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      {error && <p className="web-error">{error}</p>}

      {loading && <div className="web-loading"><div className="spinner" /></div>}

      {!loading && results && (
        <Grid title={results.length + ' result' + (results.length === 1 ? '' : 's')}
              items={results} onPick={open} />
      )}

      {!loading && !results && (
        <>
          {resume.length > 0 && (
            <Rail
              title="Continue Watching"
              items={resume}
              wide
              onPick={(entry) => play(entry.video, entry.item)}
              caption={(entry) => (
                <>
                  <strong>{entry.item.title}</strong>
                  <span>{entry.video.episode ? episodeLabel(entry.video) : 'Resume'}</span>
                </>
              )}
            />
          )}
          <Rail title="TV Shows" items={shows} onPick={open} />
          <Rail title="Movies" items={movies} onPick={open} />
        </>
      )}

      {openItem && (
        <Sheet
          item={openItem}
          colour={colour}
          onClose={() => setOpenItem(null)}
          onPlay={play}
          onPlayItem={playItem}
        />
      )}
    </div>
  );
}

/** A finger-scrolled row of posters. */
function Rail({ title, items, onPick, wide = false, caption = null }) {
  if (!items?.length) return null;
  return (
    <section className="rail">
      <h2>{title}</h2>
      <div className="rail-scroll">
        {items.map((entry) => {
          const item = entry.item ?? entry;
          const src = artwork(wide ? item.backdrop : item.poster, wide ? 'w500' : 'w300');
          return (
            <button
              className={wide ? 'tile wide' : 'tile'}
              key={entry.video?.id ?? item.id}
              onClick={() => onPick(entry)}
            >
              {src
                ? <img src={src} alt={item.title} loading="lazy" />
                : <span className="tile-fallback">{item.title}</span>}
              {entry.progressPercent > 0 && (
                <span className="tile-progress">
                  <i style={{ width: Math.min(100, entry.progressPercent) + '%' }} />
                </span>
              )}
              {caption && <span className="tile-caption">{caption(entry)}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Grid({ title, items, onPick }) {
  return (
    <section className="rail">
      <h2>{title}</h2>
      <div className="grid">
        {items.map((item) => {
          const src = artwork(item.poster, 'w300');
          return (
            <button className="tile" key={item.id} onClick={() => onPick(item)}>
              {src
                ? <img src={src} alt={item.title} loading="lazy" />
                : <span className="tile-fallback">{item.title}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A title, opened over the library rather than replacing it. */
function Sheet({ item, colour, onClose, onPlay, onPlayItem }) {
  const [season, setSeason] = useState(() => item.nextUp?.season ?? item.seasons?.[0]?.number ?? null);
  const backdrop = artwork(item.backdrop, 'w780');
  const active = item.seasons?.find((s) => s.number === season);

  return (
    <div className="sheet" role="dialog" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="sheet-body">
        <button className="sheet-close" onClick={onClose} aria-label="Close">×</button>

        {backdrop && <img className="sheet-art" src={backdrop} alt="" />}

        <div className="sheet-text">
          <h2>{item.title}</h2>
          <p className="sheet-meta">
            {[item.year, item.certification,
              item.kind === 'movie'
                ? formatRuntime(item.runtime)
                : item.seasonCount + ' season' + (item.seasonCount === 1 ? '' : 's'),
            ].filter(Boolean).join(' · ')}
          </p>

          <button className="btn play" style={{ background: colour }}
                  onClick={() => onPlayItem(item)}>
            ▶ {item.kind === 'movie'
              ? (item.video?.position > 0 ? 'Resume' : 'Play')
              : (item.nextUp ? 'Play S' + item.nextUp.season + ' E' + item.nextUp.episode : 'Play')}
          </button>

          {item.overview && <p className="sheet-overview">{item.overview}</p>}

          {item.loading && <div className="spinner" />}

          {item.seasons?.length > 0 && (
            <>
              <div className="season-row">
                {item.seasons.map((entry) => (
                  <button
                    key={entry.number}
                    className={entry.number === season ? 'season on' : 'season'}
                    onClick={() => setSeason(entry.number)}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>

              <ul className="episodes">
                {active?.episodes.map((episode) => (
                  <li key={episode.id}>
                    <button onClick={() => onPlay(episode, item)}>
                      <span className="episode-n">{episode.episode}</span>
                      <span className="episode-name">
                        {episode.title || 'Episode ' + episode.episode}
                      </span>
                      {episode.watched && <span className="episode-done">✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default WebApp;
