// The Anthropic API key and model for the desktop app, kept encrypted with Electron's safeStorage
// (the login keychain on macOS, DPAPI on Windows, the desktop's secret service on Linux) in
// userData/ai-settings.json. This is the one place the key is entered: the editor window reads and
// writes it over IPC, the hotkeys and the overlay read it directly, and the other WriteWise surfaces
// on this machine (the browser extension through `writewise native-host`, the CLI) ask for it over a
// local socket that only the same user account can reach. When no key is stored here, the desktop
// app falls back to ANTHROPIC_API_KEY and ~/.config/writewise/config.json like the CLI does.
const { app, safeStorage, ipcMain } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const DEFAULT_MODEL = 'claude-opus-5-5'
const file = () => path.join(app.getPath('userData'), 'ai-settings.json')

let cache = null // the decrypted store; dropped on every write

/**
 * Decrypts with safeStorage, retrying while it reports itself temporarily unavailable (common for a moment after
 * launch), then falling back to the synchronous API, which works whenever the keychain is reachable.
 */
async function decryptKey(buf) {
  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await safeStorage.decryptStringAsync(buf) } catch (err) {
      lastErr = err
      if (!/temporarily unavailable/i.test(String(err && err.message))) break
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    }
  }
  try { if (safeStorage.isEncryptionAvailable()) return { result: safeStorage.decryptString(buf), shouldReEncrypt: false } } catch (err) { lastErr = err }
  throw lastErr || new Error('could not decrypt')
}

async function readStore() {
  if (cache) return cache
  let raw
  try { raw = fs.readFileSync(file(), 'utf8') } catch (err) {
    if (err.code !== 'ENOENT') console.warn('could not read AI settings:', err.message)
    return (cache = { apiKey: '', model: '', plain: false, exists: false })
  }
  try {
    const j = JSON.parse(raw)
    const model = typeof j.model === 'string' ? j.model : ''
    let apiKey = ''
    let plain = false
    if (typeof j.key === 'string' && j.key) {
      if (j.encrypted) {
        const r = await decryptKey(Buffer.from(j.key, 'base64'))
        apiKey = r.result
        if (r.shouldReEncrypt) { await writeStore({ apiKey, model }); cache = null }
      } else {
        apiKey = j.key
        plain = true
      }
    }
    return (cache = { apiKey: apiKey.trim(), model, plain, exists: true })
  } catch (err) {
    // Never cache a failure: the keychain is often briefly unavailable right after launch, and caching it would
    // make every feature think there is no key until the app restarts.
    console.warn('could not decrypt AI settings:', err.message)
    return { apiKey: '', model: '', plain: false, exists: true }
  }
}

async function writeStore({ apiKey, model }) {
  const key = String(apiKey || '').trim()
  let encrypted = false
  let stored = key
  if (key) {
    try { encrypted = await safeStorage.isAsyncEncryptionAvailable() } catch { encrypted = false }
    if (encrypted) {
      // A keychain that cannot be reached (locked, or a session without one) fails here although
      // encryption was reported available: keep the key, flag it as unencrypted, and tell the user in Settings.
      try { stored = (await safeStorage.encryptStringAsync(key)).toString('base64') } catch (err) { console.warn('safeStorage could not encrypt the API key:', err.message); encrypted = false; stored = key }
    }
    if (!encrypted) console.warn('the API key is stored unencrypted in', file())
  }
  const j = {
    version: 1,
    model: String(model || ''),
    key: stored,
    encrypted,
    updatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(j, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file(), 0o600) } catch { /* not supported here */ }
  cache = null
}

let fallback = null // async () => { apiKey, model, source } from ANTHROPIC_API_KEY / config.json (the CLI bundle)

/**
 * The settings every consumer uses. `stored` says whether the key came from this app's own store
 * (then the Settings field shows it); otherwise the key, if any, came from the environment or
 * config.json and the field stays empty so the user can still enter one that takes precedence.
 */
async function getAiSettings() {
  const s = await readStore()
  if (s.apiKey) return { apiKey: s.apiKey, model: s.model || DEFAULT_MODEL, source: s.plain ? 'app-plain' : 'app', stored: true }
  let fb = null
  if (fallback) {
    try { fb = await fallback() } catch (err) { console.warn('AI key fallback failed:', err.message) }
  }
  if (fb && fb.apiKey) return { apiKey: fb.apiKey, model: s.model || fb.model || DEFAULT_MODEL, source: fb.source, stored: false }
  return { apiKey: '', model: s.model || DEFAULT_MODEL, source: 'none', stored: false }
}

