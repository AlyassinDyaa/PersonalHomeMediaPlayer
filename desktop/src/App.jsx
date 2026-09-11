import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork, episodeLabel, displayTitle, formatRuntime, formatYears } from './api.js';
import Hero from './components/Hero.jsx';
import Row from './components/Row.jsx';
import Card from './components/Card.jsx';
import Detail from './components/Detail.jsx';
import Browse from './components/Browse.jsx';
import Comics from './components/Comics.jsx';
import Lists from './components/Lists.jsx';
import Mosaic from './components/Mosaic.jsx';
import SectionView from './components/SectionView.jsx';
import ComicReader from './components/ComicReader.jsx';
import { shelveByGenre } from './genres.js';
import { applyBackground } from './backgrounds.js';
import { applyShelfStyle, applyCardSize } from './shelfStyles.js';
import { applyRailStyle } from './railStyles.js';
import { leaveProfile } from './leave.js';
import Confirm from './components/Confirm.jsx';
import BrandRail from './components/BrandRail.jsx';
import ProfileFace from './components/ProfileFace.jsx';
import Settings from './components/Settings.jsx';
import SearchScreen from './components/SearchScreen.jsx';
import Skeleton from './components/Skeleton.jsx';
import { headerPreview, brandColor } from './branding.js';
import { rememberArrivals, isRecent } from './recent.js';
import { pickHeroes, rememberHeroes } from './hero.js';
import { useSwipe } from './useSwipe.js';
import { usePull, bothGestures } from './usePull.js';
import { useRemote } from './useRemote.js';
import { flyFrom } from './flight.js';

