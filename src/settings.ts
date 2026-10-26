import type { Settings } from './types'

const KEY = 'writewise:settings'

export const DEFAULTS: Settings = {
  mode: 'writing',
  passive: true,
  readability: true,
  wordiness: true,
  equality: true,
  profanity: false,
  personal: [],
  cloud: false,
  language: 'en-US',
  aiKey: '',
  aiModel: 'claude-opus-5-5',
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...parsed, personal: Array.isArray(parsed.personal) ? parsed.personal : [] }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage unavailable */ }
}

const DOC_KEY = 'writewise:doc'

export function loadDoc(): { title: string; text: string } {
  try {
    const raw = localStorage.getItem(DOC_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (typeof d.text === 'string') return { title: typeof d.title === 'string' ? d.title : 'Untitled document', text: d.text }
    }
  } catch { /* ignore */ }
  return { title: 'Untitled document', text: '' }
}

export function saveDoc(title: string, text: string) {
  try { localStorage.setItem(DOC_KEY, JSON.stringify({ title, text })) } catch { /* ignore */ }
}
