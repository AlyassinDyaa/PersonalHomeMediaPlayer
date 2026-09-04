import React from 'react';
import { createRoot } from 'react-dom/client';
import { initApi } from '../api.js';
import WebApp from './WebApp.jsx';
import ProfileGate from '../components/ProfileGate.jsx';
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

initApi().then((info) => {
  installOfflinePage();
  createRoot(document.getElementById('root')).render(
    <ProfileGate>
      <WebApp info={info} />
    </ProfileGate>,
  );
});
