import React from 'react';
import { artwork } from '../api.js';

/**
 * Poster tile. Falls back to the title on a plain surface when an item has no
 * artwork, so an unmatched item is still readable rather than a blank box.
 */
export function Card({ item, onClick, wide = false, label = null, progress = null, image = null }) {
  const src = image ?? artwork(wide ? item.backdrop : item.poster, wide ? 'w780' : 'w500');

  return (
    <div className={wide ? 'card wide' : 'card'} onClick={onClick} role="button" tabIndex={0}
         onKeyDown={(event) => { if (event.key === 'Enter') onClick?.(); }}>
      <div className="card-poster">
        {src
          ? <img src={src} alt={item.title} loading="lazy" draggable={false} />
          : <div className="card-fallback">{item.title}</div>}
        {progress > 0 && (
          <div className="card-progress"><span style={{ width: Math.min(100, progress) + '%' }} /></div>
        )}
      </div>
      {label && <div className="card-label">{label}</div>}
    </div>
  );
}

export default Card;
