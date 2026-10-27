// Grammarly-style suggestions in any app (macOS), sentence by sentence.
//
// The Accessibility helper streams the focused text box of the app in front (focus / text / moved /
// blur events). After a pause in typing the text is checked, the findings are grouped by sentence,
// the helper is asked where each sentence and each flagged word sits on screen, and a transparent,
// non-activating panel laid over the display draws a soft highlight per sentence (flagged words
// underlined inside it) plus a card that proposes the corrected sentence as a whole. With an
// Anthropic API key in the editor's settings the card can also ask Claude for a context-aware
// correction that sees the whole message. The panel never takes the app's focus; it accepts the
// mouse only while the pointer is over a sentence or the card.
const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')

const OWN_BUNDLES = new Set(['app.writewise.desktop', 'com.github.Electron'])
const AI_CHAT_BUNDLES = new Set(['com.anthropic.claudefordesktop', 'com.openai.chat'])
const MAX_ISSUES = 120
const CHECK_DELAY_MS = 650
const debug = (...a) => { if (process.env.WRITEWISE_DEBUG) console.log('[overlay]', ...a) }

/**
 * Sentence boundaries with offsets. A run of . ! ? (plus closing quotes/brackets) followed by
 * whitespace or the end, or a line break, ends a sentence; "3.5" and "e.g" inside a word do not.
 * A line with no punctuation (a one-line chat prompt) is one sentence.
 */
function splitSentences(text) {
  const out = []
  const push = (s, e) => {
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e > s) out.push({ start: s, end: e })
  }
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') { push(start, i); start = i + 1; continue }
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1
      while (j < text.length && /[.!?]/.test(text[j])) j++
      while (j < text.length && /["')\]]/.test(text[j])) j++
      if (j >= text.length || /\s/.test(text[j])) { push(start, j); start = j; i = j - 1 }
    }
  }
  push(start, text.length)
  return out
}

/**
 * Groups issues by sentence and builds the whole-sentence correction: the safe fixes Cmd+Shift+G would
 * apply, plus the top suggestion for every other finding that has one. Findings without a replacement
 * (passive voice, hard to read) are kept as notes on the card.
 */
function buildSentences(text, issues, m) {
  const items = []
  for (const s of splitSentences(text)) {
    const inside = issues.filter((i) => i.start >= s.start && i.end <= s.end)
    if (!inside.length) continue
    const sentence = text.slice(s.start, s.end)
    const local = inside.map((i) => ({ ...i, start: i.start - s.start, end: i.end - s.start }))
    const safe = m.autoFix(sentence, local)
    const appliedIds = new Set(safe.applied.map((i) => i.id))
    const edits = safe.edits.map((e) => ({ start: e.start, end: e.end, replacement: e.replacement }))
    for (const i of local) if (!appliedIds.has(i.id) && i.replacements && i.replacements[0]) edits.push({ start: i.start, end: i.end, replacement: i.replacements[0] })
    edits.sort((a, b) => a.start - b.start)
    const kept = []
    let lastEnd = -1
    for (const e of edits) { if (e.start < lastEnd) continue; kept.push(e); lastEnd = e.end }
    let fixed = sentence
    for (const e of [...kept].reverse()) fixed = fixed.slice(0, e.start) + e.replacement + fixed.slice(e.end)
    items.push({
      id: `s${s.start}-${s.end}`, start: s.start, end: s.end, sentence, fixed, changes: kept.length, issues: inside,
      notes: inside.filter((i) => !i.replacements || !i.replacements.length).map((i) => ({ title: i.title, message: i.message })),
    })
  }
  return items
}

