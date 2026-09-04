import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork, episodeLabel, displayTitle, formatRuntime } from './api.js';
import Hero from './components/Hero.jsx';
import Row from './components/Row.jsx';
import Card from './components/Card.jsx';
import Detail from './components/Detail.jsx';
import Browse from './components/Browse.jsx';
import Comics from './components/Comics.jsx';
import ComicReader from './components/ComicReader.jsx';
import { shelveByGenre } from './genres.js';
import BrandRail from './components/BrandRail.jsx';
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
  { id: 'comics', label: 'Comics' },
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
  /** The comic open in the reader, which covers everything else. */
  const [readingComic, setReadingComic] = useState(null);
  const [query, setQuery] = useState('');

  const [items, setItems] = useState([]);
  const [resume, setResume] = useState([]);
  const [favourites, setFavourites] = useState([]);
  const [genres, setGenres] = useState([]);
  /** Shelves the user arranged by hand, in Settings. */
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  /** Whether each screen arranges titles by genre; set in Settings. */
  const [grouping, setGrouping] = useState({ movies: true, shows: true });
  /** Whether the Comics tab is offered; set in Settings. */
  const [showComics, setShowComics] = useState(true);
  const [libraryName, setLibraryName] = useState('');
  const [libraryColor, setLibraryColor] = useState('');

  const reload = useCallback(async () => {
    try {
      const [allItems, continueWatching, kept, genreList, settings, shelves] = await Promise.all([
        api.items({ sort: 'title' }),
        api.continueWatching(),
        api.favourites(),
        api.genres(),
        api.settings().catch(() => ({})),
        // A library with no collections is the normal case, not a failure.
        api.collectionShelves().catch(() => []),
      ]);
      setLibraryName(settings.libraryName ?? '');
      setLibraryColor(settings.libraryColor ?? '');
      setGrouping({
        movies: settings.groupMoviesByGenre ?? true,
        shows: settings.groupShowsByGenre ?? true,
      });
      setShowComics(settings.showComics !== false);
      setItems(allItems);
      setResume(continueWatching);
      setFavourites(kept);
      setGenres(genreList);
      setCollections(shelves);
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

  /*
   * Catch up whenever this window is looked at again.
   *
   * The library is one thing seen from several places: a film watched on the
   * tablet moves in Continue Watching, and the computer should not still be
   * showing yesterday's row when it is next glanced at. Refreshing on focus
   * covers that without holding a connection open or polling a library that is
   * usually sitting idle.
   *
   * Throttled, because switching windows is something people do constantly and
   * the row does not change that fast.
   */
  useEffect(() => {
    let lastAt = Date.now();
    const QUIET_MS = 15_000;

    const catchUp = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastAt < QUIET_MS) return;
      lastAt = now;
      reload();
    };

    window.addEventListener('focus', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      window.removeEventListener('focus', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [reload]);

  /**
   * Drop a title from Continue Watching.
   *
   * Removed from the row first and reconciled afterwards: the row is the thing
   * being dismissed, so it has to respond at once, and a failed request puts
   * the title back rather than leaving the row lying about what was kept.
   */
  const forgetProgress = useCallback(async (entry) => {
    const itemId = entry.item.id;
    const previous = resume;
    setResume((current) => current.filter((row) => row.item.id !== itemId));
    try {
      await api.removeFromContinue(itemId);
    } catch (err) {
      setResume(previous);
      setError(err.message);
    }
  }, [resume]);

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



  /**
   * The tabs on offer.
   *
   * Comics can be turned off in Settings, and a view already open on it
   * falls back to Home rather than leaving a tab selected that is no longer
   * in the strip.
   */
  const tabs = useMemo(
    () => VIEWS.filter((entry) => entry.id !== 'comics' || showComics),
    [showComics],
  );

  useEffect(() => {
    if (!showComics && view === 'comics') setView('home');
  }, [showComics, view]);

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

  /* Declared above the banner, which reads it to decide whether to rotate. */
  const [openCategory, setOpenCategory] = useState(null);

  /*
   * The handful of titles the banner rotates through.
   *
   * Needs a backdrop and a description to fill the space, and is sorted by
   * rating so the largest thing on screen is something worth showing. Titles
   * with a logo are preferred — the banner is built around one — but only
   * while there are enough of them to rotate through.
   */
  const heroPicks = useMemo(() => {
    const withArt = items.filter((item) => item.backdrop && item.overview);
    const withLogo = withArt.filter((item) => item.logo);
    const pool = withLogo.length >= 5 ? withLogo : withArt;
    return [...pool]
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 10);
  }, [items]);

  const [heroIndex, setHeroIndex] = useState(0);

  // A rescan can shorten the list under us; start again rather than point past
  // the end of it.
  useEffect(() => { setHeroIndex(0); }, [heroPicks]);

  /*
   * Move along every twelve seconds.
   *
   * Only while the banner is actually on screen: rotating behind a detail page
   * or a category would mean returning to a home screen that had silently
   * changed underneath you.
   */
  useEffect(() => {
    const visible = view === 'home' && !openCategory && !detailId && !query.trim();
    if (!visible || heroPicks.length < 2) return undefined;

    const timer = setInterval(
      () => setHeroIndex((index) => (index + 1) % heroPicks.length),
      12000,
    );
    return () => clearInterval(timer);
  }, [heroPicks, view, openCategory, detailId, query]);

  const featured = heroPicks[heroIndex] ?? heroPicks[0] ?? items[0] ?? null;

  const recentlyAdded = useMemo(
    () => [...items].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 24),
    [items],
  );

  /**
   * The genre rails on the home page.
   *
   * Short shelves are left out rather than shown as a rail of one or two, and
   * only the largest handful are kept, because the page already carries
   * Continue Watching, Your List and the rest above them.
   */
  const genreRails = useMemo(
    () => shelveByGenre(items).filter((rail) => rail.entries.length >= 3).slice(0, 8),
    [items],
  );

  /*
   * Universes: DC, Marvel and the rest, worked out from the titles.
   *
   * Computed over everything rather than per kind, so a universe tile covers
   * both its films and its shows — which is how somebody thinks about them.
   */
  /*
   * Badged shelves are the ones with a logo on them.
   *
   * These used to be worked out from the titles, and it did real damage:
   * Pixar's patterns took "Batman: The Brave and the Bold", "Captain America:
   * Brave New World" and "Guns Up" — three titles from three different places,
   * none of them Pixar — and because Pixar was listed first it took them off
   * the shelves where they belonged. No pattern list survives contact with a
   * real library. A shelf is now something a person made and named.
   */
  const badged = useMemo(
    () => collections.filter((collection) => collection.logo),
    [collections],
  );

  // A category stops existing when the library is rescanned into a different
  // shape, and a screen showing a shelf that is no longer there is a dead end.
  useEffect(() => {
    if (!openCategory) return;
    const still = collections.some((entry) => entry.id === openCategory.id);
    if (!still) setOpenCategory(null);
  }, [collections, openCategory]);

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

  /** Open a comic, fetching what the reader needs to step through a series. */
  const readComic = useCallback((issue) => {
    const id = typeof issue === "string" ? issue : issue.id;
    api.comicIssue(id)
      .then(setReadingComic)
      // Without the neighbours the reader still works, just without
      // "next issue" at the end.
      .catch(() => setReadingComic(typeof issue === "string" ? null : issue));
  }, []);

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
    const at = tabs.findIndex((entry) => entry.id === view);
    const next = tabs[at + direction];
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

  /*
   * A comic being read takes the whole screen and nothing else is drawn.
   *
   * Keyed on the issue so moving to the next one starts the reader afresh
   * rather than leaving the previous comic's page number behind.
   */
  if (readingComic) {
    return (
      <ComicReader
        key={readingComic.id}
        issue={readingComic}
        onClose={() => setReadingComic(null)}
        onOpenIssue={readComic}
      />
    );
  }

  if (detailId) {
    return (
      <>
        <Nav view={view} goto={goto} query={query} setQuery={setQuery} tabs={tabs} scrolled
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
      <Nav view={view} goto={goto} query={query} setQuery={setQuery} tabs={tabs} scrolled={scrolled}
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

      {/* One category, opened from a tile. */}
      {!loading && view === 'home' && openCategory && (
        <Browse
          title={openCategory.name}
          items={openCategory.items}
          onSelect={openDetail}
          renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>}
          query={query}
          groupByGenre={false}
          onBack={() => setOpenCategory(null)}
        />
      )}

      {!loading && !query.trim() && !openCategory && view === 'home' && items.length > 0 && (
        <>
          <Hero
            item={featured}
            onPlay={playItem}
            onDetails={openDetail}
            dots={{
              count: heroPicks.length,
              index: heroIndex,
              onSelect: setHeroIndex,
            }}
          />
          <div className="rows">
            <Row
              title="Continue Watching"
              items={resume}
              wide
              onSelect={(entry) => play(entry.video, entry.item)}
              onRemove={forgetProgress}
              renderLabel={(entry) => (
                <>
                  <strong>{entry.item.title}</strong>
                  {entry.video.episode ? episodeLabel(entry.video) : 'Resume'}
                </>
              )}
            />
            <Row title="Your List" items={favourites} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            {/*
              * The user's own shelves, above everything the library worked out
              * for itself. Somebody who took the trouble to arrange a shelf
              * means it more than any genre we inferred.
              */}
            {collections.filter((entry) => !entry.logo).map((collection) => (
              <Row key={collection.id} title={collection.name} items={collection.items}
                   onSelect={openDetail}
                   renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            ))}
            <Row title="Recently Released" items={recentlyAdded} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />

            {/*
              * Universes as tiles, and the two kinds beside them.
              *
              * These were three more rails of posters in a screen already made
              * of rails, so nothing stood out and the shelves below were never
              * reached. As tiles they read as places rather than as more of the
              * same, and DC and Marvel say far more about this library than
              * "Animation" ever did.
              */}
            {/*
              * The shelves you badged, as a rail of logos — the row of
              * providers people already know from streaming apps. Only
              * collections with a logo appear here; the rest keep an ordinary
              * poster rail lower down, so badging one is how you promote it.
              */}
            <BrandRail title="Collections" categories={badged} onOpen={setOpenCategory} />

            <Row title="TV Shows" items={shows} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="Movies" items={movies} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="Top Rated" items={topRated} onSelect={openDetail}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.rating?.toFixed(1)}</>} />

            {/*
              * Genre rails, each title on one shelf only.
              *
              * These used to list every title carrying the genre, so the same
              * show appeared under Action, then Adventure, then Animation —
              * three rails deep in the same posters. Each title now sits under
              * whichever of its genres is rarest in the library, which is both
              * the more telling shelf and the one that stops the repetition.
              */}
            <BrandRail
              title="Genres"
              categories={genreRails.map((rail) => ({
                id: 'genre-' + rail.name, name: rail.name, items: rail.entries,
              }))}
              onOpen={setOpenCategory}
            />
          </div>
        </>
      )}

      {!loading && view === 'comics' && (
        <Comics onRead={readComic} query={query} />
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
          groupByGenre={view === 'movies' ? grouping.movies : grouping.shows}
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

function Nav({ view, goto, query, setQuery, scrolled, brand, brandColor, tabs }) {
  /*
   * On a phone the sections live behind a button.
   *
   * Four labels and a search box do not fit across 375 pixels — laid out in a
   * row they were clipped mid-word, and scrolling them sideways hides the very
   * choices the bar exists to offer. A menu shows all of them at a size worth
   * tapping, and gives the search box the width it needs.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  // Going somewhere closes the menu; leaving it open over the new page would
  // mean two taps to read anything.
  const visit = (id) => { setMenuOpen(false); goto(id); };

  return (
    <nav className={scrolled ? 'nav scrolled' : 'nav'}>
      <button
        className="nav-burger"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? '✕' : '☰'}
      </button>

      <div className="nav-brand" title={brand} style={{ color: brandColor }}>{brand}</div>
      {/* On a phone the bar names the section, since the links are hidden. */}
      <div className="nav-section">{tabs.find((entry) => entry.id === view)?.label}</div>
      <div className="nav-links">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={view === entry.id ? 'nav-link active' : 'nav-link'}
            onClick={() => goto(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {menuOpen && (
        <>
          {/* Tapping the page behind it is the ordinary way out of a menu. */}
          <div className="nav-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="nav-menu">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                className={view === entry.id ? 'nav-menu-link active' : 'nav-menu-link'}
                onClick={() => visit(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      )}
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
