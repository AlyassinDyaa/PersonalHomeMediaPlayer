import React, { useMemo, useState } from 'react';
import { artwork } from '../api.js';

/**
 * The whole library at once, as artwork and nothing else.
 *
 * Every other screen here is a way of narrowing: a genre, a shelf, a search,
 * a row of ten with the rest scrolled off. None of them ever shows how much
 * there is. Two hundred and fifty covers tiled small is a different kind of
 * answer — you do not read it, you look at it, and the thing you had
 * forgotten owning is the thing that catches your eye.
 *
 * No labels, deliberately. A caption under each would turn this back into a
 * grid, and the grid already exists on Films and TV Shows. The name appears
 * for whatever the pointer is over, once, along the bottom.
 */
export function Mosaic({ items, onSelect, onBack }) {
  const [hovered, setHovered] = useState(null);

  /*
   * Sorted by colour rather than by name.
   *
   * Alphabetical would put the same posters in the same order as every other
   * screen, which wastes the one thing this arrangement is for. Grouped by
   * the colour each poster is mostly made of, the wall reads as a spectrum
   * and neighbours look like they belong together.
   */
  const tiles = useMemo(() => {
    const hue = (hex) => {
      if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 999;
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 998;            // grey, and it goes at the end
      const d = max - min;
      const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
        : max === g ? (b - r) / d + 2
          : (r - g) / d + 4;
      return h * 60;
    };
    return [...items]
      .filter((item) => item.poster)
      .sort((a, b) => hue(a.accent) - hue(b.accent) || a.title.localeCompare(b.title));
  }, [items]);

  return (
    <>
      <div className="page-header">
        {onBack && (
          <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
            ← Back
          </button>
        )}
        <h1 className="page-title">Everything</h1>
        <span className="page-sub">{tiles.length} titles</span>
      </div>

      <div className="mosaic" onMouseLeave={() => setHovered(null)}>
        {tiles.map((item) => (
          <button
            key={item.id}
            type="button"
            className="mosaic-tile"
            style={item.accent ? { '--loading': item.accent } : undefined}
            title={item.title}
            aria-label={item.title}
            onMouseEnter={() => setHovered(item)}
            onFocus={() => setHovered(item)}
            onClick={(event) => onSelect(item, event)}
          >
            <img src={artwork(item.poster, 'w200')} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>

      {/* One name, for whatever is under the pointer. Fixed, so it does not
          move the wall about as it changes. */}
      <div className={hovered ? 'mosaic-name showing' : 'mosaic-name'}>
        {hovered && (
          <>
            <strong>{hovered.title}</strong>
            {hovered.year ? <span>{hovered.year}</span> : null}
          </>
        )}
      </div>
    </>
  );
}

export default Mosaic;
