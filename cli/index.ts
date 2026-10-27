#!/usr/bin/env node
// WriteWise command line: proofreads text, feeds Claude Code's UserPromptSubmit
// hook, and serves the engine as an MCP tool. Also imported by the Electron
// main process for the clipboard hotkey.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createChecker, DEFAULT_CHECK_OPTIONS, type Checker } from '../src/engine/core'
import { autoFix } from '../src/engine/autofix'
import { analyzePrompt, buildPromptTemplate } from '../src/engine/prompt'
import type { CheckOptions, Issue, PromptReport } from '../src/types'
import { configFile, describeSource, desktopSocketPath, fetchAiSettingsFromDesktop, maskKey, readConfig, resolveAiSettings, writeConfig, DEFAULT_AI_MODEL, type AiKeySource, type AiSettings, type WriteWiseConfig } from './config'
import { createNativeMessageDecoder, encodeNativeMessage, handleNativeMessage, lookupAiSettings, serveNativeHost, NATIVE_HOST_NAME } from './native-host'

export { createChecker, autoFix, analyzePrompt, buildPromptTemplate, DEFAULT_CHECK_OPTIONS }
// Shared API-key handling (also used by the Electron main process through this bundle).
export { configFile, describeSource, desktopSocketPath, fetchAiSettingsFromDesktop, maskKey, readConfig, resolveAiSettings, writeConfig, DEFAULT_AI_MODEL }
export { createNativeMessageDecoder, encodeNativeMessage, handleNativeMessage, lookupAiSettings, serveNativeHost, NATIVE_HOST_NAME }
export type { AiKeySource, AiSettings, WriteWiseConfig }

// ---------- dictionary ----------
async function exists(p: string) { try { await access(p); return true } catch { return false } }

export async function findDictDir(explicit?: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [explicit, process.env.WRITEWISE_DICT, path.join(here, 'dict'), path.join(here, '..', 'dist', 'dict'), path.join(here, '..', 'public', 'dict')].filter(Boolean) as string[]
  for (const c of candidates) if (await exists(path.join(c, 'en-US.dic'))) return c
  throw new Error('Could not find the en-US dictionary. Set WRITEWISE_DICT to a folder containing en-US.aff and en-US.dic.')
}

export async function createNodeChecker(dictDir?: string): Promise<Checker> {
  const dir = await findDictDir(dictDir)
  const [aff, dic] = await Promise.all([readFile(path.join(dir, 'en-US.aff'), 'utf8'), readFile(path.join(dir, 'en-US.dic'), 'utf8')])
  return createChecker({ aff, dic })
}

// ---------- fixing ----------
export interface FixOutput {
  original: string
  fixed: string
  applied: Issue[]
  remaining: Issue[]
  prompt: PromptReport
}

export async function fixText(checker: Checker, text: string, options: Partial<CheckOptions> = {}): Promise<FixOutput> {
  const opts: CheckOptions = { ...DEFAULT_CHECK_OPTIONS, mode: 'prompt', ...options }
  // Fixes can unlock further fixes (e.g. "their are" -> "there are" -> "There are"), so run a few passes.
  let fixed = text
  const applied: Issue[] = []
  let result = await checker.check(fixed, opts)
  for (let pass = 0; pass < 3; pass++) {
    const step = autoFix(fixed, result.issues)
    if (!step.applied.length) break
    applied.push(...step.applied)
    fixed = step.text
    result = await checker.check(fixed, opts)
  }
  const remaining = result.issues.filter((i) => i.category !== 'prompt' || opts.mode === 'prompt')
  return { original: text, fixed, applied, remaining, prompt: result.prompt ?? analyzePrompt(fixed) }
}

const PROMPT_ELEMENTS_THAT_MATTER = new Set(['task', 'context', 'format', 'constraints', 'criteria'])
/** Fixes that change meaning or readability. Capitalization and spacing alone are not worth interrupting Claude for. */
const COSMETIC_RULES = /^(sentence-capitalization|pronoun-i|double-space|space-before-punctuation|comma-space|period-space|double-punctuation|retext-sentence-spacing:)/

