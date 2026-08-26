import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork, episodeLabel, displayTitle, formatRuntime } from './api.js';
import Hero from './components/Hero.jsx';
import Row from './components/Row.jsx';
import Card from './components/Card.jsx';
import Detail from './components/Detail.jsx';
import Browse from './components/Browse.jsx';
import Settings from './components/Settings.jsx';
import { headerPreview, brandColor } from './branding.js';
import { useSwipe } from './useSwipe.js';

/** Pluralise a count for UI labels: 1 season, 3 seasons. */
function plural(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

/** Secondary line under a poster: seasons for a show, year and length for a film. */
function cardMeta(item) {
  if (item.kind === 'show') return plural(item.seasonCount, 'season');
  return [item.year, formatRuntime(item.runtime)].filter(Boolean).join(' · ');
}

const VIEWS = [
  { id: 'home', label: 'Home' },
  { id: 'shows', label: 'TV Shows' },
  { id: 'movies', label: 'Movies' },
  { id: 'library', label: 'Library' },
];

/**
 * The library.
 *
 * The same component serves the desktop window and a browser on the network, so
 * a tablet gets the real interface rather than a reduced one. Only playback
 * differs: the desktop app hands the file to mpv, a browser plays it in the
 * page, and onPlayVideo is how that is supplied.
 */
export function App({ info, onPlayVideo = null, refreshSignal = 0 }) {
  // Initial view can be deep-linked via the URL hash (#library).
  const [view, setView] = useState(() => {
    const fromHash = (window.location.hash || '').replace('#', '').split('/')[0];
    return VIEWS.some((entry) => entry.id === fromHash) ? fromHash : 'home';
  });
  const [detailId, setDetailId] = useState(null);
  const [query, setQuery] = useState('');

  const [items, setItems] = useState([]);
  const [resume, setResume] = useState([]);
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  const [libraryName, setLibraryName] = useState('');
  const [libraryColor, setLibraryColor] = useState('');

  const reload = useCallback(async () => {
    try {
      const [allItems, continueWatching, genreList, settings] = await Promise.all([
        api.items({ sort: 'title' }),
        api.continueWatching(),
        api.genres(),
        api.settings().catch(() => ({})),
      ]);
      setLibraryName(settings.libraryName ?? '');
      setLibraryColor(settings.libraryColor ?? '');
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

  // Something finished playing elsewhere in the app; pick up where it got to
  // rather than reloading the page and losing the reader's place.
  useEffect(() => {
    if (refreshSignal) reload();
  }, [refreshSignal, reload]);

  /** Reflect a settings change in the header without waiting for a reload. */
  const applyBranding = useCallback((next) => {
    setLibraryName(next.libraryName ?? '');
    setLibraryColor(next.libraryColor ?? '');
  }, []);


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



  const searchable = view === 'movies' ? 'movie' : view === 'shows' ? 'show' : null;

  /** Titles matching the header search, scoped to the tab that is open. */
  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return items
      .filter((item) => !searchable || item.kind === searchable)
      .filter((item) => item.title.toLowerCase().includes(trimmed))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [items, query, searchable, view]);

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

  /**
   * Start playback. For a show, everything from the chosen episode onward is
   * handed to the player as a queue so it can advance on its own; entries carry
   * only an id and a title, and their file paths resolve as each one starts.
   */
  const play = useCallback(async (video, item) => {
    try {
      const full = await api.video(video.id);

      // In a browser the page plays the video itself. There is no queue: the
      // file is streamed on demand, so the next episode is started when it is
      // asked for rather than handed over in advance.
      if (onPlayVideo) {
        onPlayVideo({ ...video, ...full }, item);
        return;
      }
      if (!window.media?.play) {
        setError('Playback is only available in the desktop app.');
        return;
      }

      const episodes = (item.seasons ?? [])
        .flatMap((season) => season.episodes)
        .filter((entry) => entry.id);
      const startIndex = episodes.findIndex((entry) => entry.id === video.id);

      const queue = startIndex >= 0
        ? episodes.slice(startIndex).map((entry) => ({
            videoId: entry.id,
            title: displayTitle(item, entry),
          }))
        : [{ videoId: full.id, title: displayTitle(item, { ...video, title: full.title }) }];

      const response = await window.media.play({
        videoId: full.id,
        filePath: full.path,
        title: displayTitle(item, { ...video, title: full.title }),
        subtitleFiles: full.subtitles.map((subtitle) => subtitle.path),
        startPosition: full.position > 30 ? full.position : 0,
        queue,
      });
      if (!response?.ok) setError(response?.error ?? 'Playback failed');
    } catch (err) {
      setError(err.message);
    }
  }, [onPlayVideo]);

  /** Play from an item tile: movies play directly, shows play their next episode. */
  const playItem = useCallback(async (item) => {
    const full = await api.item(item.id);
    const video = full.kind === 'movie' ? full.video : full.nextUp;
    if (video) play(video, full);
    else setDetailId(item.id);
  }, [play]);

  /**
   * A `#play/<itemId>` hash starts that title once the library has loaded.
   *
   * Makes a desktop shortcut that resumes a specific show possible, and lets
   * playback be driven without clicking through the UI.
   */
  useEffect(() => {
    if (loading || items.length === 0) return;
    const hash = window.location.hash || '';
    const marker = '#play/';
    if (!hash.startsWith(marker)) return;

    const wanted = hash.slice(marker.length);
    window.location.hash = '';
    const target = items.find((entry) => entry.id === wanted);
    if (target) playItem(target);
  }, [loading, items, playItem]);

  const openDetail = useCallback((entry) => {
    const item = entry.item ?? entry;
    setDetailId(item.id);
    window.scrollTo(0, 0);
  }, []);

  /**
   * Swiping left and right moves along the tabs, and swiping right out of a
   * title goes back to where it was opened from — the gesture a tablet expects
   * where a desktop would reach for the Back button.
   */
  const step = (direction) => {
    const at = VIEWS.findIndex((entry) => entry.id === view);
    const next = VIEWS[at + direction];
    if (next) goto(next.id);
  };

  const swipe = useSwipe({
    onLeft: () => { if (!detailId) step(1); },
    onRight: () => {
      if (detailId) setDetailId(null);
      else step(-1);
    },
  });

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
        <Nav view={view} goto={goto} query={query} setQuery={setQuery} scrolled
             brand={headerPreview(libraryName)} brandColor={brandColor(libraryColor)} />
        {/* Keyed so moving between titles replays the entrance rather than
            swapping content in place, which reads as a jump. */}
        <div className="view" key={detailId} {...swipe}>
          <Detail
            itemId={detailId}
            onBack={() => setDetailId(null)}
            onPlay={play}
            library={items}
            onSelect={openDetail}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Nav view={view} goto={goto} query={query} setQuery={setQuery} scrolled={scrolled}
           brand={headerPreview(libraryName)} brandColor={brandColor(libraryColor)} />

      <div className="view" key={view + (query.trim() ? ':search' : '')} {...swipe}>

      {/* Only worth saying on the computer that would be running mpv. A
          browser plays the video itself and has no use for the advice. */}
      {info && info.mpvAvailable === false && !onPlayVideo && (
        <div className="banner">
          mpv was not found, so playback is disabled. Install mpv, or set <code>mpvPath</code> in config.json.
        </div>
      )}
      {error && <div className="banner">{error}</div>}

      {loading && <div className="center-note"><div className="spinner" /><p>Loading your library…</p></div>}

      {!loading && view === 'home' && query.trim() && (
        <>
          <div className="page-header">
            <h1 className="page-title">Results</h1>
            <span className="page-sub">{results.length} for “{query.trim()}”</span>
          </div>
          <div className="grid">
            {results.map((item) => (
              <Card key={item.id} item={item} onClick={() => openDetail(item)}
                    label={<><strong>{item.title}</strong>{cardMeta(item)}</>} />
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
          <Settings onScanned={reload} onSettingsChanged={applyBranding} />
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
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="TV Shows" items={shows} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="Movies" items={movies} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="Top Rated" items={topRated} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.rating?.toFixed(1)}</>} />

            {genres.slice(0, 8).map((genre) => {
              const inGenre = items.filter((item) => item.genres.includes(genre.name));
              if (inGenre.length < 3) return null;
              return (
                <Row key={genre.name} title={genre.name} items={inGenre} onSelect={openDetail}
                     renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
              );
            })}
          </div>
        </>
      )}

      {!loading && view === 'library' && (
        <Settings onScanned={reload} onSettingsChanged={applyBranding} />
      )}

      {!loading && (view === 'movies' || view === 'shows') && (
        <Browse
          title={view === 'movies' ? 'Movies' : 'TV Shows'}
          items={view === 'movies' ? movies : shows}
          onSelect={openDetail}
          query={query}
          renderLabel={(item) => (
            <>
              <strong>{item.title}</strong>
              {cardMeta(item)}
            </>
          )}
        />
      )}
      </div>
    </>
  );
}

const SEARCH_PLACEHOLDER = {
  home: 'Search your library',
  movies: 'Search movies',
  shows: 'Search TV shows',
  library: 'Search your library',
};

function Nav({ view, goto, query, setQuery, scrolled, brand, brandColor }) {
  return (
    <nav className={scrolled ? 'nav scrolled' : 'nav'}>
      <div className="nav-brand" title={brand} style={{ color: brandColor }}>{brand}</div>
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
      {view !== 'library' && (
      <div className="search-box">
        <span style={{ opacity: 0.5 }}>⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={SEARCH_PLACEHOLDER[view] ?? 'Search titles'}
          spellCheck={false}
        />
        {query && (
          <button className="clear-btn" onClick={() => setQuery('')} aria-label="Clear search">×</button>
        )}
      </div>
      )}
    </nav>
  );
}

export default App;
