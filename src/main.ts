import './style.css'
import type { EditorView } from '@codemirror/view'
import type { Category, CheckOptions, DocStats, Issue, Mode, PromptReport, Settings, Tone, WorkerRequest, WorkerResponse } from './types'
import { acceptAllSafe, applyReplacement, createEditor, dismissIssue, focusIssue, getIssues, getText, replaceRange, setIssuesEffect, setText, type IssueRange } from './editor'
import { checkWithLanguageTool, LT_MAX_CHARS } from './cloud'
import { rewrite, type AiMode } from './ai'
import { hydrateAiSettings, isDesktop, loadDoc, loadSettings, saveAiSettings, saveDoc, saveSettings, type AiState } from './settings'
import { registerServiceWorker } from './pwa'
import { analyzePrompt, buildPromptTemplate } from './engine/prompt'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

// ---------- state ----------
let settings: Settings = loadSettings()
// In the desktop app the Anthropic key lives in the OS keychain (shared with the hotkeys, the overlay and the
// other WriteWise surfaces): pull it in, and drop any copy that older versions left in localStorage.
let aiState: AiState = { aiKey: settings.aiKey, aiModel: settings.aiModel, source: 'local', stored: true }
hydrateAiSettings(settings)
  .then((s) => { aiState = s; settings.aiKey = s.aiKey; settings.aiModel = s.aiModel })
  .catch((err) => console.warn('AI settings unavailable:', err))
let filter: Category | 'all' = 'all'
let stats: DocStats | null = null
let tone: Tone | null = null
let promptReport: PromptReport | null = null
let engineReady = false
let localVersion = 0
let localInFlight = false
let localPending = false
let cloudVersion = 0
let cloudAbort: AbortController | null = null
let lastCloudAt = 0
let cloudTimer: number | undefined
let localTimer: number | undefined
let saveTimer: number | undefined
let docVersion = 0
const ignored = new Set<string>()

// ---------- worker ----------
const worker = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' })
const base = new URL(import.meta.env.BASE_URL, document.baseURI)
worker.postMessage({ type: 'init', affUrl: new URL('dict/en-US.aff', base).href, dicUrl: new URL('dict/en-US.dic', base).href } satisfies WorkerRequest)

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data
  if (msg.type === 'ready') {
    engineReady = true
    setStatus('Ready')
    scheduleLocal(0)
  } else if (msg.type === 'result') {
    localInFlight = false
    if (msg.id === localVersion) {
      const issues = msg.issues.filter((i) => !ignored.has(ignoreKey(i)))
      view.dispatch({ effects: setIssuesEffect.of({ source: 'local', issues }) })
      stats = msg.stats
      tone = msg.tone
      promptReport = msg.prompt
      setStatus(settings.cloud ? 'Checked · cloud boost on' : 'Checked')
      renderPanel()
    }
    if (localPending) { localPending = false; runLocal() }
  } else if (msg.type === 'error') {
    localInFlight = false
    console.error('engine error', msg.message)
    setStatus('Engine error: ' + msg.message)
  }
}

function ignoreKey(i: Issue) { return `${i.ruleId}|${i.actual.toLowerCase()}` }

// ---------- editor ----------
const initial = loadDoc()
const titleInput = $<HTMLInputElement>('#doc-title')
titleInput.value = initial.title

const view: EditorView = createEditor($('#editor'), initial.text, {
  onChange: () => {
    docVersion++
    scheduleLocal(350)
    scheduleCloud()
    scheduleSave()
    renderPanel()
  },
  renderTooltip,
})

function checkOptions(): CheckOptions {
  return { mode: settings.mode, passive: settings.passive, readability: settings.readability, wordiness: settings.wordiness, equality: settings.equality, profanity: settings.profanity, personal: settings.personal }
}

function scheduleLocal(delay: number) {
  clearTimeout(localTimer)
  localTimer = window.setTimeout(runLocal, delay)
}

function runLocal() {
  if (!engineReady) return
  if (localInFlight) { localPending = true; return }
  localInFlight = true
  localVersion++
  setStatus('Checking…')
  worker.postMessage({ type: 'check', id: localVersion, text: getText(view), options: checkOptions() } satisfies WorkerRequest)
}

function scheduleCloud() {
  clearTimeout(cloudTimer)
  if (!settings.cloud) return
  const wait = Math.max(1200, 3000 - (Date.now() - lastCloudAt))
  cloudTimer = window.setTimeout(runCloud, wait)
}

