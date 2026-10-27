// Settings shared by every WriteWise surface on this machine, and how the Anthropic API key is
// found outside the desktop app (CLI, Claude Code hook, MCP server, browser-extension bridge).
// The desktop app keeps its own copy in the OS keychain through Electron's safeStorage and only
// falls back to what is here. Nothing in this file ever sends the key anywhere.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import net from 'node:net'

export const DEFAULT_AI_MODEL = 'claude-opus-5-5'

export interface WriteWiseConfig {
  /** Anthropic API key, plain text, owner-only file. */
  anthropicApiKey?: string
  /** Claude model id used by every surface that does not set its own. */
  model?: string
  /** Extra Chrome extension IDs allowed to use the native-messaging bridge (unpacked dev builds). */
  extensionIds?: string[]
}

/** Where a key came from: the desktop app's keychain store, the running desktop app (over its socket), the environment, config.json, or nowhere. */
export type AiKeySource = 'app' | 'app-plain' | 'desktop' | 'env' | 'config' | 'none'
export interface AiSettings { apiKey: string; model: string; source: AiKeySource }

/** ~/.config/writewise (XDG_CONFIG_HOME honoured; WRITEWISE_CONFIG_DIR overrides, mainly for tests). */
export function configDir(): string {
  if (process.env.WRITEWISE_CONFIG_DIR) return process.env.WRITEWISE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
  return path.join(base, 'writewise')
}
export function configFile(): string { return path.join(configDir(), 'config.json') }

export async function readConfig(): Promise<WriteWiseConfig> {
  let raw: string
  try { raw = await readFile(configFile(), 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) { throw new Error(`${configFile()} is not valid JSON: ${(err as Error).message}`) }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as WriteWiseConfig) : {}
}

/** Merges `patch` into config.json (an empty string or undefined removes the key) and keeps the file owner-only. */
export async function writeConfig(patch: Partial<WriteWiseConfig>): Promise<WriteWiseConfig> {
  const current = await readConfig().catch(() => ({} as WriteWiseConfig))
  const next: Record<string, unknown> = { ...current, ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k]
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await writeFile(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  await chmod(configFile(), 0o600).catch(() => { /* not supported on this file system */ })
  return next as WriteWiseConfig
}

/** The key and model for Claude outside the desktop app: ANTHROPIC_API_KEY first, then config.json. */
export async function resolveAiSettings(): Promise<AiSettings> {
  const cfg = await readConfig().catch(() => ({} as WriteWiseConfig))
  const model = (process.env.WRITEWISE_AI_MODEL || (typeof cfg.model === 'string' && cfg.model) || DEFAULT_AI_MODEL).trim()
  const env = (process.env.ANTHROPIC_API_KEY || '').trim()
  if (env) return { apiKey: env, model, source: 'env' }
  const fromFile = typeof cfg.anthropicApiKey === 'string' ? cfg.anthropicApiKey.trim() : ''
  if (fromFile) return { apiKey: fromFile, model, source: 'config' }
  return { apiKey: '', model, source: 'none' }
}

export function describeSource(source: AiKeySource): string {
  switch (source) {
    case 'app': return "the desktop app's keychain store"
    case 'app-plain': return "the desktop app's settings file (unencrypted: no system keyring)"
    case 'desktop': return 'the running desktop app'
    case 'env': return 'ANTHROPIC_API_KEY'
    case 'config': return configFile()
    default: return 'nowhere'
  }
}

export function maskKey(key: string): string {
  if (!key) return ''
  return key.length <= 12 ? '…' : `${key.slice(0, 7)}…${key.slice(-4)}`
}

// ---------- the running desktop app ----------
/** Local socket on which the desktop app hands its keychain-backed settings to the other surfaces (same user account only). */
export function desktopSocketPath(): string {
  if (process.env.WRITEWISE_DESKTOP_SOCKET) return process.env.WRITEWISE_DESKTOP_SOCKET
  if (process.platform === 'win32') {
    let user = 'user'
    try { user = userInfo().username || user } catch { /* no account info */ }
    return `\\\\.\\pipe\\writewise-desktop-${user.replace(/[^\w.-]/g, '_')}`
  }
  return path.join(configDir(), 'desktop.sock')
}

/** Asks the running desktop app for its AI settings; null when it is not running or has no key. */
export function fetchAiSettingsFromDesktop(timeoutMs = 1500): Promise<AiSettings | null> {
  return new Promise((resolve) => {
    let done = false
    let sock: net.Socket
    const finish = (v: AiSettings | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* already closed */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try { sock = net.connect(desktopSocketPath()) } catch { finish(null); return }
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ cmd: 'get-ai-settings' }) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        const msg = JSON.parse(buf.slice(0, nl))
        if (msg && msg.ok === true && typeof msg.apiKey === 'string' && msg.apiKey.trim()) {
          finish({ apiKey: msg.apiKey.trim(), model: typeof msg.model === 'string' && msg.model ? msg.model : DEFAULT_AI_MODEL, source: 'desktop' })
        } else finish(null)
      } catch { finish(null) }
    })
    sock.on('error', () => finish(null))
    sock.on('close', () => finish(null))
  })
}
