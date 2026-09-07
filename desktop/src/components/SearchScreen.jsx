import React, { useEffect, useMemo, useRef, useState } from 'react';
import Card from './Card.jsx';

/**
 * Searching, given the whole screen.
 *
 * On a phone the search field lived in the top bar, sharing about 375 pixels
 * with a menu button, a face, and the name of the section — which left it
 * showing "Search TV sh" and nothing else. A field that cannot show its own
 * placeholder cannot show what you typed either.
 *
 * So searching becomes a place rather than a corner: the whole screen, the
 * field at the top where the keyboard will not cover it, and what you looked
 * for last time offered underneath, because the same few titles get searched
 * for over and over in a house.
 */

/** What was looked for before, kept on the device that looked. */
const REMEMBERED = 'library.recentSearches';
const KEEP = 6;

function remembered() {
  try {
    const stored = JSON.parse(localStorage.getItem(REMEMBERED) ?? '[]');
    return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];   // Private browsing, or something else wrote nonsense there.
  }
}

function remember(term) {
  const trimmed = term.trim();
  if (trimmed.length < 2) return;
  try {
    const next = [trimmed, ...remembered().filter((entry) => entry !== trimmed)].slice(0, KEEP);
    localStorage.setItem(REMEMBERED, JSON.stringify(next));
  } catch {
    // Not remembering is a small loss; failing to search would be a large one.
  }
}

export function SearchScreen({ items, onOpen, onClose, cardMeta }) {
  const [term, setTerm] = useState('');
  const [recent, setRecent] = useState(remembered);
  const field = useRef(null);

  /*
   * The field takes the keyboard as the screen opens.
   *
   * iOS only raises its keyboard for a field focused during a gesture it can
   * attribute to the person — opening this screen is one, but only just, so
   * the focus goes in on the next frame rather than in the middle of the
   * render.
   */
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  // Escape closes, as it does everywhere else.
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = term.trim().toLowerCase();

  const results = useMemo(() => {
    if (!trimmed) return [];
    return items
      .filter((item) => item.title.toLowerCase().includes(trimmed))
      // What starts with the word comes before what merely contains it.
      .sort((a, b) => {
        const first = a.title.toLowerCase().startsWith(trimmed) ? 0 : 1;
        const second = b.title.toLowerCase().startsWith(trimmed) ? 0 : 1;
        return first - second || a.title.localeCompare(b.title);
      });
  }, [items, trimmed]);

  const open = (item) => {
    remember(term);
    setRecent(remembered());
    onOpen(item);
  };

  const useRecent = (entry) => {
    setTerm(entry);
    field.current?.focus();
  };

  const forget = () => {
    try { localStorage.removeItem(REMEMBERED); } catch { /* nothing to forget */ }
    setRecent([]);
  };

  return (
    <div className="search-screen">
      <div className="search-screen-bar">
        <div className="search-screen-field">
          <span aria-hidden="true">⌕</span>
          <input
            ref={field}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search your library"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onKeyDown={(event) => { if (event.key === 'Enter') remember(term); }}
          />
          {term && (
            <button type="button" className="clear-btn" aria-label="Clear" onClick={() => setTerm('')}>×</button>
          )}
        </div>
        <button type="button" className="search-screen-cancel" onClick={onClose}>Cancel</button>
      </div>

      <div className="search-screen-body">
        {!trimmed && recent.length > 0 && (
          <div className="search-recent">
            <div className="search-recent-head">
              <span>Recent</span>
              <button type="button" onClick={forget}>Clear</button>
            </div>
            {recent.map((entry) => (
              <button key={entry} type="button" className="search-recent-row" onClick={() => useRecent(entry)}>
                <span aria-hidden="true">↺</span>
                {entry}
              </button>
            ))}
          </div>
        )}

        {!trimmed && recent.length === 0 && (
          <p className="search-screen-hint">Type a few letters of a title.</p>
        )}

        {trimmed && results.length === 0 && (
          <p className="search-screen-hint">Nothing here matches “{term.trim()}”.</p>
        )}

        {results.length > 0 && (
          <>
            <p className="search-screen-count">
              {results.length} {results.length === 1 ? 'title' : 'titles'}
            </p>
            <div className="grid">
              {results.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  label={<><strong>{item.title}</strong><span>{cardMeta(item)}</span></>}
                  onClick={() => open(item)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SearchScreen;