async function runCloud() {
  if (!settings.cloud) return
  const text = getText(view)
  if (!text.trim()) { view.dispatch({ effects: setIssuesEffect.of({ source: 'cloud', issues: [] }) }); return }
  cloudAbort?.abort()
  cloudAbort = new AbortController()
  const version = ++cloudVersion
  const startDoc = docVersion
  lastCloudAt = Date.now()
  try {
    const issues = await checkWithLanguageTool(text, settings.language, cloudAbort.signal)
    if (version !== cloudVersion) return
    if (startDoc !== docVersion) { scheduleCloud(); return } // text changed meanwhile; try again later
    view.dispatch({ effects: setIssuesEffect.of({ source: 'cloud', issues: issues.filter((i) => !ignored.has(ignoreKey(i))) }) })
    setStatus(text.length > LT_MAX_CHARS ? `Checked · cloud boost covered the first ${LT_MAX_CHARS.toLocaleString()} characters` : 'Checked · cloud boost on')
    renderPanel()
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    console.warn('cloud check failed', err)
    setStatus('Cloud boost unavailable (offline or rate limited); local checks still active')
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => saveDoc(titleInput.value, getText(view)), 500)
}
titleInput.addEventListener('input', scheduleSave)

// ---------- status ----------
function setStatus(text: string) { $('#status-engine').textContent = text }

// ---------- tooltip (inline card) ----------
function renderTooltip(range: IssueRange): HTMLElement {
  const { issue } = range
  const el = document.createElement('div')
  el.className = `ww-tip ww-tip-${issue.category}`
  el.innerHTML = `<div class="tip-head"><span class="dot"></span><span class="tip-title"></span><span class="tip-cat"></span></div><div class="tip-msg"></div><div class="tip-actions"></div>`
  el.querySelector('.tip-title')!.textContent = issue.title
  el.querySelector('.tip-cat')!.textContent = categoryLabel(issue.category)
  el.querySelector('.tip-msg')!.textContent = issue.message
  const actions = el.querySelector('.tip-actions')!
  for (const rep of issue.replacements.slice(0, 4)) {
    const b = document.createElement('button')
    b.className = 'btn fix'
    b.textContent = rep === '' ? 'Remove' : rep
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', () => { applyReplacement(view, issue.id, rep); scheduleLocal(200) })
    actions.appendChild(b)
  }
  const dismiss = document.createElement('button')
  dismiss.className = 'btn ghost small'
  dismiss.textContent = 'Dismiss'
  dismiss.addEventListener('mousedown', (ev) => ev.preventDefault())
  dismiss.addEventListener('click', () => dismiss_(issue))
  actions.appendChild(dismiss)
  if (isSpelling(issue)) {
    const add = document.createElement('button')
    add.className = 'btn ghost small'
    add.textContent = 'Add to dictionary'
    add.addEventListener('mousedown', (ev) => ev.preventDefault())
    add.addEventListener('click', () => addToDictionary(issue))
    actions.appendChild(add)
  }
  return el
}

function isSpelling(i: Issue) { return i.ruleId.startsWith('retext-spell:') || i.ruleId.startsWith('cloud:MORFOLOGIK') }

function dismiss_(issue: Issue) {
  ignored.add(ignoreKey(issue))
  // Remove every current issue with the same key (e.g. the same misspelling repeated).
  for (const r of getIssues(view.state)) if (ignoreKey(r.issue) === ignoreKey(issue)) dismissIssue(view, r.issue.id)
  renderPanel()
}

function addToDictionary(issue: Issue) {
  const word = issue.actual.trim()
  if (word && !settings.personal.includes(word)) settings.personal = [...settings.personal, word]
  saveSettings(settings)
  dismiss_(issue)
  scheduleLocal(0)
}

// ---------- panel ----------
const CATS: Category[] = ['correctness', 'clarity', 'engagement', 'delivery', 'prompt']
function categoryLabel(c: Category) { return c === 'prompt' ? 'Prompt' : c[0].toUpperCase() + c.slice(1) }
const WEIGHT: Record<Category, number> = { correctness: 3, clarity: 1.5, engagement: 1, delivery: 1, prompt: 1 }

function computeScore(issues: IssueRange[], words: number): number {
  if (words === 0) return 100
  const penalty = issues.reduce((s, r) => s + WEIGHT[r.issue.category], 0) / Math.max(words, 100) * 100
  return Math.max(0, Math.min(100, Math.round(100 - penalty)))
}

