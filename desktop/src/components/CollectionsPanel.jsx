import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork } from '../api.js';
import FolderPicker from './FolderPicker.jsx';

/**
 * Building shelves by hand.
 *
 * Two ways to fill one, and the choice is made once when the shelf is created
 * because it changes what the shelf *is*. A picked shelf is a list somebody
 * maintains. A folder shelf is a question asked of the disk every time it is
 * shown — point it at a USB drive and the shelf fills when the drive is in and
 * empties when it is out, with nothing to tidy up either way.
 */
/**
 * Choose a badge for a shelf.
 *
 * Searches the metadata provider's company images, which is the practical
 * source for the marks people name a shelf after — DC, Marvel, Pixar,
 * Nickelodeon. A shelf with a badge is promoted to the rail of logos at the
 * top of the home screen; one without keeps an ordinary poster row, so this
 * is also how a shelf is given prominence.
 */
function LogoPicker({ collection, busy, run }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  async function search(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(await api.searchLogos(query.trim()));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="collection-logo">
      <div className="collection-logo-current">
        {collection.logo
          ? <img src={artwork(collection.logo, 'w300')} alt="" />
          : <span className="settings-empty" style={{ margin: 0 }}>No badge</span>}
        {collection.logo && (
          <button
            className="btn btn-ghost" disabled={busy}
            onClick={() => run(() => api.updateCollection(collection.id, { logo: null }))}
          >Remove badge</button>
        )}
      </div>

      <form className="collection-logo-search" onSubmit={search}>
        <input
          className="key-input"
          placeholder="Find a badge — DC, Marvel, Pixar, Nickelodeon"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-secondary" disabled={!query.trim() || searching}>
          {searching ? 'Looking…' : 'Search'}
        </button>
      </form>

      {results.length > 0 && (
        <div className="collection-logo-results">
          {results.map((entry) => (
            <button
              key={entry.id} className="logo-option" title={entry.name} disabled={busy}
              onClick={() => {
                run(() => api.updateCollection(collection.id, { logo: entry.logo }));
                setResults([]);
                setQuery('');
              }}
            >
              <img src={artwork(entry.logo, 'w300')} alt={entry.name} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollectionsPanel({ onChanged }) {
  const [collections, setCollections] = useState([]);
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(null);
  const [members, setMembers] = useState([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.collections(), api.items({ sort: 'title' })])
      .then(([list, all]) => { setCollections(list); setItems(all); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Whenever a shelf is opened, fetch what is actually on it.
  useEffect(() => {
    if (!open) { setMembers([]); return; }
    api.collectionItems(open).then(setMembers).catch(() => setMembers([]));
  }, [open, collections]);

  const refresh = useCallback(() => { load(); onChanged?.(); }, [load, onChanged]);

  const run = useCallback(async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const create = () => run(async () => {
    await api.createCollection({ name, folderPath: folderPath || null });
    setName('');
    setFolderPath('');
  });

  const openCollection = collections.find((entry) => entry.id === open) ?? null;
  const memberIds = useMemo(() => new Set(members.map((entry) => entry.id)), [members]);

  /** Titles not already on this shelf, narrowed by whatever was typed. */
  const candidates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return items
      .filter((item) => !memberIds.has(item.id))
      .filter((item) => !needle || item.title.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [items, memberIds, filter]);

  return (
    <section className="settings-card">
      <h2>Collections</h2>
      <p className="settings-hint">
        Your own shelves on the home screen. Either pick the titles yourself, or
        point a shelf at a folder and let it hold whatever is inside — useful for
        a USB drive, which fills the shelf when plugged in and empties it when not.
      </p>

      {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

      {collections.length === 0 && (
        <p className="settings-empty">No collections yet.</p>
      )}

      {collections.map((collection, index) => (
        <div key={collection.id} className="collection-row">
          <button
            className="collection-head"
            onClick={() => setOpen(open === collection.id ? null : collection.id)}
          >
            <span className="collection-name">{collection.name}</span>
            <span className="collection-meta">
              {collection.folderPath
                ? collection.folderPath + ' · ' + collection.count + ' found'
                : collection.count + (collection.count === 1 ? ' title' : ' titles')}
            </span>
          </button>

          <div className="collection-actions">
            <button
              className="btn btn-ghost" disabled={busy || index === 0}
              title="Move up"
              onClick={() => run(() => api.updateCollection(collection.id, { move: 'up' }))}
            >↑</button>
            <button
              className="btn btn-ghost" disabled={busy || index === collections.length - 1}
              title="Move down"
              onClick={() => run(() => api.updateCollection(collection.id, { move: 'down' }))}
            >↓</button>
            <button
              className="btn btn-ghost" disabled={busy}
              onClick={() => {
                const next = window.prompt('Rename this collection', collection.name);
                if (next && next.trim()) run(() => api.updateCollection(collection.id, { name: next }));
              }}
            >Rename</button>
            <button
              className="btn btn-ghost danger" disabled={busy}
              onClick={() => {
                /* The titles are untouched; only the shelf goes. */
                if (window.confirm('Remove the collection "' + collection.name + '"? The titles stay in your library.')) {
                  run(() => api.deleteCollection(collection.id));
                  if (open === collection.id) setOpen(null);
                }
              }}
            >Remove</button>
          </div>

          {open === collection.id && (
            <div className="collection-body">
              <LogoPicker collection={collection} busy={busy} run={run} />

              {collection.folderPath ? (
                <p className="settings-hint" style={{ margin: 0 }}>
                  This shelf follows <code>{collection.folderPath}</code>. Titles are
                  not added by hand — whatever the scan finds under that folder
                  appears here.
                  {collection.count === 0 && ' Nothing there at the moment, so the shelf is hidden.'}
                </p>
              ) : (
                <>
                  <div className="collection-members">
                    {members.length === 0 && <p className="settings-empty">Nothing on this shelf yet.</p>}
                    {members.map((item) => (
                      <span key={item.id} className="chip">
                        {item.title}
                        <button
                          className="chip-x" title="Take off this shelf" disabled={busy}
                          onClick={() => run(() => api.removeFromCollection(collection.id, item.id))}
                        >×</button>
                      </span>
                    ))}
                  </div>

                  <input
                    className="key-input"
                    placeholder="Search your library to add a title"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    spellCheck={false}
                  />
                  <div className="collection-candidates">
                    {candidates.map((item) => (
                      <button
                        key={item.id} className="btn btn-ghost" disabled={busy}
                        onClick={() => run(() => api.addToCollection(collection.id, item.id))}
                      >
                        + {item.title}{item.year ? ' (' + item.year + ')' : ''}
                      </button>
                    ))}
                    {candidates.length === 0 && (
                      <p className="settings-empty">
                        {filter.trim() ? 'Nothing matches that.' : 'Everything is already on this shelf.'}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="collection-new">
        <h3>New collection</h3>
        <div className="key-row">
          <input
            className="key-input"
            placeholder="Name it — Saturday Mornings, Kids, Comfort Films"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) create(); }}
          />
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            Create
          </button>
        </div>

        <div className="key-row" style={{ marginTop: 10 }}>
          <input
            className="key-input"
            placeholder="Optional: a folder this shelf should follow"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-secondary" onClick={() => setPicking(true)}>Choose folder</button>
          {folderPath && (
            <button className="btn btn-ghost" onClick={() => setFolderPath('')}>Clear</button>
          )}
        </div>
        <p className="settings-hint" style={{ margin: '8px 0 0' }}>
          {folderPath
            ? 'This shelf will hold whatever the library finds under that folder.'
            : 'Leave the folder empty to pick the titles yourself.'}
        </p>
      </div>

      {picking && (
        <FolderPicker
          onChoose={(chosen) => { setFolderPath(chosen); setPicking(false); }}
          onCancel={() => setPicking(false)}
        />
      )}
    </section>
  );
}

export default CollectionsPanel;
