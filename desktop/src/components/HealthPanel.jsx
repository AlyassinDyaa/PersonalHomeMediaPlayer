import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * What is wrong with the library, said plainly.
 *
 * Deliberately not run on its own: checking every file means touching several
 * thousand paths across external drives, which is not something to do quietly
 * every time somebody opens settings. It is asked for, and it says how long
 * ago it was asked.
 *
 * Nothing here is repaired automatically. A missing episode cannot be
 * conjured, and a file that moved might be coming back — the useful thing is
 * knowing precisely which episode and which file, which is what this says.
 */
export function HealthPanel() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ranAt, setRanAt] = useState(null);
  const [open, setOpen] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.libraryHealth());
      setRanAt(new Date());
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, []);

  /*
   * Nothing runs until this is opened.
   *
   * The file check touches several thousand paths across external drives,
   * which is not something to do quietly every time somebody opens the tab to
   * press Scan. Opening the section is the request.
   */
  useEffect(() => {
    if (open && !report && !busy) check();
  }, [open, report, busy, check]);

  return (
    <section className="settings-card">
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <h2>Needs attention</h2>
        <span className="settings-disclosure-mark">{open ? '▾' : '▸'}</span>
      </button>

      {!open && (
        <p className="settings-hint" style={{ margin: 0 }}>
          {report
            ? (report.problems === 0
                ? 'Nothing to report.'
                : report.problems + (report.problems === 1 ? ' thing' : ' things') + ' worth a look.')
            : 'Gaps in a season, files that have moved, titles nothing was found for.'}
        </p>
      )}

      {open && (
      <>

      {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

      {!report && busy && <p className="settings-hint">Checking the library…</p>}

      {report && (
        <>
          <p className="settings-hint">
            {report.problems === 0
              ? 'Nothing to report. Every file is where the library expects it, '
                + 'every title is matched, and no season has a gap in it.'
              : report.problems + (report.problems === 1 ? ' thing' : ' things')
                + ' worth a look. ' + report.checkedFiles + ' files checked.'}
          </p>

          {report.incomplete.length > 0 && (
            <div className="health-group">
              <h3>Seasons with missing episodes</h3>
              <ul className="health-list">
                {report.incomplete.map((show) => (
                  <li key={show.id}>
                    <strong>{show.title}</strong>
                    {show.year ? <span className="health-year"> ({show.year})</span> : null}
                    <ul>
                      {show.seasons.map((season) => (
                        <li key={season.season}>
                          Season {season.season} — missing {season.summary}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="settings-hint">
                Only gaps below the highest episode present are counted. A season that
                simply stops early may be complete, and there is no way to tell from
                the files alone.
              </p>
            </div>
          )}

          {report.missingFiles.length > 0 && (
            <div className="health-group">
              <h3>Files the library can no longer find</h3>
              <ul className="health-list">
                {report.missingFiles.slice(0, 25).map((file) => (
                  <li key={file.id}>
                    <strong>{file.title}</strong>
                    <code className="health-path">{file.path}</code>
                  </li>
                ))}
              </ul>
              {report.missingFiles.length > 25 && (
                <p className="settings-hint">
                  …and {report.missingFiles.length - 25} more. A rescan removes them
                  once the drive they were on is genuinely gone.
                </p>
              )}
            </div>
          )}

          {report.unmatched.length > 0 && (
            <div className="health-group">
              <h3>Titles nothing was found for</h3>
              <ul className="health-list">
                {report.unmatched.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    {item.year ? <span className="health-year"> ({item.year})</span> : null}
                  </li>
                ))}
              </ul>
              <p className="settings-hint">
                These play perfectly well; they just have no artwork or description.
                Opening one and using “Wrong title?” sets it right.
              </p>
            </div>
          )}

          {report.emptyCollections.length > 0 && (
            <div className="health-group">
              <h3>Collections with nothing in them</h3>
              <ul className="health-list">
                {report.emptyCollections.map((collection) => (
                  <li key={collection.id}><strong>{collection.name}</strong></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="settings-actions">
        <button className="btn btn-ghost" onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {ranAt && (
          <span className="settings-hint" style={{ margin: 0 }}>
            Last checked {ranAt.toLocaleTimeString()}
          </span>
        )}
      </div>
      </>
      )}
    </section>
  );
}

export default HealthPanel;