function renderPanel() {
  const issues = getIssues(view.state)
  const words = stats?.words ?? getText(view).trim().split(/\s+/).filter(Boolean).length
  $('#status-words').textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`

  // counts
  const counts: Record<string, number> = { all: issues.length }
  for (const c of CATS) counts[c] = 0
  for (const r of issues) counts[r.issue.category]++
  for (const key of ['all', ...CATS]) $(`#cnt-${key}`).textContent = String(counts[key])
  $('.cat.c-prompt').hidden = settings.mode !== 'prompt'
  if (filter === 'prompt' && settings.mode !== 'prompt') filter = 'all'
  document.querySelectorAll<HTMLButtonElement>('.cat').forEach((b) => b.classList.toggle('active', b.dataset.cat === filter))

  // score + tone / prompt checklist
  const ring = $('#score-ring')
  const prompt = settings.mode === 'prompt'
  const score = prompt && promptReport ? promptReport.score : computeScore(issues, words)
  ring.style.setProperty('--pct', String(words === 0 ? 0 : score))
  $('#score-value').textContent = words === 0 ? '—' : String(score)
  ring.className = 'score-ring ' + (score >= 85 ? 'good' : score >= 60 ? 'ok' : 'bad')
  $('.score-label').textContent = prompt ? 'Prompt score' : 'Overall score'
  const hint = $('#score-hint')
  if (words === 0) hint.textContent = prompt ? 'Paste or write the prompt you plan to give an AI.' : 'Start typing to get suggestions.'
  else if (prompt && promptReport) {
    const ok = promptReport.checks.filter((c) => c.ok).length
    hint.textContent = `${ok} of ${promptReport.checks.length} prompt elements present.`
  } else hint.textContent = score >= 90 ? 'Looking great.' : score >= 70 ? 'Good, with a few things to fix.' : 'Several issues to address.'

  const toneEl = $('#tone')
  toneEl.innerHTML = ''
  if (!prompt && tone && words >= 20) {
    const chips = [
      tone.formality === 'formal' ? 'Formal' : tone.formality === 'casual' ? 'Casual' : 'Neutral',
      tone.confidence === 'confident' ? 'Confident' : tone.confidence === 'tentative' ? 'Tentative' : null,
      tone.friendly ? 'Friendly' : null,
    ].filter(Boolean) as string[]
    for (const c of chips) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = c; toneEl.appendChild(s) }
  }

  const checks = $('#prompt-checks')
  checks.hidden = !prompt
  checks.innerHTML = ''
  if (prompt && promptReport && words > 0) {
    for (const c of promptReport.checks) {
      const li = document.createElement('li')
      li.className = c.ok ? 'ok' : 'missing'
      li.innerHTML = `<span class="mark">${c.ok ? '✓' : '○'}</span><span class="label"></span><span class="hint"></span>`
      li.querySelector('.label')!.textContent = c.label
      li.querySelector('.hint')!.textContent = c.ok ? '' : c.hint
      checks.appendChild(li)
    }
  }

  // cards
  const cards = $('#cards')
  cards.innerHTML = ''
  const shown = issues.filter((r) => filter === 'all' || r.issue.category === filter)
  $<HTMLButtonElement>('#btn-accept-all').disabled = !issues.some((r) => r.issue.category === 'correctness' && r.issue.replacements.length === 1 && r.issue.replacements[0] !== '')
  if (!shown.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = words === 0 ? 'Suggestions will appear here as you write.' : issues.length ? 'No suggestions in this category.' : (prompt ? 'No vague wording found. Check the list above for missing prompt elements.' : 'No suggestions. Nice work!')
    cards.appendChild(empty)
  }
  for (const r of shown) cards.appendChild(renderCard(r))

  renderStats(words)
}

