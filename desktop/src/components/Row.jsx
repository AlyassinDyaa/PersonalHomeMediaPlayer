import React from 'react';
import Card from './Card.jsx';

/** Horizontally scrolling rail of poster tiles. */
export function Row({ title, items, onSelect, wide = false, renderLabel = null }) {
  if (!items?.length) return null;

  return (
    <section className="row">
      <div className="row-header">
        <h2 className="row-title">{title}</h2>
        <span className="row-count">{items.length}</span>
      </div>
      <div className="row-scroller">
        {items.map((entry) => {
          const item = entry.item ?? entry;
          return (
            <Card
              key={entry.video?.id ?? item.id}
              item={item}
              wide={wide}
              progress={entry.progressPercent ?? null}
              label={renderLabel ? renderLabel(entry) : null}
              onClick={() => onSelect(entry)}
            />
          );
        })}
      </div>
    </section>
  );
}

export default Row;
