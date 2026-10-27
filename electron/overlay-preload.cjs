// Bridge between the overlay page and the main process (sandboxed; no Node access in the page).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  onRender: (cb) => ipcRenderer.on('overlay:render', (_e, payload) => cb(payload)),
  hover: (over) => ipcRenderer.send('overlay:hover', !!over),
  card: (id) => ipcRenderer.send('overlay:card', id || null),
  apply: (id, replacement) => ipcRenderer.send('overlay:apply', { id, replacement }),
  dismiss: (id) => ipcRenderer.send('overlay:dismiss', id),
  debug: (info) => ipcRenderer.send('overlay:debug', info),
  regions: (rects) => ipcRenderer.send('overlay:regions', rects),
})
