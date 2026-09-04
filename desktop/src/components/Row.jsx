import React, { useCallback, useEffect, useRef, useState } from 'react';
import Card from './Card.jsx';

/**
 * Horizontally scrolling rail of poster tiles.
 *
 * The native scrollbar is hidden and replaced with hover arrows. Beyond
 * matching how streaming UIs behave, this sidesteps a real rendering problem:
 * setting `scrollbar-width` makes Chromium use standard scrollbar styling and
 * ignore every `::-webkit-scrollbar` rule, which produced a bright white bar
 * under each row.
 */
export function Row({
  title, items, onSelect, wide = false, renderLabel = null, onRemove = null,
  renderImage = null, onSeeAll = null,
}) {
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
  }, [updateArrows, items]);

  const scrollBy = (direction) => {
    const node = scroller.current;
    if (!node) return;
    // Move by a little less than a full viewport so context is preserved.
    node.scrollBy({ left: direction * (node.clientWidth * 0.85), behavior: 'smooth' });
  };

  if (!items?.length) return null;

  return (
    <section className="row">
      <div className="row-header">
        <h2 className="row-title">{title}</h2>
        <span className="row-count">{items.length}</span>
        {/* A shelf too long for one rail can be opened in full. */}
        {onSeeAll && (
          <button className="chip row-see-all" onClick={onSeeAll}>See all</button>
        )}
      </div>

      <div className="row-viewport">
        {canLeft && (
          <button className="row-arrow left" onClick={() => scrollBy(-1)} aria-label="Scroll left">
            ‹
          </button>
        )}

        <div className="row-scroller" ref={scroller} onScroll={updateArrows}>
          {items.map((entry) => {
            const item = entry.item ?? entry;
            return (
              <Card
                key={entry.video?.id ?? item.id}
                item={item}
                wide={wide}
                progress={entry.progressPercent ?? null}
                label={renderLabel ? renderLabel(entry) : null}
                // Comics keep their covers somewhere else entirely, so a rail
                // can be told where to find the picture for each tile.
                image={renderImage ? renderImage(entry) : null}
                onClick={() => onSelect(entry)}
                onRemove={onRemove ? () => onRemove(entry) : null}
                removeLabel="Remove from Continue Watching"
              />
            );
          })}
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

export default Row;