/** Builds the context block added to a Claude Code prompt, or null when there is nothing useful to add. */
export function hookContext(result: FixOutput): string | null {
  const words = result.original.trim().split(/\s+/).filter(Boolean)
  if (words.length < 3) return null
  const parts: string[] = []
  const substantive = result.applied.filter((i) => !COSMETIC_RULES.test(i.ruleId))
  if (substantive.length) {
    parts.push(`Corrected version of the user's message (${substantive.length} spelling/grammar fix${substantive.length === 1 ? '' : 'es'} applied automatically; treat this as what the user meant):\n"""\n${result.fixed}\n"""`)
  }
  const vague = Array.from(new Set(result.remaining.filter((i) => i.category === 'prompt').map((i) => i.actual.toLowerCase())))
  if (vague.length) parts.push(`Vague wording to interpret carefully or ask about: ${vague.map((v) => `"${v}"`).join(', ')}.`)
  if (words.length >= 20 && process.env.WRITEWISE_HOOK_NUDGE !== '0') {
    const missing = result.prompt.checks.filter((c) => !c.ok && PROMPT_ELEMENTS_THAT_MATTER.has(c.key)).map((c) => c.label.toLowerCase())
    if (missing.length >= 3) {
      parts.push(`Prompt check: the message does not state ${missing.join(', ')}. If one of these would materially change the result, ask one short clarifying question first; otherwise proceed with a sensible assumption and say what you assumed.`)
    }
  }
  if (!parts.length) return null
  return '[WriteWise prompt assist]\n' + parts.join('\n\n')
}

// ---------- CLI helpers ----------
async function readInput(file?: string): Promise<string> {
  if (file && file !== '-') return readFile(file, 'utf8')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function lineCol(text: string, offset: number) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const col = offset - before.lastIndexOf('\n')
  return `${line}:${col}`
}

function selfPath() { return fileURLToPath(import.meta.url) }

function usage() {
  console.log(`WriteWise CLI

  writewise fix [file] [--prompt] [--json]   Fix spelling/grammar (stdin or file). --prompt wraps it as a structured AI prompt.
  writewise fix [file] --claude [--prompt]   The same, then Claude corrects the result with your key (sends the text to Anthropic).
  writewise check [file]                      List every suggestion with line:column.
  writewise key set [key] [--model=<id>]      Save your Anthropic API key for every WriteWise surface (~/.config/writewise/config.json, owner-only;
                                              reads stdin when no key is given). ANTHROPIC_API_KEY in the environment takes precedence.
  writewise key show | clear                  Show which key is in use and where it comes from, or remove the saved one.
  writewise native-host                       Native-messaging host for the browser extension (registered by the desktop app; not for manual use).
  writewise hook                              Claude Code UserPromptSubmit hook (reads the hook JSON on stdin).
  writewise mcp                               Run as an MCP server over stdio (tools: proofread_text, analyze_prompt, check_text).
  writewise install-claude-code               Register the hook in ~/.claude/settings.json and the MCP server with the claude CLI.
  writewise uninstall-claude-code             Remove both again.
`)
}

// ---------- Claude Code integration ----------
async function installClaudeCode() {
  const bin = selfPath()
  const settingsPath = path.join(homedir(), '.claude', 'settings.json')
  let settings: any = {}
  if (await exists(settingsPath)) {
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) } catch { throw new Error(`${settingsPath} is not valid JSON; fix it first.`) }
  }
  settings.hooks ??= {}
  const list: any[] = Array.isArray(settings.hooks.UserPromptSubmit) ? settings.hooks.UserPromptSubmit : []
  const filtered = list.filter((entry) => !JSON.stringify(entry).includes('writewise'))
  filtered.push({ hooks: [{ type: 'command', command: `node "${bin}" hook`, timeout: 20 }] })
  settings.hooks.UserPromptSubmit = filtered
  await mkdir(path.dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  console.log(`✓ Hook registered in ${settingsPath}\n  Every prompt you submit in Claude Code is now proofread; corrections and prompt gaps are passed to Claude as context.`)

  const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'writewise', '--', 'node', bin, 'mcp'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    console.log(`• Could not register the MCP server automatically (is the "claude" CLI on your PATH?). Run this yourself:\n  claude mcp add --scope user --transport stdio writewise -- node "${bin}" mcp`)
  } else {
    console.log('✓ MCP server "writewise" registered with Claude Code (tools: proofread_text, analyze_prompt, check_text).')
  }
  console.log(`\nFor the Claude Desktop app, add this to claude_desktop_config.json (Settings → Developer → Edit Config):\n${JSON.stringify({ mcpServers: { writewise: { command: 'node', args: [bin, 'mcp'] } } }, null, 2)}`)
  console.log('\nRestart Claude Code / Claude Desktop for the changes to take effect.')
}

