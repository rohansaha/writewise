// Where the Anthropic API key comes from outside the desktop app: ANTHROPIC_API_KEY, then
// ~/.config/writewise/config.json (WRITEWISE_CONFIG_DIR points the tests at a temp folder).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'writewise-config-'))
process.env.WRITEWISE_CONFIG_DIR = tmp
delete process.env.ANTHROPIC_API_KEY
delete process.env.WRITEWISE_AI_MODEL
const m = await import(path.join(root, 'bin', 'writewise.mjs'))

test('no key anywhere', async () => {
  assert.deepEqual(await m.resolveAiSettings(), { apiKey: '', model: 'claude-opus-5-5', source: 'none' })
})

test('config.json is written owner-only and read back', async () => {
  await m.writeConfig({ anthropicApiKey: 'sk-ant-from-file', model: 'claude-sonnet-5-5' })
  assert.equal(m.configFile(), path.join(tmp, 'config.json'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(m.configFile()).mode & 0o777, 0o600)
  assert.deepEqual(await m.readConfig(), { anthropicApiKey: 'sk-ant-from-file', model: 'claude-sonnet-5-5' })
  assert.deepEqual(await m.resolveAiSettings(), { apiKey: 'sk-ant-from-file', model: 'claude-sonnet-5-5', source: 'config' })
})

test('the environment wins over config.json', async () => {
  process.env.ANTHROPIC_API_KEY = ' sk-ant-from-env '
  const s = await m.resolveAiSettings()
  assert.equal(s.apiKey, 'sk-ant-from-env')
  assert.equal(s.source, 'env')
  assert.equal(s.model, 'claude-sonnet-5-5', 'the model still comes from config.json')
  process.env.WRITEWISE_AI_MODEL = 'claude-haiku-5-5'
  assert.equal((await m.resolveAiSettings()).model, 'claude-haiku-5-5')
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.WRITEWISE_AI_MODEL
})

test('clearing the key keeps the other settings', async () => {
  await m.writeConfig({ extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] })
  await m.writeConfig({ anthropicApiKey: '' })
  assert.deepEqual(await m.readConfig(), { model: 'claude-sonnet-5-5', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] })
  assert.equal((await m.resolveAiSettings()).source, 'none')
})

test('a broken config.json is reported, not ignored', async () => {
  fs.writeFileSync(m.configFile(), '{ not json')
  await assert.rejects(m.readConfig(), /not valid JSON/)
  assert.equal((await m.resolveAiSettings()).source, 'none', 'resolution degrades to "no key"')
})

test('maskKey hides the middle', () => {
  assert.equal(m.maskKey(''), '')
  assert.equal(m.maskKey('short'), '…')
  assert.equal(m.maskKey('sk-ant-api03-abcdefghijklmnop'), 'sk-ant-…mnop')
})
