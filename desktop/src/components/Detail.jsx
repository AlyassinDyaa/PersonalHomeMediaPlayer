import React, { useEffect, useMemo, useState } from 'react';
import { api, artwork, formatRuntime, formatDuration, formatSize } from '../api.js';
import Row from './Row.jsx';

/** Remembered between visits, so the chosen episode layout sticks. */
const VIEW_KEY = 'episodeView';

function readEpisodeView() {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    // Private windows and locked-down profiles can refuse storage entirely.
    return 'list';
  }
}

/** Detail view for a movie or a show, including the season/episode browser. */
export function Detail({ itemId, onBack, onPlay, library = [], onSelect = null }) {
  const [item, setItem] = useState(null);
  const [season, setSeason] = useState(null);
  const [episodeView, setEpisodeView] = useState(readEpisodeView);
  const [error, setError] = useState(null);
  const [favourite, setFavourite] = useState(false);
  /** Open only while the automatic match is being corrected. */
  const [fixing, setFixing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);

    api.item(itemId)
      .then((loaded) => {
        if (cancelled) return;
        setItem(loaded);
        setFavourite(Boolean(loaded.favourite));
        setFixing(false);
        // Open on the season containing the next unwatched episode.
        setSeason(loaded.nextUp?.season ?? loaded.seasons?.[0]?.number ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => { cancelled = true; };
  }, [itemId]);

  const chooseView = (next) => {
    setEpisodeView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not being able to remember the choice is not worth interrupting for.
    }
  };

  /**
   * Other titles sharing a genre with this one, closest first.
   *
   * Drawn from the library already loaded by the home screen, so opening a
   * title costs no extra requests.
   */
  const alike = useMemo(() => {
    if (!item || !library.length) return [];
    const genres = new Set(item.genres ?? []);
    if (!genres.size) return [];

    return library
      .filter((entry) => entry.id !== item.id)
      .map((entry) => ({
        entry,
        shared: (entry.genres ?? []).filter((genre) => genres.has(genre)).length,
      }))
      .filter(({ shared }) => shared > 0)
      // Most genres in common first, then the better-rated of equals.
      .sort((a, b) => b.shared - a.shared || (b.entry.rating ?? 0) - (a.entry.rating ?? 0))
      .slice(0, 20)
      .map(({ entry }) => entry);
  }, [item, library]);

  if (error) {
    return <div className="center-note"><p>Could not load this title.</p><p>{error}</p></div>;
  }
  if (!item) {
    return <div className="center-note"><div className="spinner" /></div>;
  }

  const backdrop = artwork(item.backdrop, 'w1280');
  const logo = artwork(item.logo, 'w500');
  const activeSeason = item.seasons?.find((s) => s.number === season);

  return (
    <div>
      <button className="back-btn" onClick={onBack}>← Back</button>

      <div className="detail-hero">
        <div className="hero-bg" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined} />
        <div className="hero-content">
          {logo
            ? <img className="hero-logo" src={logo} alt={item.title} />
            : <h1 className="hero-title">{item.title}</h1>}

          <div className="hero-meta">
            {item.year && <span>{item.year}</span>}
            {item.certification && <span className="badge">{item.certification}</span>}
            {item.kind === 'movie'
              ? item.runtime > 0 && <span className="dot">{formatRuntime(item.runtime)}</span>
              : <span className="dot">{item.seasonCount} season{item.seasonCount === 1 ? '' : 's'}, {item.episodeCount} episodes</span>}
            {item.rating > 0 && <span className="dot">{item.rating.toFixed(1)}</span>}
          </div>

          {item.genres?.length > 0 && (
            <div className="hero-meta">{item.genres.join(' · ')}</div>
          )}

          {item.overview && <p className="hero-overview">{item.overview}</p>}

          <div className="hero-actions">
            {item.kind === 'movie' && item.video && (
              <button className="btn btn-primary" onClick={() => onPlay(item.video, item)}>
                {item.video.position > 0 ? '▶ Resume' : '▶ Play'}
              </button>
            )}
            {item.kind === 'show' && item.nextUp && (
              <button className="btn btn-primary" onClick={() => onPlay(item.nextUp, item)}>
                ▶ Play S{item.nextUp.season} E{item.nextUp.episode}
              </button>
            )}

            <button
              className={favourite ? 'btn btn-secondary is-favourite' : 'btn btn-secondary'}
              aria-pressed={favourite}
              onClick={async () => {
                const wanted = !favourite;
                // Shown before it is saved: this is a toggle, and a toggle that
                // waits for a round trip feels broken.
                setFavourite(wanted);
                try {
                  await api.setFavourite(item.id, wanted);
                } catch (err) {
                  setFavourite(!wanted);
                  setError(err.message);
                }
              }}
            >
              {favourite ? '♥ In your list' : '♡ Add to your list'}
            </button>

            <button className="btn btn-ghost" onClick={() => setFixing(true)}>
              Wrong title?
            </button>
          </div>
        </div>
      </div>

      {fixing && (
        <MatchFixer
          item={item}
          onClose={() => setFixing(false)}
          onError={setError}
        />
      )}

      <div className="detail-body">
        {item.kind === 'show' && item.seasons?.length > 0 && (
          <>
            <div className="section-head">
              <div className="season-tabs">
                {item.seasons.map((entry) => (
                  <button
                    key={entry.number}
                    className={entry.number === season ? 'season-tab active' : 'season-tab'}
                    onClick={() => setSeason(entry.number)}
                  >
                    {entry.name} <span style={{ opacity: 0.6 }}>({entry.episodes.length})</span>
                  </button>
                ))}
              </div>

              {/* Two ways to read a season: a dense list, or large stills for
                  browsing by what an episode looks like. */}
              <div className="view-toggle" role="group" aria-label="Episode layout">
                <button
                  className={episodeView === 'list' ? 'view-btn active' : 'view-btn'}
                  onClick={() => chooseView('list')}
                  title="List"
                  aria-pressed={episodeView === 'list'}
                >
                  <ListGlyph /> List
                </button>
                <button
                  className={episodeView === 'grid' ? 'view-btn active' : 'view-btn'}
                  onClick={() => chooseView('grid')}
                  title="Grid"
                  aria-pressed={episodeView === 'grid'}
                >
                  <GridGlyph /> Grid
                </button>
              </div>
            </div>

            {episodeView === 'grid' ? (
              <div className="episode-grid">
                {activeSeason?.episodes.map((episode) => (
                  <EpisodeTile
                    key={episode.id}
                    episode={episode}
                    onPlay={() => onPlay(episode, item)}
                  />
                ))}
              </div>
            ) : (
              activeSeason?.episodes.map((episode) => (
                <EpisodeRow
                  key={episode.id}
                  episode={episode}
                  onPlay={() => onPlay(episode, item)}
                />
              ))
            )}
          </>
        )}

        <AboutPanel item={item} />

        {alike.length >= 3 && onSelect && (
          <div className="detail-rail">
            <Row
              title={'More Like ' + item.title}
              items={alike}
              onSelect={onSelect}
              renderLabel={(entry) => (
                <>
                  <strong>{entry.title}</strong>
                  {[entry.year, entry.kind === 'show'
                    ? entry.seasonCount + ' season' + (entry.seasonCount === 1 ? '' : 's')
                    : formatRuntime(entry.runtime)].filter(Boolean).join(' · ')}
                </>
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** How far through an episode the viewer is, as a percentage. */
function watchedPercent(episode) {
  if (!episode.duration) return 0;
  return Math.min(100, (episode.position / episode.duration) * 100);
}

/** What to show next to an episode's name: how long it runs, or that it is done. */
function episodeNote(episode) {
  if (episode.watched) return <span className="episode-watched">Watched</span>;
  return formatDuration(episode.duration)
    || formatRuntime(episode.runtime)
    || formatSize(episode.size);
}

function EpisodeRow({ episode, onPlay }) {
  const still = artwork(episode.still, 'w300');
  const percent = watchedPercent(episode);

  return (
    <div className="episode" onClick={onPlay}>
      <div className="episode-number">{episode.episode}</div>
      <div className="episode-still">
        {still && <img src={still} alt="" loading="lazy" />}
        {percent > 0 && (
          <div className="card-progress"><span style={{ width: percent + '%' }} /></div>
        )}
      </div>
      <div className="episode-info">
        <div className="episode-title">
          <span>
            {episode.title || 'Episode ' + episode.episode}
            {episode.episodeEnd && ' – ' + episode.episodeEnd}
          </span>
          <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 13 }}>
            {episodeNote(episode)}
          </span>
        </div>
        {episode.overview && <p className="episode-overview">{episode.overview}</p>}
      </div>
    </div>
  );
}

/** The same episode as a large tile, for browsing a season by its artwork. */
function EpisodeTile({ episode, onPlay }) {
  const still = artwork(episode.still, 'w500');
  const percent = watchedPercent(episode);

  return (
    <div className="episode-tile" onClick={onPlay} role="button" tabIndex={0}
         onKeyDown={(event) => { if (event.key === 'Enter') onPlay(); }}>
      <div className="episode-tile-still">
        {still
          ? <img src={still} alt="" loading="lazy" draggable={false} />
          : <div className="card-fallback">{episode.title || 'Episode ' + episode.episode}</div>}
        <span className="episode-tile-badge">{episode.episode}</span>
        <span className="episode-tile-play">▶</span>
        {percent > 0 && (
          <div className="card-progress"><span style={{ width: percent + '%' }} /></div>
        )}
      </div>
      <div className="episode-tile-title">
        {episode.title || 'Episode ' + episode.episode}
        {episode.episodeEnd && ' – ' + episode.episodeEnd}
      </div>
      <div className="episode-tile-note">{episodeNote(episode)}</div>
      {episode.overview && <p className="episode-tile-overview">{episode.overview}</p>}
    </div>
  );
}

/**
 * The lower half of the page.
 *
 * A film has no episode list, so without this there was nothing below the
 * artwork but a line of file details. Everything here is already held in the
 * library, so it costs no extra requests.
 */
function AboutPanel({ item }) {
  const video = item.kind === 'movie' ? item.video : null;
  const facts = [];

  if (item.year) facts.push(['Released', item.year]);
  if (item.kind === 'movie' && item.runtime > 0) facts.push(['Runtime', formatRuntime(item.runtime)]);
  if (item.kind === 'show') {
    facts.push(['Episodes', item.episodeCount + ' across ' + item.seasonCount
      + ' season' + (item.seasonCount === 1 ? '' : 's')]);
  }
  if (item.rating > 0) facts.push(['Rating', item.rating.toFixed(1) + ' / 10']);
  if (item.certification) facts.push(['Rated', item.certification]);
  if (item.status) facts.push(['Status', item.status]);
  if (item.genres?.length) facts.push(['Genres', item.genres.join(', ')]);

  if (video) {
    const format = [
      video.extension?.replace('.', '').toUpperCase(),
      formatSize(video.size),
    ].filter(Boolean).join(' · ');
    if (format) facts.push(['File', format]);
    if (item.subtitles?.length) {
      facts.push(['Subtitles', item.subtitles.length + ' track'
        + (item.subtitles.length === 1 ? '' : 's')]);
    }
  }

  const folder = item.sourceFolders?.[0];

  return (
    <section className="about">
      <h2 className="about-heading">About {item.title}</h2>
      {item.tagline && <p className="about-tagline">“{item.tagline}”</p>}
      {/* The description over the artwork is clamped to three lines. Repeating
          it in full is only worth the space when there was more of it to read;
          for a short synopsis the two blocks would be the same paragraph. */}
      {item.overview?.length > 240 && <p className="about-overview">{item.overview}</p>}

      <dl className="about-facts">
        {facts.map(([label, value]) => (
          <div className="about-fact" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {folder && (
        <p className="about-path" title={folder}>
          <span>Stored in</span> <code>{folder}</code>
        </p>
      )}
    </section>
  );
}

const ListGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 5h6v4H3zM11 6h10v2H11zM3 11h6v4H3zM11 12h10v2H11zM3 17h6v4H3zM11 18h10v2H11z" />
  </svg>
);

const GridGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 4h8v7H3zM13 4h8v7h-8zM3 13h8v7H3zM13 13h8v7h-8z" />
  </svg>
);

/**
 * Point a title at the right TMDB entry.
 *
 * The scanner searches by whatever the folder is called, and occasionally comes
 * back confident and wrong — a single downloaded episode of "Lanterns" was
 * matched to a film called "Street of Broken Lanterns" and there was no way to
 * say otherwise from inside the app. The choice is stored as an override, so it
 * survives every future scan rather than being re-decided each time.
 */
function MatchFixer({ item, onClose, onError }) {
  const [query, setQuery] = useState(item.title);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  const search = async () => {
    const wanted = query.trim();
    if (!wanted) return;
    setBusy(true);
    try {
      setResults(await api.searchTmdb(item.kind, wanted));
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // The list the user came to correct is the obvious first search.
  useEffect(() => { search(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const choose = async (candidate) => {
    try {
      await api.matchItem(item.id, candidate.tmdbId);
      setSaved(candidate);
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <div className="match-fixer">
      <div className="match-head">
        <h2>Which one is this?</h2>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>

      {saved ? (
        <p className="settings-hint">
          Set to <strong>{saved.title}</strong>{saved.year ? ' (' + saved.year + ')' : ''}.
          Run a scan from the Library screen to fetch its artwork and description.
        </p>
      ) : (
        <>
          <div className="key-row">
            <input
              className="key-input"
              type="text"
              value={query}
              placeholder={'Search ' + (item.kind === 'show' ? 'TV shows' : 'films')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') search(); }}
            />
            <button className="btn btn-secondary" onClick={search} disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>

          {results?.length === 0 && (
            <p className="settings-hint">Nothing found for that.</p>
          )}

          <div className="match-results">
            {(results ?? []).map((candidate) => (
              <button
                key={candidate.tmdbId}
                className={candidate.tmdbId === item.tmdbId ? 'match-card current' : 'match-card'}
                onClick={() => choose(candidate)}
              >
                {candidate.poster
                  ? <img src={artwork(candidate.poster, 'w200')} alt="" loading="lazy" />
                  : <span className="match-noart" />}
                <span className="match-text">
                  <strong>{candidate.title}</strong>
                  <span>{candidate.year ?? 'year unknown'}
                    {candidate.tmdbId === item.tmdbId ? ' · current' : ''}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default Detail;
