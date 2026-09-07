import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, artwork } from '../api.js';
import FolderPicker from './FolderPicker.jsx';
import Confirm from './Confirm.jsx';
import Overlay from './Overlay.jsx';

/**
 * The shelves this library is arranged into.
 *
 * They belong to the library rather than to whoever is looking at it: the
 * owner arranges them and everybody sees the same arrangement, which is the
 * point of arranging anything in a house. So this reads for everyone and is
 * editable only by the owner — and the server enforces that too, since a
 * hidden button is a courtesy rather than a rule.
 *
 * Two decisions shape this page. Shelves are listed under the screen they
 * appear on, because "which shelves are on Films" is the question somebody
 * actually arrives with. And editing one happens in a sheet rather than by
 * unfolding the row: the picker inside is a wall of posters, and unfolding it
 * pushed every other shelf off the screen, so opening one shelf meant losing
 * sight of the rest.
 */

/** Where a shelf can appear, and what to call each place. */
const PLACES = [
  ['movie', 'Films'],
  ['show', 'TV Shows'],
  ['both', 'Both'],
];

/** Remembers whether the whole section was put away. */
const SHUT_KEY = 'collectionsShut';

/** The order the groups are listed in, and what to head each with. */
const GROUPS = [
  ['movie', 'On Films'],
  ['show', 'On TV Shows'],
  ['both', 'On both screens'],
];

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
        {/* The picture keeps its place whether or not there is one, so nothing
            below it jumps when a badge is chosen. */}
        <div className={collection.logo ? 'collection-logo-slot has-badge' : 'collection-logo-slot'}>
          {collection.logo
            ? <img src={artwork(collection.logo, 'w300')} alt="" />
            : <span>No badge</span>}
        </div>
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

/**
 * Whether a shelf can hold this title.
 *
 * A shelf shown on Films holds films; one shown on TV Shows holds shows. Both
 * holds either. Offering the wrong ones would let a film be filed onto a shelf
 * that never appears on the screen films are browsed from — filed correctly,
 * as far as the database is concerned, and invisible.
 */
function canHold(collection, item) {
  if (collection.folderPath) return false;
  const where = collection.shownOn ?? 'both';
  if (where === 'both') return true;
  return where === (item.kind === 'movie' ? 'movie' : 'show');
}

/**
 * Send one title to another shelf.
 *
 * The shelves are the answer, so the shelves are the list — not a search box
 * or a dropdown. There are rarely more than a dozen, they are already named by
 * the person reading, and the whole decision is one press.
 */
