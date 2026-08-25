import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork, episodeLabel, displayTitle } from './api.js';
import Hero from './components/Hero.jsx';
import Row from './components/Row.jsx';
import Card from './components/Card.jsx';
import Detail from './components/Detail.jsx';
import Browse from './components/Browse.jsx';
import Settings from './components/Settings.jsx';

/** Pluralise a count for UI labels: 1 season, 3 seasons. */
function plural(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

const VIEWS = [
  { id: 'home', label: 'Home' },
  { id: 'shows', label: 'TV Shows' },
  { id: 'movies', label: 'Movies' },
  { id: 'library', label: 'Library' },
];

export function App({ info }) {
  // Initial view can be deep-linked via the URL hash (#library).
  const [view, setView] = useState(() => {
    const fromHash = (window.location.hash || '').replace('#', '');
    return VIEWS.some((entry) => entry.id === fromHash) ? fromHash : 'home';
  });
  const [detailId, setDetailId] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  const [items, setItems] = useState([]);
  const [resume, setResume] = useState([]);
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scrolled, setScrolled] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [allItems, continueWatching, genreList] = await Promise.all([
        api.items({ sort: 'title' }),
        api.continueWatching(),
        api.genres(),
      ]);
      setItems(allItems);
      setResume(continueWatching);
      setGenres(genreList);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Refresh progress-driven rows when the player closes.
  useEffect(() => {
    if (!window.media?.onPlayerClosed) return undefined;
    return window.media.onPlayerClosed(() => { reload(); });
  }, [reload]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Debounced search.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setResults([]); return undefined; }
    const timer = setTimeout(() => {
      api.search(trimmed).then(setResults).catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const movies = useMemo(() => items.filter((item) => item.kind === 'movie'), [items]);
  const shows = useMemo(() => items.filter((item) => item.kind === 'show'), [items]);

  const featured = useMemo(() => {
    const withArt = items.filter((item) => item.backdrop && item.overview);
    if (!withArt.length) return items[0] ?? null;
    // Stable per session rather than per render, so it does not flicker.
    const index = Math.floor((Date.now() / 60000) % withArt.length);
    return withArt[index];
  }, [items]);

  const recentlyAdded = useMemo(
    () => [...items].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 24),
    [items],
  );

  const topRated = useMemo(
    () => [...items].filter((i) => i.rating > 0).sort((a, b) => b.rating - a.rating).slice(0, 24),
    [items],
  );

  /** Start playback of a specific video through the main process. */
  const play = useCallback(async (video, item) => {
    if (!window.media?.play) {
      setError('Playback is only available in the desktop app.');
      return;
    }
    try {
      const full = await api.video(video.id);
      const label = displayTitle(item, { ...video, title: full.title });

      const response = await window.media.play({
        filePath: full.path,
        videoId: full.id,
        startPosition: full.position > 30 ? full.position : 0,
        subtitleFiles: full.subtitles.map((subtitle) => subtitle.path),
        title: label,
      });
      if (!response?.ok) setError(response?.error ?? 'Playback failed');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  /** Play from an item tile: movies play directly, shows play their next episode. */
  const playItem = useCallback(async (item) => {
    const full = await api.item(item.id);
    const video = full.kind === 'movie' ? full.video : full.nextUp;
    if (video) play(video, full);
    else setDetailId(item.id);
  }, [play]);

  const openDetail = useCallback((entry) => {
    const item = entry.item ?? entry;
    setDetailId(item.id);
    window.scrollTo(0, 0);
  }, []);

  const goto = (next) => {
    setView(next);
    setDetailId(null);
    setQuery('');
    window.location.hash = next;
    window.scrollTo(0, 0);
  };

  if (detailId) {
    return (
      <>
        <Nav view={view} goto={goto} query={query} setQuery={setQuery} scrolled />
        <Detail itemId={detailId} onBack={() => setDetailId(null)} onPlay={play} />
      </>
    );
  }

  return (
    <>
      <Nav view={view} goto={goto} query={query} setQuery={setQuery} scrolled={scrolled} />

      {info && info.mpvAvailable === false && (
        <div className="banner">
          mpv was not found, so playback is disabled. Install mpv, or set <code>mpvPath</code> in config.json.
        </div>
      )}
      {error && <div className="banner">{error}</div>}

      {loading && <div className="center-note"><div className="spinner" /><p>Loading your library…</p></div>}

      {!loading && query.trim() && (
        <>
          <div className="page-header">
            <h1 className="page-title">Results</h1>
            <span className="page-sub">{results.length} for “{query.trim()}”</span>
          </div>
          <div className="grid">
            {results.map((item) => (
              <Card key={item.id} item={item} onClick={() => openDetail(item)}
                    label={<><strong>{item.title}</strong>{item.year}</>} />
            ))}
          </div>
        </>
      )}

      {!loading && !query.trim() && view === 'home' && items.length === 0 && (
        <>
          <div className="page-header">
            <h1 className="page-title">Welcome</h1>
            <span className="page-sub">Add the folder holding your movies and shows to get started</span>
          </div>
          <Settings onScanned={reload} />
        </>
      )}

      {!loading && !query.trim() && view === 'home' && items.length > 0 && (
        <>
          <Hero item={featured} onPlay={playItem} onDetails={openDetail} />
          <div className="rows">
            <Row
              title="Continue Watching"
              items={resume}
              wide
              onSelect={(entry) => play(entry.video, entry.item)}
              renderLabel={(entry) => (
                <>
                  <strong>{entry.item.title}</strong>
                  {entry.video.episode ? episodeLabel(entry.video) : 'Resume'}
                </>
              )}
            />
            <Row title="Recently Released" items={recentlyAdded} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.year}</>} />
            <Row title="TV Shows" items={shows} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{plural(item.seasonCount, 'season')}</>} />
            <Row title="Movies" items={movies} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.year}</>} />
            <Row title="Top Rated" items={topRated} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.rating?.toFixed(1)}</>} />

            {genres.slice(0, 8).map((genre) => {
              const inGenre = items.filter((item) => item.genres.includes(genre.name));
              if (inGenre.length < 3) return null;
              return (
                <Row key={genre.name} title={genre.name} items={inGenre} onSelect={openDetail}
                     renderLabel={(item) => <><strong>{item.title}</strong>{item.year}</>} />
              );
            })}
          </div>
        </>
      )}

      {!loading && !query.trim() && view === 'library' && (
        <Settings onScanned={reload} />
      )}

      {!loading && !query.trim() && (view === 'movies' || view === 'shows') && (
        <Browse
          title={view === 'movies' ? 'Movies' : 'TV Shows'}
          items={view === 'movies' ? movies : shows}
          onSelect={openDetail}
          renderLabel={(item) => (
            <>
              <strong>{item.title}</strong>
              {item.kind === 'show' ? plural(item.episodeCount, 'episode') : item.year}
            </>
          )}
        />
      )}
    </>
  );
}

function Nav({ view, goto, query, setQuery, scrolled }) {
  return (
    <nav className={scrolled ? 'nav scrolled' : 'nav'}>
      <div className="nav-brand">MY LIBRARY</div>
      <div className="nav-links">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            className={view === entry.id ? 'nav-link active' : 'nav-link'}
            onClick={() => goto(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="nav-spacer" />
      <div className="search-box">
        <span style={{ opacity: 0.5 }}>⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles"
          spellCheck={false}
        />
      </div>
    </nav>
  );
}

export default App;
