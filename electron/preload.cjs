// Bridge between the editor page and the main process (the page is sandboxed; no Node access).
// The page sees `window.writewiseDesktop`; src/settings.ts uses it instead of localStorage for the
// Anthropic API key so the key lives in the OS keychain (electron/ai-settings.cjs) and is shared
// with the hotkeys, the in-app overlay and the other WriteWise surfaces on this machine.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('writewiseDesktop', {
  getAiSettings: () => ipcRenderer.invoke('ai-settings:get'),
  setAiSettings: (s) => ipcRenderer.invoke('ai-settings:set', {
    apiKey: typeof (s && s.apiKey) === 'string' ? s.apiKey : '',
    model: typeof (s && s.model) === 'string' ? s.model : '',
  }),
})