function renderCard(r: IssueRange): HTMLElement {
  const { issue } = r
  const card = document.createElement('article')
  card.className = `card c-${issue.category}`
  card.setAttribute('role', 'listitem')
  card.tabIndex = 0
  const actual = issue.actual.length > 60 ? issue.actual.slice(0, 57) + '…' : issue.actual
  card.innerHTML = `<header><span class="dot"></span><span class="title"></span><span class="cat"></span>${issue.source === 'cloud' ? '<span class="src" title="From cloud boost">☁</span>' : ''}</header><div class="excerpt"></div><p class="msg"></p><div class="actions"></div>`
  card.querySelector('.title')!.textContent = issue.title
  card.querySelector('.cat')!.textContent = categoryLabel(issue.category)
  card.querySelector('.excerpt')!.textContent = actual
  card.querySelector('.msg')!.textContent = issue.message
  const actions = card.querySelector('.actions')!
  for (const rep of issue.replacements.slice(0, 3)) {
    const b = document.createElement('button')
    b.className = 'btn fix'
    b.textContent = rep === '' ? 'Remove' : rep
    b.addEventListener('click', (ev) => { ev.stopPropagation(); applyReplacement(view, issue.id, rep); scheduleLocal(200); renderPanel() })
    actions.appendChild(b)
  }
  const dis = document.createElement('button')
  dis.className = 'btn ghost small'
  dis.textContent = 'Dismiss'
  dis.addEventListener('click', (ev) => { ev.stopPropagation(); dismiss_(issue) })
  actions.appendChild(dis)
  if (isSpelling(issue)) {
    const add = document.createElement('button')
    add.className = 'btn ghost small'
    add.textContent = 'Add to dictionary'
    add.addEventListener('click', (ev) => { ev.stopPropagation(); addToDictionary(issue) })
    actions.appendChild(add)
  }
  const go = () => { focusIssue(view, issue.id); if (window.innerWidth < 900) $('#panel').classList.remove('open') }
  card.addEventListener('click', go)
  card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go() })
  return card
}

function fmtMinutes(min: number): string {
  if (min < 1 / 60) return '0 sec'
  if (min < 1) return `${Math.round(min * 60)} sec`
  const m = Math.floor(min), s = Math.round((min - m) * 60)
  return s ? `${m} min ${s} sec` : `${m} min`
}

function renderStats(words: number) {
  const dl = $('#stats')
  const s = stats
  const rows: Array<[string, string]> = s
    ? [
        ['Words', s.words.toLocaleString()],
        ['Characters', s.characters.toLocaleString()],
        ['Sentences', String(s.sentences)],
        ['Paragraphs', String(s.paragraphs)],
        ['Reading time', fmtMinutes(s.readingTimeMin)],
        ['Speaking time', fmtMinutes(s.speakingTimeMin)],
        ['Avg. sentence', `${s.avgSentenceLength} words`],
        ['Unique words', s.words ? `${Math.round((s.uniqueWords / s.words) * 100)}%` : '—'],
        ['Readability', s.words ? `${s.readabilityLabel} (${s.fleschEase})` : '—'],
        ['Grade level', s.words ? String(s.gradeLevel) : '—'],
      ]
    : [['Words', String(words)]]
  dl.innerHTML = ''
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    dl.append(dt, dd)
  }
}

// ---------- category filter ----------
$('#cats').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('.cat')
  if (!b) return
  filter = (b.dataset.cat as Category | 'all') ?? 'all'
  renderPanel()
})

$('#btn-accept-all').addEventListener('click', () => {
  const n = acceptAllSafe(view)
  if (n) { setStatus(`Applied ${n} fix${n === 1 ? '' : 'es'}`); scheduleLocal(100); scheduleCloud(); renderPanel() }
})

// ---------- mode switch ----------
function setMode(mode: Mode) {
  settings.mode = mode
  saveSettings(settings)
  document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode))
  document.body.dataset.mode = mode
  $('#ai-writing-actions').hidden = mode !== 'writing'
  $('#ai-prompt-actions').hidden = mode !== 'prompt'
  promptReport = null
  scheduleLocal(0)
  renderPanel()
}
document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)))

// ---------- file actions ----------
function newDoc() {
  if (getText(view).trim() && !confirm('Start a new document? The current text is kept in your browser history only until you close it.')) return
  setText(view, '')
  titleInput.value = 'Untitled document'
  ignored.clear()
  scheduleSave()
  scheduleLocal(0)
  renderPanel()
}
const fileInput = $<HTMLInputElement>('#file-input')
function openDoc() { fileInput.click() }
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (!f) return
  setText(view, await f.text())
  titleInput.value = f.name.replace(/\.(txt|md|markdown)$/i, '')
  fileInput.value = ''
  scheduleSave()
  scheduleLocal(0)
  scheduleCloud()
  renderPanel()
})
function saveDocFile() {
  const blob = new Blob([getText(view)], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = (titleInput.value.trim() || 'document') + '.txt'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
$('#btn-new').addEventListener('click', newDoc)
$('#btn-open').addEventListener('click', openDoc)
$('#btn-save').addEventListener('click', saveDocFile)
window.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey
  if (!mod) return
  if (ev.key === 's') { ev.preventDefault(); saveDocFile() }
  else if (ev.key === 'o') { ev.preventDefault(); openDoc() }
  else if (ev.key === 'n' && !ev.shiftKey) { ev.preventDefault(); newDoc() }
})

