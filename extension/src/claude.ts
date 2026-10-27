// Claude for the browser extension: the user's own key, opt-in, read from chrome.storage.local by the
// background service worker so content scripts never see it. The only network request the extension
// ever makes is this one, to api.anthropic.com, and only when the user clicks "Fix with Claude".
// Service workers cannot `import()`, so the SDK is imported statically here (and only here).
import Anthropic from '@anthropic-ai/sdk'
import { rewriteWith } from '../../src/ai-core'
import { CLAUDE_DEFAULTS, MAX_CLAUDE_CHARS, type ClaudeSettings } from './claude-constants'

export async function loadClaudeSettings(): Promise<ClaudeSettings> {
  return { ...CLAUDE_DEFAULTS, ...(await chrome.storage.local.get(CLAUDE_DEFAULTS)) } as ClaudeSettings
}

/** Corrects grammar, spelling and punctuation in `text` with Claude; wording and structure stay as they are. */
export async function claudeFix(text: string): Promise<string> {
  const s = await loadClaudeSettings()
  if (!s.claudeEnabled) throw new Error('Turn on "Use Claude for sentence fixes" in the WriteWise popup first.')
  if (!s.claudeKey) throw new Error('Add your Anthropic API key in the WriteWise popup first, or fetch it from the desktop app.')
  if (!text.trim()) throw new Error('Nothing to fix.')
  if (text.length > MAX_CLAUDE_CHARS) throw new Error('Too long for Claude: keep it under 20,000 characters.')
  const client = new Anthropic({ apiKey: s.claudeKey, dangerouslyAllowBrowser: true })
  return rewriteWith(client, { model: s.claudeModel || CLAUDE_DEFAULTS.claudeModel, mode: 'fix', text })
}
