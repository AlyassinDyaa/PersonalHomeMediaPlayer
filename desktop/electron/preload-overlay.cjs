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
  next: () => ipcRenderer.invoke('player:next'),
  previous: () => ipcRenderer.invoke('player:previous'),
  moveScreen: () => ipcRenderer.invoke('player:moveScreen'),
  setFullscreen: (next) => ipcRenderer.invoke('player:setFullscreen', Boolean(next)),
  toggleFullscreen: () => ipcRenderer.invoke('player:toggleFullscreen'),

  /**
   * Drag and resize the video window from the controls, which stand in for the
   * title bar the borderless video window does not have. Points are in screen
   * coordinates, so they stay valid as the window moves out from under them.
   */
  gestureStart: (kind, point) => ipcRenderer.send('player:gestureStart', { kind, point }),
  gestureMove: (point) => ipcRenderer.send('player:gestureMove', point),
  gestureEnd: (point) => ipcRenderer.send('player:gestureEnd', point),

  /**
   * Toggle whether the overlay window accepts mouse input. False makes it
   * click-through so the video window behaves normally underneath.
   */
  setInteractive: (interactive) => ipcRenderer.send('overlay:interactive', Boolean(interactive)),

  /** Fired when the cursor moves, so the controls can reappear. */
  onWake: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('overlay:wake', listener);
    return () => ipcRenderer.removeListener('overlay:wake', listener);
  },

  /** @returns {() => void} unsubscribe */
  onState: (handler) => {
    const listener = (event, payload) => handler(payload);
    ipcRenderer.on('overlay:state', listener);
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
});