/** Pluralise a count for UI labels: 1 season, 3 seasons. */
function plural(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

/** Secondary line under a poster: seasons for a show, year and length for a film. */
/**
 * How much of something is left, in minutes.
 *
 * Nothing when it has barely been started, because "58 min left" of a
 * sixty-minute film says only that it has not been watched, and the row it
 * sits on already says that.
 */
function timeLeft(entry) {
  const total = entry.video?.duration ?? 0;
  const at = entry.video?.position ?? 0;
  if (!total || at <= 0) return null;
  const left = Math.round((total - at) / 60);
  if (left <= 0) return 'Nearly done';
  if (left > 180) return null;
  return left + ' min left';
}

function cardMeta(item) {
  if (item.kind === 'show') {
    /* When it ran, then how much of it there is. */
    return [formatYears(item), plural(item.seasonCount, 'season')]
      .filter(Boolean).join(' · ');
  }
  return [item.year, formatRuntime(item.runtime)].filter(Boolean).join(' · ');
}

/*
 * Where you can go, and the mark each place is known by.
 *
 * The glyphs are only drawn in the bar along the bottom of a phone, where
 * there is room for a symbol and a word but not for a word alone at a size
 * worth tapping.
 */
const VIEWS = [
  { id: 'home', label: 'Home', glyph: '◫' },
  { id: 'shows', label: 'TV Shows', glyph: '▦' },
  { id: 'movies', label: 'Movies', glyph: '▶' },
  { id: 'comics', label: 'Comics', glyph: '❐' },
  { id: 'family', label: 'Family', glyph: '⌂' },
  { id: 'artwork', label: 'Artwork', glyph: '▨' },
  { id: 'lists', label: 'My Lists', glyph: '☆' },
  { id: 'library', label: 'Library', glyph: '⚙' },
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
  /* What this profile means to get to: titles, and runs of comics. */
  const [watchlist, setWatchlist] = useState({ items: [], comics: [] });
  /* Started and set aside, kept off Continue Watching. */
  const [backlog, setBacklog] = useState([]);
  /* A run of comics the Lists page asked to have opened, once on Comics. */
  const [comicSeries, setComicSeries] = useState(null);
  /*
   * The sections this profile may see.
   *
   * Asked of the server rather than worked out here: whether a section is
   * switched on is the owner's business and whether this person is in it is
   * theirs, and neither is something the app should be deciding for itself.
   * Null until the answer arrives, so nothing flickers into view first.
   */
  const [mySections, setMySections] = useState(null);
  const [genres, setGenres] = useState([]);
  /** Shelves the user arranged by hand, in Settings. */
  const [collections, setCollections] = useState([]);
  /*
   * Every shelf, including the empty ones.
   *
   * The rails above are only the shelves worth drawing — an empty one is a
   * gap on the page rather than information. But a shelf just made is empty
   * by definition, and filling it is the first thing anybody does, so the
   * list to add to has to be the whole list.
   */
  const [allShelves, setAllShelves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  /* Far enough down a title's page that the banner is gone from the screen. */
  const [pastBanner, setPastBanner] = useState(false);
  /** Whether each screen arranges titles by genre; set in Settings. */
  const [grouping, setGrouping] = useState({ movies: true, shows: true });
  /** Whether the Comics tab is offered; set in Settings. */
  const [showComics, setShowComics] = useState(true);
  /** Which collection layouts the owner offers; null until settings arrive. */
  const [shelfLayouts, setShelfLayouts] = useState(null);
  /** Whether the home screen also shelves titles by genre; set in Settings. */
  const [genreShelves, setGenreShelves] = useState(true);
  /** Who is watching, shown in the bar so it is never a guess. */
  const [me, setMe] = useState(null);
  const [libraryName, setLibraryName] = useState('');
  const [libraryColor, setLibraryColor] = useState('');
  /* What sits behind the library, chosen by whoever looks after it. */
  const [background, setBackground] = useState('flat');
  /* Empty means the backdrop follows whatever artwork is on screen. */
  const [backgroundColor, setBackgroundColor] = useState('');
  /* How every row of covers is drawn: plain, on a ledge, in glass, and so on. */
  const [shelfStyle, setShelfStyle] = useState('plain');
  const [shelfRow, setShelfRow] = useState('none');
  const [shelfColor, setShelfColor] = useState('');
  const [shelfStrength, setShelfStrength] = useState(50);
  /* What the sidebar is made of. */
  const [railStyle, setRailStyle] = useState('glass');
  const [railOpacity, setRailOpacity] = useState(45);
  const [cardSize, setCardSize] = useState('medium');
  const [backgroundStrength, setBackgroundStrength] = useState(100);

  const reload = useCallback(async () => {
    try {
      const [allItems, continueWatching, kept, genreList, settings, shelves, everyShelf, later, aside] = await Promise.all([
        api.items({ sort: 'title' }),
        api.continueWatching(),
        api.favourites(),
        api.genres(),
        api.settings().catch(() => ({})),
        // A library with no collections is the normal case, not a failure.
        api.collectionShelves().catch(() => []),
        api.collections().catch(() => []),
        api.watchlist().catch(() => ({ items: [], comics: [] })),
        api.backlog().catch(() => []),
      ]);
      setLibraryName(settings.libraryName ?? '');
      setLibraryColor(settings.libraryColor ?? '');
      setBackground(settings.background ?? 'flat');
      setBackgroundColor(settings.backgroundColor ?? '');
      setShelfStyle(settings.shelfStyle ?? 'plain');
      setShelfRow(settings.shelfRow ?? 'none');
      setShelfColor(settings.shelfColor ?? '');
      setShelfStrength(settings.shelfStrength ?? 50);
      setRailStyle(settings.railStyle ?? 'glass');
      setRailOpacity(settings.railOpacity ?? 45);
      setCardSize(settings.cardSize ?? 'medium');
      setBackgroundStrength(settings.backgroundStrength ?? 100);
      setGrouping({
        movies: settings.groupMoviesByGenre ?? true,
        shows: settings.groupShowsByGenre ?? true,
      });
      setShowComics(settings.showComics !== false);
      setShelfLayouts(Array.isArray(settings.shelfLayouts) ? settings.shelfLayouts : null);
      setGenreShelves(settings.genreShelves !== false);
      setItems(allItems);
      // What counts as newly arrived depends on the rest of the library, so
      // it is worked out again whenever the library changes.
      rememberArrivals(allItems);
      setResume(continueWatching);
      setFavourites(kept);
      setWatchlist({ items: later?.items ?? [], comics: later?.comics ?? [] });
      setBacklog(Array.isArray(aside) ? aside : []);
      api.sections()
        .then((answer) => setMySections((answer.sections ?? [])
          /*
           * Switched on, as well as permitted.
           *
           * The owner is sent every section whether or not it is on, because
           * the Settings page has to draw the switches — so the list that
           * decides which icons appear has to read that flag rather than
           * assume being sent a section means having it. Everybody else is
           * sent only what they have, and those entries carry no flag, which
           * is why this asks whether it is false rather than whether it is true.
           */
          .filter((entry) => entry.on !== false)
          .map((entry) => entry.id)))
        .catch(() => setMySections([]));
      setGenres(genreList);
      setCollections(shelves);
      setAllShelves(everyShelf);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Who is watching, for the bar. Its own request because it changes for
  // reasons the library does not: switching profile, or editing a picture.
  useEffect(() => {
    let alive = true;
    api.profiles()
      .then((body) => { if (alive) setMe(body.current ?? null); })
      .catch(() => { if (alive) setMe(null); });
    return () => { alive = false; };
  }, [refreshSignal]);

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

  /**
   * Reflect a settings change in the header without waiting for a reload.
   *
   * Tolerates being handed nothing. It is the callback anything in Settings
   * reaches for when it wants to say "something changed", and one of those
   * callers had nothing to say — which threw, and put an error across the
   * Collections page every time a shelf was made.
   */
  const applyBranding = useCallback((next) => {
    if (!next) return;
    setLibraryName(next.libraryName ?? '');
    setLibraryColor(next.libraryColor ?? '');
    setBackground(next.background ?? 'flat');
    setBackgroundColor(next.backgroundColor ?? '');
    setShelfStyle(next.shelfStyle ?? 'plain');
    setShelfRow(next.shelfRow ?? 'none');
    setShelfColor(next.shelfColor ?? '');
    setShelfStrength(next.shelfStrength ?? 50);
    setRailStyle(next.railStyle ?? 'glass');
    setRailOpacity(next.railOpacity ?? 45);
    setCardSize(next.cardSize ?? 'medium');
    setBackgroundStrength(next.backgroundStrength ?? 100);
  }, []);


  // Refresh progress-driven rows when the player closes.
  useEffect(() => {
    if (!window.media?.onPlayerClosed) return undefined;
    return window.media.onPlayerClosed(() => { reload(); });
  }, [reload]);

  /*
   * How far down the page is, wherever the page happens to scroll.
   *
   * html, body and the root are all given the full height, which makes the
   * body itself the thing that scrolls rather than the window. So the number
   * to read is not always window.scrollY — on a browser it is the body — and
   * the event has to be caught on the way down, because a scroll on an
   * element does not bubble up to the window at all. Without both of those
   * the bar never learns it has been scrolled past.
   */
  useEffect(() => {
    const distance = () => window.scrollY
      || document.scrollingElement?.scrollTop
      || document.body.scrollTop
      || 0;

    const onScroll = () => {
      const down = distance();
      setScrolled(down > 20);
      setPastBanner(down > 260);
    };

    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);



  /**
   * The tabs on offer.
   *
   * Comics can be turned off in Settings, and a view already open on it
   * falls back to Home rather than leaving a tab selected that is no longer
   * in the strip.
   */
  const tabs = useMemo(() => VIEWS.filter((entry) => {
    /*
     * Comics kept its own switch from before sections existed, and the two
     * agree; the rest are offered only where the server said so.
     */
    if (entry.id === 'comics') return showComics && (mySections?.includes('comics') ?? true);
    if (entry.id === 'family' || entry.id === 'artwork') {
      return mySections?.includes(entry.id) ?? false;
    }
    if (entry.id === 'shows' || entry.id === 'movies') {
      return mySections?.includes(entry.id) ?? true;
    }
    return true;
  }).sort((a, b) => {
    /*
     * In the order the owner put them.
     *
     * Home, the lists and the way into Settings are fixed — they are not
     * sections and nobody is arranging them — so they keep the places this
     * file gives them, and the sections sort themselves in between.
     */
    const rank = (entry) => {
      const at = (mySections ?? []).indexOf(entry.id);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    return rank(a) - rank(b);
  }), [showComics, mySections]);

  useEffect(() => {
    if (!showComics && view === 'comics') setView('home');
    if (mySections && !tabs.some((entry) => entry.id === view) && view !== 'library') {
      setView('home');
    }
  }, [showComics, view, tabs, mySections]);

  /* Whether the search screen is up. On a phone searching is a destination
     of its own rather than a field wedged into the bar. */
  const [searching, setSearching] = useState(false);
  /* The title whose actions are being offered, from holding a poster down. */
  const [heldItem, setHeldItem] = useState(null);
  /* Whether the library is being fetched again by hand. */
  const [refreshing, setRefreshing] = useState(false);
  /*
   * Gathering titles for a shelf, from the screen you are already looking at.
   *
   * A set rather than a list: ticking is a question about one title at a time,
   * asked in whatever order somebody's eye happens to land.
   */
  const [gathering, setGathering] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());

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

  /*
   * Dress the page whenever the choice or the library changes.
   *
   * On the body rather than in the tree, so it survives every screen change
   * and the player — which covers the lot — is untouched by it. The posters
   * are only read by the one option that wants them.
   */
  useEffect(() => {
    const wall = items
      .filter((item) => item.poster)
      .slice(0, 3)
      .map((item) => artwork(item.poster, 'w300'));
    applyBackground(background, { posters: wall, colour: backgroundColor, strength: backgroundStrength });
  }, [background, backgroundColor, backgroundStrength, items]);

  useEffect(() => {
    applyShelfStyle(shelfStyle, shelfRow, shelfColor, shelfStrength);
  }, [shelfStyle, shelfRow, shelfColor, shelfStrength]);

  useEffect(() => { applyRailStyle(railStyle, railOpacity); }, [railStyle, railOpacity]);

  useEffect(() => { applyCardSize(cardSize); }, [cardSize]);

  const movies = useMemo(() => items.filter((item) => item.kind === 'movie'), [items]);
  const shows = useMemo(() => items.filter((item) => item.kind === 'show'), [items]);

  /**
   * The shelves belonging to whichever of the two screens is open.
   *
   * A shelf shown on both screens is not one mixed shelf drawn twice: on Films
   * it is its films, on TV Shows it is its shows. A rail of eight films with
   * two stray series in it is not a shelf of films, and seeing the same two
   * series again under Films is exactly the doubling the shelves exist to stop.
   *
   * A shelf left with nothing for this screen is dropped rather than drawn
   * empty — a Marvel shelf holding only films has no business heading the
   * TV Shows page.
   */
  const shelvesHere = useMemo(() => {
    if (view !== 'movies' && view !== 'shows') return [];
    const wanted = view === 'movies' ? 'movie' : 'show';

    return collections
      .filter((entry) => {
        const where = entry.shownOn ?? 'both';
        return where === 'both' || where === wanted;
      })
      .map((entry) => ({
        ...entry,
        items: (entry.items ?? []).filter((item) => item.kind === wanted),
      }))
      .filter((entry) => entry.items.length > 0);
  }, [collections, view]);

  /**
   * The titles left over once the shelves have taken theirs.
   *
   * A shelf moves a title rather than copying it: seeing Batman Beyond on the
   * DC shelf and then again, three rows down, among everything else is the same
   * library twice over and makes the shelf look decorative. What is left below
   * is genuinely what has not been filed anywhere.
   *
   * Not applied while gathering, when the whole library has to be reachable —
   * otherwise a title already on one shelf could never be put on another.
   */
  const unshelved = useMemo(() => {
    const all = view === 'movies' ? movies : shows;
    if (!shelvesHere.length) return all;

    const filed = new Set(shelvesHere.flatMap((shelf) => (shelf.items ?? []).map((item) => item.id)));
    return filed.size ? all.filter((item) => !filed.has(item.id)) : all;
  }, [view, movies, shows, shelvesHere]);

  /* Declared above the banner, which reads it to decide whether to rotate. */
  const [openCategory, setOpenCategory] = useState(null);
  /* The whole library at once, as artwork. Its own screen rather than a tab,
     because it answers a different question from any of them. */
  const [wall, setWall] = useState(false);

  /*
   * The handful of titles the banner rotates through.
   *
   * Needs a backdrop and a description to fill the space. Titles with a logo
   * are preferred — the banner is built around one — but only while there are
   * enough of them to rotate through.
   *
   * Drawn at random, because taking the ten best-rated meant the same ten
   * titles in the same order every single time the library was opened. A
   * banner that never changes stops being looked at, and a library of 250
   * films that always opens on the same four is a library that feels much
   * smaller than it is.
   *
   * Not random over everything, though. The banner is the largest thing on
   * the screen, and the worst-rated title in the library has no business
   * filling it. So the field is the better-rated part of what has the artwork,
   * and the shuffle happens inside that — varied every time, without ever
   * being embarrassing.
   */
  const heroPicks = useMemo(() => pickHeroes(items, 10), [items]);

  /* Noted after the fact, not while choosing: a memo that wrote to storage
     would be doing something other than working out a value. */
  useEffect(() => {
    rememberHeroes(heroPicks.map((item) => item.id));
  }, [heroPicks]);

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

  /**
   * Newest first — but what has just arrived here comes before all of it.
   *
   * The shelf is ordered by the year a title came out, which is what makes it
   * a shelf of new films rather than a shelf of new files. The exception is
   * the handful that genuinely arrived in the library recently: those go to
   * the front whatever their year, because a 1994 film added last night is the
   * thing somebody in this house has not seen yet, and the reason to look at
   * this shelf at all.
   *
   * Which titles count as newly arrived is worked out in recent.js, and is
   * deliberately nothing when the whole library was scanned at once.
   */
  const recentlyReleased = useMemo(
    () => [...items]
      .sort((a, b) => {
        const arrived = (isRecent(b) ? 1 : 0) - (isRecent(a) ? 1 : 0);
        return arrived || (b.year ?? 0) - (a.year ?? 0);
      })
      .slice(0, 24),
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

  /**
   * Back to the top, whichever element is doing the scrolling.
   *
   * The body scrolls rather than the window in a browser, so telling only the
   * window to go back leaves the new page opened halfway down — and the bar
   * still carrying the last title, because as far as it knows nothing moved.
   */
  const toTop = () => {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    document.body.scrollTop = 0;
    setScrolled(false);
    setPastBanner(false);
  };

  const openDetail = useCallback((entry, event) => {
    const item = entry.item ?? entry;
    /*
     * The picture that was pressed, measured before anything moves.
     *
     * Taken from the press itself rather than looked up afterwards: by the
     * time the new page exists the rail may have been replaced, and a
     * measurement of something that is no longer there is worse than none.
     */
    /*
     * Found from what was actually pressed rather than from the handler.
     *
     * The event's currentTarget is only meaningful while the interface is
     * still dispatching it, and by the time it has been handed along it can
     * be nothing at all. What was under the finger stays true.
     */
    const pressed = event?.target?.closest?.('.card')?.querySelector?.('.card-poster img')
      ?? event?.currentTarget?.querySelector?.('.card-poster img');
    setDetailId(item.id);
    toTop();
    flyFrom(pressed);
  }, []);

  /*
   * Arrows, an OK and a back — the five buttons a television remote has.
   *
   * Back means leaving a title if one is open, and otherwise nothing, so the
   * key is left to the browser rather than swallowed.
   */
  useRemote({
    onBack: () => {
      if (searching) { setSearching(false); return true; }
      if (heldItem) { setHeldItem(null); return true; }
      if (detailId) { setDetailId(null); return true; }
      return false;
    },
  });

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

  const pull = usePull(reload, { enabled: !detailId });
  const swipe = useSwipe({
    onLeft: () => { if (!detailId) step(1); },
    onRight: () => {
      if (detailId) setDetailId(null);
      else step(-1);
    },
  });

  /**
   * Start the whole page again.
   *
   * Deliberately a full reload rather than another fetch of the library. Asking
   * for the data again leaves everything else as it was — the build that is
   * running, whatever a screen has got itself into, anything held in memory
   * since — and the moment somebody presses this is precisely the moment they
   * have decided that what is in front of them is wrong. A reload is the one
   * answer that covers all of it, and it is what they would do by hand if
   * there were an address bar to do it in.
   */
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    window.location.reload();
  };

  const tickTitle = (id) => setTicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const stopGathering = () => { setGathering(false); setTicked(new Set()); };

  /**
   * Put everything ticked on one shelf.
   *
   * Sent one after another rather than all at once, so they land in the order
   * they were ticked in — which is the order somebody meant them to be in.
   */
  const addTickedTo = async (collectionId) => {
    const chosen = [...ticked];
    stopGathering();
    try {
      for (const id of chosen) await api.addToCollection(collectionId, id);
      await reload();
    } catch (failure) {
      setError(failure.message);
    }
  };

  const goto = (next) => {
    stopGathering();
    setOpenCategory(null);
    setSearching(false);
    setView(next);
    setDetailId(null);
    setQuery('');
    window.location.hash = next;
    toTop();
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

  /*
   * Searching covers the screen while it is open.
   *
   * Drawn before anything else and instead of it: a search that shared the
   * page would have the library scrolling behind the keyboard, and on a phone
   * the results would be below the fold before they were drawn.
   */
  if (searching) {
    return (
      <SearchScreen
        items={items}
        cardMeta={cardMeta}
        onOpen={(item) => { setSearching(false); openDetail(item.id); }}
        onClose={() => setSearching(false)}
      />
    );
  }

  if (detailId) {
    return (
      <>
        <Nav view={view} goto={goto} query={query} setQuery={setQuery} tabs={tabs} me={me} scrolled
             onSearch={() => setSearching(true)}
             onRefresh={refresh}
             refreshing={refreshing}
             section={pastBanner ? items.find((entry) => entry.id === detailId)?.title : null}
             brand={headerPreview(libraryName)} brandColor={brandColor(libraryColor)} />
        <Rail view={view} goto={goto} tabs={tabs} me={me} />
        <TabBar view={view} goto={goto} tabs={tabs} />
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
      <Nav view={view} goto={goto} query={query} setQuery={setQuery} tabs={tabs} me={me} scrolled={scrolled}
           onSearch={() => setSearching(true)}
           onRefresh={refresh}
           refreshing={refreshing}
           onGather={
             me?.isOwner && (view === 'movies' || view === 'shows')
               ? () => (gathering ? stopGathering() : setGathering(true))
               : null
           }
           gathering={gathering}
           brand={headerPreview(libraryName)} brandColor={brandColor(libraryColor)} />
      <Rail view={view} goto={goto} tabs={tabs} me={me} />
      <TabBar view={view} goto={goto} tabs={tabs} />

      {/* What a pull at the top of the page is doing, while it is doing it. */}
      {(pull.distance > 0 || pull.refreshing) && (
        <div
          className={pull.refreshing ? 'pull refreshing' : (pull.ready ? 'pull ready' : 'pull')}
          style={{ transform: 'translateY(' + (pull.refreshing ? 44 : pull.distance) + 'px)' }}
        >
          <span className="pull-mark">{pull.refreshing ? '↻' : (pull.ready ? '↑' : '↓')}</span>
          {pull.refreshing ? 'Refreshing' : (pull.ready ? 'Release to refresh' : 'Pull to refresh')}
        </div>
      )}

      {gathering && (
        <GatherBar
          count={ticked.size}
          shelves={allShelves.filter((entry) => {
            const where = entry.shownOn ?? 'both';
            return where === 'both' || where === (view === 'movies' ? 'movie' : 'show');
          })}
          allShelves={allShelves}
          onAdd={addTickedTo}
          onCancel={stopGathering}
        />
      )}

      {heldItem && (
        <TitleActions
          entry={heldItem}
          favourite={favourites.some((entry) => entry.id === (heldItem.item ?? heldItem).id)}
          watchLater={watchlist.items.some((entry) => entry.id === (heldItem.item ?? heldItem).id)}
          setAside={backlog.some((entry) => entry.item.id === (heldItem.item ?? heldItem).id)}
          /* Only worth offering for something actually under way. */
          canSetAside={Boolean(heldItem.video)
            || backlog.some((entry) => entry.item.id === (heldItem.item ?? heldItem).id)}
          onSetAside={async (wanted) => {
            const item = heldItem.item ?? heldItem;
            setHeldItem(null);
            try {
              await api.setBacklog(item.id, wanted);
              await reload();
            } catch (failure) {
              setError(failure.message);
            }
          }}
          onWatchLater={async (wanted) => {
            const item = heldItem.item ?? heldItem;
            setHeldItem(null);
            try {
              await api.setWatchlist(item.id, wanted);
              await reload();
            } catch (failure) {
              setError(failure.message);
            }
          }}
          onClose={() => setHeldItem(null)}
          onOpen={() => { setHeldItem(null); openDetail(heldItem); }}
          onFavourite={async (wanted) => {
            const item = heldItem.item ?? heldItem;
            setHeldItem(null);
            try {
              await api.setFavourite(item.id, wanted);
              await reload();
            } catch (failure) {
              setError(failure.message);
            }
          }}
        />
      )}

      <div className="view" key={view + (query.trim() ? ':search' : '')} {...bothGestures(swipe, pull.handlers)}>

      {/* Only worth saying on the computer that would be running mpv. A
          browser plays the video itself and has no use for the advice. */}
      {info && info.mpvAvailable === false && !onPlayVideo && (
        <div className="banner">
          mpv was not found, so playback is disabled. Install mpv, or set <code>mpvPath</code> in config.json.
        </div>
      )}
      {error && <div className="banner">{error}</div>}

      {loading && <Skeleton />}

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
          <Settings onScanned={reload} onSettingsChanged={applyBranding} onShelvesChanged={reload} />
        </>
      )}

      {!loading && wall && (
        <Mosaic
          items={view === 'movies' ? movies : view === 'shows' ? shows : items}
          onSelect={(item, event) => { setWall(false); openDetail(item, event); }}
          onBack={() => setWall(false)}
        />
      )}

      {/* One shelf or genre, opened on its own, from wherever it was found. */}
      {!loading && !wall && openCategory && (
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
              onLongPress={setHeldItem}
              renderLabel={(entry) => (
                <>
                  <strong>{entry.item.title}</strong>
                  {/*
                    * What is left, not what is done.
                    *
                    * A bar says how far in you are; the question actually
                    * being asked of this row is whether there is time for it
                    * before bed. Both are shown — the bar is still drawn on
                    * the picture — but the words are the useful half.
                    */}
                  {[
                    entry.video.episode ? episodeLabel(entry.video) : null,
                    timeLeft(entry),
                  ].filter(Boolean).join(' · ') || 'Resume'}
                </>
              )}
            />
            {/*
              * Shelves are not drawn here.
              *
              * They live at the top of Films and TV Shows, where somebody
              * looking for a run of films actually goes. The home screen was
              * already a stack of rails; one more per shelf made it longer
              * without making it clearer.
              */}
            <Row title="Top Rated" items={topRated} onSelect={openDetail} ranked
                 onLongPress={setHeldItem}
                 renderLabel={(item) => <><strong>{item.title}</strong>{item.rating?.toFixed(1)}</>} />
            <Row title="Recently Released" items={recentlyReleased} onSelect={openDetail} onLongPress={setHeldItem}
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
            <Row title="TV Shows" items={shows} onSelect={openDetail} onLongPress={setHeldItem}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            <Row title="Movies" items={movies} onSelect={openDetail} onLongPress={setHeldItem}
                 renderLabel={(item) => <><strong>{item.title}</strong>{cardMeta(item)}</>} />
            {/*
              * Genre rails, each title on one shelf only.
              *
              * These used to list every title carrying the genre, so the same
              * show appeared under Action, then Adventure, then Animation —
              * three rails deep in the same posters. Each title now sits under
              * whichever of its genres is rarest in the library, which is both
              * the more telling shelf and the one that stops the repetition.
              */}
            {/*
              * The collections go last.
              *
              * They were near the top, above the shows and films, on the
              * grounds that they are the arrangement somebody chose. But the
              * top of the home screen is for what to watch tonight — what is
              * half-finished, what is new, what is well liked — and a row of
              * marks is a way of navigating rather than an answer to that.
              * Down here they are the thing you scroll to when nothing above
              * has caught you, which is when they are actually wanted.
              */}
            <BrandRail title="Collections" categories={badged} onOpen={setOpenCategory} />

            {genreShelves && (
              <BrandRail
                title="Genres"
                categories={genreRails.map((rail) => ({
                  id: 'genre-' + rail.name, name: rail.name, items: rail.entries,
                }))}
                onOpen={setOpenCategory}
              />
            )}
          </div>
        </>
      )}

      {!loading && view === 'comics' && (
        <Comics
          onRead={readComic}
          query={query}
          shelfLayouts={shelfLayouts}
          openSeriesId={comicSeries}
          onSeriesShown={() => setComicSeries(null)}
        />
      )}

      {!loading && (view === 'family' || view === 'artwork') && (
        <SectionView
          key={view}
          section={view}
          label={view === 'family' ? 'Family' : 'Artwork'}
          isOwner={Boolean(me?.isOwner)}
          onSelect={openDetail}
          onLongPress={setHeldItem}
        />
      )}

      {!loading && view === 'lists' && (
        <Lists
          favourites={favourites}
          watchlist={watchlist}
          backlog={backlog}
          onResume={(entry) => (entry.video ? play(entry.video, entry.item) : openDetail(entry.item))}
          onTakeUp={async (entry) => {
            try { await api.setBacklog(entry.item.id, false); await reload(); } catch (failure) { setError(failure.message); }
          }}
          onSelect={openDetail}
          onLongPress={setHeldItem}
          onOpenComic={(id) => { setComicSeries(id); goto('comics'); }}
          onRemoveFavourite={async (item) => {
            try { await api.setFavourite(item.id, false); await reload(); } catch (failure) { setError(failure.message); }
          }}
          onRemoveWatch={async (item) => {
            try { await api.setWatchlist(item.id, false); await reload(); } catch (failure) { setError(failure.message); }
          }}
          onRemoveComic={async (series) => {
            try { await api.setComicWatchlist(series.id, false); await reload(); } catch (failure) { setError(failure.message); }
          }}
        />
      )}

      {!loading && view === 'library' && (
        <Settings onScanned={reload} onSettingsChanged={applyBranding} onShelvesChanged={reload} />
      )}

      {!loading && !wall && !openCategory && (view === 'movies' || view === 'shows') && (
        <Browse
          picking={gathering}
          ticked={ticked}
          onTick={tickTitle}
          shelves={shelvesHere}
          shelfLayouts={shelfLayouts}
          onOpenShelf={setOpenCategory}
          title={view === 'movies' ? 'Movies' : 'TV Shows'}
          onSeeEverything={() => setWall(true)}
          items={unshelved}
          everything={view === 'movies' ? movies : shows}
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

/**
 * What has been ticked, and which shelf it is going on.
 *
 * Along the bottom, where it does not cover the titles being chosen, and only
 * while something is being gathered. Every shelf that belongs on this screen is
 * offered by name: choosing one is the last press of the whole business, and
 * making somebody find a menu for it would undo the point of ticking covers.
 */
function GatherBar({ count, shelves, allShelves, onAdd, onCancel }) {
  const nothingYet = count === 0;

  return (
    <div className="gather">
      <span className="gather-count">
        {nothingYet ? 'Tap the titles you want' : count + (count === 1 ? ' title' : ' titles')}
      </span>

      <div className="gather-shelves">
        {shelves.map((shelf) => (
          <button
            key={shelf.id}
            type="button"
            className="btn btn-primary"
            disabled={nothingYet}
            onClick={() => onAdd(shelf.id)}
          >
            Add to {shelf.name}
          </button>
        ))}

        {shelves.length === 0 && (
          <span className="gather-note">
            {allShelves.length === 0
              ? 'No shelves yet — make one in Library › Collections.'
              : 'No shelf belongs on this screen. Change one under Library › Collections.'}
          </span>
        )}
      </div>

      <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/**
 * What can be done with a title, without opening it.
 *
 * Reached by holding a poster down, or by right-clicking one — the gesture a
 * phone uses for "tell me more about this" and the one a desktop uses for the
 * same. It comes up from the bottom edge, where the hand already is, rather
 * than in the middle of the screen where nothing else is.
 */
function TitleActions({
  entry, favourite, watchLater = false, onClose, onOpen, onFavourite, onWatchLater = null,
  setAside = false, canSetAside = false, onSetAside = null,
}) {
  const item = entry.item ?? entry;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal actions" onClick={(event) => event.stopPropagation()}>
        <div className="actions-head">
          <strong>{item.title}</strong>
          <span>{item.year}</span>
        </div>

        <button type="button" className="actions-row" onClick={onOpen}>
          <span className="actions-mark" aria-hidden="true">▤</span>
          More info
        </button>

        <button type="button" className="actions-row" onClick={() => onFavourite(!favourite)}>
          <span className="actions-mark" aria-hidden="true">{favourite ? '✓' : '♡'}</span>
          {favourite ? 'Remove from favourites' : 'Add to favourites'}
        </button>

        {onWatchLater && (
          <button type="button" className="actions-row" onClick={() => onWatchLater(!watchLater)}>
            <span className="actions-mark" aria-hidden="true">{watchLater ? '✓' : '+'}</span>
            {watchLater ? 'Remove from watch later' : 'Watch later'}
          </button>
        )}

        {/*
          * Between being nagged about it and forgetting it.
          *
          * Only offered for something already under way, because setting
          * aside a title nobody has started is what the watchlist is for.
          */}
        {onSetAside && canSetAside && (
          <button type="button" className="actions-row" onClick={() => onSetAside(!setAside)}>
            <span className="actions-mark" aria-hidden="true">{setAside ? '↩' : '⇥'}</span>
            {setAside ? 'Put back on Continue Watching' : 'Set aside for later'}
          </button>
        )}

        <button type="button" className="actions-row quiet" onClick={onClose}>
          <span className="actions-mark" aria-hidden="true">✕</span>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The destinations, along the bottom, where a thumb is.
 *
 * Only drawn on a phone — the stylesheet hides it on anything wider, where the
 * same destinations are a row of words across the top. A menu behind a button
 * hid every choice behind a tap and put them at the far end of the screen from
 * the hand holding it; this is the arrangement every other app on the phone
 * already uses, which is most of why it is the right one.
 */
/**
 * The sections, drawn.
 *
 * Stroked rather than filled, at one weight, so they read as a set — and so a
 * section that is not the current one can simply be a dimmer colour rather
 * than a different picture.
 */
const SECTION_ICONS = {
  home: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  ),
  shows: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="6.5" width="19" height="12.5" rx="2" />
      <path d="M8 3.2 12 6.5l4-3.3" />
    </svg>
  ),
  movies: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M2.5 9h19M7 4.5v4.5M17 4.5v4.5" />
      <path d="M10.5 12.5v4l4-2z" />
    </svg>
  ),
  comics: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 6.5C10.5 5 8.5 4.3 5 4.3v13c3.5 0 5.5.7 7 2.2 1.5-1.5 3.5-2.2 7-2.2v-13c-3.5 0-5.5.7-7 2.2z" />
      <path d="M12 6.5v13" />
    </svg>
  ),
  family: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 11.5 12 4.5l8 7" />
      <path d="M6 10.5V19h12v-8.5" />
      <circle cx="9.6" cy="14" r="1.4" />
      <circle cx="14.4" cy="14" r="1.4" />
    </svg>
  ),
  /*
   * A brush, not a picture frame.
   *
   * The frame said "pictures", which is what the section holds rather than
   * what it is for — and beside a television and a film reel it read as one
   * more container. A brush says somebody made these.
   */
  artwork: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {/* The handle, running up to the right. */}
      <path d="M20.2 3.8a2 2 0 0 0-2.8 0l-6.5 6.5 2.8 2.8 6.5-6.5a2 2 0 0 0 0-2.8z" />
      {/* The ferrule. */}
      <path d="M10.9 10.3 13.7 13.1" />
      {/* The bristles, and the stroke they leave. */}
      <path d="M9.6 11.6c-1.6-.6-3.2.2-3.9 1.7-.6 1.3-.4 2.4-1.6 3.4-.5.4-.8.6-.8.6s1.6 1.1 3.6 1.1c2.4 0 4.3-1.5 4.3-3.6 0-1.4-.6-2.6-1.6-3.2z" />
    </svg>
  ),
  lists: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4.2L5.5 21V4.5a1 1 0 0 1 1-1z" />
    </svg>
  ),
  leave: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 4H18a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 18 20h-3.5" />
      <path d="M3.5 12h11M10.5 8l4 4-4 4" />
    </svg>
  ),
  library: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </svg>
  ),
};

/**
 * The sections, down the left edge.
 *
 * A row of words across the top costs a strip of every screen and gets no
 * wider as the window does. Down the side it costs a sliver, the artwork keeps
 * the full height of the window, and there is somewhere obvious to put more
 * sections as they arrive.
 *
 * Icons at rest, words when you approach it: narrow enough to ignore, and
 * legible the moment somebody is actually looking for a section. Keyboard
 * focus opens it too, because a person tabbing through has the same question
 * as a person hovering and no pointer to ask it with.
 *
 * Only on a window wide enough to spare the sliver. A phone keeps the bar
 * along the bottom, where a thumb already is — a rail there would be a column
 * of targets at the far edge of the reach.
 */
function Rail({ view, goto, tabs, me }) {
  /* Whether the way out has been pressed and is waiting on an answer. */
  const [leaving, setLeaving] = useState(false);

  return (
    <nav className="rail" aria-label="Sections">
      {me && (
        <button
          type="button"
          className={view === 'library' ? 'rail-me on' : 'rail-me'}
          title={me.name + ' — your library'}
          aria-current={view === 'library' ? 'page' : undefined}
          onClick={() => goto('library')}
        >
          <ProfileFace profile={me} size="list" />
          <span className="rail-label">{me.name}</span>
        </button>
      )}

      {/*
        * The sections, less the one the name already goes to.
        *
        * Library sat at the bottom as a sixth icon while the profile at the top
        * led to the same screen — the same destination twice, in one column.
        */}
      <div className="rail-items">
        {tabs.filter((entry) => entry.id !== 'library').map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={view === entry.id ? 'rail-item on' : 'rail-item'}
            aria-current={view === entry.id ? 'page' : undefined}
            title={entry.label}
            onClick={() => goto(entry.id)}
          >
            <span className="rail-glyph" aria-hidden="true">
              {SECTION_ICONS[entry.id] ?? entry.glyph}
            </span>
            {/* Read aloud, not drawn: the sidebar stays narrow and a screen
                reader still hears which section this is. */}
            <span className="rail-label">{entry.label}</span>
          </button>
        ))}
      </div>

      {/*
        * The way out, at the foot.
        *
        * Kept apart from the sections by all the space the column has, so it
        * cannot be hit on the way to Movies — and behind a question, because
        * one stray press should not put anybody back at the door.
        */}
      {me && (
        <button
          type="button"
          className="rail-item rail-out"
          title="Log out"
          onClick={() => setLeaving(true)}
        >
          <span className="rail-glyph" aria-hidden="true">{SECTION_ICONS.leave}</span>
          <span className="rail-label">Log out</span>
        </button>
      )}

      {leaving && (
        <Confirm
          title="Log out?"
          body={'You will be back at the faces, and ' + me.name + ' will have to be chosen again to carry on.'}
          confirmLabel="Log out"
          cancelLabel="Stay"
          onConfirm={() => { setLeaving(false); leaveProfile(); }}
          onCancel={() => setLeaving(false)}
        />
      )}
    </nav>
  );
}

function TabBar({ view, goto, tabs }) {
  return (
    <nav className="tabbar">
      {tabs.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={view === entry.id ? 'tabbar-tab on' : 'tabbar-tab'}
          aria-current={view === entry.id}
          onClick={() => goto(entry.id)}
        >
          <span className="tabbar-glyph" aria-hidden="true">
            {/* The same drawings the sidebar uses, so one icon set serves
                every screen rather than a phone having its own. */}
            {SECTION_ICONS[entry.id] ?? entry.glyph}
          </span>
          {entry.label}
        </button>
      ))}
    </nav>
  );
}

