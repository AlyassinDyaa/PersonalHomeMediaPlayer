import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, comicPage } from '../api.js';

/** How long the controls stay up after being summoned. */
const CHROME_HIDE_MS = 3000;
/** How often a page turn is written back, so closing the app keeps the place. */
const SAVE_EVERY_MS = 1500;

/**
 * Reading a comic.
 *
 * Built for a thumb on a tablet first. The picture fills the screen and the
 * furniture stays out of the way: the sides of the page turn it, the middle
 * summons the controls, and everything else is a swipe. Nothing is drawn over
 * the artwork unless it was asked for.
 *
 * Pages are fetched as ordinary images, so the browser caches them and the ones
 * on either side are pulled in early — turning a page should not be a wait.
 */
export function ComicReader({ issue, onClose, onOpenIssue }) {
  const [pages, setPages] = useState(issue.pages ?? 0);
  const [at, setAt] = useState(issue.page ?? 0);
  const [chrome, setChrome] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  /** Two pages at once, the way a printed comic actually opens. */
  const [spread, setSpread] = useState(false);
  /** Right to left, for manga. */
  const [rightToLeft, setRightToLeft] = useState(false);
  /** Whole page on screen, or full width and scroll down it. */
  const [fitWidth, setFitWidth] = useState(false);

  const hideTimer = useRef(null);
  const savedAt = useRef(0);
  const touchStart = useRef(null);
  const atRef = useRef(at);
  atRef.current = at;

  const wake = useCallback(() => {
    setChrome(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChrome(false), CHROME_HIDE_MS);
  }, []);

  // Make the comic ready. The count comes back long before every page has been
  // unpacked, which is what lets the first page appear straight away.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.openComic(issue.id)
      .then((result) => {
        if (cancelled) return;
        setPages(result.pages);
        setLoading(false);
        wake();
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(hideTimer.current);
    };
  }, [issue.id, wake]);

  /*
   * The page count, read through a ref rather than closed over.
   *
   * It arrives a moment after the reader opens, and anything holding the old
   * value would go stale — including the save below, which used to be rebuilt
   * when the count changed and so ran its "leaving now" cleanup mid-read,
   * writing a marker at page zero for a comic nobody had left.
   */
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  /** Remember the page, but not on every single turn. */
  const remember = useCallback((page, force) => {
    const now = Date.now();
    if (!force && now - savedAt.current < SAVE_EVERY_MS) return;
    savedAt.current = now;

    const total = pagesRef.current;
    api.saveComicProgress({
      issueId: issue.id,
      page,
      pages: total,
      finished: total > 0 && page >= total - 1,
    }).catch(() => {
      // Losing a page marker is not worth interrupting the reading for.
    });
  }, [issue.id]);

  // Only ever on the way out, so the place is kept when the reader is closed.
  useEffect(() => () => remember(atRef.current, true), [remember]);

  const step = spread ? 2 : 1;

  const goTo = useCallback((page) => {
    const wanted = Math.max(0, Math.min(page, Math.max(0, pages - 1)));
    setAt(wanted);
    remember(wanted);
    wake();
  }, [pages, remember, wake]);

  const forward = useCallback(() => goTo(atRef.current + step), [goTo, step]);
  const back = useCallback(() => goTo(atRef.current - step), [goTo, step]);

  // Which way the sides of the screen turn. In right-to-left the left edge
  // moves forwards, which is what a manga reader expects.
  const tapLeft = rightToLeft ? forward : back;
  const tapRight = rightToLeft ? back : forward;

  useEffect(() => {
    const onKey = (event) => {
      // The arrow keys follow the edges of the screen, so they turn the same
      // way round in a right-to-left comic as a tap does.
      if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') {
        event.preventDefault();
        tapRight();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        tapLeft();
      } else if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'Home') goTo(0);
      else if (event.key === 'End') goTo(pages - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tapLeft, tapRight, forward, back, goTo, onClose, pages]);

  /** The page, and its partner when two are shown at once. */
  const showing = useMemo(() => {
    if (!spread) return [at];
    // A comic's first page is a cover and stands alone; after that they pair.
    if (at === 0) return [0];
    const left = at % 2 === 0 ? at - 1 : at;
    return [left, left + 1].filter((page) => page < pages);
  }, [at, spread, pages]);

  // The next pages, fetched before they are asked for.
  const preload = useMemo(() => {
    const wanted = [];
    for (let i = 1; i <= 3; i++) {
      const page = at + i;
      if (page < pages) wanted.push(page);
    }
    return wanted;
  }, [at, pages]);

  /*
   * Zoom, for the small lettering.
   *
   * Two fingers pinch it, a double tap jumps in and out again, and while it is
   * zoomed a drag moves the page around instead of turning it — turning a page
   * by accident halfway through reading a caption is worse than not being able
   * to turn it with one finger for a moment.
   */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pinch = useRef(null);
  const lastTap = useRef(0);

  const zoomed = zoom > 1.01;

  const resetZoom = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  // A new page starts unzoomed, or the reader would land somewhere arbitrary.
  useEffect(resetZoom, [at, resetZoom]);

  const distanceBetween = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );

  const onTouchStart = (event) => {
    if (event.touches.length === 2) {
      pinch.current = { from: distanceBetween(event.touches), zoom };
      touchStart.current = null;
      return;
    }
    const touch = event.touches[0];
    touchStart.current = {
      x: touch.clientX, y: touch.clientY, at: Date.now(), pan: { ...pan },
    };
  };

  const onTouchMove = (event) => {
    if (pinch.current && event.touches.length === 2) {
      const scale = distanceBetween(event.touches) / pinch.current.from;
      setZoom(Math.max(1, Math.min(4, pinch.current.zoom * scale)));
      return;
    }
    // Dragging a zoomed page moves it rather than turning it.
    if (zoomed && touchStart.current && event.touches.length === 1) {
      const touch = event.touches[0];
      setPan({
        x: touchStart.current.pan.x + (touch.clientX - touchStart.current.x),
        y: touchStart.current.pan.y + (touch.clientY - touchStart.current.y),
      });
    }
  };

  const onTouchEnd = (event) => {
    if (pinch.current && event.touches.length === 0) pinch.current = null;

    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;

    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const moved = Math.abs(dx) > 12 || Math.abs(dy) > 12;

    // Two taps in quick succession zoom in, and again to come back out.
    if (!moved) {
      const now = Date.now();
      if (now - lastTap.current < 320) {
        lastTap.current = 0;
        if (zoomed) resetZoom();
        else setZoom(2.2);
        return;
      }
      lastTap.current = now;
    }

    // While zoomed a drag was moving the page, so it must not also turn it.
    if (zoomed) return;

    // A swipe, not a scroll and not a tap.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) tapRight();
      else tapLeft();
    }
  };

  /** Where a tap landed: the outer thirds turn, the middle shows the controls. */
  const onTap = (event) => {
    if (touchStart.current) return;
    // A zoomed page is being read, not paged through; a stray tap on the edge
    // should not throw away the place being looked at.
    if (zoomed) { wake(); return; }

    const { left, width } = event.currentTarget.getBoundingClientRect();
    // A stage with no width yet — the reader opening, or a hidden tab — would
    // divide by zero and turn every tap into nothing at all. Showing the
    // controls is the harmless answer while there is nothing to measure.
    if (!width) { wake(); return; }

    const where = (event.clientX - left) / width;
    if (where < 0.32) tapLeft();
    else if (where > 0.68) tapRight();
    else wake();
  };

  const label = showing.length > 1
    ? 'Pages ' + (showing[0] + 1) + '–' + (showing[showing.length - 1] + 1)
    : 'Page ' + (at + 1);

  return (
    <div className="reader" onMouseMove={wake}>
      <div
        className={'reader-stage' + (fitWidth ? ' fit-width' : '') + (rightToLeft ? ' rtl' : '')}
        onClick={onTap}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: 'scale(' + zoom + ') translate(' + (pan.x / zoom) + 'px, ' + (pan.y / zoom) + 'px)',
          // Only while zoomed, or the transition fights every pinch.
          transition: pinch.current ? 'none' : 'transform 0.18s ease',
        }}
      >
        {showing.map((page) => (
          <img
            key={page}
            className="reader-page"
            src={comicPage(issue.id, page)}
            alt={'Page ' + (page + 1)}
            draggable={false}
            onError={() => setError('That page could not be read')}
          />
        ))}

        {/* Fetched but never shown, so the next turn is instant. */}
        <div className="reader-preload" aria-hidden="true">
          {preload.map((page) => (
            <img key={page} src={comicPage(issue.id, page)} alt="" />
          ))}
        </div>
      </div>

      {loading && (
        <div className="reader-note">
          <div className="spinner" />
          <p>Opening {issue.title}…</p>
        </div>
      )}

      {error && (
        <div className="reader-note">
          <p className="player-error">{error}</p>
          <button className="btn ghost" onClick={onClose}>Back</button>
        </div>
      )}

      <div className={chrome ? 'reader-top' : 'reader-top hidden'}>
        <button className="player-close" onClick={onClose}>‹ Back</button>
        <span className="player-title">
          {issue.series?.title ? issue.series.title + ' · ' : ''}{issue.title}
        </span>
        <div className="player-actions">
          <button
            className={spread ? 'player-step on' : 'player-step'}
            onClick={() => { setSpread(!spread); wake(); }}
          >
            {spread ? 'Two pages' : 'One page'}
          </button>
          <button
            className={rightToLeft ? 'player-step on' : 'player-step'}
            onClick={() => { setRightToLeft(!rightToLeft); wake(); }}
          >
            {rightToLeft ? 'Right to left' : 'Left to right'}
          </button>
          <button
            className={fitWidth ? 'player-step on' : 'player-step'}
            onClick={() => { setFitWidth(!fitWidth); wake(); }}
          >
            {fitWidth ? 'Fit width' : 'Whole page'}
          </button>
          {/* Pinching is the natural gesture, but a mouse has no pinch. */}
          <button
            className={zoomed ? 'player-step on' : 'player-step'}
            onClick={() => { zoomed ? resetZoom() : setZoom(2.2); wake(); }}
          >
            {zoomed ? 'Zoom ' + zoom.toFixed(1) + '×' : 'Zoom in'}
          </button>
        </div>
      </div>

      <div className={chrome ? 'reader-bar' : 'reader-bar hidden'}>
        <button className="player-key" onClick={tapLeft} aria-label="Previous page">‹</button>
        <span className="player-time">{label}</span>
        <input
          className="player-seek"
          type="range"
          min={0}
          max={Math.max(0, pages - 1)}
          value={at}
          onChange={(event) => goTo(Number(event.target.value))}
          aria-label="Page"
        />
        <span className="player-time">{pages || '—'}</span>
        <button className="player-key" onClick={tapRight} aria-label="Next page">›</button>

        {at >= pages - 1 && issue.nextIssue && (
          <button className="player-step on" onClick={() => onOpenIssue?.(issue.nextIssue)}>
            Next issue ›
          </button>
        )}
      </div>
    </div>
  );
}

export default ComicReader;
