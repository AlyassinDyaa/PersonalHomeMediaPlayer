import { api, rememberProfile } from './api.js';

/**
 * Leave the profile, and go back to the faces.
 *
 * The two builds leave in different ways. The desktop window is loaded from a
 * file on disk, so sending it to "/login" asked for file:///login — a page
 * that does not exist, which is why this once went black. It is also local,
 * and therefore trusted: there is no session to end and no door to be sent
 * back to, so forgetting the choice and reloading is the whole of it, and the
 * gate asks again. A browser does have a session, and signing out is what
 * returns it to the faces.
 */
export async function leaveProfile() {
  rememberProfile(null);

  if (typeof window !== 'undefined' && window.media) {
    window.location.reload();
    return;
  }

  try { await api.logout(); } catch { /* leaving regardless */ }
  window.location.replace('/login');
}