function Nav({
  view, goto, query, setQuery, scrolled, brand, brandColor, tabs, me, onSearch,
  section = null, onRefresh = null, refreshing = false,
  onGather = null, gathering = false,
}) {
  /*
   * On a phone the sections live behind a button.
   *
   * Four labels and a search box do not fit across 375 pixels — laid out in a
   * row they were clipped mid-word, and scrolling them sideways hides the very
   * choices the bar exists to offer. A menu shows all of them at a size worth
   * tapping, and gives the search box the width it needs.
   */
  return (
    <nav className={scrolled ? 'nav scrolled' : 'nav'}>

      {/*
        * Whose library this is, rather than what it is called.
        *
        * The name of the library is on the door and on the settings screen;
        * once inside, the useful thing to know is which of you is watching —
        * particularly on a shared tablet, where the answer decides what is on
        * the shelves and where every episode was left.
        */}
      {me
        ? (
          <button
            className="nav-me"
            onClick={() => goto('library')}
            title={'Watching as ' + me.name}
          >
            <ProfileFace profile={me} size="list" />
            <span className="nav-me-name">{me.name}</span>
          </button>
        )
        : <div className="nav-brand" title={brand} style={{ color: brandColor }}>{brand}</div>}
      {/*
        * What you are looking at.
        *
        * Ordinarily the section, which on a phone is the only thing saying
        * where you are. On a title's page, once its banner has scrolled off
        * the top, the title itself — so the answer to "what is this" is always
        * on screen rather than only at the moment you arrive.
        */}
      <div className={section ? 'nav-section titled' : 'nav-section'}>
        {section ?? tabs.find((entry) => entry.id === view)?.label}
      </div>
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

      <div className="nav-spacer" />

      {/*
        * Two ways to the same search, for two shapes of screen.
        *
        * A window wide enough to hold a field keeps the field, because typing
        * where the results already are is faster than opening anything. A
        * phone gets a button instead: there is no width for a field that also
        * has to share the bar with a face and the name of the section, and one
        * that showed "Search TV sh" was worse than no field at all.
        */}
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

      <button className="nav-search" aria-label="Search" onClick={() => onSearch?.()}>⌕</button>

      {/*
        * Gather titles for a shelf.
        *
        * Only the owner, and only where there are titles to gather from. It is
        * beside the refresh button because both are things done *to* the screen
        * rather than places to go.
        */}
      {onGather && (
        <button
          className={gathering ? 'nav-gather on' : 'nav-gather'}
          aria-label={gathering ? 'Stop choosing titles' : 'Choose titles for a shelf'}
          title={gathering ? 'Stop choosing' : 'Choose titles for a shelf'}
          aria-pressed={gathering}
          onClick={() => onGather()}
        >{gathering ? '✕' : '+'}</button>
      )}

      {/* Fetch the library again. Turns while it is doing so. */}
      {onRefresh && (
        <button
          className={refreshing ? 'nav-refresh turning' : 'nav-refresh'}
          aria-label="Refresh the library"
          title="Refresh the library"
          disabled={refreshing}
          onClick={() => onRefresh()}
        >↻</button>
      )}
    </nav>
  );
}

export default App;
