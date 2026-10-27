// WriteWise content script: watches the focused text box on any page, checks
// it with the extension's background engine, shows a badge + suggestion panel,
// and (on AI chat sites by default) auto-applies safe fixes as you type.
import type { Issue } from '../../src/types'

type Mode = 'writing' | 'prompt'
interface Edit { start: number; end: number; replacement: string }
interface CheckResponse { issues: Issue[]; fixed: string; edits: Edit[]; promptScore: number | null; template?: string; error?: string }
interface Settings { enabled: boolean; disabledSites: string[]; autoFixSites: string[]; autoFixEverywhere: boolean }

export const AI_SITES = ['claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'perplexity.ai', 'copilot.microsoft.com', 'poe.com', 'grok.com', 'chat.mistral.ai', 'huggingface.co', 'chat.deepseek.com', 'you.com']
const DEFAULT_SETTINGS: Settings = { enabled: true, disabledSites: [], autoFixSites: AI_SITES, autoFixEverywhere: false }
const HOST = location.hostname.replace(/^www\./, '')
const MAX_CHARS = 20000

const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime?.id
let settings: Settings = { ...DEFAULT_SETTINGS }
// Opt-in "Fix with Claude" (popup > Claude). Only the flag is read here; the key stays in the background worker.
let claudeEnabled = false

// ---------- settings ----------
async function loadSettings(): Promise<void> {
  if (hasChrome && chrome.storage?.sync) {
    settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) } as Settings
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.claudeEnabled) { claudeEnabled = !!changes.claudeEnabled.newValue; if (panelOpen) renderPanel() }
        return
      }
      if (area !== 'sync') return
      for (const [k, v] of Object.entries(changes)) (settings as any)[k] = v.newValue ?? (DEFAULT_SETTINGS as any)[k]
      if (active) scheduleCheck(active, 0)
    })
    try { claudeEnabled = !!(await chrome.storage.local.get({ claudeEnabled: false })).claudeEnabled } catch { claudeEnabled = false }
  } else {
    try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('writewise:ext') || '{}') } } catch { /* ignore */ }
  }
}
async function saveSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  if (hasChrome && chrome.storage?.sync) await chrome.storage.sync.set(patch)
  else localStorage.setItem('writewise:ext', JSON.stringify(settings))
}
const siteMatches = (list: string[]) => list.some((s) => HOST === s || HOST.endsWith('.' + s))
const siteEnabled = () => settings.enabled && !siteMatches(settings.disabledSites)
const autoFixOn = () => settings.autoFixEverywhere || siteMatches(settings.autoFixSites)
const isAiSite = () => siteMatches(AI_SITES)

// ---------- engine messaging ----------
function sendCheck(text: string, mode: Mode): Promise<CheckResponse> {
  const testHook = (window as any).__writewiseCheck
  if (testHook) return testHook(text, mode)
  if (!hasChrome) return Promise.reject(new Error('no engine'))
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'check', text, mode }, (res: CheckResponse) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!res) return reject(new Error('no response'))
      if (res.error) return reject(new Error(res.error))
      resolve(res)
    })
  })
}

/** Asks the background worker to correct the text with Claude (the user's own key, opt-in). */
function sendClaudeFix(text: string): Promise<string> {
  if (!hasChrome) return Promise.reject(new Error('no engine'))
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'claude-fix', text }, (res: { fixed?: string; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!res) return reject(new Error('no response'))
      if (res.error) return reject(new Error(res.error))
      resolve(res.fixed ?? '')
    })
  })
}

