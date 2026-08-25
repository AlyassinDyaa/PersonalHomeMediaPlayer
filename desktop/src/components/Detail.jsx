import React, { useEffect, useState } from 'react';
import { api, artwork, formatRuntime, formatDuration, formatSize } from '../api.js';

/** Detail view for a movie or a show, including the season/episode browser. */
export function Detail({ itemId, onBack, onPlay }) {
  const [item, setItem] = useState(null);
  const [season, setSeason] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);

    api.item(itemId)
      .then((loaded) => {
        if (cancelled) return;
        setItem(loaded);
        // Open on the season containing the next unwatched episode.
        setSeason(loaded.nextUp?.season ?? loaded.seasons?.[0]?.number ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => { cancelled = true; };
  }, [itemId]);

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
          </div>
        </div>
      </div>

      <div className="detail-body">
        {item.kind === 'movie' && item.video && (
          <div className="hero-meta">
            <span>{item.video.extension?.replace('.', '').toUpperCase()}</span>
            <span className="dot">{formatSize(item.video.size)}</span>
            {item.subtitles?.length > 0 && (
              <span className="dot">{item.subtitles.length} subtitle tracks</span>
            )}
          </div>
        )}

        {item.kind === 'show' && item.seasons?.length > 0 && (
          <>
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

            {activeSeason?.episodes.map((episode) => {
              const still = artwork(episode.still, 'w300');
              const percent = episode.duration
                ? Math.min(100, (episode.position / episode.duration) * 100)
                : 0;

              return (
                <div className="episode" key={episode.id} onClick={() => onPlay(episode, item)}>
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
                        {episode.watched
                          ? <span className="episode-watched">Watched</span>
                          : formatDuration(episode.duration) || formatSize(episode.size)}
                      </span>
                    </div>
                    {episode.overview && <p className="episode-overview">{episode.overview}</p>}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export default Detail;
