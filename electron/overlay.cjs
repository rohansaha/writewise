// Grammarly-style underlines in any app (phase 1).
//
// The Accessibility helper streams the focused text box of the app in front (focus / text / moved /
// blur events). After a pause in typing the text is checked, the helper is asked where each flagged
// range sits on screen, and the underlines plus a suggestion card are drawn in a transparent,
// click-through, always-on-top window laid over the whole display. The window never takes focus;
// it only accepts the mouse while the pointer is over an underline or the card.
const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')

const OWN_BUNDLES = new Set(['app.writewise.desktop', 'com.github.Electron'])
const AI_CHAT_BUNDLES = new Set(['com.anthropic.claudefordesktop', 'com.openai.chat'])
const MAX_ISSUES = 80
const CHECK_DELAY_MS = 650
const debug = (...a) => { if (process.env.WRITEWISE_DEBUG) console.log('[overlay]', ...a) }

function createOverlay({ ax, getEngine, notify }) {
  let enabled = false
  let win = null
  let box = null          // latest focus/text payload from the helper
  let issues = []         // issues for `checkedText`
  let checkedText = null
  let checkTimer = null
  let boundsTimer = null
  let checking = false
  let cardId = null
  let dismissed = new Set()
  let boxKey = null
  let restarts = 0
  let pageReady = false
  let pendingPayload = null
  let regions = []        // interactive rects reported by the page (window-relative)
  let pollTimer = null
  let mouseOn = false

  // ---------- window ----------
  function ensureWindow() {
    if (win) return win
    win = new BrowserWindow({
      // 'panel' makes it a non-activating NSPanel: clicking it never brings WriteWise to the front, so the app
      // being edited stays active. It must stay focusable, though: a non-focusable panel accepts the mouse but
      // never delivers clicks to its page. The panel is hidden again as soon as a fix is applied or dismissed.
      type: 'panel',
      show: false, frame: false, transparent: true, alwaysOnTop: true, focusable: true, hasShadow: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      acceptFirstMouse: true,
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.on('did-finish-load', () => {
      pageReady = true
      debug('page loaded')
      if (pendingPayload) { win.webContents.send('overlay:render', pendingPayload); pendingPayload = null }
    })
    win.loadFile(path.join(__dirname, 'overlay.html')).catch((err) => console.warn('[overlay] page failed to load:', err.message))
    win.on('closed', () => { win = null; pageReady = false; stopPolling() })
    return win
  }

  function hideWindow() {
    stopPolling()
    regions = []
    if (win && win.isVisible()) win.hide()
  }

  // The panel does not forward mouse moves to its page, so hit testing happens here: while underlines are
  // showing, the cursor is polled and the window accepts the mouse only over an underline or the card.
  function setMouse(on) {
    if (!win || mouseOn === on) return
    mouseOn = on
    debug('mouse', on ? 'accepting' : 'passing through', 'cursor', JSON.stringify(screen.getCursorScreenPoint()))
    if (on) win.setIgnoreMouseEvents(false); else win.setIgnoreMouseEvents(true, { forward: true })
  }
  function pollCursor() {
    if (!win || !win.isVisible()) return setMouse(false)
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    setMouse(regions.some((r) => x >= r[0] - 3 && x <= r[0] + r[2] + 3 && y >= r[1] - 3 && y <= r[1] + r[3] + 3))
  }
  function startPolling() { if (!pollTimer) pollTimer = setInterval(pollCursor, 40) }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; setMouse(false) }

  function clear() {
    clearTimeout(checkTimer)
    clearTimeout(boundsTimer)
    issues = []
    checkedText = null
    cardId = null
    hideWindow()
  }

  // ---------- helper events ----------
  function keyOf(b) { return `${b.bundle}|${b.pid}|${(b.bounds || []).map(Math.round).join(',')}` }

  function onBox(payload) {
    if (!enabled) return
    if (!payload.editable || payload.secure || OWN_BUNDLES.has(payload.bundle)) { box = null; return clear() }
    const key = keyOf(payload)
    if (key !== boxKey) { boxKey = key; dismissed = new Set(); cardId = null }
    box = payload
    clearTimeout(checkTimer)
    debug('event', payload.type, 'gen', payload.gen, 'len', (payload.text || '').length, 'sameText', payload.text === checkedText, 'checkedLen', checkedText === null ? null : checkedText.length, 'sel', [payload.selStart, payload.selLen])
    if (payload.text === checkedText) { scheduleLayout(0); return } // only the caret moved
    // The text changed: drop stale underlines right away and check again after a pause in typing.
    issues = []
    cardId = null
    hideWindow()
    checkTimer = setTimeout(() => { check(payload).catch((err) => console.warn('[overlay] check failed:', err.message)) }, CHECK_DELAY_MS)
  }

  async function check(payload) {
    if (checking) { checkTimer = setTimeout(() => check(box || payload), 150); return }
    checking = true
    try {
      const { m, checker } = await getEngine()
      const mode = AI_CHAT_BUNDLES.has(payload.bundle) ? 'prompt' : 'writing'
      const result = await checker.check(payload.text, { ...m.DEFAULT_CHECK_OPTIONS, mode })
      if (!box || box.text !== payload.text) return // superseded
      checkedText = payload.text
      issues = result.issues.filter((i) => i.end > i.start && !dismissed.has(dismissKey(i))).slice(0, MAX_ISSUES)
      debug('checked', payload.app, 'issues:', issues.length)
      await layout()
    } finally {
      checking = false
    }
  }

  function dismissKey(i) { return `${i.ruleId}|${i.actual}` }

  function scheduleLayout(delay) {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => { layout().catch((err) => console.warn('[overlay] layout failed:', err.message)) }, delay)
  }

  // ---------- geometry + drawing ----------
  async function layout() {
    if (!box || !issues.length) return render([])
    const text = box.text
    let rects = []
    try { rects = (await ax.request({ cmd: 'bounds', pid: box.pid, ranges: issues.map((i) => [i.start, i.end - i.start]) })).rects || [] } catch { rects = [] }
    if (!box || box.text !== text) return
    const items = []
    issues.forEach((issue, idx) => {
      const r = rects[idx]
      if (Array.isArray(r) && r[2] > 0 && r[3] > 0) items.push({ issue, rect: r })
    })
    render(items)
  }

  function render(items) {
    if (!items.length) { cardId = null; return hideWindow() }
    const w = ensureWindow()
    const anchor = items[0].rect
    const display = screen.getDisplayNearestPoint({ x: Math.round(anchor[0]), y: Math.round(anchor[1]) })
    // Cover the display's work area (macOS keeps windows out of the menu bar anyway) and position everything
    // against the bounds the window actually got.
    const want = display.workArea
    const cur = w.getBounds()
    if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) w.setBounds(want)
    const b = w.getBounds()
    if (cardId && !items.some((it) => it.issue.id === cardId)) cardId = null
    const payload = {
      size: [b.width, b.height],
      card: cardId,
      items: items.map(({ issue, rect }) => ({
        id: issue.id, x: rect[0] - b.x, y: rect[1] - b.y, w: rect[2], h: rect[3],
        category: issue.category, title: issue.title, message: issue.message, actual: issue.actual,
        replacements: (issue.replacements || []).slice(0, 3),
      })),
    }
    debug('render', payload.items.length, 'underlines; card:', cardId)
    if (pageReady) w.webContents.send('overlay:render', payload); else pendingPayload = payload
    if (!w.isVisible()) w.showInactive()
    startPolling()
    debug('window visible:', w.isVisible(), 'bounds:', JSON.stringify(w.getBounds()))
  }

  // ---------- messages from the overlay page ----------
  ipcMain.on('overlay:regions', (_e, rects) => { regions = Array.isArray(rects) ? rects : [] })
  ipcMain.on('overlay:hover', () => { /* hit testing is done in pollCursor */ })
  ipcMain.on('overlay:card', (_e, id) => { cardId = id || null; debug('card', cardId) })
  ipcMain.on('overlay:debug', (_e, info) => { if (process.env.WRITEWISE_DEBUG) console.log('[overlay:geometry]', JSON.stringify({ origin: win ? [win.getBounds().x, win.getBounds().y] : null, ...info })) })
  ipcMain.on('overlay:dismiss', (_e, id) => {
    const issue = issues.find((i) => i.id === id)
    if (issue) dismissed.add(dismissKey(issue))
    issues = issues.filter((i) => i.id !== id)
    cardId = null
    scheduleLayout(0)
  })
  ipcMain.on('overlay:apply', async (_e, { id, replacement }) => {
    const issue = issues.find((i) => i.id === id)
    debug('apply', id, JSON.stringify(replacement), issue ? [issue.start, issue.end] : 'no issue', box ? box.app : 'no box')
    if (!issue || !box || typeof replacement !== 'string') return
    cardId = null
    const caret = box.selStart || 0
    issues = issues.filter((i) => i.id !== id)
    hideWindow()
    try {
      const r = await ax.request({ cmd: 'replace', pid: box.pid, start: issue.start, length: issue.end - issue.start, text: replacement })
      debug('replace ->', JSON.stringify(r))
      if (!r.ok) throw new Error(r.error || 'replace failed')
      // Keep the caret where it was, shifted when the edit sat before it.
      let c = caret
      if (issue.end <= caret) c += replacement.length - (issue.end - issue.start)
      else if (issue.start < caret) c = issue.start + replacement.length
      await ax.request({ cmd: 'select', pid: box.pid, start: c, length: 0 })
    } catch (err) {
      console.warn('[overlay] apply failed:', err.message)
      notify('WriteWise', 'Could not apply the fix: ' + err.message)
    }
  })

  // When the overlay panel takes the mouse, Chromium apps briefly report no focused element and then the same
  // box again. A blur therefore only counts if no focus/text event follows within a short grace period.
  let blurTimer = null
  ax.on('focus', (p) => { clearTimeout(blurTimer); onBox(p) })
  ax.on('text', (p) => { clearTimeout(blurTimer); onBox(p) })
  ax.on('moved', () => { if (issues.length) scheduleLayout(60) })
  // While the card is open the panel holds key status and the app reports no focused element at all, so a
  // blur is ignored until the card closes (the panel hides, focus returns, and a focus event follows).
  ax.on('blur', () => { debug('event blur; card open:', !!cardId); clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (cardId) return; box = null; clear() }, 1200) })
  ax.on('exit', () => {
    box = null
    clear()
    if (enabled && restarts < 3) { restarts++; setTimeout(() => { if (enabled) start().catch(() => {}) }, 1500) }
  })

  // ---------- lifecycle ----------
  /** Turns the overlay on. Resolves false when macOS has not granted Accessibility access yet. */
  async function start() {
    enabled = true
    if (!ax.available()) return false
    try {
      const t = await ax.request({ cmd: 'trusted', prompt: false })
      if (!t.ok) {
        await ax.request({ cmd: 'trusted', prompt: true })
        notify('WriteWise needs Accessibility access', 'Allow WriteWise under System Settings > Privacy & Security > Accessibility to underline suggestions in other apps.')
        return false
      }
      await ax.request({ cmd: 'watch', on: true })
      return true
    } catch (err) {
      console.warn('[overlay] start failed:', err.message)
      return false
    }
  }

  function stop() {
    enabled = false
    box = null
    clear()
    if (ax.available()) { try { ax.send({ cmd: 'watch', on: false }) } catch { /* helper gone */ } }
  }

  return { start, stop, isEnabled: () => enabled, clear }
}

module.exports = { createOverlay }