function MoveSheet({ item, from, collections, busy, onClose, onChoose }) {
  const options = collections.filter((entry) => entry.id !== from.id && canHold(entry, item));

  return (
    <Overlay>
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal shelf-sheet"
        role="dialog" aria-modal="true" aria-label={'Move ' + item.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shelf-sheet-head">
          <div>
            <h3>Move “{item.title}”</h3>
            <span className="settings-hint" style={{ margin: 0 }}>
              Off {from.name}, onto whichever shelf you pick.
            </span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>

        <div className="shelf-sheet-body">
          {options.length === 0 ? (
            <p className="settings-empty" style={{ margin: 0 }}>
              There is no other shelf on the {item.kind === 'movie' ? 'Films' : 'TV Shows'} screen
              to move this to. Make one first, or set an existing shelf to show there.
            </p>
          ) : (
            <div className="shelf-list">
              {options.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="shelf-item"
                  disabled={busy}
                  onClick={() => onChoose(entry)}
                >
                  {entry.logo
                    ? <img className="shelf-item-badge" src={artwork(entry.logo, 'w300')} alt="" />
                    : <span className="shelf-item-badge blank" aria-hidden="true">{entry.name.charAt(0)}</span>}
                  <span className="shelf-item-text">
                    <strong>{entry.name}</strong>
                    <span>{entry.count + (entry.count === 1 ? ' title' : ' titles')}</span>
                  </span>
                  <span className="shelf-item-more" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </Overlay>
  );
}

/**
 * Everything about one shelf, in a sheet over the list.
 *
 * What is *not* here is as deliberate as what is: there is no wall of posters
 * to pick from. Titles are gathered from the Films and TV Shows screens with
 * the + button, where the covers are already in front of you at the size you
 * chose them by. Duplicating that here made this page enormous and the choice
 * worse, because it was a list of names rather than a shelf of covers.
 */
function ShelfSheet({ collection, members, busy, run, onClose, onRename, onRemove, onMove, canMoveUp, canMoveDown }) {
  return (
    <Overlay>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shelf-sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="shelf-sheet-head">
          <div>
            <h3>{collection.name}</h3>
            <span className="settings-hint" style={{ margin: 0 }}>
              {collection.folderPath
                ? collection.folderPath
                : collection.count + (collection.count === 1 ? ' title' : ' titles')}
            </span>
          </div>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>

        <div className="shelf-sheet-body">
          <div className="shelf-where">
            <span className="shelf-where-label">Shown on</span>
            {/* One choice out of three, so it is drawn as one control rather
                than as three buttons that happen to sit together. */}
            <div className="shelf-kinds" role="group">
              {PLACES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={(collection.shownOn ?? 'both') === id ? 'chip on' : 'chip'}
                  aria-pressed={(collection.shownOn ?? 'both') === id}
                  disabled={busy}
                  onClick={() => run(() => api.updateCollection(collection.id, { shownOn: id }))}
                >{label}</button>
              ))}
            </div>
          </div>

          <LogoPicker collection={collection} busy={busy} run={run} />

          {collection.folderPath ? (
            <p className="settings-hint">
              This shelf follows <code>{collection.folderPath}</code>. Whatever the scan finds
              under that folder appears here; nothing is added by hand.
            </p>
          ) : (
            <>
              <div className="shelf-sheet-members">
                {members.length === 0
                  ? <p className="settings-empty" style={{ margin: 0 }}>Nothing on this shelf yet.</p>
                  : members.map((item) => (
                    /* Not the same shape as the control above it: these are
                       things on the shelf, not a choice between three. The
                       name moves the title, the cross takes it off. */
                    <span key={item.id} className="shelf-member">
                      <button
                        type="button" className="shelf-member-name" disabled={busy}
                        title={'Move “' + item.title + '” to another collection'}
                        onClick={() => onMove?.(item)}
                      >{item.title}</button>
                      <button
                        type="button" className="shelf-member-x" disabled={busy}
                        title={'Take “' + item.title + '” off this shelf'}
                        aria-label={'Take “' + item.title + '” off this shelf'}
                        onClick={() => run(() => api.removeFromCollection(collection.id, item.id))}
                      >×</button>
                    </span>
                  ))}
              </div>

              <p className="settings-hint">
                Press a title to move it to another collection, or its cross to take it
                off this one. Add titles from the {(PLACES.find(([id]) => id === (collection.shownOn ?? 'both')) ?? PLACES[2])[1]}
                {' '}screen: press <strong>+</strong> beside the search box, tap the covers you want,
                then choose this shelf.
              </p>
            </>
          )}
        </div>

        {/*
          * Four things that do four different jobs, and now look like it:
          * renaming is an ordinary action, moving is a pair of nudges drawn as
          * one control, and removing is the only one that cannot be undone.
          */}
        <div className="shelf-sheet-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRename}>Rename</button>

          <div className="shelf-order" role="group" aria-label="Where this shelf sits">
            <button
              type="button" className="btn btn-ghost" disabled={busy || !canMoveUp}
              title="Move this shelf earlier" aria-label="Move this shelf earlier"
              onClick={() => run(() => api.updateCollection(collection.id, { move: 'up' }))}
            >↑<span className="shelf-order-word"> Earlier</span></button>
            <button
              type="button" className="btn btn-ghost" disabled={busy || !canMoveDown}
              title="Move this shelf later" aria-label="Move this shelf later"
              onClick={() => run(() => api.updateCollection(collection.id, { move: 'down' }))}
            >↓<span className="shelf-order-word"> Later</span></button>
          </div>

          <span className="shelf-sheet-gap" />
          <button type="button" className="btn btn-ghost danger" disabled={busy} onClick={onRemove}>Remove</button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}

export function CollectionsPanel({ onChanged, isOwner = true }) {
  const [collections, setCollections] = useState([]);
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  /* Which screen a new shelf will appear on. Films, because most are. */
  const [shownOn, setShownOn] = useState('movie');
  const [picking, setPicking] = useState(false);
  /** The shelf whose sheet is open. */
  const [open, setOpen] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  /* A shelf about to be renamed or removed, waiting to be asked about. */
  const [asking, setAsking] = useState(null);
  /** A title being sent to another shelf. */
  const [moving, setMoving] = useState(null);
  /*
   * Groups folded away, by the screen they belong to.
   *
   * Open to begin with: a page that hides its contents until asked is worse
   * than a long one. Folding is for when a library has grown enough that the
   * group you want is below the fold — which is exactly when somebody wants to
   * put the other two away.
   */
  const [folded, setFolded] = useState(() => new Set());

  /*
   * Whether the whole section is put away.
   *
   * Settings is a long page and this is the longest thing on it — every shelf
   * in the library, under three headings, above a form for making another. Put
   * away it is one line, and it stays that way between visits, because someone
   * who folds a section has said what they want done with it.
   */
  const [shut, setShut] = useState(() => {
    try {
      return window.localStorage.getItem(SHUT_KEY) === 'yes';
    } catch {
      // A private window or a locked-down profile can refuse storage outright.
      return false;
    }
  });

  const toggleSection = () => setShut((current) => {
    const next = !current;
    try { window.localStorage.setItem(SHUT_KEY, next ? 'yes' : 'no'); } catch { /* not important enough to fail over */ }
    return next;
  });

  const fold = (id) => setFolded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const load = useCallback(() => {
    api.collections()
      .then(setCollections)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Whatever is on the open shelf, fetched when it opens and after any change.
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
    await api.createCollection({ name, folderPath: folderPath || null, shownOn });
    setName('');
    setFolderPath('');
  });

  /** The shelves, under the screen each belongs to. */
  const grouped = useMemo(
    () => GROUPS.map(([id, heading]) => ({
      id,
      heading,
      shelves: collections.filter((entry) => (entry.shownOn ?? 'both') === id),
    })).filter((group) => group.shelves.length > 0),
    [collections],
  );

  const openShelf = collections.find((entry) => entry.id === open) ?? null;
  const openIndex = collections.findIndex((entry) => entry.id === open);

  return (
    <section className={shut ? 'settings-card is-shut' : 'settings-card'}>
      <button
        type="button"
        className={shut ? 'settings-fold folded' : 'settings-fold'}
        aria-expanded={!shut}
        onClick={toggleSection}
      >
        <span className="settings-fold-caret" aria-hidden="true">▾</span>
        <h2>Collections</h2>
        <span className="settings-fold-count">
          {collections.length === 1 ? '1 shelf' : collections.length + ' shelves'}
        </span>
      </button>

      {!shut && (
      <>
      <p className="settings-hint">
        {isOwner
          ? 'How this library is arranged, and what everybody sees. A shelf sits at the top of the screen you give it, above the genres.'
          : 'How this library is arranged. These shelves are set by whoever looks after the library.'}
      </p>

      {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

      {collections.length === 0 && (
        <p className="settings-empty">No shelves yet.</p>
      )}

      {grouped.map((group) => (
        <div className="shelf-group" key={group.id}>
          <button
            type="button"
            className={folded.has(group.id) ? 'shelf-group-head folded' : 'shelf-group-head'}
            aria-expanded={!folded.has(group.id)}
            onClick={() => fold(group.id)}
          >
            <span className="shelf-group-caret" aria-hidden="true">▾</span>
            {group.heading}
            <span>{group.shelves.length}</span>
          </button>

          {!folded.has(group.id) && (
          <div className="shelf-list">
            {group.shelves.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className="shelf-item"
                disabled={!isOwner}
                onClick={() => isOwner && setOpen(collection.id)}
              >
                {collection.logo
                  ? <img className="shelf-item-badge" src={artwork(collection.logo, 'w300')} alt="" />
                  : <span className="shelf-item-badge blank" aria-hidden="true">{collection.name.charAt(0)}</span>}

                <span className="shelf-item-text">
                  <strong>{collection.name}</strong>
                  <span>
                    {collection.folderPath
                      ? collection.folderPath + ' · ' + collection.count + ' found'
                      : collection.count + (collection.count === 1 ? ' title' : ' titles')}
                  </span>
                </span>

                {isOwner && <span className="shelf-item-more" aria-hidden="true">›</span>}
              </button>
            ))}
          </div>
          )}
        </div>
      ))}

      {isOwner && (
        <div className="collection-new">
          <h3>New shelf</h3>

          <div className="key-row">
            <input
              className="key-input"
              placeholder="Name it — Saturday Mornings, Kids, Comfort Films"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) create(); }}
              spellCheck={false}
            />
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>
              Create
            </button>
          </div>

          <div className="shelf-where" style={{ marginTop: '10px' }}>
            <span className="shelf-where-label">Shown on</span>
            <div className="shelf-kinds">
              {PLACES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={shownOn === id ? 'chip on' : 'chip'}
                  onClick={() => setShownOn(id)}
                >{label}</button>
              ))}
            </div>
          </div>

          <details className="shelf-folder">
            <summary>Or point it at a folder</summary>
            <div className="key-row" style={{ marginTop: '10px' }}>
              <input
                className="key-input"
                placeholder="A folder this shelf should follow"
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
              A folder shelf holds whatever is inside it — useful for a USB drive, which fills the
              shelf when plugged in and empties it when not.
            </p>
          </details>
        </div>
      )}
      </>
      )}

      {openShelf && (
        <ShelfSheet
          collection={openShelf}
          members={members}
          busy={busy}
          run={run}
          canMoveUp={openIndex > 0}
          canMoveDown={openIndex < collections.length - 1}
          onClose={() => setOpen(null)}
          onMove={(item) => setMoving(item)}
          onRename={() => setAsking({ what: 'rename', collection: openShelf })}
          onRemove={() => setAsking({ what: 'remove', collection: openShelf })}
        />
      )}

      {moving && openShelf && (
        <MoveSheet
          item={moving}
          from={openShelf}
          collections={collections}
          busy={busy}
          onClose={() => setMoving(null)}
          onChoose={(target) => {
            const item = moving;
            setMoving(null);
            run(() => api.moveBetweenCollections(openShelf.id, target.id, [item.id]));
          }}
        />
      )}

      {asking?.what === 'rename' && (
        <Confirm
          title={'Rename “' + asking.collection.name + '”'}
          confirmLabel="Rename"
          danger={false}
          field={{ label: 'Call it', value: asking.collection.name, placeholder: 'A name for this shelf' }}
          onCancel={() => setAsking(null)}
          onConfirm={(next) => {
            const { collection } = asking;
            setAsking(null);
            run(() => api.updateCollection(collection.id, { name: next }));
          }}
        />
      )}

      {asking?.what === 'remove' && (
        <Confirm
          title={'Remove “' + asking.collection.name + '”?'}
          body="The shelf goes; every title on it stays in your library."
          confirmLabel="Remove the shelf"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const { collection } = asking;
            setAsking(null);
            setOpen(null);
            run(() => api.deleteCollection(collection.id));
          }}
        />
      )}

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
