import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBaseUrl, formatSize } from '../api.js';
import FolderPicker from './FolderPicker.jsx';
import { headerPreview, brandColor, BRAND_COLORS } from '../branding.js';

/**
 * Library settings: which folders to scan, and running a scan with live
 * progress. Scan progress arrives over server-sent events so the bar reflects
 * real work rather than an animation.
 */
export function Settings({ onScanned, onSettingsChanged }) {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  // Which folder the picker is choosing: a library root, or where the
  // library's own files are kept.
  const [picking, setPicking] = useState(null);
  const [moving, setMoving] = useState(null);
  const [passcode, setPasscode] = useState('');
  const [sharingBusy, setSharingBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [name, setName] = useState('');
  const [nameSaved, setNameSaved] = useState(false);
  const [color, setColor] = useState('');
  const [error, setError] = useState(null);

  const [scan, setScan] = useState(null); // { percent, message, phase }
  const [result, setResult] = useState(null);
  const sourceRef = useRef(null);

  const load = useCallback(() => {
    Promise.all([api.settings(), api.stats()])
      .then(([loadedSettings, loadedStats]) => {
        setSettings(loadedSettings);
        setStats(loadedStats);
        setName(loadedSettings.libraryName ?? '');
        setColor(brandColor(loadedSettings.libraryColor));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close any open event stream when leaving the screen.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  const saveName = async () => {
    try {
      const saved = await api.saveSettings({ libraryName: name, libraryColor: color });
      setSettings(saved);
      setNameSaved(true);
      setError(null);
      onSettingsChanged?.(saved);
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Colours save on the spot. A colour is judged by looking at it, so making
   * the choice wait behind a Save button would hide the thing being chosen.
   */
  const chooseColor = async (next) => {
    setColor(next);
    try {
      const saved = await api.saveSettings({ libraryColor: next });
      setSettings(saved);
      setError(null);
      onSettingsChanged?.(saved);
    } catch (err) {
      setError(err.message);
    }
  };

  /** Persist a single boolean setting and reflect it straight away. */
  const saveToggle = async (key, value) => {
    // Update first so the checkbox responds to the click rather than to the
    // round trip; the response replaces it either way.
    setSettings((previous) => ({ ...previous, [key]: value }));
    try {
      setSettings(await api.saveSettings({ [key]: value }));
      setError(null);
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  const saveRoots = async (roots) => {
    try {
      const saved = await api.saveSettings({ libraryRoots: roots });
      setSettings(saved);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Turn network sharing on or off.
   *
   * Which addresses the server answers on is decided when it starts, so the
   * server is restarted rather than left to disagree with the setting.
   */
  const setSharing = async (enabled) => {
    if (enabled && !settings.passcodeSet) {
      setError('Set a passcode first — the library is not shared without one.');
      return;
    }
    setSharingBusy(true);
    try {
      const saved = await api.saveSettings({ remoteAccess: enabled });
      setSettings(saved);
      setError(null);
      await window.media?.restartServer?.();
      // The address only exists once the server is listening on it.
      setTimeout(load, 800);
    } catch (err) {
      setError(err.message);
    } finally {
      setSharingBusy(false);
    }
  };

  const savePasscode = async () => {
    try {
      setSettings(await api.saveSettings({ passcode: passcode.trim() }));
      setPasscode('');
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Move the library's database and artwork to a folder the user chooses.
   *
   * The app restarts its server around the copy, so the screen reloads once it
   * lands rather than showing figures from a database that is no longer open.
   */
  const chooseDataDir = async (folder) => {
    setPicking(null);
    if (!folder || !window.media?.setDataDir) return;

    setMoving({ busy: true, message: 'Moving your library…' });
    try {
      const result = await window.media.setDataDir(folder);
      if (!result?.ok) {
        setMoving(null);
        setError(result?.error ?? 'Could not move the library folder.');
        return;
      }
      setMoving({ busy: false, message: 'Library now stored in ' + result.dataDir });
      setError(null);
      load();
      onScanned?.();
    } catch (err) {
      setMoving(null);
      setError(err.message);
    }
  };

  const addRoot = (folder) => {
    setPicking(null);
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
          <h2>Name</h2>
          <p className="settings-hint">
            Your name appears in the header, so the library reads as yours.
          </p>
          <div className="key-row">
            <input
              className="key-input"
              value={name}
              placeholder="Your name"
              maxLength={40}
              spellCheck={false}
              onChange={(event) => { setName(event.target.value); setNameSaved(false); }}
              onKeyDown={(event) => { if (event.key === 'Enter') saveName(); }}
            />
            <button className="btn btn-secondary" onClick={saveName}>Save</button>
          </div>
          <div className="color-row">
            <span className="settings-hint" style={{ margin: 0 }}>Colour</span>
            {BRAND_COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={swatch.value === color ? 'swatch selected' : 'swatch'}
                style={{ background: swatch.value }}
                title={swatch.name}
                aria-label={swatch.name}
                aria-pressed={swatch.value === color}
                onClick={() => chooseColor(swatch.value)}
              />
            ))}

            {/* Anything not in the row, for a colour of their own. */}
            <label className="swatch custom" title="Custom colour" style={{ background: color }}>
              <input
                type="color"
                value={color}
                onChange={(event) => chooseColor(event.target.value)}
              />
            </label>
          </div>

          <p className="settings-hint" style={{ margin: '12px 0 0' }}>
            {nameSaved
              ? 'Saved.'
              : <>Header will read <strong style={{ color }}>{headerPreview(name)}</strong>.</>}
          </p>
        </section>

        <section className="settings-card">
          <h2>Playback</h2>
          <p className="settings-hint">
            Skip prompts use chapter markers when a file has them. Most releases do
            not, so the timings fall back to a convention and can land in the wrong
            place — turn them off if they get in the way.
          </p>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.skipIntroEnabled !== false}
              onChange={(event) => saveToggle('skipIntroEnabled', event.target.checked)}
            />
            <span>
              <strong>Skip Intro</strong>
              <span className="toggle-note">Offers to jump past an opening title sequence</span>
            </span>
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.skipOutroEnabled !== false}
              onChange={(event) => saveToggle('skipOutroEnabled', event.target.checked)}
            />
            <span>
              <strong>Next episode prompt</strong>
              <span className="toggle-note">Appears over the closing minutes of an episode</span>
            </span>
          </label>
        </section>

        <section className="settings-card">
          <h2>Watch on other devices</h2>
          <p className="settings-hint">
            Share the library with phones and tablets on your home network. They
            open it in a browser — nothing to install, and the films stay on this
            computer. What you watch stays in step across every device.
          </p>

          {!settings.streamingReady && (
            <p className="settings-empty">
              ffmpeg was not found, so browsers cannot be served. It ships with the
              app; a development checkout needs it in vendor/ffmpeg.
            </p>
          )}

          <div className="key-row">
            <input
              type="password"
              className="key-input"
              value={passcode}
              placeholder={settings.passcodeSet ? 'Replace the passcode' : 'Choose a passcode'}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) => setPasscode(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') savePasscode(); }}
            />
            <button className="btn btn-secondary" disabled={!passcode.trim()} onClick={savePasscode}>
              Save
            </button>
          </div>
          <p className="settings-hint" style={{ margin: '8px 0 0' }}>
            {settings.passcodeSet
              ? 'A passcode is set. Anyone opening the library in a browser has to enter it.'
              : 'At least four characters. Sharing cannot be turned on without one.'}
          </p>

          <label className="toggle-row" style={{ marginTop: 16 }}>
            <input
              type="checkbox"
              checked={settings.remoteAccess === true}
              disabled={sharingBusy || !settings.passcodeSet}
              onChange={(event) => setSharing(event.target.checked)}
            />
            <span>
              <strong>Share on my network</strong>
              <span className="toggle-note">
                {sharingBusy
                  ? 'Restarting the library…'
                  : 'Other devices in the house can reach this library'}
              </span>
            </span>
          </label>

          {settings.remoteAccess && settings.networkUrl && (
            <div className="scan-result" style={{ marginTop: 14 }}>
              Open this on the iPad:
              <div className="root-row" style={{ marginTop: 8 }}>
                <code className="root-path" style={{ fontSize: 15 }}>{settings.networkUrl}</code>
              </div>
              <p className="settings-hint" style={{ margin: '8px 0 0' }}>
                Type it including <code>http://</code>. Most browsers now assume
                <code> https://</code> for an address typed without one, and this
                library is served over plain HTTP on your own network — so a
                browser that guesses reports a connection error rather than
                asking. In Chrome, turning off “Always use secure connections”
                stops it guessing.
              </p>
              <p className="settings-hint" style={{ margin: '8px 0 0' }}>
                Both devices must be on the same Wi-Fi, and this computer has to be
                awake. Windows may ask to allow the connection the first time.
              </p>
            </div>
          )}

          {settings.remoteAccess && !settings.networkUrl && (
            <p className="settings-empty">
              Sharing is on, but this computer has no network address yet.
            </p>
          )}
        </section>

        <section className="settings-card">
          <h2>Storage</h2>
          <p className="settings-hint">
            Where this app keeps its own files — the index of your library and the
            downloaded artwork. Your movies and shows are not moved. Put it on a
            drive with room to spare, or on the same portable drive as the app so
            it travels with you.
          </p>

          <div className="root-row">
            <span className="root-dot ok" />
            <code className="root-path">{settings.dataDir}</code>
          </div>

          {moving ? (
            <p className="settings-hint" style={{ marginTop: 12 }}>
              {moving.busy && <span className="spinner inline" />}
              {moving.message}
            </p>
          ) : (
            <button
              className="btn btn-secondary"
              style={{ marginTop: 14 }}
              disabled={!window.media?.setDataDir}
              onClick={() => setPicking('data')}
            >
              Change folder
            </button>
          )}
          {!window.media?.setDataDir && (
            <p className="settings-empty">Available in the desktop app.</p>
          )}
        </section>

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

          <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={() => setPicking('root')}>
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

          <div className="key-row">
            <input
              type="password"
              className="key-input"
              value={apiKey}
              placeholder={settings.tmdbConfigured ? 'Replace TMDB API key' : 'Paste your TMDB API key'}
              onChange={(event) => { setApiKey(event.target.value); setKeySaved(false); }}
              spellCheck={false}
            />
            <button
              className="btn btn-secondary"
              disabled={!apiKey.trim()}
              onClick={async () => {
                try {
                  setSettings(await api.saveSettings({ tmdbApiKey: apiKey.trim() }));
                  setApiKey('');
                  setKeySaved(true);
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              Save key
            </button>
          </div>
          <p className="settings-hint" style={{ margin: '8px 0 0' }}>
            {keySaved
              ? 'Saved. Run a scan to fetch artwork and descriptions.'
              : 'A free key from themoviedb.org supplies posters, descriptions and episode titles.'}
          </p>
          <div className="status-row">
            <span>Player</span>
            <span className={settings.mpvPath ? 'ok-text' : 'warn-text'}>
              {settings.mpvPath || 'mpv not found'}
            </span>
          </div>
        </section>
      </div>

      {picking && (
        <FolderPicker
          onChoose={picking === 'data' ? chooseDataDir : addRoot}
          onCancel={() => setPicking(null)}
        />
      )}
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
