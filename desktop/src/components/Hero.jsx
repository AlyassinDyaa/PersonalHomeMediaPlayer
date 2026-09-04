import React from 'react';
import { artwork, formatRuntime } from '../api.js';

/**
 * Featured banner at the top of the home screen.
 *
 * Shows one title at a time out of a handful, moving on by itself. The banner
 * is the largest thing on the screen and was the same title every session,
 * which wasted the space on something already seen; rotating it makes the top
 * of the library a place where different things surface.
 *
 * `dots` carries the position in the rotation and a way to jump. It is
 * optional: with one candidate there is nothing to page through and no dots
 * are drawn.
 */
export function Hero({ item, onPlay, onDetails, dots = null }) {
  if (!item) return null;

  const backdrop = artwork(item.backdrop, 'w1280');
  const logo = artwork(item.logo, 'w500');

  return (
    <div className="hero">
      {/*
        * Keyed on the item so React swaps the element rather than mutating it,
        * which lets the new backdrop fade in over the old one instead of
        * snapping between them.
        */}
      <div
        key={item.id}
        className="hero-bg"
        style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined}
      />

      <div className="hero-content" key={'content-' + item.id}>
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

      {dots && dots.count > 1 && (
        <div className="hero-dots">
          {Array.from({ length: dots.count }, (_, index) => (
            <button
              key={index}
              type="button"
              className={index === dots.index ? 'hero-dot on' : 'hero-dot'}
              aria-label={'Show featured title ' + (index + 1)}
              aria-current={index === dots.index}
              onClick={() => dots.onSelect(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default Hero;
