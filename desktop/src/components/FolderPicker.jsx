import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Browse the filesystem to choose a library folder.
 *
 * Uses the server's directory listing rather than a native dialog so the same
 * picker keeps working from a browser client later, and shows a count of the
 * media files found so the choice can be confirmed before committing to it.
 */
export function FolderPicker({ onChoose, onCancel }) {
  const [current, setCurrent] = useState(null);
  const [listing, setListing] = useState({ parent: null, entries: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);

    api.browse(current)
      .then((result) => { if (!cancelled) setListing(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [current]);

  // Count media under the selected folder, so an empty choice is obvious.
  useEffect(() => {
    if (!current) { setPreview(null); return undefined; }
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      api.browsePreview(current)
        .then((result) => { if (!cancelled) setPreview(result); })
        .catch(() => { if (!cancelled) setPreview(null); })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [current]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Choose a library folder</h2>
          <button className="btn-ghost" onClick={onCancel}>Close</button>
        </div>

        <div className="picker-path">
          <button
            className="btn-ghost"
            disabled={!current}
            onClick={() => setCurrent(listing.parent)}
          >
            ↑ Up
          </button>
          <code>{current || 'This PC'}</code>
        </div>

        {error && <div className="banner" style={{ margin: '0 0 12px' }}>{error}</div>}

        <div className="picker-list">
          {loading && <div className="center-note" style={{ height: 160 }}><div className="spinner" /></div>}
          {!loading && listing.entries.length === 0 && (
            <p style={{ color: 'var(--text-faint)', padding: 16 }}>No sub-folders here.</p>
          )}
          {!loading && listing.entries.map((entry) => (
            <button key={entry.path} className="picker-item" onClick={() => setCurrent(entry.path)}>
              <span className="picker-icon">📁</span>
              <span>{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="modal-footer">
          <div className="picker-preview">
            {checking && 'Counting media…'}
            {!checking && preview && (
              preview.videos > 0
                ? preview.videos + ' video files found here'
                : 'No video files found in this folder'
            )}
          </div>
          <button
            className="btn btn-primary"
            disabled={!current}
            onClick={() => onChoose(current)}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export default FolderPicker;
