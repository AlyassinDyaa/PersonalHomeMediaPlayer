import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import SectionAccess from './SectionAccess.jsx';
import Confirm from './Confirm.jsx';
import FolderPicker from './FolderPicker.jsx';

/**
 * The parts of the library, and who is let into each.
 *
 * This replaces a page that was only ever about comics. The shape it had was
 * right — a switch, who may see it, where it looks, and a scan — but it was
 * written once for one section, so the next one would have meant writing it
 * again. It is written against a section now, and the list comes from the
 * server, so a section added later appears here without this file changing.
 *
 * Every switch asks before it moves. Turning a section off takes it away from
 * everybody who had it, and turning one on can put private files in front of
 * the house — neither is the kind of thing that should happen because
 * somebody's finger landed on a toggle while scrolling.
 */
export function SectionsPanel({ isOwner, onChanged }) {
  const [sections, setSections] = useState(null);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(null);
  const [scans, setScans] = useState({});

  const load = useCallback(() => {
    api.sections()
      .then((answer) => setSections(answer.sections ?? []))
      .catch((failure) => setError(failure.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Switching a section is confirmed first, and the wording says what it does
     to the people who are not in the room. */
  const askToSwitch = (section) => {
    const turningOn = !section.on;
    setAsking({
      kind: 'switch',
      section,
      title: turningOn
        ? 'Turn ' + section.label + ' on?'
        : 'Turn ' + section.label + ' off?',
      body: turningOn
        ? 'It appears for you straight away. Nobody else in the house sees it until you add them below.'
        : 'It disappears for everybody, including anybody you have already added. Nothing on the disk is touched, and switching it back on restores who had it.',
      confirmLabel: turningOn ? 'Turn it on' : 'Turn it off',
      danger: !turningOn,
    });
  };

  const doSwitch = async (section) => {
    setBusy(section.id);
    try {
      await api.setSectionOn(section.id, !section.on);
      load();
      onChanged?.();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  };

  const setRoots = async (section, roots) => {
    setBusy(section.id);
    try {
      await api.setSectionRoots(section.id, roots);
      load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  };

  /*
   * Up and down rather than dragging.
   *
   * Five rows do not need a drag, and a drag is the one interaction that
   * fails quietly on a touch screen and needs a fallback anyway. Two buttons
   * work everywhere, say what they will do, and can be pressed repeatedly
   * without the list moving out from under the finger.
   */
  const move = async (section, by) => {
    const order = sections.map((entry) => entry.id);
    const at = order.indexOf(section.id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];

    /* Shown before it is saved: a list that waits for a round trip before it
       moves feels like the button missed. */
    setSections(order.map((id) => sections.find((entry) => entry.id === id)));
    try {
      await api.setSectionOrder(order);
      onChanged?.();
    } catch (failure) {
      setError(failure.message);
      load();
    }
  };

  const scan = async (section) => {
    setBusy(section.id);
    setScans((was) => ({ ...was, [section.id]: { running: true } }));
    try {
      const result = section.id === 'comics'
        ? await api.scanComics()
        : await api.scanSection(section.id);
      setScans((was) => ({ ...was, [section.id]: { ...result, running: false } }));
      load();
    } catch (failure) {
      setScans((was) => ({ ...was, [section.id]: { running: false } }));
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  };

  /*
   * Say something while there is nothing to say.
   *
   * This drew nothing at all until the answer arrived, so anything that went
   * wrong before it did — a call that never resolved, a throw on the way in —
   * left an empty page that looked exactly like one still loading, and hid
   * the reason. Loading says it is loading, and a failure says what failed.
   */
  if (error && !sections) {
    return (
      <div className="settings-card" style={{ padding: 18 }}>
        <p className="settings-empty">The sections could not be read: {error}</p>
      </div>
    );
  }
  if (!sections) return <p className="settings-empty">Reading the sections…</p>;

  return (
    <>
      {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

      {/*
        * Open only what is in use.
        *
        * Five sections expanded at once is a page nobody can see the shape of,
        * and four of them are usually settled. One that is switched off has
        * nothing worth reading under it either — the switch says all of it — so
        * it stays shut until somebody opens it.
        */}
      {sections.map((section, index) => (
        <details
          className="settings-card"
          key={section.id}
          /* Keyed on the switch so turning one on opens it, rather than
             leaving somebody to wonder where the folder button went. */
          open={section.on}
        >
          <summary>
            <h2>{section.label}</h2>
            {/* Inside the summary, so they sit on the row the section is
                named on; the press must not also fold the card. */}
            <span className="section-move">
              <button
                type="button"
                className="chip"
                title={'Move ' + section.label + ' up'}
                aria-label={'Move ' + section.label + ' up'}
                disabled={index === 0}
                onClick={(event) => { event.preventDefault(); move(section, -1); }}
              >
                ↑
              </button>
              <button
                type="button"
                className="chip"
                title={'Move ' + section.label + ' down'}
                aria-label={'Move ' + section.label + ' down'}
                disabled={index === sections.length - 1}
                onClick={(event) => { event.preventDefault(); move(section, 1); }}
              >
                ↓
              </button>
            </span>
          </summary>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={section.on}
              disabled={busy === section.id}
              /* The change is not made here; the sheet below makes it. */
              onChange={() => askToSwitch(section)}
            />
            <span>
              <strong>{section.on ? 'Switched on' : 'Switched off'}</strong>
              <span className="toggle-note">{section.hint}</span>
            </span>
          </label>

          {section.on && (
            <>
              {/*
                * Where it looks, and what it found.
                *
                * Only for the sections that keep their own place: films and
                * television are read from the library folders on the
                * Maintenance page, and saying so twice would invite somebody
                * to set them in two places.
                */}
              {section.folders && (
                <>
                  <p className="settings-hint">
                    {section.roots.length === 0
                      ? 'Give it a folder and it will read what is in there. The folders inside become the groups.'
                      : 'The folders inside these become the groups you see. Add as many folders as you like; they are read together.'}
                  </p>

                  {section.roots.map((root) => {
                    const status = section.rootsStatus?.find((entry) => entry.path === root);
                    return (
                      <div className="root-row" key={root}>
                        <span className={status?.available ? 'root-dot ok' : 'root-dot bad'} />
                        <code className="root-path">{root}</code>
                        {!status?.available && <span className="root-warn">not connected</span>}
                        <button
                          className="btn btn-ghost danger-text"
                          disabled={busy === section.id}
                          onClick={() => setRoots(
                            section,
                            section.roots.filter((entry) => entry !== root),
                          )}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}

                  <div className="key-row">
                    <button
                      className="btn btn-secondary"
                      disabled={busy === section.id}
                      onClick={() => setAsking({ kind: 'folder', section })}
                    >
                      {section.roots.length ? '+ Add another folder' : '+ Add a folder'}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!section.roots.length || busy === section.id
                        || scans[section.id]?.running}
                      onClick={() => scan(section)}
                    >
                      {scans[section.id]?.running ? 'Reading…' : 'Scan ' + section.label}
                    </button>
                  </div>

                  {section.counts && (
                    <p className="settings-hint" style={{ margin: '10px 0 0' }}>
                      {section.counts.videos + section.counts.images === 0
                        ? 'Nothing found yet.'
                        : [
                          section.counts.videos ? section.counts.videos + ' videos' : null,
                          section.counts.images ? section.counts.images + ' pictures' : null,
                          section.counts.folders ? 'in ' + section.counts.folders + ' folders' : null,
                        ].filter(Boolean).join(' · ')}
                    </p>
                  )}

                  {scans[section.id] && !scans[section.id].running && scans[section.id].videos != null && (
                    <div className="scan-result">
                      Read <strong>{scans[section.id].videos}</strong> videos
                      and <strong>{scans[section.id].images}</strong> pictures.
                    </div>
                  )}
                </>
              )}

              {/* Who is in it. Nobody, until somebody is named. */}
              {isOwner && <SectionAccess section={section.id} noun={section.label} />}
            </>
          )}
        </details>
      ))}

      {asking?.kind === 'switch' && (
        <Confirm
          title={asking.title}
          body={asking.body}
          confirmLabel={asking.confirmLabel}
          danger={asking.danger}
          onCancel={() => setAsking(null)}
          onConfirm={() => { const { section } = asking; setAsking(null); doSwitch(section); }}
        />
      )}

      {asking?.kind === 'folder' && (
        <FolderPicker
          onCancel={() => setAsking(null)}
          onChoose={(folder) => {
            const { section } = asking;
            setAsking(null);
            setRoots(section, [...section.roots, folder]);
          }}
        />
      )}
    </>
  );
}

export default SectionsPanel;
