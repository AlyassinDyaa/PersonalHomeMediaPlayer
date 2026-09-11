import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBaseUrl, formatSize } from '../api.js';
import FolderPicker from './FolderPicker.jsx';
import Confirm from './Confirm.jsx';
import CollectionsPanel from './CollectionsPanel.jsx';
import SectionAccess from './SectionAccess.jsx';
import SectionsPanel from './SectionsPanel.jsx';
import HealthPanel from './HealthPanel.jsx';
import RequestsPanel from './RequestsPanel.jsx';
import ProfilesPanel from './ProfilesPanel.jsx';
import { headerPreview, brandColor, BRAND_COLORS } from '../branding.js';
import { BACKGROUNDS, BACKDROP_COLOURS, backgroundClass } from '../backgrounds.js';
import {
  SHELF_STYLES, SHELF_ROWS, SHELF_COLOURS, SHELF_ROWS_WITH_STRENGTH,
  shelfStyleClass, shelfRowClass,
} from '../shelfStyles.js';
import { RAIL_STYLES, railStyleClass } from '../railStyles.js';
import { CARD_SIZES } from '../shelfStyles.js';

/**
 * Library settings: which folders to scan, and running a scan with live
 * progress. Scan progress arrives over server-sent events so the bar reflects
 * real work rather than an animation.
 */
/** The collection layouts an owner can offer, and what each is. */
const SHELF_LAYOUT_CHOICES = [
  ['rows', 'Rows', 'One rail per collection, with the covers'],
  ['grid', 'Grid', 'Every collection as a tile with its badge'],
  ['list', 'List', 'One line each, best for a long list'],
];

/**
 * The groups the settings are divided into, in the order they are offered.
 *
 * `ownerOnly` marks the ones that name the machine the library runs on — its
 * folders, its drives, its passcode, where its own files are kept. They are
 * not merely disabled for everybody else but absent, because the point of the
 * owner profile is that a guest cannot learn any of it. What is left is the
 * two things that belong to whoever is watching: their own shelves, and which
 * of the household they are.
 */
const SETTINGS_TABS = [
  { id: 'overview', label: 'Overview', hint: 'What is here, and how it is doing' },
  { id: 'library', label: 'Appearance', ownerOnly: true, hint: 'How the library looks — its name, colour, backdrop and shelves' },
  { id: 'collections', label: 'Collections', ownerOnly: true, hint: 'Your own shelves on the home screen' },
  { id: 'sections', label: 'Sections', ownerOnly: true, hint: 'The parts of the library, and who is let into each' },
  { id: 'playback', label: 'Playback', ownerOnly: true, hint: 'How episodes and films play' },
  { id: 'sharing', label: 'Sharing', ownerOnly: true, hint: 'Watching on a phone, a tablet, or another computer' },
  { id: 'profiles', label: 'Profiles', hint: 'Who is watching, and what each of them can see' },
  { id: 'requests', label: 'Requests', hint: 'Films and shows people would like added' },
  { id: 'maintenance', label: 'Maintenance', ownerOnly: true, hint: 'Folders, scanning, storage, and the state of the library' },
];

/**
 * A mark for each tab.
 *
 * Drawn rather than typed, at one weight, so the column reads as one set
 * instead of eight characters that happened to land near each other. They
 * are what makes a list of eight scannable at a glance — the word is read
 * second, and only to confirm.
 */
const TAB_ICONS = {
  overview: <path d="M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z" />,
  library: <path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20l1-6L3.4 9.9 9.4 9z" />,
  collections: <path d="M4 7h16M4 12h16M4 17h10" />,
  sections: <path d="M4 5h7v7H4zm9 0h7v4h-7zm0 6h7v8h-7zm-9 3h7v5H4z" />,
  playback: <path d="M9 7.5v9l7-4.5z M4.5 12a7.5 7.5 0 1 0 15 0 7.5 7.5 0 1 0-15 0" />,
  sharing: <path d="M12 4v9m0-9-3.2 3.2M12 4l3.2 3.2M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />,
  profiles: <path d="M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zm-6 8.2c0-2.9 2.7-4.6 6-4.6s6 1.7 6 4.6M16 5.2a3 3 0 0 1 0 5.9m1.6 3.7c2 .5 3.4 1.9 3.4 4.4" />,
  requests: <path d="M12 6.5v11M6.5 12h11" />,
  maintenance: <path d="M14.7 6.3a3.8 3.8 0 0 1 5 5l-8.7 8.7a2 2 0 0 1-2.8 0l-2.2-2.2a2 2 0 0 1 0-2.8z M13 8l3 3" />,
};