async function uninstallClaudeCode() {
  const settingsPath = path.join(homedir(), '.claude', 'settings.json')
  if (await exists(settingsPath)) {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (Array.isArray(settings.hooks?.UserPromptSubmit)) {
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((entry: unknown) => !JSON.stringify(entry).includes('writewise'))
      if (!settings.hooks.UserPromptSubmit.length) delete settings.hooks.UserPromptSubmit
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      console.log(`✓ Hook removed from ${settingsPath}`)
    }
  }
  const r = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'writewise'], { encoding: 'utf8' })
  console.log(r.status === 0 ? '✓ MCP server removed' : '• MCP server not removed (run: claude mcp remove --scope user writewise)')
}

async function runHook() {
  // Never break the user's session: any failure results in no output and exit 0.
  try {
    const raw = await readInput()
    const payload = JSON.parse(raw)
    const prompt: string = typeof payload.prompt === 'string' ? payload.prompt : ''
    const trimmed = prompt.trim()
    // Skip slash commands, shell lines, pasted code and very long inputs (subagent reports also arrive here).
    if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('!') || trimmed.includes('```') || trimmed.length > 6000) return
    // Skip automated inputs: system notifications, task/agent events and anything that opens with an XML-style tag.
    if (/^\s*(\[SYSTEM|<[a-z][\w-]*[\s>])/i.test(trimmed) || /<(task-notification|side-sessions-event|ci-monitor-event|agent-message|system-reminder)\b/i.test(trimmed)) return
    const checker = await createNodeChecker()
    const result = await fixText(checker, prompt)
    const context = hookContext(result)
    if (!context) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
  } catch (err) {
    process.stderr.write(`writewise hook: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

// ---------- main ----------
export async function main(argv: string[]) {
  const [cmd, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith('--')))
  const file = rest.find((a) => !a.startsWith('--'))
  switch (cmd) {
    case 'fix': {
      const checker = await createNodeChecker()
      const text = await readInput(file)
      const result = await fixText(checker, text)
      if (flags.has('--claude')) {
        // Offline fixes first, then Claude with the user's own key (ANTHROPIC_API_KEY, the running desktop app, or config.json); nothing is sent otherwise.
        const ai = await lookupAiSettings()
        if (!ai.apiKey) throw new Error(`No Anthropic API key found: set ANTHROPIC_API_KEY, enter one under Settings in the WriteWise desktop app, or run "writewise key set" (writes ${configFile()}).`)
        process.stderr.write(`Asking ${ai.model} (key from ${describeSource(ai.source)})…\n`)
        const out = await rewrite({ apiKey: ai.apiKey, model: ai.model, mode: flags.has('--prompt') ? 'prompt' : 'fix', text: result.fixed })
        if (flags.has('--json')) { console.log(JSON.stringify({ ...result, claude: out, model: ai.model }, null, 2)); return }
        process.stdout.write(out.endsWith('\n') ? out : out + '\n')
        return
      }
      if (flags.has('--json')) { console.log(JSON.stringify(result, null, 2)); return }
      process.stdout.write(flags.has('--prompt') ? buildPromptTemplate(result.fixed, result.prompt) : result.fixed)
      if (!result.fixed.endsWith('\n')) process.stdout.write('\n')
      process.stderr.write(`${result.applied.length} fix${result.applied.length === 1 ? '' : 'es'} applied, ${result.remaining.length} suggestion${result.remaining.length === 1 ? '' : 's'} left\n`)
      return
    }
    case 'check': {
      const checker = await createNodeChecker()
      const text = await readInput(file)
      const { issues } = await checker.check(text, { ...DEFAULT_CHECK_OPTIONS, mode: flags.has('--prompt') ? 'prompt' : 'writing' })
      for (const i of issues) console.log(`${lineCol(text, i.start)}  [${i.category}] ${i.title}: ${i.message}${i.replacements.length ? `  → ${i.replacements.slice(0, 3).join(' | ')}` : ''}`)
      console.log(`${issues.length} suggestion${issues.length === 1 ? '' : 's'}`)
      return
    }
    case 'hook': return runHook()
    case 'mcp': { const { serve } = await import('./mcp'); return serve() }
    case 'native-host': return serveNativeHost()
    case 'key': {
      const sub = rest[0]
      const modelFlag = rest.find((a) => a.startsWith('--model='))?.slice('--model='.length)
      if (sub === 'set') {
        let key = rest.slice(1).find((a) => !a.startsWith('--')) || ''
        if (!key || key === '-') key = (await readInput()).trim()
        if (!key) throw new Error('Pass the key as an argument or on stdin, e.g.  echo sk-ant-… | writewise key set')
        await writeConfig({ anthropicApiKey: key, ...(modelFlag ? { model: modelFlag } : {}) })
        console.log(`✓ Key saved to ${configFile()} (readable only by you).\n  Used by the CLI, the Claude Code hook, the MCP server and the browser-extension bridge; the desktop app uses it too until you enter a key under its Settings.`)
        return
      }
      if (sub === 'clear') {
        await writeConfig({ anthropicApiKey: '' })
        console.log(`✓ Key removed from ${configFile()}`)
        return
      }
      if (!sub || sub === 'show') {
        const s = await lookupAiSettings()
        console.log(s.apiKey ? `Key ${maskKey(s.apiKey)} from ${describeSource(s.source)}; model ${s.model}` : `No API key found. Looked at: the running desktop app, ANTHROPIC_API_KEY, ${configFile()}.`)
        return
      }
      throw new Error(`Unknown key command "${sub}" (set | show | clear)`)
    }
    case 'install-claude-code': return installClaudeCode()
    case 'uninstall-claude-code': return uninstallClaudeCode()
    default: usage()
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main(process.argv.slice(2)).catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })

// ---------- context-aware sentence correction (Claude API, user's own key) ----------
import { rewrite } from '../src/ai'

export interface SentenceRewriteParams {
  apiKey: string
  model: string
  /** The sentence to correct. */
  sentence: string
  /** The whole text it sits in, used only as context. */
  context: string
  signal?: AbortSignal
}

/**
 * Corrects one sentence with the surrounding text as context (so "their"/"there", tense and
 * agreement are judged in context), changing as little as possible. Used by the desktop overlay's
 * "Rewrite with Claude" button. Returns only the corrected sentence.
 */
export async function rewriteSentence(p: SentenceRewriteParams): Promise<string> {
  const instruction = `Below is a full message (CONTEXT) and one SENTENCE taken from it. Correct the SENTENCE: fix spelling, grammar, punctuation and clearly wrong word choices, judging them from the context. Keep its meaning, tone, wording and length as they are; change only what is needed. Output only the corrected sentence, with no quotes and no explanation.\n\nCONTEXT:\n"""\n${p.context}\n"""\n\nSENTENCE:`
  const out = await rewrite({ apiKey: p.apiKey, model: p.model, mode: 'custom', instruction, text: p.sentence, signal: p.signal })
  return out.replace(/^["'“”]+|["'“”]+$/g, '').trim()
}


export interface PromptBuildParams {
  apiKey: string
  model: string
  /** The text to turn into a prompt (the whole box, or the selection). */
  text: string
  /** The whole text box it came from, when `text` is only a part of it. */
  surrounding?: string
  /** The app the user is typing into, e.g. "Claude" or "Slack". */
  app?: string
  signal?: AbortSignal
}

/**
 * Turns rough notes into a structured prompt with Claude, using what is around them: the rest of the text box
 * and the app it will be sent from. Spelling and grammar are corrected in context first, every section is filled
 * from what the user actually wrote, and [brackets] are used only for details that are genuinely missing.
 */
export async function buildPromptWithClaude(p: PromptBuildParams): Promise<string> {
  const where = p.app ? `The prompt will be sent to an AI assistant from the app "${p.app}"${/claude/i.test(p.app) ? ' (Claude)' : ''}.` : 'The prompt will be sent to an AI assistant.'
  const around = p.surrounding && p.surrounding.trim() !== p.text.trim()
    ? `\n\nThe notes are part of a longer message; use it only as context (do not turn it into the prompt):\n"""\n${p.surrounding}\n"""` : ''
  const instructionOverride = `Turn the user's notes into a complete prompt. ${where} First correct spelling, grammar and word choice in context (for example "shud" means "should", "their going" means "they're going"). Then fill every section from what the notes and the context actually say: who and what it is about, the audience, tone, length and constraints the user stated. Use [square brackets] only for details that are truly missing and would change the answer; never bracket something the user already said. Keep it as short as the request allows: a one-line request gets a compact prompt, not a long form.${around}`
  const { rewrite } = await import('../src/ai')
  return rewrite({ apiKey: p.apiKey, model: p.model, mode: 'prompt', text: p.text, instructionOverride, signal: p.signal })
}