// ---------- editable fields ----------
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', ''])
function isEditable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.closest('[data-writewise-ui]')) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled && el.getAttribute('autocomplete') !== 'off-writewise'
  return el.isContentEditable
}
function editableRoot(el: HTMLElement): HTMLElement {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el
  let root: HTMLElement = el
  while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement
  return root
}
function getText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return el.innerText.replace(/\r\n/g, '\n')
}
function caretAtEnd(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length
  const sel = el.ownerDocument.getSelection()
  if (!sel || !sel.isCollapsed || !sel.focusNode || !el.contains(sel.focusNode)) return false
  const range = el.ownerDocument.createRange()
  range.setStart(sel.focusNode, sel.focusOffset)
  range.setEnd(el, el.childNodes.length)
  return range.toString().trim() === ''
}
function setText(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, text); else el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.setSelectionRange(text.length, text.length)
    return
  }
  el.focus()
  const doc = el.ownerDocument
  const sel = doc.getSelection()
  sel?.selectAllChildren(el)
  const lines = text.split('\n')
  let ok = true
  lines.forEach((line, i) => {
    if (i > 0) ok = doc.execCommand('insertLineBreak') && ok
    if (line) ok = doc.execCommand('insertText', false, line) && ok
  })
  if (!ok || getText(el).replace(/\n+$/, '') !== text.replace(/\n+$/, '')) {
    // Editors that ignore execCommand: replace the content directly.
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
  // Caret to end.
  const range = doc.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(range)
}
function applyEdits(text: string, edits: Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  return out
}

// ---------- state ----------
let active: HTMLElement | null = null
let checkTimer: number | undefined
let lastText = ''
let lastResult: CheckResponse | null = null
let lastAutoFixed = ''
let checking = false
let dismissed = new Set<string>()
let panelOpen = false

function scheduleCheck(el: HTMLElement, delay: number) {
  clearTimeout(checkTimer)
  checkTimer = window.setTimeout(() => runCheck(el), delay)
}

async function runCheck(el: HTMLElement) {
  if (!siteEnabled() || el !== active) return
  const text = getText(el)
  if (!text.trim() || text.length > MAX_CHARS) { lastResult = null; renderBadge(); return }
  if (text === lastText && lastResult) { renderBadge(); return }
  if (checking) { scheduleCheck(el, 300); return }
  checking = true
  try {
    const res = await sendCheck(text, isAiSite() ? 'prompt' : 'writing')
    if (el !== active || getText(el) !== text) return
    lastText = text
    lastResult = res
    if (autoFixOn() && text !== lastAutoFixed) maybeAutoFix(el, text, res)
    renderBadge()
    if (panelOpen) renderPanel()
  } catch (err) {
    console.debug('[WriteWise]', err)
  } finally {
    checking = false
  }
}

/** Autocorrect-style: apply safe fixes that end before the word being typed, only when the caret is at the end. */
function maybeAutoFix(el: HTMLElement, text: string, res: CheckResponse) {
  if (!res.edits.length || !caretAtEnd(el)) return
  const m = /\S+$/.exec(text)
  const cutoff = m ? m.index : text.length
  const edits = res.edits.filter((e) => e.end <= cutoff)
  if (!edits.length) return
  const fixed = applyEdits(text, edits)
  if (fixed === text) return
  lastAutoFixed = fixed
  setText(el, fixed)
  lastText = ''
  flash(`${edits.length} fix${edits.length === 1 ? '' : 'es'} applied`)
  scheduleCheck(el, 400)
}

