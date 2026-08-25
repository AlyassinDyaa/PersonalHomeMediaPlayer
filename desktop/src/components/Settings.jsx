import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBaseUrl, formatSize } from '../api.js';
import FolderPicker from './FolderPicker.jsx';

/**
 * Library settings: which folders to scan, and running a scan with live
 * progress. Scan progress arrives over server-sent events so the bar reflects
 * real work rather than an animation.
 */
export function Settings({ onScanned }) {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(null);

  const [scan, setScan] = useState(null); // { percent, message, phase }
  const [result, setResult] = useState(null);
  const sourceRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([api.settings(), api.stats()])
      .then(([loadedSettings, loadedStats]) => {
        setSettings(loadedSettings);
        setStats(loadedStats);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close any open event stream when leaving the screen.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  const saveRoots = async (roots) => {
    try {
      const saved = await api.saveSettings({ libraryRoots: roots });
      setSettings(saved);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const addRoot = (folder) => {
    setPicking(false);
    if (!folder) return;
    const roots = settings?.libraryRoots ?? [];
    if (roots.includes(folder)) return;
    saveRoots([...roots, folder]);
  };

  const removeRoot = (folder) => {
    saveRoots((settings?.libraryRoots ?? []).filter((root) => root !== folder));
  };

  const startScan = () => {
    if (scan) return;
    setResult(null);
    setError(null);
    setScan({ percent: 0, message: 'Starting…', phase: 'walk' });

    const source = new EventSource(apiBaseUrl() + '/api/scan/stream');
    sourceRef.current = source;

    source.addEventListener('progress', (event) => {
      const payload = JSON.parse(event.data);
      setScan((previous) => ({
        // A null percent means "no better estimate": hold the last value
        // rather than snapping the bar backwards.
        percent: payload.percent ?? previous?.percent ?? 0,
        message: payload.message,
        phase: payload.phase,
        done: payload.done,
        total: payload.total,
      }));
    });

    source.addEventListener('done', (event) => {
      setResult(JSON.parse(event.data));
      setScan(null);
      source.close();
      sourceRef.current = null;
      load();
      onScanned?.();
    });

    source.addEventListener('error', () => {
      setError('The scan stopped unexpectedly.');
      setScan(null);
      source.close();
      sourceRef.current = null;
    });
  };

  if (!settings) {
    return <div className="center-note"><div className="spinner" /></div>;
  }

  const hasRoots = settings.libraryRoots.length > 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Library</h1>
        <span className="page-sub">Choose where your movies and shows live</span>
      </div>

      <div className="settings">
        {error && <div className="banner" style={{ margin: '0 0 18px' }}>{error}</div>}

        <section className="settings-card">
          <h2>Folders</h2>
          <p className="settings-hint">
            Point at any folder containing movies or TV shows. Sub-folders are searched
            automatically, and nothing needs renaming.
          </p>

          {!hasRoots && (
            <p className="settings-empty">No folders added yet.</p>
          )}

          {settings.rootsStatus.map((root) => (
            <div className="root-row" key={root.path}>
              <span className={root.available ? 'root-dot ok' : 'root-dot bad'} />
              <code className="root-path">{root.path}</code>
              {!root.available && <span className="root-warn">not connected</span>}
              <button className="btn-ghost" onClick={() => removeRoot(root.path)}>Remove</button>
            </div>
          ))}

          <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={() => setPicking(true)}>
            + Add folder
          </button>
        </section>

        <section className="settings-card">
          <h2>Scan</h2>

          {scan ? (
            <>
              <div className="progress">
                <div className="progress-fill" style={{ width: scan.percent + '%' }} />
              </div>
              <div className="progress-label">
                <span>{phaseLabel(scan)}</span>
                <span>{scan.percent}%</span>
              </div>
              <p className="settings-hint" style={{ marginTop: 6 }}>{scan.message}</p>
            </>
          ) : (
            <>
              <p className="settings-hint">
                {stats?.videos > 0
                  ? stats.movies + ' movies and ' + stats.shows + ' shows indexed'
                    + (stats.totalSize ? ' · ' + formatSize(stats.totalSize) : '')
                  : 'Nothing indexed yet.'}
              </p>
              <button className="btn btn-primary" disabled={!hasRoots} onClick={startScan}>
                {stats?.videos > 0 ? 'Rescan library' : 'Scan library'}
              </button>
              {!hasRoots && <p className="settings-empty">Add a folder first.</p>}
            </>
          )}

          {result && (
            <div className="scan-result">
              Found <strong>{result.movies}</strong> movies and <strong>{result.shows}</strong> shows
              across <strong>{result.videos}</strong> files.
              {result.suggestions > 0 && ' ' + result.suggestions + ' groupings need confirmation.'}
              {result.missingRoots?.length > 0 && (
                <div className="root-warn" style={{ marginTop: 8 }}>
                  Skipped unavailable: {result.missingRoots.join(', ')}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="settings-card">
          <h2>Status</h2>
          <div className="status-row">
            <span>Artwork &amp; metadata</span>
            <span className={settings.tmdbConfigured ? 'ok-text' : 'warn-text'}>
              {settings.tmdbConfigured ? 'TMDB connected' : 'no API key configured'}
            </span>
          </div>
          <div className="status-row">
            <span>Player</span>
            <span className={settings.mpvPath ? 'ok-text' : 'warn-text'}>
              {settings.mpvPath || 'mpv not found'}
            </span>
          </div>
          <div className="status-row">
            <span>Data folder</span>
            <code style={{ fontSize: 12, color: 'var(--text-faint)' }}>{settings.dataDir}</code>
          </div>
        </section>
      </div>

      {picking && <FolderPicker onChoose={addRoot} onCancel={() => setPicking(false)} />}
    </>
  );
}

function phaseLabel(scan) {
  switch (scan.phase) {
    case 'walk': return 'Reading folders';
    case 'group': return 'Identifying titles';
    case 'metadata':
      return scan.total
        ? 'Fetching artwork (' + scan.done + ' of ' + scan.total + ')'
        : 'Fetching artwork';
    case 'merge': return 'Merging duplicates';
    case 'persist': return 'Saving';
    default: return 'Working';
  }
}

export default Settings;
