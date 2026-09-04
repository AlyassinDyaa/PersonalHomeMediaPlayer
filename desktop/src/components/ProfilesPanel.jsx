import React, { useCallback, useEffect, useState } from 'react';
import { api, rememberProfile } from '../api.js';

/** The rating a kids profile is held to, highest first as they are offered. */
const LIMITS = [
  { value: '', label: 'Everything' },
  { value: 'PG-13', label: 'Up to PG-13' },
  { value: 'PG', label: 'Up to PG' },
  { value: 'G', label: 'G and TV-Y only' },
];

/**
 * The people who use this library.
 *
 * Everybody can see the list and change which of them they are. Only the owner
 * can add, remove or edit one, because a profile is what decides who may see
 * the drives — a library where any viewer could mint themselves a new profile
 * would be a library with no owner at all.
 */
export function ProfilesPanel({ isOwner }) {
  const [profiles, setProfiles] = useState(null);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await api.profiles();
      setProfiles(answer.profiles);
      setCurrent(answer.current);
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /*
   * Switching is done by forgetting who we are and reloading.
   *
   * Everything on screen was fetched as this profile — the shelves, the rows,
   * the half-finished episodes — so re-asking for all of it piecemeal would be
   * a longer way to arrive at the same place, with more chances to leave one
   * stale panel behind.
   */
  const switchProfile = useCallback(() => {
    rememberProfile(null);
    window.location.reload();
  }, []);

  const save = useCallback(async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        const patch = {
          name: draft.name,
          kind: draft.kind,
          maxCertification: draft.maxCertification || null,
        };
        // An untouched PIN field must not clear the PIN that is already set,
        // so the key is only sent when something was typed into it.
        if (draft.pin !== undefined) patch.pin = draft.pin;
        await api.updateProfile(draft.id, patch);
      } else {
        await api.createProfile({
          name: draft.name,
          kind: draft.kind,
          pin: draft.pin ?? '',
          maxCertification: draft.maxCertification || null,
        });
      }
      setDraft(null);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  const remove = useCallback(async (profile) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProfile(profile.id);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (!profiles) {
    return <div className="center-note"><div className="spinner" /></div>;
  }

  return (
    <>
      <section className="settings-card">
        <h2>Who&rsquo;s watching</h2>
        <p className="settings-hint">
          Each profile keeps its own Continue Watching, its own favourites, and its own
          place in every episode. Everyone still reaches the library with the same
          passcode &mdash; a profile says which of you is watching, not who is allowed in.
        </p>

        {error && <div className="banner" style={{ margin: '0 0 14px' }}>{error}</div>}

        <ul className="profile-list">
          {profiles.map((profile) => (
            <li key={profile.id} className="profile-list-item">
              <span className="profile-face profile-face-small" style={{ background: profile.colour }}>
                {[...profile.name][0]?.toUpperCase()}
              </span>
              <span className="profile-list-name">
                {profile.name}
                {profile.id === current?.id && <span className="profile-tag">You</span>}
                {profile.isOwner && <span className="profile-tag">Owner</span>}
                {profile.kind === 'kid' && <span className="profile-tag">Kids</span>}
                {profile.hasPin && <span className="profile-tag">PIN</span>}
              </span>
              {isOwner && (
                <span className="profile-list-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => setDraft({
                      id: profile.id,
                      name: profile.name,
                      kind: profile.kind,
                      maxCertification: profile.maxCertification ?? '',
                    })}
                  >
                    Edit
                  </button>
                  {!profile.isOwner && (
                    <button
                      type="button"
                      className="btn-ghost danger-text"
                      disabled={busy}
                      onClick={() => remove(profile)}
                    >
                      Remove
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="settings-actions">
          {profiles.length > 1 && (
            <button type="button" className="btn-ghost" onClick={switchProfile}>
              Switch profile
            </button>
          )}
          {isOwner && !draft && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setDraft({ name: '', kind: 'adult', maxCertification: '' })}
            >
              Add a profile
            </button>
          )}
        </div>
      </section>

      {draft && (
        <section className="settings-card">
          <h2>{draft.id ? 'Edit profile' : 'New profile'}</h2>
          <form onSubmit={save} className="profile-form">
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                autoFocus
                maxLength={40}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Their name"
              />
            </label>

            <label className="field">
              <span>Kind</span>
              <select
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
              >
                <option value="adult">Anyone</option>
                <option value="kid">Kids</option>
              </select>
            </label>

            <label className="field">
              <span>Can watch</span>
              <select
                value={draft.maxCertification}
                onChange={(event) => setDraft({ ...draft, maxCertification: event.target.value })}
              >
                {LIMITS.map((limit) => (
                  <option key={limit.value} value={limit.value}>{limit.label}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={draft.pin ?? ''}
                onChange={(event) => setDraft({
                  ...draft,
                  pin: event.target.value.replace(/\D/g, ''),
                })}
                placeholder={draft.id ? 'Leave blank to keep it as it is' : 'Optional, four digits or more'}
              />
            </label>

            <p className="settings-hint">
              A title with no rating at all is hidden from a limited profile, not shown.
              Most of a library is rated, and the rest is usually the part nobody checked.
            </p>

            <div className="settings-actions">
              <button type="button" className="btn-ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </section>
      )}

      {!isOwner && (
        <div className="settings-owner-only">
          Only the owner of this library can add or change profiles, or see where the
          films are kept. You can still choose which profile you are watching as.
        </div>
      )}
    </>
  );
}

export default ProfilesPanel;
