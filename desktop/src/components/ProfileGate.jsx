import React, { useCallback, useEffect, useState } from 'react';
import { api, currentProfileId, rememberProfile } from '../api.js';
import ProfilePicker from './ProfilePicker.jsx';

/**
 * Settles who is watching before the library is drawn.
 *
 * Wrapped around both builds, because both need the answer for the same
 * reason: the profile decides which titles are on the shelves and whose
 * episode is half-finished, so a library drawn first would only have to be
 * thrown away.
 *
 * A household with one profile is never asked. There is nothing to choose
 * between, and a television that demands a tap before every viewing to confirm
 * the only possible answer is worse than one that does not.
 */
export function ProfileGate({ children }) {
  const [state, setState] = useState({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const { profiles, current } = await api.profiles();
      const remembered = currentProfileId();

      // One profile means one answer. Remember it so later requests name it
      // rather than leaning on the server's fallback.
      if (profiles.length <= 1) {
        if (current) rememberProfile(current.id);
        setState({ status: 'ready' });
        return;
      }

      /*
       * A remembered profile the server does not recognise is stale — it was
       * deleted, or the library was replaced. Asking again is the only honest
       * answer; carrying on would silently write this person's history onto
       * whoever the server fell back to.
       */
      if (remembered && current && remembered === current.id) {
        setState({ status: 'ready' });
        return;
      }

      rememberProfile(null);
      setState({ status: 'choosing', profiles });
    } catch (error) {
      // A library that cannot say who its people are is still a library. The
      // app below will surface its own error if the failure was real.
      setState({ status: 'ready', error });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const chosen = useCallback(() => setState({ status: 'ready' }), []);

  if (state.status === 'loading') {
    return <div className="center-note"><div className="spinner" /></div>;
  }
  if (state.status === 'choosing') {
    return <ProfilePicker profiles={state.profiles} onChosen={chosen} />;
  }
  return children;
}

export default ProfileGate;