export function Settings({ onScanned, onSettingsChanged, onShelvesChanged }) {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  /* Whether the row of tabs is being put in order rather than used. */
  const [arranging, setArranging] = useState(false);
  /* A folder the owner has asked to take off the library, pending an answer. */
  const [droppingRoot, setDroppingRoot] = useState(null);
  // Which folder the picker is choosing: a library root, or where the
  // library's own files are kept.
  const [picking, setPicking] = useState(null);
  const [moving, setMoving] = useState(null);
  const [passcode, setPasscode] = useState('');
  const [sharingBusy, setSharingBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  // 'saved' after pasting one, 'included' after going back to the shipped key.
  const [keySaved, setKeySaved] = useState('');
  const [name, setName] = useState('');
  /* The line under the name; empty means the door makes a sentence of it. */
  const [subtitle, setSubtitle] = useState('');
  const [nameSaved, setNameSaved] = useState(false);
  const [color, setColor] = useState('');
  const [error, setError] = useState(null);
  /** Which group of settings is on screen; ten stacked cards were too many. */
  const [tab, setTab] = useState('library');

  const [suggestions, setSuggestions] = useState([]);
  /** Shows already joined together, so a wrong answer can be taken back. */
  const [merges, setMerges] = useState([]);
  const [separating, setSeparating] = useState(null);

  const [scan, setScan] = useState(null); // { percent, message, phase }
  const [result, setResult] = useState(null);
  const sourceRef = useRef(null);

  const load = useCallback(() => {
    api.merges().then(setMerges).catch(() => setMerges([]));
    Promise.all([api.settings(), api.stats(), api.suggestions().catch(() => [])])
      .then(([loadedSettings, loadedStats, pending]) => {
        setSettings(loadedSettings);
        setStats(loadedStats);
        setSuggestions(pending);
        setName(loadedSettings.libraryName ?? '');
        setSubtitle(loadedSettings.librarySubtitle ?? '');
        setColor(brandColor(loadedSettings.libraryColor));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Answer one grouping question.
   *
   * Removed from the list straight away: the question has been answered, and
   * "One show" only takes visible effect on the next scan, so leaving the card
   * sitting there would read as though the answer had not registered.
   */
  const answerSuggestion = useCallback(async (id, action) => {
    setSuggestions((current) => current.filter((entry) => entry.id !== id));
    try {
      await api.resolveSuggestion(id, action);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Close any open event stream when leaving the screen.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  const saveName = async () => {
    try {
      const saved = await api.saveSettings({
        libraryName: name,
        librarySubtitle: subtitle,
        libraryColor: color,
      });
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
      const saved = await api.saveSettings({ [key]: value });
      setSettings(saved);
      /*
       * Tell the app, not just this page.
       *
       * Some of these change how the whole library looks rather than how it
       * behaves — the background above is the obvious one — and without this
       * the choice sat in Settings until the next reload, which reads as the
       * button not having worked.
       */
      onSettingsChanged?.(saved);
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

  const [comicScan, setComicScan] = useState(null);

  const saveComicRoots = async (roots) => {
    try {
      setSettings(await api.saveSettings({ comicRoots: roots }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const addComicRoot = (folder) => {
    setPicking(null);
    if (!folder) return;
    const roots = settings?.comicRoots ?? [];
    if (roots.includes(folder)) return;
    saveComicRoots([...roots, folder]);
  };

  /** Read the comic folders. Its own scan: different files, different code. */
  const startComicScan = async () => {
    if (comicScan) return;
    setComicScan({ running: true });
    try {
      const result = await api.scanComics();
      setComicScan({ running: false, ...result });
    } catch (err) {
      setComicScan(null);
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

  const isOwner = settings.isOwner === true;
  /*
   * The tabs, in the order somebody put them.
   *
   * Anything the stored order does not name keeps its place at the end, which
   * is what lets a tab added in a later version appear at all rather than
   * quietly vanishing for anybody who had ever rearranged these.
   */
  const order = settings?.settingsTabOrder ?? [];
  const tabs = [...SETTINGS_TABS]
    .filter((entry) => isOwner || !entry.ownerOnly)
    .sort((a, b) => {
      const rank = (entry) => {
        const at = order.indexOf(entry.id);
        return at < 0 ? Number.MAX_SAFE_INTEGER : at;
      };
      return rank(a) - rank(b);
    });

  /* Moving one, and saving where they all ended up. */
  const moveTab = async (id, by) => {
    const ids = tabs.map((entry) => entry.id);
    const at = ids.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    /* The owner-only ones a guest never sees are appended, so rearranging as
       somebody who cannot see them all does not throw the rest away. */
    const full = [...ids, ...SETTINGS_TABS.map((e) => e.id).filter((e) => !ids.includes(e))];
    await saveToggle('settingsTabOrder', full);
  };
  // The remembered tab can be one this profile is not offered — the owner
  // left Settings on Folders, then somebody else picked their own profile.
  const active = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id;

  // A profile that is not the owner is never told the roots, so the array is
  // simply absent rather than empty.
  const hasRoots = (settings.libraryRoots ?? []).length > 0;

  const here = tabs.find((entry) => entry.id === active);

  return (
    <>
      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="settings-nav-head">
            <h1>Settings</h1>
            <p>{(settings.libraryName || '').trim() || 'Your library'}</p>
          </div>

          <nav className="settings-nav-list">
            {tabs.map((entry, index) => (
              <div
                className={'settings-nav-slot' + (arranging ? ' arranging' : '')}
                key={entry.id}
              >
                <button
                  type="button"
                  className={'settings-nav-item' + (active === entry.id ? ' on' : '')}
                  aria-current={active === entry.id ? 'page' : undefined}
                  onClick={() => (arranging ? undefined : setTab(entry.id))}
                >
                  <span className="settings-nav-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">{TAB_ICONS[entry.id]}</svg>
                  </span>
                  <span className="settings-nav-word">{entry.label}</span>
                </button>

                {/*
                  * Rearranging is a mode rather than a handle on every row.
                  *
                  * These are pressed to get somewhere, constantly; arrows
                  * beside each one permanently would be two more things to
                  * miss the row with. Asked for, they appear; done, they go.
                  */}
                {arranging && (
                  <span className="settings-nav-move">
                    <button
                      type="button"
                      title={'Move ' + entry.label + ' up'}
                      aria-label={'Move ' + entry.label + ' up'}
                      disabled={index === 0}
                      onClick={() => moveTab(entry.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title={'Move ' + entry.label + ' down'}
                      aria-label={'Move ' + entry.label + ' down'}
                      disabled={index === tabs.length - 1}
                      onClick={() => moveTab(entry.id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                )}
              </div>
            ))}
          </nav>

          {isOwner && (
            <button
              type="button"
              className={'settings-arrange' + (arranging ? ' on' : '')}
              aria-pressed={arranging}
              onClick={() => setArranging(!arranging)}
            >
              {arranging ? 'Done rearranging' : 'Rearrange'}
            </button>
          )}
        </aside>

      <div className="settings">
        <header className="settings-pane-head">
          <h2>{here?.label}</h2>
          <p>{here?.hint}</p>
        </header>

        {active === 'overview' && (
          <Overview
            settings={settings}
            stats={stats}
            isOwner={isOwner}
            onGo={setTab}
          />
        )}

        {error && <div className="banner" style={{ margin: '0 0 18px' }}>{error}</div>}











        {active === 'library' && (
          <>
          <details className="settings-card" open>
            <summary><h2>Name</h2></summary>
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

            {/*
              * A second line, for when the name is initials.
              *
              * Left empty the door says "<name>'s Library", which is right
              * when the name is a person's. Filled in, the name stands on its
              * own and this explains it underneath, in the same colour.
              */}
            <div className="key-row">
              <input
                className="key-input"
                value={subtitle}
                placeholder="A line underneath — optional"
                maxLength={60}
                spellCheck={false}
                onChange={(event) => { setSubtitle(event.target.value); setNameSaved(false); }}
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

            {/*
              * What sits behind the library.
              *
              * Shown as five small panes rather than a dropdown, because this
              * is judged by looking at it — a list of the words "Glow",
              * "Aurora" and "Vignette" tells nobody anything. Each pane is
              * painted by the same stylesheet that paints the real thing, so
              * what is on offer is what arrives.
              */}
            <div className="bg-choice">
              <span className="settings-hint" style={{ margin: '0 0 8px' }}>
                Behind the library
              </span>
              <div className="bg-options">
                {BACKGROUNDS.map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    className={
                      (settings.background ?? 'flat') === id
                        ? 'bg-option selected' : 'bg-option'
                    }
                    title={hint}
                    aria-pressed={(settings.background ?? 'flat') === id}
                    onClick={() => saveToggle('background', id)}
                  >
                    <span
                      className={'bg-swatch ' + (backgroundClass(id) || 'bg-plain')}
                      /* The pane shows the colour the room will actually use:
                         the chosen one, or the library colour standing in for
                         whatever artwork happens to be on screen. */
                      style={{ '--bg-tint': settings.backgroundColor || color }}
                      aria-hidden="true"
                    />
                    <span className="bg-option-name">{label}</span>
                  </button>
                ))}
              </div>
              {/*
                * The colour every design is drawn from.
                *
                * Following the artwork is first and is the default, because it
                * costs nothing and the room then changes as you move through
                * the library. A fixed colour is for a household that would
                * rather it looked the same every time.
                */}
              <div className="backdrop-colour">
                <span className="settings-hint" style={{ margin: 0 }}>Colour</span>
                <button
                  type="button"
                  className={
                    (settings.backgroundColor ?? '')
                      ? 'backdrop-follow' : 'backdrop-follow selected'
                  }
                  onClick={() => saveToggle('backgroundColor', '')}
                >
                  Follow the artwork
                </button>

                {BACKDROP_COLOURS.filter(([value]) => value).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={value === settings.backgroundColor ? 'swatch selected' : 'swatch'}
                    style={{ background: value }}
                    title={label}
                    aria-label={label}
                    aria-pressed={value === settings.backgroundColor}
                    onClick={() => saveToggle('backgroundColor', value)}
                  />
                ))}

                {/* Anything not in the row, for a colour of their own. */}
                <label
                  className="swatch custom"
                  title="Custom colour"
                  style={{ background: settings.backgroundColor || '#0b0b0f' }}
                >
                  <input
                    type="color"
                    value={settings.backgroundColor || '#7d8aa0'}
                    onChange={(event) => saveToggle('backgroundColor', event.target.value)}
                  />
                </label>
              </div>

              {(settings.background ?? 'flat') !== 'flat' && (
                <label className="shelf-strength">
                  <span className="settings-hint" style={{ margin: 0 }}>Strength</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={settings.backgroundStrength ?? 100}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setSettings((previous) => ({ ...previous, backgroundStrength: value }));
                    }}
                    onPointerUp={(event) => saveToggle('backgroundStrength', Number(event.target.value))}
                    onKeyUp={(event) => saveToggle('backgroundStrength', Number(event.target.value))}
                    onTouchEnd={(event) => saveToggle('backgroundStrength', Number(event.target.value))}
                    aria-label="Backdrop strength"
                  />
                  <span className="shelf-strength-value">{settings.backgroundStrength ?? 100}%</span>
                </label>
              )}

              <p className="settings-hint" style={{ margin: '10px 0 0' }}>
                Everybody watching sees the same one.{' '}
                {(settings.backgroundColor ?? '')
                  ? 'The colour is fixed, so the room looks the same on every screen.'
                  : 'It takes its colour from whatever is on screen, so it follows the film rather than sitting on top of it.'}
              </p>
            </div>
          </details>

          {/*
            * How every row of covers is drawn.
            *
            * Chosen by looking, like the backdrop: each pane is three small
            * covers given the same treatment the real shelves get, so the
            * word underneath is a caption rather than the whole description.
            */}
          <details className="settings-card" open>
            <summary><h2>How shelves look</h2></summary>
            <p className="settings-hint">
              Every row of covers &mdash; your collections and the genres alike
              &mdash; is drawn from two choices that go together any way you like:
              what each cover looks like, and what the row stands on. The covers
              stay the same size, in the same order, whichever you pick.
            </p>

            <span className="settings-hint" style={{ margin: '0 0 8px' }}>Each cover</span>
            <div className="bg-options">
              {SHELF_STYLES.map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    (settings.shelfStyle ?? 'plain') === id
                      ? 'bg-option selected' : 'bg-option'
                  }
                  title={hint}
                  aria-pressed={(settings.shelfStyle ?? 'plain') === id}
                  onClick={() => saveToggle('shelfStyle', id)}
                >
                  <span
                    className={'shelf-swatch ' + (shelfStyleClass(id) || 'shelf-plain')}
                    style={{ '--tint': settings.shelfColor || settings.backgroundColor || color }}
                    aria-hidden="true"
                  >
                    <i /><i /><i />
                  </span>
                  <span className="bg-option-name">{label}</span>
                </button>
              ))}
            </div>
            <p className="settings-hint" style={{ margin: '8px 0 16px' }}>
              {(SHELF_STYLES.find(([id]) => id === (settings.shelfStyle ?? 'plain')) ?? SHELF_STYLES[0])[2]}.
            </p>

            <span className="settings-hint" style={{ margin: '0 0 8px' }}>Under each row</span>
            <div className="bg-options">
              {SHELF_ROWS.map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    (settings.shelfRow ?? 'none') === id
                      ? 'bg-option selected' : 'bg-option'
                  }
                  title={hint}
                  aria-pressed={(settings.shelfRow ?? 'none') === id}
                  onClick={() => saveToggle('shelfRow', id)}
                >
                  <span
                    className={'shelf-swatch ' + (shelfRowClass(id) || 'shelf-plain')}
                    style={{ '--tint': settings.shelfColor || settings.backgroundColor || color }}
                    aria-hidden="true"
                  >
                    <i /><i /><i />
                  </span>
                  <span className="bg-option-name">{label}</span>
                </button>
              ))}
            </div>
            <p className="settings-hint" style={{ margin: '8px 0 0' }}>
              {(SHELF_ROWS.find(([id]) => id === (settings.shelfRow ?? 'none')) ?? SHELF_ROWS[0])[2]}.
            </p>

            {/*
              * How much of it.
              *
              * The value changes as the thumb moves, so the number beside it
              * keeps up, and is written once the thumb is let go — a save on
              * every pixel of a drag would be a hundred saves for one choice.
              */}
            {SHELF_ROWS_WITH_STRENGTH.has(settings.shelfRow ?? 'none') && (
              <label className="shelf-strength">
                <span className="settings-hint" style={{ margin: 0 }}>Strength</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={settings.shelfStrength ?? 50}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSettings((previous) => ({ ...previous, shelfStrength: value }));
                  }}
                  onPointerUp={(event) => saveToggle('shelfStrength', Number(event.target.value))}
                  onKeyUp={(event) => saveToggle('shelfStrength', Number(event.target.value))}
                  onTouchEnd={(event) => saveToggle('shelfStrength', Number(event.target.value))}
                  aria-label="Strength"
                />
                <span className="shelf-strength-value">{settings.shelfStrength ?? 50}%</span>
              </label>
            )}

            {/* The colour the shelf, the spotlight and the pins are drawn in. */}
            <div className="backdrop-colour">
              <span className="settings-hint" style={{ margin: 0 }}>Colour</span>
              <button
                type="button"
                className={(settings.shelfColor ?? '') ? 'backdrop-follow' : 'backdrop-follow selected'}
                onClick={() => saveToggle('shelfColor', '')}
              >
                Follow the artwork
              </button>

              {SHELF_COLOURS.filter(([value]) => value).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={value === settings.shelfColor ? 'swatch selected' : 'swatch'}
                  style={{ background: value }}
                  title={label}
                  aria-label={label}
                  aria-pressed={value === settings.shelfColor}
                  onClick={() => saveToggle('shelfColor', value)}
                />
              ))}

              <label
                className="swatch custom"
                title="Custom colour"
                style={{ background: settings.shelfColor || '#0b0b0f' }}
              >
                <input
                  type="color"
                  value={settings.shelfColor || '#a8773f'}
                  onChange={(event) => saveToggle('shelfColor', event.target.value)}
                />
              </label>
            </div>

            <p className="settings-hint" style={{ margin: '10px 0 0' }}>
              {(settings.shelfColor ?? '')
                ? 'The shelf keeps this colour on every screen.'
                : 'The shelf takes its colour from whatever is on screen, like the backdrop.'}
              {' '}Everybody watching sees the same shelves.
            </p>
          </details>

          {/*
            * How much of a screen one cover takes.
            *
            * Offered as words rather than a slider: there are three sensible
            * answers and a slider would invite fiddling with a number that
            * does not want tuning.
            */}
          <details className="settings-card" open>
            <summary><h2>Cover size</h2></summary>
            <p className="settings-hint">
              How large the artwork is drawn, on every screen that draws it.
            </p>
            <div className="view-toggle" role="group" aria-label="Cover size">
              {CARD_SIZES.map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  title={hint}
                  aria-pressed={(settings.cardSize ?? 'medium') === id}
                  className={(settings.cardSize ?? 'medium') === id ? 'view-btn active' : 'view-btn'}
                  onClick={() => saveToggle('cardSize', id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="settings-hint" style={{ margin: '10px 0 0' }}>
              {(CARD_SIZES.find(([id]) => id === (settings.cardSize ?? 'medium')) ?? CARD_SIZES[1])[2]}.
            </p>
          </details>

          {/*
            * What the sidebar is made of.
            *
            * Three panes, each a small picture of the column against the
            * backdrop, because "glass" means nothing until it is seen.
            */}
          <details className="settings-card" open>
            <summary><h2>Sidebar</h2></summary>
            <p className="settings-hint">
              The column of sections down the left of a wide screen. A phone
              keeps its bar along the bottom either way.
            </p>
            <div className="bg-options">
              {RAIL_STYLES.map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    (settings.railStyle ?? 'glass') === id
                      ? 'bg-option selected' : 'bg-option'
                  }
                  title={hint}
                  aria-pressed={(settings.railStyle ?? 'glass') === id}
                  onClick={() => saveToggle('railStyle', id)}
                >
                  <span
                    className={'rail-swatch ' + (railStyleClass(id) || 'rail-solid')}
                    style={{ '--tint': settings.backgroundColor || color }}
                    aria-hidden="true"
                  >
                    <i /><i /><i />
                  </span>
                  <span className="bg-option-name">{label}</span>
                </button>
              ))}
            </div>
            {(settings.railStyle ?? 'glass') !== 'clear' && (
              <label className="shelf-strength">
                <span className="settings-hint" style={{ margin: 0 }}>Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.railOpacity ?? 45}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSettings((previous) => ({ ...previous, railOpacity: value }));
                  }}
                  onPointerUp={(event) => saveToggle('railOpacity', Number(event.target.value))}
                  onKeyUp={(event) => saveToggle('railOpacity', Number(event.target.value))}
                  onTouchEnd={(event) => saveToggle('railOpacity', Number(event.target.value))}
                  aria-label="Sidebar opacity"
                />
                <span className="shelf-strength-value">{settings.railOpacity ?? 45}%</span>
              </label>
            )}

            <p className="settings-hint" style={{ margin: '10px 0 0' }}>
              {(RAIL_STYLES.find(([id]) => id === (settings.railStyle ?? 'glass')) ?? RAIL_STYLES[1])[2]}.
              Everybody watching sees the same one.
            </p>
          </details>

          {/*
            * Which layouts exist, as opposed to which one somebody is using.
            *
            * The choice between rails, tiles and lines is made on the screen
            * itself and belongs to whoever is looking. What belongs here is
            * whether that choice is offered at all: a household that only ever
            * wants rails should not have two buttons inviting a change nobody
            * wants. Take them all but one away and the buttons disappear.
            */}
          <details className="settings-card" open>
            <summary><h2>How collections are shown</h2></summary>
            <p className="settings-hint">
              Collections can be laid out three ways on the Films, TV Shows and
              Comics screens, and anybody watching picks between whichever of them
              you leave switched on here.
            </p>

            {SHELF_LAYOUT_CHOICES.map(([id, name, hint]) => {
              const chosen = settings.shelfLayouts ?? SHELF_LAYOUT_CHOICES.map(([each]) => each);
              const on = chosen.includes(id);
              // Never all three off: something has to draw the collections.
              const last = on && chosen.length === 1;
              return (
                <label className="toggle-row" key={id}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={last}
                    onChange={(event) => {
                      const next = SHELF_LAYOUT_CHOICES
                        .map(([each]) => each)
                        .filter((each) => (each === id ? event.target.checked : chosen.includes(each)));
                      saveToggle('shelfLayouts', next.length ? next : ['rows']);
                    }}
                  />
                  <span>
                    <strong>{name}</strong>
                    <span className="toggle-note">
                      {last ? hint + ' — the only one left, so it stays' : hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </details>

          <details className="settings-card" open>
            <summary><h2>How the library is arranged</h2></summary>
            <p className="settings-hint">
              Films and series are normally shelved under genre headings. Where a
              library leans heavily one way — a shelf of cartoons that are all
              Animation — the headings say little, and a plain list reads better.
              Each screen is set on its own.
            </p>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.groupMoviesByGenre !== false}
                onChange={(event) => saveToggle('groupMoviesByGenre', event.target.checked)}
              />
              <span>
                <strong>Group Movies by genre</strong>
                <span className="toggle-note">
                  {settings.groupMoviesByGenre !== false
                    ? 'Shelved under genre headings'
                    : 'One plain list, A to Z'}
                </span>
              </span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.groupShowsByGenre !== false}
                onChange={(event) => saveToggle('groupShowsByGenre', event.target.checked)}
              />
              <span>
                <strong>Group TV Shows by genre</strong>
                <span className="toggle-note">
                  {settings.groupShowsByGenre !== false
                    ? 'Shelved under genre headings'
                    : 'One plain list, A to Z'}
                </span>
              </span>
            </label>

            <p className="settings-hint" style={{ margin: '10px 0 0' }}>
              The genre chips on those screens still filter whichever way this is
              set, so nothing is put out of reach by turning the headings off.
            </p>
          </details>

          </>
        )}

        {active === 'collections' && (
          <>
            <CollectionsPanel onChanged={onShelvesChanged} isOwner={isOwner} />

            {isOwner && (
              <details className="settings-card" open>
                <summary><h2>How the home screen is arranged</h2></summary>

                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.genreShelves !== false}
                    onChange={(event) => saveToggle('genreShelves', event.target.checked)}
                  />
                  <span>
                    <strong>Also shelve by genre</strong>
                    <span className="toggle-note">
                      {settings.genreShelves !== false
                        ? 'Action, Animation and the rest, worked out from the metadata'
                        : 'Off — your own shelves are the arrangement'}
                    </span>
                  </span>
                </label>

                <p className="settings-hint">
                  Your shelves always come first, above anything the library worked
                  out for itself. Turn the genre shelves off once you have made
                  enough of your own, and the home screen becomes exactly what you
                  arranged and nothing else.
                </p>
              </details>
            )}
          </>
        )}

        {active === 'profiles' && <ProfilesPanel isOwner={isOwner} />}

        {active === 'requests' && <RequestsPanel isOwner={isOwner} />}

        {active === 'sections' && (
          <SectionsPanel isOwner={isOwner} onChanged={onSettingsChanged} />
        )}

        {active === 'playback' && (
          <>
          <details className="settings-card" open>
            <summary><h2>Playback</h2></summary>
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
          </details>

          </>
        )}

        {active === 'sharing' && (
          <>
          <details className="settings-card" open>
            <summary><h2>Watch on other devices</h2></summary>
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
          </details>

          {/*
            * Televisions are the devices that cannot be asked to install
            * anything or to type a passcode, so they get their own switch.
            */}
          <details className="settings-card" open>
            <summary><h2>Watch on the television</h2></summary>
            <p className="settings-hint">
              A Roku, or any set that plays from a network, has no browser and will
              not install anything — but every one of them can already find media
              servers on the network. Switch this on and the library appears inside
              the television's own player, with your collections as its folders.
            </p>

            <label className="toggle-row">
              <input
                type="checkbox"
                disabled={!settings.remoteAccess}
                checked={settings.serveToTelevisions === true}
                onChange={(event) => saveToggle('serveToTelevisions', event.target.checked)}
              />
              <span>
                <strong>Let televisions find the library</strong>
                <span className="toggle-note">
                  {settings.serveToTelevisions
                    ? 'On this network, in the television’s media player'
                    : 'Off; televisions cannot see the library'}
                </span>
              </span>
            </label>

            {!settings.remoteAccess && (
              <p className="settings-hint" style={{ margin: '10px 0 0' }}>
                Turn sharing on first. A television is another device on the same
                network, so this is the same decision.
              </p>
            )}

            {settings.serveToTelevisions && (
              <p className="settings-hint" style={{ margin: '10px 0 0' }}>
                On the television, open its media player — <strong>Roku Media Player</strong>
                {' '}on a Roku — and the library is listed there. A set has no passcode
                to offer, so anything on this network can watch: right for a living
                room, wrong for a shared connection.
              </p>
            )}
          </details>

          {/*
            * Signing out matters on the devices that had to sign in.
            *
            * This computer is let in because it is this computer, so the button
            * would do nothing here — but the same settings screen is what a
            * tablet sees, and that is where somebody wants to hand the iPad to
            * a guest, or stop being signed in on a borrowed one.
            */}
          <details className="settings-card" open>
            <summary><h2>This device</h2></summary>
            <p className="settings-hint">
              Forget the passcode on this device. The library is still shared;
              this browser simply has to sign in again next time.
            </p>
            <div className="settings-actions">
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  try { await api.logout(); } catch { /* signing out locally regardless */ }
                  window.location.replace('/login');
                }}
              >
                Sign out
              </button>
            </div>
          </details>

          </>
        )}

        {active === 'maintenance' && (
          <>
          <details className="settings-card" open>
            <summary><h2>Folders</h2></summary>
            <p className="settings-hint">
              Point at any folder containing movies or TV shows. Sub-folders are searched
              automatically, and nothing needs renaming. Add as many as you like —
              a library spread over two drives is one library, and the scan reads
              all of them.
            </p>

            {!hasRoots && (
              <p className="settings-empty">No folders added yet.</p>
            )}

            {settings.rootsStatus.map((root) => (
              <div className="root-row" key={root.path}>
                <span className={root.available ? 'root-dot ok' : 'root-dot bad'} />
                <code className="root-path">{root.path}</code>
                {!root.available && <span className="root-warn">not connected</span>}
                <button
                  className="btn btn-ghost danger-text"
                  onClick={() => setDroppingRoot(root.path)}
                >
                  Remove
                </button>
              </div>
            ))}

            <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={() => setPicking('root')}>
              {hasRoots ? '+ Add another folder' : '+ Add folder'}
            </button>
          </details>

          <details className="settings-card" open>
            <summary><h2>Scan</h2></summary>

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
          </details>

          <HealthPanel />

          {merges.length > 0 && (
            <details className="settings-card" open>
              <summary><h2>Shows you joined</h2></summary>
              <p className="settings-hint" style={{ marginTop: 0 }}>
                These were answered "one show" and have been filed together ever
                since. Separating one puts it back to two and rescans; no episode
                is moved or lost either way, only the shelf it sits on.
              </p>

              {merges.map((entry) => (
                <div key={entry.alias} className="suggestion">
                  <div className="suggestion-text">
                    <strong>{entry.alias}&nbsp; joined into &nbsp;{entry.into}</strong>
                    <span>Filed as one show</span>
                  </div>
                  <div className="suggestion-actions">
                    <button
                      className="btn btn-secondary"
                      disabled={separating === entry.alias}
                      onClick={async () => {
                        setSeparating(entry.alias);
                        try {
                          await api.unmerge(entry.alias);
                          setMerges(await api.merges());
                          await load();
                        } catch (err) {
                          setError(err.message);
                        } finally {
                          setSeparating(null);
                        }
                      }}
                    >
                      {separating === entry.alias ? 'Separating…' : 'Separate again'}
                    </button>
                  </div>
                </div>
              ))}
            </details>
          )}

          {suggestions.length > 0 && (
            <details className="settings-card" open>
              <summary><h2>Is this one show or two?</h2></summary>
              <p className="settings-hint" style={{ marginTop: 0 }}>
                These titles look related. The scanner will not join them without
                being told to, because some series genuinely share a name with
                their own sequel.
              </p>

              {suggestions.map((entry) => (
                <div key={entry.id} className="suggestion">
                  <div className="suggestion-text">
                    <strong>{entry.titles?.join('  ·  ')}</strong>
                    <span>{entry.reason}</span>
                  </div>
                  <div className="suggestion-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => answerSuggestion(entry.id, 'merge')}
                    >
                      One show
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => answerSuggestion(entry.id, 'separate')}
                    >
                      Keep separate
                    </button>
                  </div>
                </div>
              ))}
            </details>
          )}

          <details className="settings-card" open>
            <summary><h2>Storage</h2></summary>
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
          </details>

          <details className="settings-card" open>
            <summary><h2>Status</h2></summary>
            <div className="status-row">
              <span>Artwork &amp; metadata</span>
              <span className={settings.tmdbConfigured ? 'ok-text' : 'warn-text'}>
                {!settings.tmdbConfigured
                  ? 'no API key configured'
                  : settings.tmdbKeyIsBundled
                    ? 'TMDB connected · included key'
                    : 'TMDB connected · your own key'}
              </span>
            </div>

            <div className="key-row">
              <input
                type="password"
                className="key-input"
                value={apiKey}
                placeholder={settings.tmdbConfigured ? 'Replace TMDB API key' : 'Paste your TMDB API key'}
                onChange={(event) => { setApiKey(event.target.value); setKeySaved(''); }}
                spellCheck={false}
              />
              <button
                className="btn btn-secondary"
                disabled={!apiKey.trim()}
                onClick={async () => {
                  try {
                    setSettings(await api.saveSettings({ tmdbApiKey: apiKey.trim() }));
                    setApiKey('');
                    setKeySaved('saved');
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                Save key
              </button>
            </div>
            {/*
              * Only offered once the user has replaced the included key, and only
              * when there is an included key to go back to. It is how a mistyped
              * or expired personal key gets undone without having to find the
              * original one again.
              */}
            {settings.tmdbKeyBundledAvailable && !settings.tmdbKeyIsBundled && (
              <button
                className="btn btn-ghost"
                style={{ marginTop: 10 }}
                onClick={async () => {
                  try {
                    setSettings(await api.saveSettings({ tmdbApiKey: '' }));
                    setApiKey('');
                    setKeySaved('included');
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                Use the included key
              </button>
            )}
            <p className="settings-hint" style={{ margin: '8px 0 0' }}>
              {keySaved === 'saved'
                ? 'Saved. Run a scan to fetch artwork and descriptions.'
                : keySaved === 'included'
                  ? 'Back to the key that came with the app.'
                  : settings.tmdbKeyIsBundled
                    ? 'A key comes with the app, so artwork and descriptions already work. Paste your own free key from themoviedb.org to use that instead.'
                    : 'A free key from themoviedb.org supplies posters, descriptions and episode titles.'}
            </p>
            <div className="status-row">
              <span>Player</span>
              <span className={settings.mpvPath ? 'ok-text' : 'warn-text'}>
                {settings.mpvPath || 'mpv not found'}
              </span>
            </div>
          </details>

          </>
        )}

      </div>
      </div>

      {droppingRoot && (
        <Confirm
          title="Stop reading this folder?"
          body={'Nothing on the disk is touched. Everything found in ' + droppingRoot
            + ' leaves the library at the next scan, and adding the folder back brings it all in again.'}
          confirmLabel="Stop reading it"
          onCancel={() => setDroppingRoot(null)}
          onConfirm={() => { const path = droppingRoot; setDroppingRoot(null); removeRoot(path); }}
        />
      )}

      {picking && (
        <FolderPicker
          onChoose={picking === 'data' ? chooseDataDir
            : picking === 'comics' ? addComicRoot
            : addRoot}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}

/**
 * What the library actually is, before anything is changed about it.
 *
 * The first thing this page said used to be "Appearance", which is somewhere
 * to change a colour rather than anything about the library itself. Somebody
 * opening Settings mostly wants to know how it is doing — how much is here,
 * who is watching, what is switched on, when it was last read — and only
 * sometimes wants to change something.
 *
 * Every figure here is one the library already keeps. Nothing is computed for
 * the sake of filling the page, and nothing is shown that would be a guess.
 */
function Overview({ settings, stats, isOwner, onGo }) {
  const [sections, setSections] = useState(null);
  const [profiles, setProfiles] = useState(null);

  useEffect(() => {
    api.sections().then((answer) => setSections(answer.sections ?? [])).catch(() => setSections([]));
    api.profiles().then((answer) => setProfiles(answer.profiles ?? answer ?? [])).catch(() => setProfiles([]));
  }, []);

  const on = (sections ?? []).filter((entry) => entry.on !== false);
  const lastScan = stats?.lastScan ? new Date(stats.lastScan) : null;

  /* Said the way somebody would say it, not as a date stamp. */
  const when = () => {
    if (!lastScan) return 'Not yet';
    const mins = Math.round((Date.now() - lastScan.getTime()) / 60000);
    if (mins < 2) return 'Just now';
    if (mins < 60) return mins + ' minutes ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours === 1 ? 'An hour ago' : hours + ' hours ago';
    const days = Math.round(hours / 24);
    return days === 1 ? 'Yesterday' : days + ' days ago';
  };

  return (
    <div className="overview">
      {/* The size of the thing, in the four numbers worth knowing. */}
      <div className="overview-figures">
        <div className="figure">
          <strong>{stats ? stats.movies : '—'}</strong>
          <span>Films</span>
        </div>
        <div className="figure">
          <strong>{stats ? stats.shows : '—'}</strong>
          <span>Series</span>
        </div>
        <div className="figure">
          <strong>{stats ? stats.episodes : '—'}</strong>
          <span>Episodes</span>
        </div>
        <div className="figure">
          <strong>{stats?.totalSize ? formatSize(stats.totalSize) : '—'}</strong>
          <span>On disk</span>
        </div>
      </div>

      <div className="overview-rows">
        {/* Where it reads from, and whether it can. */}
        {isOwner && (
          <button type="button" className="overview-row" onClick={() => onGo('maintenance')}>
            <span className="overview-row-name">
              <strong>Folders</strong>
              <span>
                {(settings.rootsStatus ?? []).length === 0
                  ? 'None yet — the library has nowhere to read from'
                  : (settings.rootsStatus ?? []).map((root) => root.path).join(' · ')}
              </span>
            </span>
            {(settings.rootsStatus ?? []).some((root) => !root.available) && (
              <span className="overview-warn">not connected</span>
            )}
            <span className="overview-row-more" aria-hidden="true">›</span>
          </button>
        )}

        <button type="button" className="overview-row" onClick={() => onGo('sections')}>
          <span className="overview-row-name">
            <strong>Sections</strong>
            <span>
              {sections === null ? 'Reading…'
                : on.length === 0 ? 'None switched on'
                  : on.map((entry) => entry.label).join(' · ')}
            </span>
          </span>
          <span className="overview-row-more" aria-hidden="true">›</span>
        </button>

        <button type="button" className="overview-row" onClick={() => onGo('profiles')}>
          <span className="overview-row-name">
            <strong>Who is watching</strong>
            <span>
              {profiles === null ? 'Reading…'
                : profiles.length === 1 ? 'Just you'
                  : profiles.length + ' profiles'}
            </span>
          </span>
          <span className="overview-row-more" aria-hidden="true">›</span>
        </button>

        {isOwner && (
          <button type="button" className="overview-row" onClick={() => onGo('maintenance')}>
            <span className="overview-row-name">
              <strong>Last read</strong>
              <span>{when()}</span>
            </span>
            <span className="overview-row-more" aria-hidden="true">›</span>
          </button>
        )}
      </div>
    </div>
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
