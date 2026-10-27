// Electron main process. Serves the built web app over a privileged app://
// scheme so module workers, localStorage and fetch behave like a normal origin.
const { app, BrowserWindow, Menu, protocol, net, shell, globalShortcut, clipboard, Notification, screen } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')
// The CLI bundle (engine, Claude rewrite, native-messaging host). In a packaged app bin/ is unpacked next to
// app.asar (package.json > build.asarUnpack) so the browser's native-messaging host can run it as a plain file.
const ENGINE = (() => {
  const inAsar = path.join(__dirname, '..', 'bin', 'writewise.mjs')
  const unpacked = inAsar.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return unpacked !== inAsar && require('node:fs').existsSync(unpacked) ? unpacked : inAsar
})()
// Global hotkeys. Cmd/Ctrl+Shift+P is left alone on purpose: it is VS Code's command palette everywhere.
const HOTKEY = 'CommandOrControl+Shift+G'  // fix the focused box (macOS) or the clipboard
const PROMPT_HOTKEY = 'Alt+Shift+P'         // turn the focused box (macOS) or the clipboard into an AI prompt

// ---------- in-place editing through the macOS Accessibility helper ----------
const { AxHelper } = require('./ax.cjs')
const { createOverlay, splitSentences, buildSentences } = require('./overlay.cjs')
const SENTENCE_HOTKEY = 'Alt+Shift+G'
const fs = require('node:fs')
const ax = new AxHelper()
let overlay = null
// The Anthropic API key (OS keychain via safeStorage) and the bridge that lets the browser extension fetch it.
const aiSettings = require('./ai-settings.cjs')
const nativeHost = require('./native-host.cjs')

// ---------- small persistent settings for the desktop shell ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'desktop-settings.json')
const shellSettings = { overlay: process.platform === 'darwin', nativeHost: false }
try { Object.assign(shellSettings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))) } catch { /* first run */ }
function saveShellSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(shellSettings, null, 2)) } catch (err) { console.warn('could not save settings', err) }
}

/** Switches the in-app underlines on or off and remembers the choice. */
async function setOverlayEnabled(on) {
  shellSettings.overlay = on
  saveShellSettings()
  if (!overlay) return
  if (!on) return overlay.stop()
  const ok = await overlay.start()
  if (ok) notify('WriteWise', 'Suggestions will be underlined in other apps as you type.')
}
// Text boxes inside WriteWise itself are handled by its own editor; never rewrite them from outside.
const OWN_BUNDLES = new Set(['app.writewise.desktop', 'com.github.Electron'])

