// Regression tests for the spelling auto-fix safety rule. Run with `npm test` (builds bin/writewise.mjs first).
// Inputs start with a capital letter because the fixer also capitalizes sentence starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const m = await import(path.join(root, 'bin', 'writewise.mjs'))
const checker = await m.createNodeChecker(path.join(root, 'public', 'dict'))
const fix = async (text) => (await m.fixText(checker, text, { mode: 'writing' })).fixed

test('known typos are still corrected', async () => {
  assert.equal(await fix('Teh cat adn the dog'), 'The cat and the dog')
})

test('a unique one-edit fix to a common word is still applied', async () => {
  assert.equal(await fix('My favorite langauge'), 'My favorite language')
})

test('all-caps acronyms are never rewritten', async () => {
  assert.equal(await fix('Install it from the DMG in release'), 'Install it from the DMG in release')
})

test('tokens with digits are never rewritten', async () => {
  assert.equal(await fix('Use the B2B plan'), 'Use the B2B plan')
})

test('ambiguous one-edit candidates are left alone', async () => {
  // "shud" is one edit from shed, shut and stud; guessing used to turn it into "shed".
  assert.equal(await fix('It shud be fast'), 'It shud be fast')
})
