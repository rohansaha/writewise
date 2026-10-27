// Bridge between the overlay page and the main process (sandboxed; no Node access in the page).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  onRender: (cb) => ipcRenderer.on('overlay:render', (_e, payload) => cb(payload)),
  onRewrite: (cb) => ipcRenderer.on('overlay:rewrite-result', (_e, result) => cb(result)),
  hover: (over) => ipcRenderer.send('overlay:hover', !!over),
  card: (id) => ipcRenderer.send('overlay:card', id || null),
  apply: (id, text) => ipcRenderer.send('overlay:apply', { id, text }),
  rewrite: (id) => ipcRenderer.send('overlay:rewrite', { id }),
  dismiss: (id) => ipcRenderer.send('overlay:dismiss', id),
  regions: (rects) => ipcRenderer.send('overlay:regions', rects),
  debug: (info) => ipcRenderer.send('overlay:debug', info),
})
