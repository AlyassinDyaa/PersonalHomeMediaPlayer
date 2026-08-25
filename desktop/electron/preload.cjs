/**
 * Preload bridge.
 *
 * The renderer gets a narrow, explicit surface rather than raw ipcRenderer,
 * so the UI can never reach arbitrary main-process channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('media', {
  info: () => ipcRenderer.invoke('app:info'),

  play: (options) => ipcRenderer.invoke('player:play', options),
  stop: () => ipcRenderer.invoke('player:stop'),
  command: (args) => ipcRenderer.invoke('player:command', args),
  state: () => ipcRenderer.invoke('player:state'),

  /** @returns {() => void} unsubscribe */
  onPosition: (handler) => {
    const listener = (event, payload) => handler(payload);
    ipcRenderer.on('player:position', listener);
    return () => ipcRenderer.removeListener('player:position', listener);
  },

  onPlayerClosed: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('player:closed', listener);
    return () => ipcRenderer.removeListener('player:closed', listener);
  },
});
