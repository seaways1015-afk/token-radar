const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tp', {
  win: (action) => ipcRenderer.send('win', action),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  mini: (on) => ipcRenderer.send('mini', on),
  setTheme: (t) => ipcRenderer.send('theme', t),
});
