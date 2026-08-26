import React from 'react';
import { createRoot } from 'react-dom/client';
import { initApi } from '../api.js';
import WebApp from './WebApp.jsx';
// The desktop stylesheet first, then what a touch screen needs on top of it.
import '../styles.css';
import './touch.css';

/**
 * The browser build's entry point. The API base has to be settled before
 * anything renders, because in a browser it comes from the address the page was
 * served from rather than from Electron.
 */
initApi().then((info) => {
  createRoot(document.getElementById('root')).render(<WebApp info={info} />);
});
