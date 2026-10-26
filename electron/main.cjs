// Electron main process. Serves the built web app over a privileged app://
// scheme so module workers, localStorage and fetch behave like a normal origin.
const { app, BrowserWindow, Menu, protocol, net, shell, globalShortcut, clipboard, Notification } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')
const ENGINE = path.join(__dirname, '..', 'bin', 'writewise.mjs')
const HOTKEY = 'CommandOrControl+Shift+G'

// ---------- clipboard fixer (works in any app: copy, press the hotkey, paste) ----------
let enginePromise = null
function getEngine() {
  if (!enginePromise) {
    enginePromise = import(pathToFileURL(ENGINE).href).then(async (m) => ({ m, checker: await m.createNodeChecker(path.join(DIST, 'dict')) }))
  }
  return enginePromise
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

async function fixClipboard() {
  const text = clipboard.readText()
  if (!text.trim()) return notify('WriteWise', 'Copy some text first, then press the hotkey.')
  try {
    const { m, checker } = await getEngine()
    const result = await m.fixText(checker, text, { mode: 'writing' })
    clipboard.writeText(result.fixed)
    const n = result.applied.length
    notify('WriteWise', n ? `Fixed ${n} issue${n === 1 ? '' : 's'}. Paste to use the corrected text.` : 'No spelling or grammar fixes needed.')
  } catch (err) {
    notify('WriteWise', 'Could not fix the clipboard: ' + (err && err.message ? err.message : err))
  }
}

async function promptifyClipboard() {
  const text = clipboard.readText()
  if (!text.trim()) return notify('WriteWise', 'Copy some text first, then press the hotkey.')
  try {
    const { m, checker } = await getEngine()
    const result = await m.fixText(checker, text, { mode: 'prompt' })
    clipboard.writeText(m.buildPromptTemplate(result.fixed, result.prompt))
    notify('WriteWise', 'Clipboard now holds a structured AI prompt. Paste it and fill in the [brackets].')
  } catch (err) {
    notify('WriteWise', 'Could not build the prompt: ' + (err && err.message ? err.message : err))
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'WriteWise',
    backgroundColor: '#f4f6f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadURL('app://bundle/index.html')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'Tools',
      submenu: [
        { label: 'Fix clipboard text', accelerator: HOTKEY, click: fixClipboard },
        { label: 'Turn clipboard into an AI prompt', accelerator: 'CommandOrControl+Shift+P', click: promptifyClipboard },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'WriteWise on GitHub', click: () => shell.openExternal('https://github.com/') }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const file = path.normalize(path.join(DIST, pathname))
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  buildMenu()
  createWindow()
  // Global hotkeys work even when another app (e.g. a chat window) is in front.
  if (!globalShortcut.register(HOTKEY, fixClipboard)) console.warn('Could not register', HOTKEY)
  if (!globalShortcut.register('CommandOrControl+Shift+P', promptifyClipboard)) console.warn('Could not register CommandOrControl+Shift+P')
  getEngine().catch((err) => console.warn('engine preload failed', err))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
