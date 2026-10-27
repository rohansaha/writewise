// Native-messaging host for the browser extension (`writewise native-host`). The browser starts this
// process when the extension asks for the desktop app's API key, talks length-prefixed JSON over
// stdin/stdout, and ends it once the request is answered. The only question it answers is "which
// Anthropic key and model should the extension use": ANTHROPIC_API_KEY if the browser was started with
// one, else the running desktop app (its keychain-backed store, over the local socket), else config.json.
// It reads nothing else and sends nothing anywhere.
import { configFile, fetchAiSettingsFromDesktop, resolveAiSettings, type AiSettings } from './config'

export const NATIVE_HOST_NAME = 'app.writewise.desktop'
export const NATIVE_HOST_VERSION = 1

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Returns a sink for stdin chunks that calls `onMessage` for each complete length-prefixed JSON message. */
export function createNativeMessageDecoder(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      const body = buf.subarray(4, 4 + len).toString('utf8')
      buf = buf.subarray(4 + len)
      let msg: unknown
      try { msg = JSON.parse(body) } catch { continue }
      onMessage(msg)
    }
  }
}

/**
 * The key for everything outside the desktop app: an explicit ANTHROPIC_API_KEY in the environment wins,
 * then the running desktop app (its keychain store), then config.json.
 */
export async function lookupAiSettings(): Promise<AiSettings> {
  const fromEnv = await resolveAiSettings()
  if (fromEnv.source === 'env') return fromEnv
  const fromDesktop = await fetchAiSettingsFromDesktop()
  if (fromDesktop) return { ...fromDesktop, model: process.env.WRITEWISE_AI_MODEL || fromDesktop.model }
  return fromEnv
}

export async function handleNativeMessage(msg: unknown): Promise<Record<string, unknown>> {
  const type = msg && typeof msg === 'object' ? (msg as { type?: unknown }).type : undefined
  switch (type) {
    case 'ping':
      return { ok: true, host: NATIVE_HOST_NAME, version: NATIVE_HOST_VERSION }
    case 'get-key': {
      const s = await lookupAiSettings()
      if (!s.apiKey) {
        return { ok: false, error: `No API key found. Enter one under Settings in the WriteWise desktop app and keep it running, set ANTHROPIC_API_KEY, or run "writewise key set" (writes ${configFile()}).` }
      }
      return { ok: true, apiKey: s.apiKey, model: s.model, source: s.source }
    }
    default:
      return { ok: false, error: `Unknown request "${String(type)}"` }
  }
}

/** Serves stdin until the browser closes it; resolves once every request has been answered. */
export function serveNativeHost(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    let pending = 0
    let ended = false
    const maybeDone = () => { if (ended && pending === 0) resolve() }
    const decode = createNativeMessageDecoder((msg) => {
      pending++
      handleNativeMessage(msg)
        .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .then((reply) => { output.write(encodeNativeMessage(reply)); pending--; maybeDone() })
    })
    input.on('data', (chunk: Buffer) => decode(chunk))
    input.on('end', () => { ended = true; maybeDone() })
    input.on('error', () => { ended = true; maybeDone() })
  })
}
