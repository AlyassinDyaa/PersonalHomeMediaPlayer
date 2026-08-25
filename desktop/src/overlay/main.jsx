import React from 'react';
import { createRoot } from 'react-dom/client';
import Overlay from './Overlay.jsx';
import './overlay.css';

createRoot(document.getElementById('overlay-root')).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);