// ---------- cloud toggle ----------
const cloudToggle = $<HTMLInputElement>('#toggle-cloud')
cloudToggle.checked = settings.cloud
cloudToggle.addEventListener('change', () => {
  if (cloudToggle.checked && !settings.cloud && !confirm('Cloud boost sends your text to the free LanguageTool.org service for extra grammar checks. Turn it on?')) {
    cloudToggle.checked = false
    return
  }
  settings.cloud = cloudToggle.checked
  saveSettings(settings)
  if (settings.cloud) scheduleCloud()
  else view.dispatch({ effects: setIssuesEffect.of({ source: 'cloud', issues: [] }) })
  renderPanel()
})

// ---------- settings dialog ----------
const dlg = $<HTMLDialogElement>('#dlg-settings')
function openSettings() {
  $<HTMLInputElement>('#set-passive').checked = settings.passive
  $<HTMLInputElement>('#set-readability').checked = settings.readability
  $<HTMLInputElement>('#set-wordiness').checked = settings.wordiness
  $<HTMLInputElement>('#set-equality').checked = settings.equality
  $<HTMLInputElement>('#set-profanity').checked = settings.profanity
  $<HTMLInputElement>('#set-cloud').checked = settings.cloud
  $<HTMLSelectElement>('#set-lang').value = settings.language
  // A key that only comes from the environment or config.json is used but not shown, so one typed here wins.
  $<HTMLInputElement>('#set-aikey').value = aiState.stored ? settings.aiKey : ''
  $<HTMLSelectElement>('#set-aimodel').value = settings.aiModel
  const note = $('#set-aikey-note')
  note.hidden = !isDesktop
  if (isDesktop) note.textContent = aiKeyNote(aiState)
  $<HTMLTextAreaElement>('#set-personal').value = settings.personal.join('\n')
  dlg.showModal()
}
function aiKeyNote(s: AiState): string {
  const shared = 'shared with the hotkeys, the in-app overlay and the browser extension'
  switch (s.source) {
    case 'env': return `No key saved in the app yet; using ANTHROPIC_API_KEY from the environment (${shared}). A key entered here takes precedence and is kept in your system keychain.`
    case 'config': return `No key saved in the app yet; using the one from ~/.config/writewise/config.json (${shared}). A key entered here takes precedence and is kept in your system keychain.`
    case 'app-plain': return `Saved by the app without encryption because no system keyring was found; ${shared}.`
    default: return `Kept in your system keychain by the desktop app, never in the editor's local storage; ${shared}, so you enter it once.`
  }
}
$('#btn-settings').addEventListener('click', openSettings)
$('#set-cancel').addEventListener('click', () => dlg.close())
$('#set-save').addEventListener('click', async (ev) => {
  ev.preventDefault()
  settings = {
    ...settings,
    passive: $<HTMLInputElement>('#set-passive').checked,
    readability: $<HTMLInputElement>('#set-readability').checked,
    wordiness: $<HTMLInputElement>('#set-wordiness').checked,
    equality: $<HTMLInputElement>('#set-equality').checked,
    profanity: $<HTMLInputElement>('#set-profanity').checked,
    cloud: $<HTMLInputElement>('#set-cloud').checked,
    language: $<HTMLSelectElement>('#set-lang').value as Settings['language'],
    aiKey: $<HTMLInputElement>('#set-aikey').value.trim(),
    aiModel: $<HTMLSelectElement>('#set-aimodel').value,
    personal: $<HTMLTextAreaElement>('#set-personal').value.split(/\n+/).map((w) => w.trim()).filter(Boolean),
  }
  saveSettings(settings)
  try {
    // Desktop: into the keychain store; the result is what is now in effect (a cleared field falls back to the environment).
    aiState = await saveAiSettings(settings.aiKey, settings.aiModel)
    settings.aiKey = aiState.aiKey
    settings.aiModel = aiState.aiModel
  } catch (err) {
    console.warn('could not save the API key:', err)
  }
  cloudToggle.checked = settings.cloud
  dlg.close()
  scheduleLocal(0)
  if (settings.cloud) scheduleCloud()
  else view.dispatch({ effects: setIssuesEffect.of({ source: 'cloud', issues: [] }) })
  renderPanel()
})

