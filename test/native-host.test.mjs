// The native-messaging host behind the browser extension's "Use the desktop app's key" button:
// length-prefixed JSON over stdio, answered from ANTHROPIC_API_KEY first, then the running desktop
// app's socket, then config.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(root, 'bin', 'writewise.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-nh-'))
// Both this process (writeConfig below) and the spawned hosts must use the temp folder, never ~/.config/writewise.
process.env.WRITEWISE_CONFIG_DIR = tmp
delete process.env.ANTHROPIC_API_KEY
const m = await import(BIN)

/** Runs `writewise native-host` with the given environment, sends the messages, returns the decoded replies. */
function runHost(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'native-host'], { env: { ...process.env, WRITEWISE_CONFIG_DIR: tmp, ANTHROPIC_API_KEY: '', WRITEWISE_DESKTOP_SOCKET: path.join(tmp, 'absent.sock'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const replies = []
    const decode = m.createNativeMessageDecoder((msg) => replies.push(msg))
    let stderr = ''
    child.stdout.on('data', decode)
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(replies) : reject(new Error(`exit ${code}: ${stderr}`))))
    for (const msg of messages) child.stdin.write(m.encodeNativeMessage(msg))
    child.stdin.end()
  })
}

test('messages round-trip through the length-prefixed framing, even when split', () => {
  const a = m.encodeNativeMessage({ type: 'ping' })
  const b = m.encodeNativeMessage({ type: 'get-key', note: 'ünïcödé' })
  assert.equal(a.readUInt32LE(0), a.length - 4)
  const got = []
  const decode = m.createNativeMessageDecoder((msg) => got.push(msg))
  const all = Buffer.concat([a, b])
  decode(all.subarray(0, 3))
  decode(all.subarray(3, a.length + 5))
  decode(all.subarray(a.length + 5))
  assert.deepEqual(got, [{ type: 'ping' }, { type: 'get-key', note: 'ünïcödé' }])
})

test('ping and unknown requests', async () => {
  const [ping, unknown] = await runHost({}, [{ type: 'ping' }, { type: 'nope' }])
  assert.deepEqual(ping, { ok: true, host: 'app.writewise.desktop', version: 1 })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /Unknown request/)
})

test('without a desktop app or key the host says where to put one', async () => {
  const [r] = await runHost({}, [{ type: 'get-key' }])
  assert.equal(r.ok, false)
  assert.match(r.error, /writewise key set/)
})

test('falls back to ANTHROPIC_API_KEY when the desktop app is not running', async () => {
  const [r] = await runHost({ ANTHROPIC_API_KEY: 'sk-ant-env', WRITEWISE_AI_MODEL: 'claude-haiku-5-5' }, [{ type: 'get-key' }])
  assert.deepEqual(r, { ok: true, apiKey: 'sk-ant-env', model: 'claude-haiku-5-5', source: 'env' })
})

/** A stand-in for the desktop app's socket server (electron/ai-settings.cjs). */
async function fakeDesktop(name, reply, requests = []) {
  const sock = path.join(tmp, name)
  const server = net.createServer((c) => {
    c.setEncoding('utf8')
    c.on('data', (d) => { requests.push(JSON.parse(d.trim())); c.end(JSON.stringify(reply) + '\n') })
  })
  await new Promise((res) => server.listen(sock, res))
  return { sock, server, requests }
}

test('asks the running desktop app before config.json', async () => {
  await m.writeConfig({ anthropicApiKey: 'sk-ant-config' })
  const d = await fakeDesktop('desktop.sock', { ok: true, apiKey: 'sk-ant-desktop', model: 'claude-sonnet-5-5', source: 'app' })
  try {
    const [r] = await runHost({ WRITEWISE_DESKTOP_SOCKET: d.sock }, [{ type: 'get-key' }])
    assert.deepEqual(r, { ok: true, apiKey: 'sk-ant-desktop', model: 'claude-sonnet-5-5', source: 'desktop' })
    assert.deepEqual(d.requests, [{ cmd: 'get-ai-settings' }])
  } finally {
    d.server.close()
    await m.writeConfig({ anthropicApiKey: '' })
  }
})

test('an explicit ANTHROPIC_API_KEY wins over the running desktop app', async () => {
  const d = await fakeDesktop('desktop-env.sock', { ok: true, apiKey: 'sk-ant-desktop', model: 'claude-sonnet-5-5', source: 'app' })
  try {
    const [r] = await runHost({ ANTHROPIC_API_KEY: 'sk-ant-env', WRITEWISE_DESKTOP_SOCKET: d.sock }, [{ type: 'get-key' }])
    assert.equal(r.apiKey, 'sk-ant-env')
    assert.equal(r.source, 'env')
    assert.deepEqual(d.requests, [], 'the desktop app is not even asked')
  } finally {
    d.server.close()
  }
})

test('a desktop app without a key does not block the config.json fallback', async () => {
  await m.writeConfig({ anthropicApiKey: 'sk-ant-config' })
  const d = await fakeDesktop('desktop-nokey.sock', { ok: false, error: 'No API key is set in WriteWise.' })
  try {
    const [r] = await runHost({ WRITEWISE_DESKTOP_SOCKET: d.sock }, [{ type: 'get-key' }])
    assert.deepEqual(r, { ok: true, apiKey: 'sk-ant-config', model: 'claude-opus-5-5', source: 'config' })
  } finally {
    d.server.close()
    await m.writeConfig({ anthropicApiKey: '' })
  }
})
