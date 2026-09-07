import React from 'react';
import { createRoot } from 'react-dom/client';
import { initApi, apiBaseUrl } from '../api.js';
import WebApp from './WebApp.jsx';
import ProfileGate from '../components/ProfileGate.jsx';
import { applyTelevision, fullScreenOnTelevision } from '../television.js';
import { ErrorBoundary, FailureScreen } from '../components/ErrorBoundary.jsx';
// The desktop stylesheet first, then what a touch screen needs on top of it.
import '../styles.css';
import './touch.css';

/**
 * The browser build's entry point. The API base has to be settled before
 * anything renders, because in a browser it comes from the address the page was
 * served from rather than from Electron.
 */
/**
 * Install the worker that answers when the computer at home does not.
 *
 * Service workers only run in a secure context, which on a home network means
 * this is skipped: a library reached at http://192.168.1.20:8787 cannot have
 * one, and the browser refuses rather than explains. Reaching the library over
 * HTTPS — through a Tailscale address, say — is what turns this on, so the
 * failure is quiet by design rather than something to warn about.
 */
function installOfflinePage() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    // Nothing depends on the registration succeeding; the library works
    // exactly as before without it, only less gracefully when it is asleep.
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/**
 * Say so when the library cannot be started at all.
 *
 * A render that throws is caught below by the boundary, which is React's own
 * mechanism and the ordinary case. This is the other one: a failure before
 * there is anything to catch it with, which used to leave the promise
 * rejected, the page empty, and a white screen as the entire explanation.
 */
function reportStartupFailure(error) {
  console.error('The library could not be started:', error);
  const container = document.getElementById('root');
  if (!container) return;
  try {
    createRoot(container).render(<FailureScreen error={error} />);
  } catch {
    // React is what failed, so it cannot be the one to report it.
    container.textContent = 'The library could not be opened: '
      + (error?.message ?? String(error));
  }
}

/**
 * Come back as the new version when the computer at home has one.
 *
 * A phone keeps the app it was given. The entry page is sent with no-cache and
 * the built files are named after their contents, which is enough in theory —
 * and in practice a Home Screen app can sit on the same copy for days, so a
 * fix made on the computer never arrives and the same fault gets reported
 * again. This closes that: the server says which build it is serving, the page
 * compares it with the one it is running, and reloads itself once if they
 * differ.
 *
 * Once, and only for a build it has not already tried. A page that reloaded
 * every time the names failed to match would spin for ever if something were
 * genuinely stuck, which is worse than being out of date.
 */
function watchForNewerBuild() {
  let mine = null;
  try {
    mine = new URL(import.meta.url).pathname.split('/').pop();
  } catch {
    return;   // Nothing to compare with; leave the page alone.
  }
  if (!mine) return;

  const tried = 'library.reloadedFor';

  const look = async () => {
    if (document.hidden) return;
    try {
      const response = await fetch(apiBaseUrl() + '/api/health', { cache: 'no-store' });
      if (!response.ok) return;   // Not signed in yet, or the server is busy.

      const { build } = await response.json();
      if (!build || build === mine) return;
      if (sessionStorage.getItem(tried) === build) return;

      sessionStorage.setItem(tried, build);
      window.location.reload();
    } catch {
      // Unreachable. The offline page has that covered.
    }
  };

  // When it comes back to the front is when somebody is about to use it, and
  // is the one moment a reload costs nothing.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
  setInterval(look, 5 * 60 * 1000);
  look();
}

// Before anything is drawn, so the first frame is already the right shape.
applyTelevision();
// A stick has no way to install this, so the browser is asked to get out of
// the way instead. Waits for the first press, which is all a browser will allow.
fullScreenOnTelevision();

initApi()
  .then((info) => {
    installOfflinePage();
    watchForNewerBuild();
    createRoot(document.getElementById('root')).render(
      <ErrorBoundary>
        <ProfileGate>
          <WebApp info={info} />
        </ProfileGate>
      </ErrorBoundary>,
    );
  })
  .catch(reportStartupFailure);