// ---------- clipboard fixer (works in any app: copy, press the hotkey, paste) ----------
let modulePromise = null
/** The CLI bundle itself (engine, Claude rewrite, config helpers); no dictionary loaded yet. */
function getModule() {
  if (!modulePromise) modulePromise = import(pathToFileURL(ENGINE).href)
  return modulePromise
}
let enginePromise = null
function getEngine() {
  if (!enginePromise) {
    enginePromise = getModule().then(async (m) => ({ m, checker: await m.createNodeChecker(path.join(DIST, 'dict')) }))
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

/**
 * Alt+Shift+G: fix the sentence under the caret (or the selected text) in place. Uses Claude with the whole
 * box as context when an API key is set in Settings, otherwise the offline engine's whole-sentence fix.
 */
async function fixSentenceInPlace() {
  const box = await focusedBox()
  if (!box) {
    if (ax.available() && !(await ensureTrusted())) return
    if (!ax.available()) return fixClipboardSentence()
    return notify('WriteWise', 'Click into a text box first, then press the hotkey.')
  }
  const text = box.text || ''
  let start, end
  if (box.selLen > 0) {
    start = box.selStart
    end = box.selStart + box.selLen
  } else {
    const caret = Math.max(0, Math.min(box.selStart || 0, text.length))
    const hit = splitSentences(text).find((r) => caret >= r.start && caret <= r.end) || splitSentences(text).find((r) => r.start > caret)
    if (!hit) return notify('WriteWise', 'No sentence at the cursor.')
    start = hit.start
    end = hit.end
  }
  const sentence = text.slice(start, end)
  if (!sentence.trim()) return notify('WriteWise', 'No sentence at the cursor.')
  const where = box.app || 'the active app'
  try {
    const { m, checker } = await getEngine()
    const settings = await getAiSettings()
    let fixed = null
    let how = 'offline'
    if (settings.apiKey) {
      notify('WriteWise', 'Asking Claude to fix this sentence…')
      how = 'Claude'
      fixed = await m.rewriteSentence({ apiKey: settings.apiKey, model: settings.model, sentence, context: text })
    } else {
      const result = await checker.check(text, { ...m.DEFAULT_CHECK_OPTIONS, mode: 'writing' })
      const item = buildSentences(text, result.issues, m).find((it) => it.start <= start && it.end >= end) || null
      fixed = item ? (box.selLen > 0 ? null : item.fixed) : null
      if (fixed === null) {
        // A selection, or a sentence the splitter sees differently: fix the exact range with the safe fixes.
        const local = result.issues.filter((i) => i.start >= start && i.end <= end).map((i) => ({ ...i, start: i.start - start, end: i.end - start }))
        fixed = m.autoFix(sentence, local).text
      }
    }
    // The box may have changed while Claude was thinking: only apply if the sentence is still where it was.
    const now = await focusedBox()
    if (!now || now.text.slice(start, end) !== sentence) return notify('WriteWise', 'The text changed meanwhile; nothing was replaced.')
    if (!fixed || fixed === sentence) return notify('WriteWise', `No changes needed in this sentence (${how}).`)
    const r = await ax.request({ cmd: 'replace', pid: box.pid, start, length: end - start, text: fixed })
    if (!r.ok) throw new Error(r.error || 'replace failed')
    await ax.request({ cmd: 'select', pid: box.pid, start: start + fixed.length, length: 0 })
    notify('WriteWise', `Fixed this sentence (${how}) in ${where}.`)
  } catch (err) {
    notify('WriteWise', 'Could not fix the sentence: ' + (err && err.message ? err.message : err))
  }
}

/** Windows/Linux form of the sentence hotkey: fix the copied sentence (Claude when a key is set) and put it back. */
async function fixClipboardSentence() {
  const text = (await clipboard.readText()) || ''
  if (!text.trim()) return notify('WriteWise', 'Copy a sentence first, then press the hotkey, then paste.')
  try {
    const { m, checker } = await getEngine()
    const settings = await getAiSettings()
    let fixed
    if (settings.apiKey) {
      notify('WriteWise', 'Asking Claude to fix this sentence…')
      fixed = await m.rewriteSentence({ apiKey: settings.apiKey, model: settings.model, sentence: text, context: text })
    } else {
      fixed = (await m.fixText(checker, text, { mode: 'writing' })).fixed
    }
    if (!fixed || fixed === text) return notify('WriteWise', 'No changes needed. Paste to use the text.')
    await clipboard.writeText(fixed)
    notify('WriteWise', `Fixed the sentence (${settings.apiKey ? 'Claude' : 'offline'}). Paste to use it.`)
  } catch (err) {
    notify('WriteWise', 'Could not fix the sentence: ' + (err && err.message ? err.message : err))
  }
}

/** Alt+Shift+P: turn the focused text box (or its selection) into a structured AI prompt, in place. */
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

let mainWin = null

/**
 * The AI settings every consumer uses: the key the user entered under Settings, kept in the OS keychain by
 * electron/ai-settings.cjs, or, when none is stored there, ANTHROPIC_API_KEY / ~/.config/writewise/config.json,
 * the same places the CLI looks. Read from the store directly; the editor window is never involved.
 */
function getAiSettings() {
  return aiSettings.getAiSettings()
}

/** Registers `writewise native-host` with the browsers so the extension can fetch the key from this app. */
async function connectBrowserExtension(interactive) {
  try {
    let extensionIds = []
    try {
      const cfg = await (await getModule()).readConfig()
      if (Array.isArray(cfg.extensionIds)) extensionIds = cfg.extensionIds
    } catch { /* no config file */ }
    const r = nativeHost.register({ enginePath: ENGINE, extensionIds })
    shellSettings.nativeHost = true
    saveShellSettings()
    if (interactive) {
      if (!r.browsers.length) notify('WriteWise', 'No Chromium-based browser profile found (Chrome, Brave, Edge, Arc, Chromium, Vivaldi). Open one once, then try again.')
      else notify('WriteWise', `Registered with ${r.browsers.join(', ')}. In the WriteWise extension popup, click "Use the desktop app's key".`)
    }
    return r
  } catch (err) {
    console.warn('native host registration failed:', err)
    if (interactive) notify('WriteWise', 'Could not connect the browser extension: ' + (err && err.message ? err.message : err))
    return null
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
    // The preload only exposes the AI-settings bridge (window.writewiseDesktop); the page stays sandboxed.
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWin = win
  win.on('closed', () => { if (mainWin === win) mainWin = null })
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
        { label: 'Fix the current sentence (Claude when a key is set)', accelerator: SENTENCE_HOTKEY, click: fixSentenceInPlace },
        { label: 'Turn the active text into an AI prompt', accelerator: PROMPT_HOTKEY, click: promptifyInPlace },
        { type: 'separator' },
        { label: 'Fix clipboard text', click: fixClipboard },
        { label: 'Turn clipboard into an AI prompt', click: promptifyClipboard },
        { type: 'separator' },
        { label: 'Connect the browser extension (share the API key)…', click: () => connectBrowserExtension(true) },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { label: 'Underline suggestions in other apps', type: 'checkbox', checked: shellSettings.overlay, click: (item) => { setOverlayEnabled(item.checked) } },
          { label: 'Open Accessibility settings…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
        ] : []),
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
  // The editor reads and writes the API key through this IPC; it must exist before the window loads.
  aiSettings.installIpc({ resolveFallback: async () => (await getModule()).resolveAiSettings() })
  buildMenu()
  createWindow()
  // Global hotkeys work even when another app (e.g. a chat window) is in front.
  if (!globalShortcut.register(HOTKEY, fixInPlace)) console.warn('Could not register', HOTKEY)
  if (!globalShortcut.register(SENTENCE_HOTKEY, fixSentenceInPlace)) console.warn('Could not register', SENTENCE_HOTKEY)
  if (!globalShortcut.register(PROMPT_HOTKEY, promptifyInPlace)) console.warn('Could not register', PROMPT_HOTKEY)
  getEngine().catch((err) => console.warn('engine preload failed', err))
  // Hand the key to the other WriteWise surfaces on this machine (browser-extension bridge, CLI) over a local socket.
  getModule().then((m) => aiSettings.startSocketServer(m.desktopSocketPath())).catch((err) => console.warn('settings socket failed:', err.message))
  if (shellSettings.nativeHost) connectBrowserExtension(false) // keep the registration current after an update or a move
  if (process.platform === 'darwin' && ax.available()) {
    overlay = createOverlay({ ax, getEngine, notify, getAiSettings })
    if (shellSettings.overlay) overlay.start().catch((err) => console.warn('overlay start failed', err))
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().filter((w) => w !== toastWin).length === 0) createWindow() })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); if (overlay) overlay.stop(); ax.stop(); aiSettings.stopSocketServer() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
