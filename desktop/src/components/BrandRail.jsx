import React, { useCallback, useEffect, useRef, useState } from 'react';
import { artwork } from '../api.js';

/**
 * A rail of square brand tiles — DC, Marvel, and the rest.
 *
 * Deliberately not the poster mosaics this replaced. Those were the size of a
 * hero and pushed everything else off the screen, which made the home page one
 * decision deep. A universe is a badge, not a picture: it wants to be small,
 * recognisable at a glance, and sat in a row with its siblings so the choice is
 * taken in one look.
 *
 * A universe that has a logo shows it; the rest show a wordmark in the brand's
 * own colour, which reads as deliberate rather than as a missing image. A logo
 * that fails to load falls back to the same wordmark, so a badge is never
 * empty.
 */
export function BrandRail({ title, categories, onOpen }) {
  const scroller = useRef(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setCanLeft(node.scrollLeft > 4);
    setCanRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const node = scroller.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(updateArrows);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateArrows, categories]);

  const scrollBy = (direction) => {
    const node = scroller.current;
    if (!node) return;
    node.scrollBy({ left: direction * (node.clientWidth * 0.85), behavior: 'smooth' });
  };

  if (!categories?.length) return null;

  return (
    <section className="row">
      <div className="row-header">
        <h2 className="row-title">{title}</h2>
        <span className="row-count">{categories.length}</span>
      </div>

      <div className="row-viewport">
        {canLeft && (
          <button className="row-arrow left" onClick={() => scrollBy(-1)} aria-label="Scroll left">
            ‹
          </button>
        )}

        <div className="row-scroller brands" ref={scroller} onScroll={updateArrows}>
          {categories.map((category) => (
            <button
              type="button"
              key={category.id}
              className={category.logo ? 'brand has-logo' : 'brand'}
              style={category.accent ? { '--brand-accent': category.accent } : undefined}
              onClick={() => onOpen(category)}
              title={category.name + ' — ' + category.items.length + ' titles'}
            >
              {category.logo
                ? <Logo category={category} />
                : <span className="brand-mark">{category.mark ?? category.name}</span>}
              <span className="brand-count">{category.items.length}</span>
            </button>
          ))}
        </div>

        {canRight && (
          <button className="row-arrow right" onClick={() => scrollBy(1)} aria-label="Scroll right">
            ›
          </button>
        )}
      </div>
    </section>
  );
}

/** A universe's logo, giving way to its wordmark if the image will not load. */
function Logo({ category }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="brand-mark">{category.mark ?? category.name}</span>;

  return (
    <img
      className="brand-logo"
      src={artwork(category.logo, 'w300')}
      alt={category.name}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export default BrandRail;