async function setAiSettings({ apiKey, model }) {
  await writeStore({ apiKey, model })
  return getAiSettings()
}

/** IPC for the editor window (electron/preload.cjs). Only pages served from the app:// bundle may call it. */
function installIpc({ resolveFallback, onChange }) {
  fallback = resolveFallback || null
  const allowed = (e) => {
    try { return !!e.senderFrame && new URL(e.senderFrame.url).protocol === 'app:' } catch { return false }
  }
  ipcMain.handle('ai-settings:get', (e) => {
    if (!allowed(e)) throw new Error('not allowed')
    return getAiSettings()
  })
  ipcMain.handle('ai-settings:set', async (e, s) => {
    if (!allowed(e)) throw new Error('not allowed')
    if (!s || typeof s !== 'object') throw new Error('bad settings')
    const result = await setAiSettings({ apiKey: typeof s.apiKey === 'string' ? s.apiKey : '', model: typeof s.model === 'string' ? s.model : '' })
    if (onChange) { try { onChange(result) } catch { /* listener failed */ } }
    return result
  })
}

// ---------- local socket for the other surfaces (cli/config.ts: fetchAiSettingsFromDesktop) ----------
let server = null
let servingPath = null

function probe(socketPath) {
  return new Promise((resolve) => {
    const c = net.connect(socketPath)
    c.once('connect', () => { c.destroy(); resolve(true) })
    c.once('error', () => resolve(false))
  })
}

/** Starts answering `{cmd:"get-ai-settings"}` on `socketPath` (newline-delimited JSON, one request per connection). */
async function startSocketServer(socketPath) {
  if (server) return true
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
    if (fs.existsSync(socketPath)) {
      // Left behind by a crashed run, unless another WriteWise is still answering there.
      if (await probe(socketPath)) { console.warn('another WriteWise already serves', socketPath); return false }
      fs.rmSync(socketPath, { force: true })
    }
  }
  server = net.createServer((sock) => {
    let buf = ''
    let answered = false
    const reply = (obj) => { if (answered) return; answered = true; sock.end(JSON.stringify(obj) + '\n') }
    sock.setEncoding('utf8')
    sock.setTimeout(5000, () => sock.destroy())
    sock.on('error', () => { /* client went away */ })
    sock.on('data', async (chunk) => {
      if (answered) return
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) { if (buf.length > 4096) sock.destroy(); return }
      let msg
      try { msg = JSON.parse(buf.slice(0, nl)) } catch { return reply({ ok: false, error: 'bad request' }) }
      const cmd = msg && msg.cmd
      if (cmd === 'ping') return reply({ ok: true, app: 'WriteWise', version: app.getVersion() })
      if (cmd === 'get-ai-settings') {
        try {
          const s = await getAiSettings()
          return reply(s.apiKey ? { ok: true, apiKey: s.apiKey, model: s.model, source: s.source } : { ok: false, error: 'No API key is set in WriteWise.' })
        } catch (err) {
          return reply({ ok: false, error: err.message })
        }
      }
      reply({ ok: false, error: 'unknown command' })
    })
  })
  // The socket file is created with the process umask; make sure only this user can open it.
  const oldMask = process.platform === 'win32' ? null : process.umask(0o077)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
  } catch (err) {
    server = null
    throw err
  } finally {
    if (oldMask !== null) process.umask(oldMask)
  }
  if (process.platform !== 'win32') { try { fs.chmodSync(socketPath, 0o600) } catch { /* fine */ } }
  server.on('error', (err) => console.warn('[ai-settings] socket error:', err.message))
  servingPath = socketPath
  return true
}

function stopSocketServer() {
  if (server) { try { server.close() } catch { /* already closed */ } server = null }
  if (servingPath && process.platform !== 'win32') { try { fs.rmSync(servingPath, { force: true }) } catch { /* gone */ } }
  servingPath = null
}

module.exports = { getAiSettings, setAiSettings, installIpc, startSocketServer, stopSocketServer, DEFAULT_MODEL }
