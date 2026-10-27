// The Claude rewrite itself, independent of how the SDK client is created: the editor loads the
// SDK on demand (src/ai.ts), the CLI bundle has it inlined, and the browser extension's service
// worker imports it statically (service workers cannot `import()`). The key only ever travels in
// the request to api.anthropic.com.
import type Anthropic from '@anthropic-ai/sdk'

export type AiMode =
  | 'improve' | 'fix' | 'shorten' | 'formal' | 'casual' | 'confident' | 'simplify'
  | 'prompt' | 'prompt-expand' | 'prompt-tighten' | 'custom'

export const EDITOR_SYSTEM = `You are a meticulous writing editor. You rewrite the user's text according to the instruction, preserving their meaning, facts, names, numbers and intent. Keep the original language and the original formatting conventions (paragraph breaks, lists, Markdown) unless the instruction says otherwise. Output only the rewritten text: no preamble, no explanation, no quotes around it.`

export const PROMPT_ENGINEER_SYSTEM = `You are an expert prompt engineer who turns rough notes into excellent prompts for an AI assistant such as Claude.

Rewrite the user's text into a complete, well-structured prompt. Preserve every concrete detail and the user's intent; never invent facts about them. Produce these Markdown sections, omitting one only if it truly does not apply:

# Role — who the assistant should be and the expertise to apply
# Context — background the assistant needs (who it is for, why, what exists already)
# Task — the precise job, as an imperative
# Requirements — constraints, must-haves, things to avoid, tone, length, language
# Output format — the exact shape of the answer (structure, length, headings, JSON, etc.)
# Success criteria — how the user will judge a good result

Add helpful specifics the user likely wants but did not state. Where a detail is missing and genuinely matters, make a sensible assumption and mark it in [square brackets] so the user can confirm or edit it. End with one line: "Before answering, ask me about anything in [brackets] that would change your answer." Output only the prompt.`

export const INSTRUCTIONS: Record<Exclude<AiMode, 'custom'>, string> = {
  improve: 'Improve this text: fix grammar, tighten wording, improve flow and clarity, and keep the tone and length roughly the same.',
  fix: 'Fix only grammar, spelling and punctuation. Do not change wording, tone or structure beyond what is needed to correct errors.',
  shorten: 'Make this text about half as long while keeping every important point.',
  formal: 'Rewrite this text in a formal, professional register suitable for business or academic communication.',
  casual: 'Rewrite this text in a relaxed, friendly, conversational tone.',
  confident: 'Rewrite this text to sound confident and assertive: remove hedging, apologies and filler, and use direct statements.',
  simplify: 'Rewrite this text in plain language a 12-year-old could understand: short sentences, common words, no jargon.',
  prompt: 'Turn this into a complete, detailed prompt for an AI assistant.',
  'prompt-expand': 'This is already a prompt for an AI assistant. Keep its structure and intent but add more detail: fill in missing context, make requirements explicit, add an output format and success criteria, and include one short example of the desired output if helpful.',
  'prompt-tighten': 'This is a prompt for an AI assistant. Remove ambiguity and vague words, make every instruction testable, and keep it as short as possible without losing any requirement.',
}

export interface RewriteRequest {
  model: string
  mode: AiMode
  text: string
  instruction?: string
  /** Overrides the mode's built-in instruction (used for prompt mode with extra context). */
  instructionOverride?: string
  onDelta?: (partial: string) => void
  signal?: AbortSignal
}

export interface RewriteParams extends RewriteRequest {
  apiKey: string
}

export function isPromptMode(mode: AiMode): boolean {
  return mode === 'prompt' || mode === 'prompt-expand' || mode === 'prompt-tighten'
}

/** Streams the rewrite through an existing SDK client; returns the final text. */
export async function rewriteWith(client: Anthropic, p: RewriteRequest): Promise<string> {
  const system = isPromptMode(p.mode) ? PROMPT_ENGINEER_SYSTEM : EDITOR_SYSTEM
  const instruction = p.instructionOverride || (p.mode === 'custom' ? (p.instruction || 'Improve this text.') : INSTRUCTIONS[p.mode])

  const stream = client.messages.stream(
    {
      model: p.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: `Instruction: ${instruction}\n\nText:\n"""\n${p.text}\n"""` }],
    },
    { signal: p.signal },
  )

  let out = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      out += event.delta.text
      p.onDelta?.(out)
    }
  }
  const final = await stream.finalMessage()
  if (final.stop_reason === 'refusal') throw new Error('The model declined this request.')
  if (final.stop_reason === 'max_tokens') throw new Error('The response was cut off because it was too long. Try a smaller selection.')
  return out.trim()
}