// ---------- AI rewrite dialog ----------
const aiDlg = $<HTMLDialogElement>('#dlg-ai')
const aiOut = $<HTMLPreElement>('#ai-output')
const aiStatus = $('#ai-status')
const aiApply = $<HTMLButtonElement>('#ai-apply')
const aiCopy = $<HTMLButtonElement>('#ai-copy')
let aiAbort: AbortController | null = null
let aiRange: { from: number; to: number } | null = null
let aiResult = ''

function aiScope(): { from: number; to: number; text: string; whole: boolean } {
  const sel = view.state.selection.main
  if (!sel.empty) return { from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to), whole: false }
  return { from: 0, to: view.state.doc.length, text: getText(view), whole: true }
}

function openAi() {
  const scope = aiScope()
  $('#ai-scope').textContent = scope.whole
    ? `Applies to the whole document (${scope.text.trim().split(/\s+/).filter(Boolean).length} words). Select text first to rewrite only part of it.`
    : `Applies to the selected text (${scope.text.trim().split(/\s+/).filter(Boolean).length} words).`
  aiOut.hidden = true
  aiOut.textContent = ''
  aiApply.hidden = true
  aiCopy.hidden = true
  aiResult = ''
  aiStatus.textContent = settings.aiKey ? '' : 'No API key set. Add an Anthropic API key in Settings to use AI rewrites, or use the offline option below in prompt mode.'
  aiDlg.showModal()
}
$('#btn-ai').addEventListener('click', openAi)
$('#ai-close').addEventListener('click', () => { aiAbort?.abort(); aiDlg.close() })

async function runAi(mode: AiMode | 'template', instruction?: string) {
  const scope = aiScope()
  if (!scope.text.trim()) { aiStatus.textContent = 'There is no text to work with yet.'; return }
  aiRange = { from: scope.from, to: scope.to }
  aiApply.hidden = true
  aiCopy.hidden = true

  if (mode === 'template') {
    aiResult = buildPromptTemplate(scope.text, analyzePrompt(scope.text))
    aiOut.hidden = false
    aiOut.textContent = aiResult
    aiStatus.textContent = 'Offline template built. Fill in the [bracketed] placeholders.'
    aiApply.hidden = false
    aiCopy.hidden = false
    return
  }
  if (!settings.aiKey) { aiStatus.textContent = 'Add an Anthropic API key in Settings first.'; return }

  aiAbort?.abort()
  aiAbort = new AbortController()
  aiOut.hidden = false
  aiOut.textContent = ''
  aiStatus.textContent = `Asking ${settings.aiModel}…`
  try {
    aiResult = await rewrite({ apiKey: settings.aiKey, model: settings.aiModel, mode, text: scope.text, instruction, signal: aiAbort.signal, onDelta: (p) => { aiOut.textContent = p } })
    aiOut.textContent = aiResult
    aiStatus.textContent = 'Done. Review the result, then replace your text or copy it.'
    aiApply.hidden = false
    aiCopy.hidden = false
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    aiStatus.textContent = 'Request failed: ' + ((err as Error).message || String(err))
  }
}
aiDlg.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]')
  if (!b) return
  const mode = b.dataset.mode as AiMode | 'template'
  runAi(mode, mode === 'custom' ? $<HTMLInputElement>('#ai-custom').value.trim() : undefined)
})
$<HTMLInputElement>('#ai-custom').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); runAi('custom', (ev.target as HTMLInputElement).value.trim()) } })
aiApply.addEventListener('click', () => {
  if (!aiRange || !aiResult) return
  replaceRange(view, aiRange.from, aiRange.to, aiResult)
  aiDlg.close()
  scheduleLocal(0)
  scheduleCloud()
  scheduleSave()
  view.focus()
})
aiCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(aiResult); aiStatus.textContent = 'Copied to clipboard.' } catch { aiStatus.textContent = 'Could not copy automatically; select the text above and copy it.' }
})

// ---------- mobile panel toggle ----------
$('#btn-panel').addEventListener('click', () => $('#panel').classList.toggle('open'))

// ---------- boot ----------
setMode(settings.mode)
renderPanel()
registerServiceWorker()
