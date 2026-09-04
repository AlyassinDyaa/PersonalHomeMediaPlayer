import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Row from './Row.jsx';
import { api, comicCover } from '../api.js';

/**
 * The comics shelf.
 *
 * Three depths, because that is how the folders are already arranged: the
 * shelves a library is divided into, the series standing on one, and the issues
 * inside a series. Nothing is inferred that the folder names did not already
 * say — somebody who keeps `COMICS/DC/Action Comics 1019-1049` has been clear
 * enough, and rearranging it would only be second-guessing them.
 */
export function Comics({ onRead, query = '' }) {
  const [shelves, setShelves] = useState([]);
  const [reading, setReading] = useState([]);
  const [stats, setStats] = useState(null);
  const [openShelf, setOpenShelf] = useState(null);
  const [openSeries, setOpenSeries] = useState(null);
  const [grid, setGrid] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.comics()
      .then((data) => {
        setShelves(data.shelves ?? []);
        setReading(data.reading ?? []);
        setStats(data.stats ?? null);
        setError(null);
      })
      .catch((failure) => setError(failure.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const openTheSeries = useCallback((id) => {
    api.comicSeries(id).then(setOpenSeries).catch((f) => setError(f.message));
  }, []);

  const trimmed = query.trim().toLowerCase();

  /** Searching looks across every shelf at once, which is what a search is. */
  const matches = useMemo(() => {
    if (!trimmed) return null;
    const found = [];
    for (const shelf of shelves) {
      for (const series of shelf.series) {
        if (series.title.toLowerCase().includes(trimmed)) found.push({ shelf, series });
      }
    }
    return found;
  }, [shelves, trimmed]);

  if (loading) {
    return <div className="center-note" style={{ height: 260 }}><div className="spinner" /></div>;
  }

  if (error) {
    return (
      <div className="center-note" style={{ height: 260 }}>
        <p className="player-error">{error}</p>
        <button className="btn" onClick={load}>Try again</button>
      </div>
    );
  }

  if (!shelves.length) {
    return (
      <div className="center-note" style={{ height: 260 }}>
        <p>No comics yet.</p>
        <p className="settings-hint">
          Add the folder holding them under Library, then press Scan comics.
        </p>
      </div>
    );
  }

  // --- one series, with its issues ----------------------------------------
  if (openSeries) {
    return (
      <>
        <div className="page-header">
          <button className="btn btn-ghost" onClick={() => setOpenSeries(null)}>‹ Back</button>
          <h1 className="page-title">{openSeries.title}</h1>
          <span className="page-sub">
            {openSeries.shelf ? openSeries.shelf + ' · ' : ''}
            {openSeries.issues.length} issues
          </span>
        </div>

        <div className="grid comic-grid">
          {openSeries.issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} onRead={onRead} />
          ))}
        </div>
      </>
    );
  }

  // --- one shelf, with its series -----------------------------------------
  if (openShelf) {
    const shelf = shelves.find((entry) => entry.name === openShelf);
    return (
      <>
        <div className="page-header">
          <button className="btn btn-ghost" onClick={() => setOpenShelf(null)}>‹ Back</button>
          <h1 className="page-title">{shelf.name}</h1>
          <span className="page-sub">{shelf.series.length} series · {shelf.issues} issues</span>
          <span style={{ flex: 1 }} />
          <button className="chip" onClick={() => setGrid(!grid)}>
            {grid ? 'Show as a list' : 'Show as covers'}
          </button>
        </div>

        {grid ? (
          <div className="grid comic-grid">
            {shelf.series.map((series) => (
              <SeriesCard key={series.id} series={series} onOpen={openTheSeries} />
            ))}
          </div>
        ) : (
          <div className="comic-list">
            {shelf.series.map((series) => (
              <button key={series.id} className="comic-row" onClick={() => openTheSeries(series.id)}>
                <strong>{series.title}</strong>
                <span>{series.issues} issues</span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  // --- everything ----------------------------------------------------------
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Comics</h1>
        {stats && (
          <span className="page-sub">
            {stats.series} series · {stats.issues} issues
          </span>
        )}
        {trimmed && <span className="page-sub">matching “{query.trim()}”</span>}
      </div>

      {matches && (
        matches.length ? (
          <div className="grid comic-grid">
            {matches.map(({ shelf, series }) => (
              <SeriesCard
                key={series.id}
                series={series}
                subtitle={shelf.name}
                onOpen={openTheSeries}
              />
            ))}
          </div>
        ) : (
          <div className="center-note" style={{ height: 200 }}>
            <p>Nothing matches “{query.trim()}”.</p>
          </div>
        )
      )}

      {!matches && (
        <>
          {/*
            * Rails rather than grids, because that is what every other shelf in
            * this app is. A page of wrapping grids read as a different program
            * bolted on beside the films.
            */}
          <div className="rows">
            {reading.length > 0 && (
              <Row
                title="Continue reading"
                items={reading}
                onSelect={onRead}
                renderImage={(issue) => comicCover(issue.id)}
                renderLabel={(issue) => (
                  <>
                    <strong>{issue.title}</strong>
                    {issue.seriesTitle}
                  </>
                )}
              />
            )}

            {shelves.map((shelf) => (
              <Row
                key={shelf.name}
                title={shelf.name}
                items={shelf.series}
                onSelect={(series) => openTheSeries(series.id)}
                renderImage={(series) => (
                  series.coverIssue ? comicCover(series.coverIssue) : null
                )}
                renderLabel={(series) => (
                  <>
                    <strong>{series.title}</strong>
                    {series.issues} issues
                  </>
                )}
                onSeeAll={() => setOpenShelf(shelf.name)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * A cover, or the title when there is not one.
 *
 * Not every comic yields a picture — a PDF has no first image to pull out,
 * and an archive can be damaged. A readable title beats the broken-image
 * glyph a browser draws in its place.
 */
function Cover({ src, title }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  /*
   * A cover that is not ready is asked for again, once.
   *
   * The server answers quickly rather than holding the request open while it
   * reads a two gigabyte archive, and draws the picture behind the answer. A
   * single retry a few seconds later catches it without the shelf having to be
   * revisited, and without turning a wall of missing covers into a stream of
   * requests.
   */
  const retry = () => {
    if (attempt >= 1) { setFailed(true); return; }
    setTimeout(() => setAttempt((n) => n + 1), 4000);
  };

  if (!src || failed) return <div className="card-fallback">{title}</div>;
  return (
    <img
      key={attempt}
      src={attempt ? src + '?again=' + attempt : src}
      alt={title}
      loading="lazy"
      onError={retry}
    />
  );
}

/** A series, shown by the cover of its first issue. */
function SeriesCard({ series, subtitle, onOpen }) {
  return (
    <div className="card comic-card" role="button" tabIndex={0}
         onClick={() => onOpen(series.id)}
         onKeyDown={(event) => { if (event.key === 'Enter') onOpen(series.id); }}>
      <div className="card-poster">
        <Cover
          src={series.coverIssue ? comicCover(series.coverIssue) : null}
          title={series.title}
        />
      </div>
      <div className="card-label">
        <strong>{series.title}</strong>
        {subtitle ? subtitle + ' · ' : ''}{series.issues} issues
      </div>
    </div>
  );
}

/** One issue, with how far through it somebody is. */
function IssueCard({ issue, onRead, showSeries }) {
  const progress = issue.pages && issue.page
    ? Math.min(100, Math.round(((issue.page + 1) / issue.pages) * 100))
    : 0;

  return (
    <div className="card comic-card" role="button" tabIndex={0}
         onClick={() => onRead(issue)}
         onKeyDown={(event) => { if (event.key === 'Enter') onRead(issue); }}>
      <div className="card-poster">
        <Cover src={comicCover(issue.id)} title={issue.title} />
        {progress > 0 && (
          <div className="card-progress"><span style={{ width: progress + '%' }} /></div>
        )}
      </div>
      <div className="card-label">
        <strong>{issue.title}</strong>
        {showSeries && issue.seriesTitle ? issue.seriesTitle : (
          issue.year ? String(issue.year) : issue.format.toUpperCase()
        )}
      </div>
    </div>
  );
}

export default Comics;
