// Electron main process. Serves the built web app over a privileged app://
// scheme so module workers, localStorage and fetch behave like a normal origin.
const { app, BrowserWindow, Menu, protocol, net, shell, globalShortcut, clipboard, Notification, screen } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')
const ENGINE = path.join(__dirname, '..', 'bin', 'writewise.mjs')
const HOTKEY = 'CommandOrControl+Shift+G'

// ---------- in-place editing through the macOS Accessibility helper ----------
const { AxHelper } = require('./ax.cjs')
const ax = new AxHelper()
// Text boxes inside WriteWise itself are handled by its own editor; never rewrite them from outside.
const OWN_BUNDLES = new Set(['app.writewise.desktop', 'com.github.Electron'])

// ---------- clipboard fixer (works in any app: copy, press the hotkey, paste) ----------
let enginePromise = null
function getEngine() {
  if (!enginePromise) {
    enginePromise = import(pathToFileURL(ENGINE).href).then(async (m) => ({ m, checker: await m.createNodeChecker(path.join(DIST, 'dict')) }))
  }
  return enginePromise
}

// Feedback for the hotkeys. macOS only shows Notification Center alerts for apps it has registered and the
// user has allowed, which an ad-hoc signed build never gets, so we also draw our own small always-on-top
// toast near the top-right corner of the screen the pointer is on. It never takes focus.
let toastWin = null
let toastTimer = null
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function toast(title, body) {
  const W = 380
  const H = 84
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const pos = [area.x + area.width - W - 12, area.y + 12]
  if (!toastWin) {
    toastWin = new BrowserWindow({
      width: W, height: H, x: pos[0], y: pos[1], show: false, frame: false, transparent: true, alwaysOnTop: true,
      focusable: false, skipTaskbar: true, resizable: false, movable: false, hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    toastWin.setAlwaysOnTop(true, 'screen-saver')
    toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    toastWin.setIgnoreMouseEvents(true)
    toastWin.on('closed', () => { toastWin = null })
  } else {
    toastWin.setPosition(pos[0], pos[1])
  }
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;font:13px/1.35 -apple-system,system-ui,sans-serif">
<div style="margin:8px;padding:11px 14px;border-radius:12px;background:rgba(28,30,34,.94);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35)">
<div style="font-weight:600">${esc(title)}</div><div style="opacity:.85;margin-top:2px">${esc(body)}</div></div>`
  const w = toastWin
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => { if (w === toastWin) w.showInactive() }).catch(() => {})
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { if (toastWin) toastWin.hide() }, 3200)
}

function notify(title, body) {
  try { toast(title, body) } catch (err) { console.warn('toast failed', err) }
  try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show() } catch { /* notifications unavailable */ }
}

async function fixClipboard() {
  const text = await clipboard.readText()
  if (!text.trim()) return notify('WriteWise', 'Copy some text first, then press the hotkey.')
  try {
    const { m, checker } = await getEngine()
    const result = await m.fixText(checker, text, { mode: 'writing' })
    await clipboard.writeText(result.fixed)
    const n = result.applied.length
    notify('WriteWise', n ? `Fixed ${n} issue${n === 1 ? '' : 's'}. Paste to use the corrected text.` : 'No spelling or grammar fixes needed.')
  } catch (err) {
    notify('WriteWise', 'Could not fix the clipboard: ' + (err && err.message ? err.message : err))
  }
}

async function promptifyClipboard() {
  const text = await clipboard.readText()
  if (!text.trim()) return notify('WriteWise', 'Copy some text first, then press the hotkey.')
  try {
    const { m, checker } = await getEngine()
    const result = await m.fixText(checker, text, { mode: 'prompt' })
    await clipboard.writeText(m.buildPromptTemplate(result.fixed, result.prompt))
    notify('WriteWise', 'Clipboard now holds a structured AI prompt. Paste it and fill in the [brackets].')
  } catch (err) {
    notify('WriteWise', 'Could not build the prompt: ' + (err && err.message ? err.message : err))
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

/** The focused text box of the app in front, or null when there is none we can edit. */
async function focusedBox() {
  if (!ax.available()) return null
  try {
    const box = await ax.request({ cmd: 'read' })
    if (process.env.WRITEWISE_DEBUG) console.log('[ax] read ->', JSON.stringify(box).slice(0, 200))
    if (!box.ok || !box.editable || OWN_BUNDLES.has(box.bundle)) return null
    return box
  } catch (err) {
    console.warn('[ax] read failed:', err.message)
    return null
  }
}

/** True when macOS lets us drive other apps; otherwise asks the system to show the permission prompt. */
async function ensureTrusted() {
  try {
    const t = await ax.request({ cmd: 'trusted', prompt: false })
    if (t.ok) return true
    await ax.request({ cmd: 'trusted', prompt: true })
    notify('WriteWise needs Accessibility access', 'Allow WriteWise under System Settings > Privacy & Security > Accessibility, then press the hotkey again.')
    return false
  } catch {
    return false
  }
}

/** Where a caret ends up after one pass of edits (offsets refer to the text before the pass). */
function mapCaret(caret, edits) {
  let out = caret
  for (const e of edits) {
    if (e.end <= caret) out += e.replacement.length - (e.end - e.start)
    else if (e.start < caret) { out = e.start + e.replacement.length; break }
    else break
  }
  return out
}

/**
 * Cmd+Shift+G: fix the text box that has focus in whatever app is in front, editing it in place.
 * With a selection only the selection is fixed. Falls back to the clipboard when no text box is focused.
 */
async function fixInPlace() {
  const box = await focusedBox()
  if (process.env.WRITEWISE_DEBUG) console.log('[ax] fixInPlace box:', box ? { app: box.app, role: box.role, len: (box.text || '').length, sel: [box.selStart, box.selLen] } : null)
  if (!box) {
    if (ax.available() && !(await ensureTrusted())) return
    return fixClipboard()
  }
  const hasSel = box.selLen > 0
  const base = hasSel ? box.selStart : 0
  let text = hasSel ? box.text.slice(base, base + box.selLen) : box.text
  const where = box.app || 'the active app'
  if (!text.trim()) return notify('WriteWise', 'Nothing to fix in ' + where + '.')
  try {
    const { m, checker } = await getEngine()
    const opts = { ...m.DEFAULT_CHECK_OPTIONS, mode: 'writing' }
    let caret = hasSel ? null : Math.max(0, Math.min(box.selStart - base, text.length))
    let total = 0
    // Fixes can unlock further fixes, so run a few passes. Each pass edits the live text box from the end
    // backwards so earlier offsets stay valid, which keeps the app's own undo history and formatting intact.
    for (let pass = 0; pass < 3; pass++) {
      const result = await checker.check(text, opts)
      const step = m.autoFix(text, result.issues)
      if (!step.edits.length) break
      const edits = [...step.edits].sort((a, b) => a.start - b.start)
      for (const e of [...edits].reverse()) {
        const r = await ax.request({ cmd: 'replace', start: base + e.start, length: e.end - e.start, text: e.replacement })
        if (!r.ok) throw new Error(r.error || 'replace failed')
      }
      if (caret !== null) caret = mapCaret(caret, edits)
      total += edits.length
      text = step.text
    }
    if (!total) return notify('WriteWise', 'No spelling or grammar fixes needed in ' + where + '.')
    if (hasSel) await ax.request({ cmd: 'select', start: base, length: text.length })
    else await ax.request({ cmd: 'select', start: base + Math.min(caret, text.length), length: 0 })
    notify('WriteWise', `Fixed ${total} issue${total === 1 ? '' : 's'} in ${where}.`)
  } catch (err) {
    notify('WriteWise', 'Could not fix the text in place: ' + (err && err.message ? err.message : err))
  }
}

/** Cmd+Shift+P: turn the focused text box (or its selection) into a structured AI prompt, in place. */
async function promptifyInPlace() {
  const box = await focusedBox()
  if (!box) {
    if (ax.available() && !(await ensureTrusted())) return
    return promptifyClipboard()
  }
  const hasSel = box.selLen > 0
  const base = hasSel ? box.selStart : 0
  const text = hasSel ? box.text.slice(base, base + box.selLen) : box.text
  if (!text.trim()) return notify('WriteWise', 'Type or select some text first.')
  try {
    const { m, checker } = await getEngine()
    const result = await m.fixText(checker, text, { mode: 'prompt' })
    const out = m.buildPromptTemplate(result.fixed, result.prompt)
    const r = await ax.request({ cmd: 'replace', start: base, length: text.length, text: out })
    if (!r.ok) throw new Error(r.error || 'replace failed')
    await ax.request({ cmd: 'select', start: base + out.length, length: 0 })
    notify('WriteWise', 'Turned the text into a structured prompt. Fill in the [brackets].')
  } catch (err) {
    notify('WriteWise', 'Could not build the prompt in place: ' + (err && err.message ? err.message : err))
  }
}

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
        { label: 'Fix text in the active app', accelerator: HOTKEY, click: fixInPlace },
        { label: 'Turn the active text into an AI prompt', accelerator: 'CommandOrControl+Shift+P', click: promptifyInPlace },
        { type: 'separator' },
        { label: 'Fix clipboard text', click: fixClipboard },
        { label: 'Turn clipboard into an AI prompt', click: promptifyClipboard },
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
  if (!globalShortcut.register(HOTKEY, fixInPlace)) console.warn('Could not register', HOTKEY)
  if (!globalShortcut.register('CommandOrControl+Shift+P', promptifyInPlace)) console.warn('Could not register CommandOrControl+Shift+P')
  getEngine().catch((err) => console.warn('engine preload failed', err))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().filter((w) => w !== toastWin).length === 0) createWindow() })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); ax.stop() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