// ---------- UI (shadow DOM) ----------
let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let badge: HTMLButtonElement | null = null
let panel: HTMLDivElement | null = null
let toast: HTMLDivElement | null = null
let rafId = 0

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #1a1f29; }
.badge { position: fixed; z-index: 2147483647; width: 24px; height: 24px; border-radius: 50%; border: 0; background: #15c39a; color: #062b22; font-weight: 700; font-size: 11px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); display: none; align-items: center; justify-content: center; padding: 0; transition: transform .1s; }
.badge:hover { transform: scale(1.1); }
.badge.has { background: #e5484d; color: #fff; }
.badge.busy { opacity: .6; }
.panel { position: fixed; z-index: 2147483647; width: 340px; max-height: 60vh; overflow: auto; background: #fff; border: 1px solid #e3e7ec; border-radius: 12px; box-shadow: 0 12px 32px rgba(20,30,50,.2); display: none; }
.panel header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e3e7ec; position: sticky; top: 0; background: #fff; }
.panel header b { flex: 1; }
.btn { border: 1px solid #e3e7ec; background: #fff; border-radius: 7px; padding: 4px 9px; cursor: pointer; font-size: 12px; }
.btn:hover { background: #f4f6f8; }
.btn.accent { background: #15c39a; border-color: #15c39a; color: #062b22; font-weight: 600; }
.btn.fix { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn.fix:hover { border-color: #15c39a; color: #0d7d63; }
.card { padding: 9px 12px; border-bottom: 1px solid #f0f2f5; border-left: 3px solid #e5484d; }
.card.clarity { border-left-color: #3b82f6; } .card.engagement { border-left-color: #16a34a; } .card.delivery { border-left-color: #8b5cf6; } .card.prompt { border-left-color: #f59e0b; }
.card .t { font-weight: 700; } .card .x { color: #66707f; text-decoration: line-through; margin-left: 6px; }
.card .m { margin: 3px 0 6px; color: #333; }
.card .a { display: flex; flex-wrap: wrap; gap: 5px; }
.empty { padding: 16px 12px; color: #66707f; text-align: center; }
footer { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-top: 1px solid #e3e7ec; color: #66707f; font-size: 12px; position: sticky; bottom: 0; background: #fff; }
footer label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.score { font-size: 12px; color: #66707f; }
.toast { position: fixed; z-index: 2147483647; background: #1a1f29; color: #fff; padding: 6px 10px; border-radius: 8px; font-size: 12px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,.3); }
@media (prefers-color-scheme: dark) {
  * { color: #e7eaef; }
  .panel, .panel header, footer { background: #161a20; border-color: #2a303a; }
  .btn { background: #1c2129; border-color: #2a303a; } .btn:hover { background: #242a33; }
  .btn.accent { color: #062b22; }
  .card { border-bottom-color: #2a303a; } .card .m { color: #cfd5de; }
}
`

function ensureUi() {
  if (host) return
  host = document.createElement('div')
  host.setAttribute('data-writewise-ui', '')
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647'
  shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  badge = document.createElement('button')
  badge.className = 'badge'
  badge.title = 'WriteWise suggestions'
  badge.addEventListener('mousedown', (e) => e.preventDefault())
  badge.addEventListener('click', () => { panelOpen = !panelOpen; if (panelOpen) renderPanel(); else hidePanel() })
  panel = document.createElement('div')
  panel.className = 'panel'
  panel.addEventListener('mousedown', (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault() })
  toast = document.createElement('div')
  toast.className = 'toast'
  shadow.append(style, badge, panel, toast)
  ;(document.body || document.documentElement).appendChild(host)
}

function position() {
  if (!active || !badge) return
  const r = active.getBoundingClientRect()
  const visible = r.width > 40 && r.height > 14 && r.bottom > 0 && r.top < innerHeight
  badge.style.display = visible && siteEnabled() ? 'flex' : 'none'
  const x = Math.min(innerWidth - 30, r.right - 30)
  const y = Math.min(innerHeight - 30, r.bottom - 30)
  badge.style.left = `${Math.max(4, x)}px`
  badge.style.top = `${Math.max(4, y)}px`
  if (panel && panelOpen) {
    const pw = 340
    const left = Math.max(8, Math.min(innerWidth - pw - 8, r.right - pw))
    const below = r.bottom + 8
    const ph = Math.min(panel.offsetHeight || 300, innerHeight * 0.6)
    const top = below + ph < innerHeight ? below : Math.max(8, r.top - ph - 8)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }
  if (toast && toast.style.display !== 'none') {
    toast.style.left = `${Math.max(8, r.right - 150)}px`
    toast.style.top = `${Math.max(8, r.bottom - 60)}px`
  }
  rafId = requestAnimationFrame(position)
}

function renderBadge() {
  ensureUi()
  if (!badge) return
  const n = lastResult ? visibleIssues().length : 0
  badge.textContent = lastResult ? String(n) : '✓'
  badge.className = 'badge' + (n ? ' has' : '')
  badge.title = n ? `${n} WriteWise suggestion${n === 1 ? '' : 's'} (click to view)` : 'No issues found'
}

function visibleIssues(): Issue[] {
  return (lastResult?.issues ?? []).filter((i) => !dismissed.has(i.ruleId + '|' + i.actual.toLowerCase()))
}

function renderPanel() {
  ensureUi()
  if (!panel || !active) return
  const el = active
  panel.innerHTML = ''
  const issues = visibleIssues()
  const header = document.createElement('header')
  const title = document.createElement('b')
  title.textContent = issues.length ? `${issues.length} suggestion${issues.length === 1 ? '' : 's'}` : 'Looks good'
  header.appendChild(title)
  if (lastResult?.promptScore != null) {
    const s = document.createElement('span')
    s.className = 'score'
    s.textContent = `prompt ${lastResult.promptScore}/100`
    header.appendChild(s)
  }
  if (lastResult?.edits.length) {
    const fixAll = document.createElement('button')
    fixAll.className = 'btn accent'
    fixAll.textContent = `Fix ${lastResult.edits.length}`
    fixAll.addEventListener('click', () => { if (!lastResult) return; setText(el, applyEdits(getText(el), lastResult.edits)); lastText = ''; scheduleCheck(el, 150); flash('Fixed') })
    header.appendChild(fixAll)
  }
  if (claudeEnabled && lastResult && hasChrome) {
    const cl = document.createElement('button')
    cl.className = 'btn'
    cl.textContent = 'Fix with Claude'
    cl.title = 'Correct grammar, spelling and punctuation with Claude using your own API key (sends this text to Anthropic)'
    cl.addEventListener('click', () => claudeFixBox(el, cl))
    header.appendChild(cl)
  }
  if (lastResult?.template) {
    const mk = document.createElement('button')
    mk.className = 'btn'
    mk.textContent = 'Make it a prompt'
    mk.title = 'Replace with a structured AI prompt; fill in the [brackets]'
    mk.addEventListener('click', () => { if (!lastResult?.template) return; setText(el, lastResult.template); lastText = ''; scheduleCheck(el, 150); hidePanel() })
    header.appendChild(mk)
  }
  const close = document.createElement('button')
  close.className = 'btn'
  close.textContent = '×'
  close.addEventListener('click', hidePanel)
  header.appendChild(close)
  panel.appendChild(header)

  if (!issues.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No suggestions for this text.'; panel.appendChild(e)
  }
  for (const issue of issues.slice(0, 60)) {
    const card = document.createElement('div')
    card.className = `card ${issue.category}`
    const t = document.createElement('div')
    t.innerHTML = '<span class="t"></span><span class="x"></span>'
    t.querySelector('.t')!.textContent = issue.title
    t.querySelector('.x')!.textContent = issue.actual.length > 40 ? issue.actual.slice(0, 37) + '…' : issue.actual
    const m = document.createElement('div'); m.className = 'm'; m.textContent = issue.message
    const a = document.createElement('div'); a.className = 'a'
    for (const rep of issue.replacements.slice(0, 3)) {
      const b = document.createElement('button')
      b.className = 'btn fix'
      b.textContent = rep === '' ? 'Remove' : rep
      b.addEventListener('click', () => {
        const text = getText(el)
        if (text.slice(issue.start, issue.end) !== issue.actual) { flash('Text changed, re-checking'); lastText = ''; scheduleCheck(el, 0); return }
        setText(el, applyEdits(text, [{ start: issue.start, end: issue.end, replacement: rep }]))
        lastText = ''
        scheduleCheck(el, 150)
      })
      a.appendChild(b)
    }
    const d = document.createElement('button'); d.className = 'btn'; d.textContent = 'Dismiss'
    d.addEventListener('click', () => { dismissed.add(issue.ruleId + '|' + issue.actual.toLowerCase()); renderBadge(); renderPanel() })
    a.appendChild(d)
    card.append(t, m, a)
    panel.appendChild(card)
  }

  const footer = document.createElement('footer')
  const auto = document.createElement('label')
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = autoFixOn()
  cb.addEventListener('change', () => {
    const sites = settings.autoFixSites.filter((s) => s !== HOST)
    saveSettings({ autoFixSites: cb.checked ? [...sites, HOST] : sites, autoFixEverywhere: cb.checked ? settings.autoFixEverywhere : false })
  })
  auto.append(cb, document.createTextNode(' Auto-fix as I type here'))
  const off = document.createElement('button'); off.className = 'btn'; off.textContent = `Turn off on ${HOST}`
  off.addEventListener('click', () => { saveSettings({ disabledSites: [...settings.disabledSites, HOST] }); hidePanel(); renderBadge() })
  footer.append(auto, off)
  panel.appendChild(footer)
  panel.style.display = 'block'
}

/** Replaces the box's text with Claude's correction, unless the text changed while Claude was thinking. */
async function claudeFixBox(el: HTMLElement, btn: HTMLButtonElement) {
  const text = getText(el)
  if (!text.trim()) return
  btn.disabled = true
  btn.textContent = 'Asking Claude…'
  try {
    const fixed = await sendClaudeFix(text)
    if (el !== active || getText(el) !== text) { flash('The text changed meanwhile; nothing replaced', 3000); return }
    if (!fixed || fixed === text) { flash('Claude found nothing to fix'); return }
    setText(el, fixed)
    lastText = ''
    scheduleCheck(el, 150)
    flash('Fixed with Claude')
  } catch (err) {
    flash((err as Error).message || 'Claude request failed', 4500)
  } finally {
    btn.disabled = false
    btn.textContent = 'Fix with Claude'
  }
}

function hidePanel() { panelOpen = false; if (panel) panel.style.display = 'none' }

let toastTimer: number | undefined
function flash(msg: string, ms = 1800) {
  ensureUi()
  if (!toast) return
  toast.textContent = `WriteWise: ${msg}`
  toast.style.display = 'block'
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { if (toast) toast.style.display = 'none' }, ms)
}

// ---------- wiring ----------
function activate(el: HTMLElement) {
  const root = editableRoot(el)
  if (root === active) return
  active = root
  lastText = ''
  lastResult = null
  dismissed = new Set()
  hidePanel()
  ensureUi()
  renderBadge()
  cancelAnimationFrame(rafId)
  position()
  scheduleCheck(root, 500)
}
function deactivate() {
  cancelAnimationFrame(rafId)
  active = null
  hidePanel()
  if (badge) badge.style.display = 'none'
}

export function start() {
  loadSettings().then(() => {
    document.addEventListener('focusin', (e) => { if (isEditable(e.target)) activate(e.target) }, true)
    document.addEventListener('focusout', (e) => {
      // Keep the UI when focus moves into our own panel.
      const next = (e as FocusEvent).relatedTarget
      if (next instanceof Node && host?.contains(next)) return
      setTimeout(() => { if (document.activeElement && isEditable(document.activeElement) && editableRoot(document.activeElement as HTMLElement) === active) return; if (!panelOpen) deactivate() }, 150)
    }, true)
    document.addEventListener('input', (e) => {
      if (!active) return
      const t = e.target
      if (t instanceof HTMLElement && (t === active || active.contains(t))) scheduleCheck(active, 700)
    }, true)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) hidePanel() }, true)
    const current = document.activeElement
    if (current && isEditable(current)) activate(current as HTMLElement)
  })
}

if (!(window as any).__writewiseStarted) {
  ;(window as any).__writewiseStarted = true
  start()
}
