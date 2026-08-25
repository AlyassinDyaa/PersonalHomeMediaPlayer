import React from 'react';
import { artwork, formatRuntime } from '../api.js';

/** Featured banner at the top of the home screen. */
export function Hero({ item, onPlay, onDetails }) {
  if (!item) return null;

  const backdrop = artwork(item.backdrop, 'w1280');
  const logo = artwork(item.logo, 'w500');

  return (
    <div className="hero">
      <div className="hero-bg" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined} />
      <div className="hero-content">
        {logo
          ? <img className="hero-logo" src={logo} alt={item.title} />
          : <h1 className="hero-title">{item.title}</h1>}

        <div className="hero-meta">
          {item.year && <span>{item.year}</span>}
          {item.certification && <span className="badge">{item.certification}</span>}
          {item.kind === 'show'
            ? item.seasonCount > 0 && <span className="dot">{item.seasonCount} season{item.seasonCount === 1 ? '' : 's'}</span>
            : item.runtime > 0 && <span className="dot">{formatRuntime(item.runtime)}</span>}
          {item.rating > 0 && <span className="dot">{item.rating.toFixed(1)} rating</span>}
        </div>

        {item.overview && <p className="hero-overview">{item.overview}</p>}

        <div className="hero-actions">
          <button className="btn btn-primary" onClick={() => onPlay(item)}>▶ Play</button>
          <button className="btn btn-secondary" onClick={() => onDetails(item)}>More Info</button>
        </div>
      </div>
    </div>
  );
}

export default Hero;
