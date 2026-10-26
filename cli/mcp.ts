// MCP server exposing the WriteWise engine as tools for Claude Code, Claude
// Desktop, or any other MCP client. Transport: stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createNodeChecker, fixText } from './index'
import { buildPromptTemplate } from '../src/engine/prompt'
import { DEFAULT_CHECK_OPTIONS, type Checker } from '../src/engine/core'

let checkerPromise: Promise<Checker> | null = null
const getChecker = () => (checkerPromise ??= createNodeChecker())

function describeIssues(issues: Array<{ title: string; category: string; message: string; actual: string; replacements: string[] }>): string {
  if (!issues.length) return 'No further suggestions.'
  return issues.slice(0, 40).map((i) => `- [${i.category}] ${i.title}: "${i.actual}" — ${i.message}${i.replacements.length ? ` Suggestions: ${i.replacements.slice(0, 3).join(', ')}` : ''}`).join('\n')
}

export async function serve() {
  const server = new McpServer({ name: 'writewise', version: '0.1.0' })

  server.registerTool(
    'proofread_text',
    {
      title: 'Proofread text',
      description: 'Fixes spelling, grammar, punctuation and capitalization in the given text (safe fixes are applied automatically) and lists the remaining style suggestions. Use it on the user\'s message before interpreting it, or on any text before showing it to the user.',
      inputSchema: { text: z.string().describe('The text to proofread') },
    },
    async ({ text }) => {
      const r = await fixText(await getChecker(), text, { mode: 'writing' })
      const out = `Corrected text:\n${r.fixed}\n\nFixes applied: ${r.applied.length}\n${r.applied.map((i) => `- ${i.title}: "${i.actual}" → "${i.replacements[0] ?? ''}"`).join('\n')}\n\nRemaining suggestions:\n${describeIssues(r.remaining)}`
      return { content: [{ type: 'text', text: out }] }
    },
  )

  server.registerTool(
    'analyze_prompt',
    {
      title: 'Analyze and improve an AI prompt',
      description: 'Scores a request meant for an AI assistant: which prompt elements are present (task, context, role/audience, output format, constraints, examples, success criteria), which words are vague, and a corrected, structured version of the prompt with [placeholders] for the missing parts. Use it to understand an unclear user request and decide what to ask.',
      inputSchema: { text: z.string().describe('The user\'s request or draft prompt') },
    },
    async ({ text }) => {
      const r = await fixText(await getChecker(), text, { mode: 'prompt' })
      const present = r.prompt.checks.filter((c) => c.ok).map((c) => c.label)
      const missing = r.prompt.checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.hint})`)
      const vague = r.remaining.filter((i) => i.category === 'prompt').map((i) => `"${i.actual}": ${i.message}`)
      const out = [
        `Prompt score: ${r.prompt.score}/100`,
        `Present: ${present.join(', ') || 'none'}`,
        `Missing: ${missing.join('; ') || 'none'}`,
        `Vague wording: ${vague.join('; ') || 'none'}`,
        `Corrected text (${r.applied.length} fixes):\n${r.fixed}`,
        `Structured version:\n${buildPromptTemplate(r.fixed, r.prompt)}`,
      ].join('\n\n')
      return { content: [{ type: 'text', text: out }] }
    },
  )

  server.registerTool(
    'check_text',
    {
      title: 'List writing suggestions',
      description: 'Returns every spelling, grammar, clarity, engagement and delivery suggestion for the text without changing it, with character offsets.',
      inputSchema: { text: z.string().describe('The text to check') },
    },
    async ({ text }) => {
      const { issues, stats, tone } = await (await getChecker()).check(text, DEFAULT_CHECK_OPTIONS)
      const out = `${issues.length} suggestions. Words: ${stats.words}, readability: ${stats.readabilityLabel} (${stats.fleschEase}), tone: ${tone.formality}/${tone.confidence}${tone.friendly ? '/friendly' : ''}\n` +
        issues.map((i) => `- ${i.start}-${i.end} [${i.category}] ${i.title}: "${i.actual}" — ${i.message}${i.replacements.length ? ` → ${i.replacements.slice(0, 3).join(' | ')}` : ''}`).join('\n')
      return { content: [{ type: 'text', text: out }] }
    },
  )

  await server.connect(new StdioServerTransport())
}
