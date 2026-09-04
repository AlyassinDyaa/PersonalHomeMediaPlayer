import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, rememberProfile } from '../api.js';

/**
 * Who is watching.
 *
 * Shown full-screen before the library, the way a television does it, because
 * the answer decides what the whole page will say — which titles are on the
 * shelves, whose episode is half-finished, whether the settings mention a
 * drive. Asking afterwards would mean drawing a library and then replacing it.
 *
 * A profile with no PIN is one tap. One with a PIN asks for it in place rather
 * than on another screen: there is only one field, and moving the eye off the
 * face that was just chosen makes it feel like a different question.
 */
export function ProfilePicker({ profiles, onChosen, onCancel }) {
  const [wanted, setWanted] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pinField = useRef(null);

  useEffect(() => {
    if (wanted?.hasPin) pinField.current?.focus();
  }, [wanted]);

  const enter = useCallback(async (profile, code) => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await api.switchProfile(profile.id, code ?? '');
      // Remembered before the caller redraws, so the very next request already
      // carries the new profile rather than the one being left.
      rememberProfile(chosen.id);
      onChosen(chosen);
    } catch (failure) {
      setError(failure.message);
      setPin('');
      pinField.current?.focus();
    } finally {
      setBusy(false);
    }
  }, [onChosen]);

  const choose = useCallback((profile) => {
    setError(null);
    setPin('');
    if (profile.hasPin) {
      setWanted(profile);
      return;
    }
    enter(profile, '');
  }, [enter]);

  const back = useCallback(() => {
    setWanted(null);
    setPin('');
    setError(null);
  }, []);

  if (wanted) {
    return (
      <div className="profile-gate">
        <div className="profile-pin">
          <Face profile={wanted} large />
          <h2>{wanted.name}</h2>
          <p className="profile-note">Enter this profile&rsquo;s PIN</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) enter(wanted, pin);
            }}
          >
            <input
              ref={pinField}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              disabled={busy}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              placeholder="PIN"
            />
            <div className="profile-pin-actions">
              <button type="button" className="btn-ghost" onClick={back} disabled={busy}>
                Back
              </button>
              <button type="submit" className="btn-primary" disabled={busy || pin.length < 4}>
                {busy ? 'Checking…' : 'Enter'}
              </button>
            </div>
          </form>
          {error && <p className="profile-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="profile-gate">
      <h1 className="profile-title">Who&rsquo;s watching?</h1>
      <div className="profile-row">
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="profile-choice"
            onClick={() => choose(profile)}
            disabled={busy}
          >
            <Face profile={profile} />
            <span className="profile-name">{profile.name}</span>
            {profile.hasPin && <span className="profile-lock" aria-label="Needs a PIN">🔒</span>}
          </button>
        ))}
      </div>
      {error && <p className="profile-error">{error}</p>}
      {onCancel && (
        <button type="button" className="btn-ghost profile-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * A profile's tile.
 *
 * An initial on a coloured ground rather than a picture: there is nowhere to
 * put an uploaded avatar in a library that scans folders, and a letter in the
 * colour somebody picked is recognised across a room just as fast.
 */
function Face({ profile, large = false }) {
  const initial = [...(profile.name ?? '?')][0]?.toUpperCase() ?? '?';
  return (
    <span
      className={'profile-face' + (large ? ' profile-face-large' : '')}
      style={{ background: profile.colour }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export default ProfilePicker;
