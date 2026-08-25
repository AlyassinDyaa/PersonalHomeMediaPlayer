/**
 * Preload bridge for the playback overlay.
 *
 * Separate from the browse window's bridge because the overlay needs a
 * different, smaller surface: player state in, commands and hit-testing out.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  /** Ask the main process to send the current state immediately. */
  ready: () => ipcRenderer.send('overlay:ready'),

  command: (args) => ipcRenderer.invoke('player:command', args),
  stop: () => ipcRenderer.invoke('player:stop'),

  /**
   * Toggle whether the overlay window accepts mouse input. False makes it
   * click-through so the video window behaves normally underneath.
   */
  setInteractive: (interactive) => ipcRenderer.send('overlay:interactive', Boolean(interactive)),

  /** @returns {() => void} unsubscribe */
  onState: (handler) => {
    const listener = (event, payload) => handler(payload);
    ipcRenderer.on('overlay:state', listener);
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
});
