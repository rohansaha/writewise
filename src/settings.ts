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

// ---------- desktop bridge (electron/preload.cjs) ----------
// In the desktop app the Anthropic key is not kept in localStorage: the main process stores it
// through Electron's safeStorage (OS keychain) and shares it with the hotkeys, the in-app overlay
// and the other WriteWise surfaces on the machine. The page talks to that store through this bridge.
export type AiKeySource = 'local' | 'app' | 'app-plain' | 'desktop' | 'env' | 'config' | 'none'
export interface DesktopAiSettings { apiKey: string; model: string; source: AiKeySource; stored: boolean }
export interface DesktopBridge {
  getAiSettings(): Promise<DesktopAiSettings>
  setAiSettings(s: { apiKey: string; model: string }): Promise<DesktopAiSettings>
}
declare global {
  interface Window { writewiseDesktop?: DesktopBridge }
}
const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.writewiseDesktop : undefined
export const isDesktop = !!desktop
// True once the keychain store is known to hold whatever key the page had; until then the page keeps
// writing the key to localStorage as older versions did, so a failed migration never loses it.
let aiInStore = false

/** What the editor knows about the key in use: its value, the model, where it came from, and whether the Settings field should show it. */
export interface AiState { aiKey: string; aiModel: string; source: AiKeySource; stored: boolean }

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

function toState(s: DesktopAiSettings): AiState {
  return { aiKey: s.apiKey || '', aiModel: s.model || DEFAULTS.aiModel, source: s.source, stored: !!s.stored }
}

/** Removes any copy of the key that older versions left in the page's storage. */
function scrubLocalAiSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && ('aiKey' in parsed || 'aiModel' in parsed)) {
      delete parsed.aiKey
      delete parsed.aiModel
      localStorage.setItem(KEY, JSON.stringify(parsed))
    }
  } catch { /* storage unavailable */ }
}

/**
 * Resolves the AI settings in use. In the browser they are the localStorage ones. In the desktop app
 * they come from the keychain-backed store; on the first run after upgrading, a key that older versions
 * saved in localStorage is moved into that store and wiped from the page.
 */
export async function hydrateAiSettings(current: Settings): Promise<AiState> {
  if (!desktop) return { aiKey: current.aiKey, aiModel: current.aiModel, source: 'local', stored: true }
  let s = await desktop.getAiSettings()
  if (!s.stored && current.aiKey) {
    try {
      s = await desktop.setAiSettings({ apiKey: current.aiKey, model: current.aiModel || s.model })
    } catch (err) {
      // The store is unavailable (no keychain?): keep working from the page's copy and try again next launch.
      console.warn('could not move the API key into the keychain store:', err)
      return { aiKey: current.aiKey, aiModel: current.aiModel, source: 'local', stored: true }
    }
  }
  aiInStore = true
  scrubLocalAiSettings()
  return toState(s)
}

/** Saves the key and model where this surface keeps them; returns the state now in effect (the desktop app may fall back to ANTHROPIC_API_KEY or config.json when the field is cleared). */
export async function saveAiSettings(aiKey: string, aiModel: string): Promise<AiState> {
  if (!desktop) return { aiKey, aiModel, source: 'local', stored: true }
  const s = toState(await desktop.setAiSettings({ apiKey: aiKey, model: aiModel }))
  aiInStore = true
  scrubLocalAiSettings()
  return s
}

export function saveSettings(s: Settings) {
  try {
    if (desktop && aiInStore) {
      // The key and model live in the keychain-backed store (saveAiSettings); never write them to the page.
      const { aiKey: _k, aiModel: _m, ...rest } = s
      localStorage.setItem(KEY, JSON.stringify(rest))
    } else {
      localStorage.setItem(KEY, JSON.stringify(s))
    }
  } catch { /* storage unavailable */ }
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
