import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import ProfileFace from './ProfileFace.jsx';

/**
 * Who in the house is let into one section of the library.
 *
 * Switching a section on is one decision and who it is on *for* is another. A
 * shelf of comics that suits the reader it was collected for is not
 * automatically for everybody, and the next section to work this way is
 * already known about — so this is written once, against a section name, and
 * reused rather than rebuilt.
 *
 * Two things it deliberately does not do. It does not wait for a Save: a row
 * of checkboxes with a button under it invites the half-finished state where
 * the ticks say one thing and the library does another. And it does not let
 * the owner be un-ticked — they hold the switch, and a library whose owner can
 * shut themselves out of a section they administer is a library with a support
 * call in it.
 *
 * @param {string} section  Which area this governs, e.g. "comics".
 * @param {string} noun     What to call the thing, in a sentence.
 */
export function SectionAccess({ section, noun = 'this' }) {
  const [profiles, setProfiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.sectionAccess(section)
      .then((answer) => setProfiles(answer.profiles ?? []))
      .catch((err) => setError(err.message));
  }, [section]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (profile) => {
    if (profile.isOwner || busy) return;

    /*
     * Shown before it is saved, and put back if the save fails. A tick that
     * waits for a round trip before moving feels broken, and this one is
     * pressed several times in a row.
     */
    const next = profiles.map((entry) => (
      entry.id === profile.id ? { ...entry, allowed: !entry.allowed } : entry
    ));
    setProfiles(next);
    setBusy(true);
    setError(null);

    try {
      await api.setSectionAccess(section, next.filter((e) => e.allowed).map((e) => e.id));
    } catch (err) {
      setProfiles(profiles);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !profiles) return <p className="settings-empty">{error}</p>;
  if (!profiles) return null;

  const allowed = profiles.filter((entry) => entry.allowed).length;

  return (
    <div className="section-access">
      <h3>Who can see {noun}</h3>
      <p className="settings-hint">
        {allowed === profiles.length
          ? 'Everybody in the house.'
          : allowed === 1
            ? 'Only you.'
            : allowed + ' of ' + profiles.length + ' profiles.'}
      </p>

      {error && <div className="banner" style={{ margin: '0 0 12px' }}>{error}</div>}

      <div className="section-access-list">
        {profiles.map((profile) => (
          <label
            key={profile.id}
            className={profile.allowed ? 'section-access-row on' : 'section-access-row'}
          >
            <input
              type="checkbox"
              checked={profile.allowed}
              disabled={profile.isOwner || busy}
              onChange={() => toggle(profile)}
            />
            <ProfileFace profile={profile} size="list" />
            <span className="section-access-name">
              <strong>{profile.name}</strong>
              <span>
                {profile.isOwner
                  ? 'Looks after the library — always has it'
                  : profile.kind === 'kid' ? 'Kids profile' : 'Adult profile'}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default SectionAccess;
