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

export { createChecker, autoFix, analyzePrompt, buildPromptTemplate }

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
  writewise check [file]                      List every suggestion with line:column.
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
    case 'install-claude-code': return installClaudeCode()
    case 'uninstall-claude-code': return uninstallClaudeCode()
    default: usage()
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main(process.argv.slice(2)).catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
