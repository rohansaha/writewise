// Manifest V3 service worker: answers "check" messages from content scripts and the popup with the
// offline engine, and "claude-fix" messages with the user's own Claude key when they opted in.
import { getChecker, handleCheck, type CheckRequest } from './engine-bridge'
import { claudeFix } from './claude'

type Request = CheckRequest | { type: 'claude-fix'; text: string }

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  const fail = (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) })
  if (msg?.type === 'check') {
    handleCheck(msg).then(sendResponse, fail)
    return true // async response
  }
  if (msg?.type === 'claude-fix') {
    claudeFix(typeof msg.text === 'string' ? msg.text : '').then((fixed) => sendResponse({ fixed }), fail)
    return true
  }
  return
})

// Warm the dictionary so the first check is fast.
chrome.runtime.onInstalled.addListener(() => { getChecker().catch(() => {}) })
getChecker().catch(() => {})
