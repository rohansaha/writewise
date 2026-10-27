import { AI_SITES } from './content-constants'
import { CLAUDE_DEFAULTS, CLAUDE_MODELS, NATIVE_HOST, STORE_EXTENSION_ID, type ClaudeSettings } from './claude-constants'

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

interface NativeReply { ok?: boolean; apiKey?: string; model?: string; source?: string; error?: string }

function describeSource(source?: string): string {
  switch (source) {
    case 'app': case 'app-plain': case 'desktop': return 'the WriteWise desktop app'
    case 'env': return 'ANTHROPIC_API_KEY on this machine'
    case 'config': return '~/.config/writewise/config.json'
    default: return 'the desktop app'
  }
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

  // ---------- Claude (optional; key in chrome.storage.local only) ----------
  const claude = { ...CLAUDE_DEFAULTS, ...(await chrome.storage.local.get(CLAUDE_DEFAULTS)) } as ClaudeSettings
  const cEnabled = $<HTMLInputElement>('claude-enabled'), cKey = $<HTMLInputElement>('claude-key'), cModel = $<HTMLSelectElement>('claude-model')
  const cStatus = $('claude-status'), cFetch = $<HTMLButtonElement>('claude-from-desktop'), cForget = $<HTMLButtonElement>('claude-forget')
  const fixClaude = $<HTMLButtonElement>('fix-claude')
  for (const [id, label] of CLAUDE_MODELS) cModel.add(new Option(label, id))
  const setModelValue = (id: string) => {
    if (![...cModel.options].some((o) => o.value === id)) cModel.add(new Option(id, id))
    cModel.value = id
  }
  cEnabled.checked = claude.claudeEnabled
  cKey.value = claude.claudeKey
  setModelValue(claude.claudeModel || CLAUDE_DEFAULTS.claudeModel)
  const refreshClaude = () => {
    cForget.hidden = !claude.claudeKey
    fixClaude.hidden = !(claude.claudeEnabled && claude.claudeKey)
  }
  refreshClaude()
  cEnabled.addEventListener('change', async () => {
    claude.claudeEnabled = cEnabled.checked
    await chrome.storage.local.set({ claudeEnabled: claude.claudeEnabled })
    cStatus.textContent = !claude.claudeEnabled ? 'Off: nothing is sent anywhere.'
      : claude.claudeKey ? 'On: "Fix with Claude" is now in the suggestion panel.'
      : 'On. Now add your API key below, or fetch it from the desktop app.'
    refreshClaude()
  })
  cKey.addEventListener('change', async () => {
    claude.claudeKey = cKey.value.trim()
    cKey.value = claude.claudeKey
    await chrome.storage.local.set({ claudeKey: claude.claudeKey })
    cStatus.textContent = claude.claudeKey ? 'Key saved in this browser only.' : 'Key removed.'
    refreshClaude()
  })
  cModel.addEventListener('change', async () => {
    claude.claudeModel = cModel.value
    await chrome.storage.local.set({ claudeModel: claude.claudeModel })
  })
  cForget.addEventListener('click', async () => {
    claude.claudeKey = ''
    cKey.value = ''
    await chrome.storage.local.set({ claudeKey: '' })
    cStatus.textContent = 'Key removed from this browser.'
    refreshClaude()
  })
  cFetch.addEventListener('click', async () => {
    cStatus.textContent = 'Asking the desktop app…'
    cFetch.disabled = true
    try {
      // Native messaging is an optional permission: asked for here, on the click, never at install time.
      const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] })
      if (!granted) { cStatus.textContent = 'Permission to talk to the desktop app was declined.'; return }
      const res = (await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'get-key' })) as NativeReply
      if (!res?.ok || !res.apiKey) { cStatus.textContent = res?.error || 'The desktop app did not return a key.'; return }
      claude.claudeKey = res.apiKey
      if (res.model) claude.claudeModel = res.model
      claude.claudeEnabled = true
      cKey.value = claude.claudeKey
      setModelValue(claude.claudeModel)
      cEnabled.checked = true
      await chrome.storage.local.set({ claudeKey: claude.claudeKey, claudeModel: claude.claudeModel, claudeEnabled: true })
      cStatus.textContent = `Key copied from ${describeSource(res.source)}; Claude is on.`
    } catch (err) {
      const msg = (err as Error)?.message || String(err)
      const devHint = chrome.runtime.id !== STORE_EXTENSION_ID
        ? ` This is an unpacked build (ID ${chrome.runtime.id}): add that ID to "extensionIds" in ~/.config/writewise/config.json, then connect again from the desktop app.`
        : ''
      if (/not found/i.test(msg)) cStatus.textContent = 'The desktop app has not registered its bridge yet: open WriteWise → Tools → Connect the browser extension, then try again.' + devHint
      else if (/forbidden/i.test(msg)) cStatus.textContent = 'The desktop app does not allow this copy of the extension.' + devHint
      else cStatus.textContent = 'Could not reach the desktop app: ' + msg
    } finally {
      cFetch.disabled = false
      refreshClaude()
    }
  })

  // ---------- paste-to-fix box ----------
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
  fixClaude.addEventListener('click', () => {
    if (!text.value.trim()) { status.textContent = 'Paste some text first.'; return }
    status.textContent = `Asking ${claude.claudeModel}…`
    fixClaude.disabled = true
    chrome.runtime.sendMessage({ type: 'claude-fix', text: text.value }, (res) => {
      fixClaude.disabled = false
      if (chrome.runtime.lastError || !res || res.error) { status.textContent = 'Error: ' + (chrome.runtime.lastError?.message ?? res?.error ?? 'no response'); return }
      result = res.fixed
      text.value = result
      copy.hidden = false
      status.textContent = 'Corrected by Claude. Review it, then copy.'
    })
  })
  copy.addEventListener('click', async () => { await navigator.clipboard.writeText(text.value); status.textContent = 'Copied.' })
}
main()
