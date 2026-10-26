// Manifest V3 service worker: answers "check" messages from content scripts and the popup.
import { getChecker, handleCheck, type CheckRequest } from './engine-bridge'

chrome.runtime.onMessage.addListener((msg: CheckRequest, _sender, sendResponse) => {
  if (msg?.type !== 'check') return
  handleCheck(msg).then(sendResponse, (err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }))
  return true // async response
})

// Warm the dictionary so the first check is fast.
chrome.runtime.onInstalled.addListener(() => { getChecker().catch(() => {}) })
getChecker().catch(() => {})
