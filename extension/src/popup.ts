import { AI_SITES } from './content-constants'

interface Settings { enabled: boolean; disabledSites: string[]; autoFixSites: string[]; autoFixEverywhere: boolean }
const DEFAULTS: Settings = { enabled: true, disabledSites: [], autoFixSites: AI_SITES, autoFixEverywhere: false }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function currentHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return null
    const u = new URL(tab.url)
    if (!/^https?:$/.test(u.protocol)) return null
    return u.hostname.replace(/^www\./, '')
  } catch { return null }
}

async function main() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) } as Settings
  const host = await currentHost()
  const matches = (list: string[]) => !!host && list.some((s) => host === s || host.endsWith('.' + s))
  $('site').textContent = host ?? 'This page cannot be checked'
  const enabled = $<HTMLInputElement>('enabled'), autofix = $<HTMLInputElement>('autofix'), all = $<HTMLInputElement>('autofix-all')
  enabled.checked = !!host && settings.enabled && !matches(settings.disabledSites)
  autofix.checked = !!host && (settings.autoFixEverywhere || matches(settings.autoFixSites))
  all.checked = settings.autoFixEverywhere
  enabled.disabled = autofix.disabled = !host
  enabled.addEventListener('change', async () => {
    if (!host) return
    const disabledSites = settings.disabledSites.filter((s) => s !== host)
    if (!enabled.checked) disabledSites.push(host)
    await chrome.storage.sync.set({ disabledSites, enabled: true })
    settings.disabledSites = disabledSites
  })
  autofix.addEventListener('change', async () => {
    if (!host) return
    const autoFixSites = settings.autoFixSites.filter((s) => s !== host)
    if (autofix.checked) autoFixSites.push(host)
    await chrome.storage.sync.set({ autoFixSites })
    settings.autoFixSites = autoFixSites
  })
  all.addEventListener('change', async () => { await chrome.storage.sync.set({ autoFixEverywhere: all.checked }); settings.autoFixEverywhere = all.checked; if (all.checked) autofix.checked = true })

  const text = $<HTMLTextAreaElement>('text'), status = $('status'), copy = $<HTMLButtonElement>('copy')
  let result = ''
  async function run(mode: 'writing' | 'prompt') {
    if (!text.value.trim()) { status.textContent = 'Paste some text first.'; return }
    status.textContent = 'Checking…'
    chrome.runtime.sendMessage({ type: 'check', text: text.value, mode }, (res) => {
      if (chrome.runtime.lastError || !res || res.error) { status.textContent = 'Error: ' + (chrome.runtime.lastError?.message ?? res?.error ?? 'no response'); return }
      result = mode === 'prompt' && res.template ? res.template : res.fixed
      text.value = result
      copy.hidden = false
      status.textContent = mode === 'prompt'
        ? `Structured prompt ready (score before: ${res.promptScore}/100). Fill in the [brackets].`
        : `${res.edits.length} fix${res.edits.length === 1 ? '' : 'es'} applied, ${res.issues.length - res.edits.length} suggestion${res.issues.length - res.edits.length === 1 ? '' : 's'} left for you to review in the app.`
    })
  }
  $('fix').addEventListener('click', () => run('writing'))
  $('prompt').addEventListener('click', () => run('prompt'))
  copy.addEventListener('click', async () => { await navigator.clipboard.writeText(text.value); status.textContent = 'Copied.' })
}
main()
