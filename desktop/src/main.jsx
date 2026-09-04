import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ProfileGate from './components/ProfileGate.jsx';
import { initApi } from './api.js';
import './styles.css';

/**
 * Resolves the API base from the main process before rendering the app, so no
 * request can fire against a stale port. Renders a spinner meanwhile rather
 * than blocking the module graph on a top-level await.
 */
function Boot() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    initApi()
      .then((resolved) => !cancelled && setInfo(resolved))
      .catch(() => !cancelled && setInfo({ mpvAvailable: false, error: true }));
    return () => { cancelled = true; };
  }, []);

  if (!info) {
    return <div className="center-note"><div className="spinner" /></div>;
  }
  return (
    <ProfileGate>
      <App info={info} />
    </ProfileGate>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);
