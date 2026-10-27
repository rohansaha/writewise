// Optional AI rewrite powered by the Claude API using the user's own key.
// Runs directly in the browser/Electron renderer; the key never leaves the device
// except in requests to api.anthropic.com. The prompts and the streaming call live in
// src/ai-core.ts so the browser extension can reuse them with a statically imported SDK.
import { rewriteWith, type RewriteParams } from './ai-core'

export type { AiMode, RewriteParams, RewriteRequest } from './ai-core'
export { EDITOR_SYSTEM, INSTRUCTIONS, PROMPT_ENGINEER_SYSTEM, isPromptMode, rewriteWith } from './ai-core'

export async function rewrite(p: RewriteParams): Promise<string> {
  // Loaded on demand so the SDK is not part of the initial bundle.
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: p.apiKey, dangerouslyAllowBrowser: true })
  return rewriteWith(client, p)
}