function createOverlay({ ax, getEngine, notify, getAiSettings }) {
  let enabled = false
  let win = null
  let box = null            // latest focus/text payload from the helper
  let sentences = []        // sentence items for `checkedText`
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
  let regions = []          // interactive rects reported by the page (window-relative)
  let pollTimer = null
  let mouseOn = false
  let aiCache = { at: 0, available: false }
  const rewrites = new Map() // sentence text -> corrected text from Claude (so re-opening a card never re-asks)

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

  // The panel does not forward mouse moves to its page, so hit testing happens here: while suggestions are
  // showing, the cursor is polled and the window accepts the mouse only over a sentence or the card.
  function setMouse(on) {
    if (!win || mouseOn === on) return
    mouseOn = on
    debug('mouse', on ? 'accepting' : 'passing through')
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
    sentences = []
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
    debug('event', payload.type, 'gen', payload.gen, 'len', (payload.text || '').length, 'sameText', payload.text === checkedText, 'sel', [payload.selStart, payload.selLen])
    if (payload.text === checkedText) { scheduleLayout(0); return } // only the caret moved
    // The text changed: drop stale marks right away and check again after a pause in typing.
    sentences = []
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
      const issues = result.issues.filter((i) => i.end > i.start).slice(0, MAX_ISSUES)
      sentences = buildSentences(payload.text, issues, m).filter((s) => !dismissed.has(s.sentence))
      debug('checked', payload.app, 'issues:', issues.length, 'sentences:', sentences.length)
      await layout()
    } finally {
      checking = false
    }
  }

  function scheduleLayout(delay) {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => { layout().catch((err) => console.warn('[overlay] layout failed:', err.message)) }, delay)
  }

  async function aiAvailable() {
    if (!getAiSettings) return false
    if (Date.now() - aiCache.at < 10000) return aiCache.available
    try { const s = await getAiSettings(); aiCache = { at: Date.now(), available: !!(s && s.apiKey) } } catch { aiCache = { at: Date.now(), available: false } }
    return aiCache.available
  }

  // ---------- geometry + drawing ----------
  async function layout() {
    if (!box || !sentences.length) return render([])
    const text = box.text
    const ranges = []
    for (const s of sentences) { ranges.push([s.start, s.end - s.start]); for (const i of s.issues) ranges.push([i.start, i.end - i.start]) }
    let rects = []
    let lines = []
    try { const res = await ax.request({ cmd: 'bounds', pid: box.pid, ranges, lines: true }, 6000); rects = res.rects || []; lines = res.lines || [] } catch { rects = [] }
    if (!box || box.text !== text) return
    const ai = await aiAvailable()
    const items = []
    let k = 0
    for (const s of sentences) {
      // A sentence gets one rectangle per visual line (a wrapped sentence must not cover the line above it).
      const union = rects[k]
      let lineRects = Array.isArray(lines[k]) ? lines[k].filter((r) => Array.isArray(r) && r[2] > 0 && r[3] > 0) : []
      if (!lineRects.length && Array.isArray(union) && union[2] > 0 && union[3] > 0) lineRects = [union]
      k++
      const words = []
      for (const i of s.issues) {
        const w = rects[k++]
        if (Array.isArray(w) && w[2] > 0 && w[3] > 0) words.push({ rect: w, category: i.category })
      }
      if (lineRects.length) items.push({ s, rects: lineRects, words })
    }
    render(items, ai)
  }

  function render(items, ai = false) {
    if (!items.length) { cardId = null; return hideWindow() }
    const w = ensureWindow()
    const anchor = items[0].rects[0]
    const display = screen.getDisplayNearestPoint({ x: Math.round(anchor[0]), y: Math.round(anchor[1]) })
    // Cover the display's work area (macOS keeps windows out of the menu bar anyway) and position everything
    // against the bounds the window actually got.
    const want = display.workArea
    const cur = w.getBounds()
    if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) w.setBounds(want)
    const b = w.getBounds()
    if (cardId && !items.some((it) => it.s.id === cardId)) cardId = null
    const payload = {
      size: [b.width, b.height],
      card: cardId,
      aiAvailable: ai,
      items: items.map(({ s, rects, words }) => ({
        id: s.id, lines: rects.map((r) => ({ x: r[0] - b.x, y: r[1] - b.y, w: r[2], h: r[3] })),
        sentence: s.sentence, fixed: s.fixed, changes: s.changes, notes: s.notes, count: s.issues.length,
        tone: s.issues.every((i) => i.category !== 'correctness') ? 'clarity' : 'correctness',
        words: words.map((x) => ({ x: x.rect[0] - b.x, y: x.rect[1] - b.y, w: x.rect[2], h: x.rect[3], category: x.category })),
      })),
    }
    debug('render', payload.items.length, 'sentences; card:', cardId, '| ai:', ai)
    if (pageReady) w.webContents.send('overlay:render', payload); else pendingPayload = payload
    if (!w.isVisible()) w.showInactive()
    debug('window visible:', w.isVisible(), 'bounds:', JSON.stringify(w.getBounds()))
    startPolling()
  }

  // ---------- messages from the overlay page ----------
  ipcMain.on('overlay:regions', (_e, rects) => { regions = Array.isArray(rects) ? rects : [] })
  ipcMain.on('overlay:hover', () => { /* hit testing is done in pollCursor */ })
  ipcMain.on('overlay:card', (_e, id) => { cardId = id || null; debug('card', cardId) })
  ipcMain.on('overlay:debug', (_e, info) => { if (process.env.WRITEWISE_DEBUG) console.log('[overlay:geometry]', JSON.stringify({ origin: win ? [win.getBounds().x, win.getBounds().y] : null, ...info })) })
  ipcMain.on('overlay:dismiss', (_e, id) => {
    const s = sentences.find((x) => x.id === id)
    if (s) dismissed.add(s.sentence)
    sentences = sentences.filter((x) => x.id !== id)
    cardId = null
    scheduleLayout(0)
  })
  ipcMain.on('overlay:apply', async (_e, { id, text }) => {
    const s = sentences.find((x) => x.id === id)
    debug('apply', id, s ? [s.start, s.end] : 'no sentence', box ? box.app : 'no box')
    if (!s || !box || typeof text !== 'string') return
    cardId = null
    const caret = box.selStart || 0
    sentences = sentences.filter((x) => x.id !== id)
    hideWindow()
    try {
      const r = await ax.request({ cmd: 'replace', pid: box.pid, start: s.start, length: s.end - s.start, text })
      debug('replace ->', JSON.stringify(r))
      if (!r.ok) throw new Error(r.error || 'replace failed')
      // Keep the caret where it was, shifted when the edit sat before it.
      let c = caret
      if (s.end <= caret) c += text.length - (s.end - s.start)
      else if (s.start < caret) c = s.start + text.length
      await ax.request({ cmd: 'select', pid: box.pid, start: c, length: 0 })
    } catch (err) {
      console.warn('[overlay] apply failed:', err.message)
      notify('WriteWise', 'Could not apply the fix: ' + err.message)
    }
  })
  ipcMain.on('overlay:rewrite', async (_e, { id }) => {
    const s = sentences.find((x) => x.id === id)
    const reply = (r) => { if (win && !win.isDestroyed()) win.webContents.send('overlay:rewrite-result', { id, sentence: s ? s.sentence : undefined, ...r }) }
    if (!s || !box) return reply({ error: 'That sentence is gone.' })
    if (rewrites.has(s.sentence)) return reply({ text: rewrites.get(s.sentence) })
    const context = box.text
    try {
      const settings = getAiSettings ? await getAiSettings() : null
      if (!settings || !settings.apiKey) return reply({ error: 'Add your Anthropic API key under Settings in WriteWise to use Claude rewrites.' })
      const { m } = await getEngine()
      debug('rewrite via Claude', id, settings.model)
      const text = await m.rewriteSentence({ apiKey: settings.apiKey, model: settings.model, sentence: s.sentence, context })
      rewrites.set(s.sentence, text)
      if (rewrites.size > 200) rewrites.delete(rewrites.keys().next().value)
      if (!box || box.text !== context) return // the text moved on; the suggestion no longer fits
      reply({ text })
    } catch (err) {
      console.warn('[overlay] rewrite failed:', err.message)
      reply({ error: (err && err.message) || 'The rewrite failed.' })
    }
  })

  // While the card is open the panel holds key status and the app reports no focused element at all, so a
  // blur is ignored until the card closes (the panel hides, focus returns, and a focus event follows).
  let blurTimer = null
  ax.on('focus', (p) => { clearTimeout(blurTimer); onBox(p) })
  ax.on('text', (p) => { clearTimeout(blurTimer); onBox(p) })
  ax.on('moved', () => { if (sentences.length) scheduleLayout(60) })
  ax.on('blur', () => { debug('event blur; card open:', !!cardId); clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (cardId) return; box = null; clear() }, 1200) })
  ax.on('exit', () => {
    box = null
    clear()
    if (enabled && restarts < 3) { restarts++; setTimeout(() => { if (enabled) start().catch(() => {}) }, 1500) }
  })

  // ---------- lifecycle ----------
  let trustTimer = null
  let prompted = false
  /**
   * Turns the overlay on. Resolves false when macOS has not granted Accessibility access yet; in that case the
   * system prompt is shown once and the permission is re-checked every few seconds, so the suggestions start as
   * soon as the user flips the switch, with no relaunch.
   */
  async function start() {
    enabled = true
    clearTimeout(trustTimer)
    if (!ax.available()) return false
    try {
      const t = await ax.request({ cmd: 'trusted', prompt: false })
      if (!t.ok) {
        if (!prompted) {
          prompted = true
          await ax.request({ cmd: 'trusted', prompt: true })
          notify('WriteWise needs Accessibility access', 'Allow WriteWise under System Settings > Privacy & Security > Accessibility to get suggestions in other apps.')
        }
        trustTimer = setTimeout(() => { if (enabled) start().then((ok) => { if (ok) notify('WriteWise', 'Thanks! Sentences with issues will now be highlighted in other apps as you type.') }).catch(() => {}) }, 4000)
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
    clearTimeout(trustTimer)
    box = null
    clear()
    if (ax.available()) { try { ax.send({ cmd: 'watch', on: false }) } catch { /* helper gone */ } }
  }

  return { start, stop, isEnabled: () => enabled, clear }
}

module.exports = { createOverlay, splitSentences, buildSentences }
