import React, { useCallback, useEffect, useState } from 'react';
import ProfileFace from './ProfileFace.jsx';
import AvatarCropper from './AvatarCropper.jsx';
import { api, rememberProfile } from '../api.js';

/**
 * The colours a profile can wear.
 *
 * Matches the palette the server assigns from, so a profile somebody chose a
 * colour for and one that was given one automatically look like they belong to
 * the same library.
 */
/** "3 minutes ago", near enough for a glance. */
function whenSeen(at) {
  if (!at) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.round(hours / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}

const PROFILE_COLOURS = ['#e50914', '#0071eb', '#e6b91e', '#1db954', '#b14ae0', '#ff6b35'];

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
  /** The file being cropped, before it becomes a picture. */
  const [cropping, setCropping] = useState(null);
  /** Set when adjusting the picture already saved, rather than a new one. */
  const [editingSource, setEditingSource] = useState(null);
  /** A PIN change waiting to be confirmed; holds what was typed. */
  const [confirmPin, setConfirmPin] = useState(null);

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
  /*
   * Switching profile signs out.
   *
   * Signing in is now done by choosing a face, so the session itself names who
   * is watching — forgetting the choice locally and reloading simply brought
   * the same person back. Ending the session is what returns to the door.
   */
  const switchProfile = useCallback(async () => {
    rememberProfile(null);
    try { await api.logout(); } catch { /* leaving regardless */ }
    window.location.replace('/login');
  }, []);

  /** Write the draft. Split out so confirming a PIN can call it directly. */
  const commit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        const patch = {
          name: draft.name,
          kind: draft.kind,
          maxCertification: draft.maxCertification || null,
        };
        if (draft.colour) patch.colour = draft.colour;
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
          // Left out when nothing was picked, so the server assigns the next
          // colour in its palette rather than everyone sharing the first one.
          ...(draft.colour ? { colour: draft.colour } : {}),
        });
      }
      setDraft(null);
      setConfirmPin(null);
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  /*
   * Changing a PIN stops to ask first.
   *
   * It is the one edit here that can lock somebody out of their own profile,
   * and a typo is invisible while typing because the field shows dots. Asking
   * again costs a second and catches exactly that.
   */
  const save = useCallback((event) => {
    event.preventDefault();
    if (draft?.pin) {
      setConfirmPin(draft.pin);
      return;
    }
    commit();
  }, [draft, commit]);

  /*
   * Hold the page still while a sheet is open.
   *
   * Cleared on the way out however the sheet closed — cancelled, saved, or the
   * whole panel unmounted — because a page left unable to scroll is a far
   * worse fault than the one this fixes.
   */
  useEffect(() => {
    const open = Boolean(cropping || editingSource || confirmPin);
    document.body.classList.toggle('modal-open', open);
    return () => document.body.classList.remove('modal-open');
  }, [cropping, editingSource, confirmPin]);

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
          {/*
            * The owner is listed to the owner, and to nobody else.
            *
            * Whoever set the library up is the one person here with power over
            * it — the drives it reads, the passcode, who else exists. A guest
            * profile has no use for that name and no way to act on it, so
            * showing it only tells them which account is worth having.
            */}
          {profiles
            .filter((profile) => isOwner || !profile.isOwner || profile.id === current?.id)
            .map((profile) => (
            <li key={profile.id} className="profile-list-item">
              <ProfileFace profile={profile} size="list" />
              <span className="profile-list-name">
                {profile.name}
                {profile.id === current?.id && <span className="profile-tag">You</span>}
                {profile.isOwner && <span className="profile-tag">Owner</span>}
                {profile.kind === 'kid' && <span className="profile-tag">Kids</span>}
                {profile.hasPin && <span className="profile-tag">PIN</span>}
                {/* Shown to the owner only; the server withholds it from everyone else. */}
                {profile.lastAddress && (
                  <span className="profile-seen">
                    {profile.lastNetwork}
                    {' · '}
                    <code>{profile.lastAddress}</code>
                    {whenSeen(profile.lastSeenAt) ? ' · ' + whenSeen(profile.lastSeenAt) : ''}
                  </span>
                )}
              </span>
              {(isOwner || profile.id === current?.id) && (
                <span className="profile-list-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setDraft({
                      id: profile.id,
                      name: profile.name,
                      kind: profile.kind,
                      maxCertification: profile.maxCertification ?? '',
                      colour: profile.colour ?? '',
                      avatarAt: profile.avatarAt ?? null,
                    })}
                  >
                    Edit
                  </button>
                  {isOwner && !profile.isOwner && (
                    <button
                      type="button"
                      className="btn btn-ghost danger-text"
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
            <button type="button" className="btn btn-ghost" onClick={switchProfile}>
              Switch profile
            </button>
          )}
          {isOwner && !draft && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setDraft({ name: '', kind: 'adult', maxCertification: '', colour: '' })}
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

            <div className="field">
              <span>Picture</span>
              <div className="avatar-choose">
                <ProfileFace profile={{ ...draft, id: draft.id, name: draft.name || '?' }} size="large" />
                <div className="avatar-choose-actions">
                  <label className="btn btn-ghost">
                    {draft.avatarAt ? 'Change picture' : 'Choose a picture'}
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file && draft.id) setCropping(file);
                      }}
                    />
                  </label>
                  {draft.avatarAt && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setEditingSource(api.avatarSourceUrl(draft.id, draft.avatarAt))}
                    >
                      Adjust crop
                    </button>
                  )}
                  {draft.avatarAt && (
                    <button
                      type="button"
                      className="btn btn-ghost danger-text"
                      onClick={async () => {
                        await api.clearAvatar(draft.id).catch(() => {});
                        setDraft((current) => ({ ...current, avatarAt: null }));
                        load();
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {!draft.id && (
                <p className="settings-hint" style={{ margin: 0 }}>
                  Save the profile first, then a picture can be added to it.
                </p>
              )}

              {/*
                * In a modal, like the folder picker.
                *
                * Cropping is a task with its own beginning and end, and doing
                * it inline pushed the rest of the form about while it was
                * open. A sheet over the page keeps the picture the only thing
                * being decided.
                */}
              {(cropping || editingSource) && (
                <div
                  className="modal-backdrop"
                  onClick={() => { if (!busy) { setCropping(null); setEditingSource(null); } }}
                >
                <div className="modal cropper-modal" onClick={(event) => event.stopPropagation()}>
                  <div className="modal-header">
                    <h2>{editingSource ? 'Adjust the picture' : 'Choose the picture'}</h2>
                  </div>
                <AvatarCropper
                  file={cropping}
                  src={editingSource}
                  busy={busy}
                  onCancel={() => { setCropping(null); setEditingSource(null); }}
                  onDone={async (image, source) => {
                    setBusy(true);
                    try {
                      const saved = await api.setAvatar(draft.id, image, source);
                      setDraft((current) => ({ ...current, avatarAt: saved.avatarAt }));
                      setCropping(null);
                      setEditingSource(null);
                      load();
                    } catch (failure) {
                      setError(failure.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                </div>
                </div>
              )}
            </div>

            {confirmPin && (
              <div
                className="modal-backdrop"
                onClick={() => { if (!busy) setConfirmPin(null); }}
              >
                <div className="modal" onClick={(event) => event.stopPropagation()}>
                  <div className="modal-header">
                    <h2>Change the PIN?</h2>
                  </div>
                  <p className="settings-hint">
                    {draft.name || 'This profile'} will need this PIN from now on.
                    It cannot be looked up afterwards, so it is worth being sure.
                  </p>
                  <p className="pin-confirm">{confirmPin.replace(/./g, '•')}</p>
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => setConfirmPin(null)}
                    >
                      Go back
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={commit}
                    >
                      {busy ? 'Saving…' : 'Set this PIN'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="field">
              <span>Colour</span>
              <div className="colour-choices">
                {PROFILE_COLOURS.map((colour) => (
                  <button
                    key={colour}
                    type="button"
                    className={(draft.colour ?? '') === colour ? 'swatch selected' : 'swatch'}
                    style={{ background: colour }}
                    aria-label={'Use ' + colour}
                    aria-pressed={(draft.colour ?? '') === colour}
                    onClick={() => setDraft({ ...draft, colour })}
                  />
                ))}
                <label className="swatch custom" title="Any other colour"
                       style={{ background: draft.colour || '#2a2a35' }}>
                  <input
                    type="color"
                    value={draft.colour || '#e50914'}
                    onChange={(event) => setDraft({ ...draft, colour: event.target.value })}
                  />
                </label>
              </div>
            </div>

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
              <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !draft.name.trim()}>
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
