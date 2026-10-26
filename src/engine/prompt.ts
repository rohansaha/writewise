// Prompt-mode analysis: scores how complete a piece of text is as an
// instruction for an AI assistant and flags vague wording. Pure functions,
// shared by the worker and the main thread (offline template builder).
import type { PromptCheck, PromptReport } from '../types'
import type { RawIssue } from './rules'

const TASK_RE = /\b(write|create|generate|draft|compose|explain|describe|summari[sz]e|list|build|make|design|plan|outline|review|analy[sz]e|compare|translate|fix|refactor|debug|improve|rewrite|convert|extract|classify|rank|recommend|suggest|brainstorm|teach|show me|help me|i need|i want|i'd like|can you|could you|please|give me|tell me|find|identify|implement|optimi[sz]e|evaluate|critique|proofread|edit)\b/i
const CONTEXT_RE = /\b(context|background|i am|i'm|we are|we're|our (team|company|product|users|customers)|my (team|company|product|project|app|business|boss|class|students|audience)|for my|currently|so far|already|previously|the goal is|because|situation)\b/i
const ROLE_RE = /\b(you are|act as|act like|as an? (expert|senior|experienced|professional)|take the role|pretend|persona|role:|audience|for (beginners|experts|kids|children|students|executives|developers|customers|engineers|non-technical|a general audience))\b/i
const FORMAT_RE = /\b(format|bullet|bulleted|numbered list|table|json|yaml|csv|markdown|paragraphs?|headings?|sections?|outline|essay|email|tweet|slides?|code block|step[- ]by[- ]step|steps|checklist|summary of|one[- ]liner|in \d+ (words|sentences|paragraphs|bullets|points)|\d+[- ]word|word count|template|structure|respond with|output|return)\b/i
const CONSTRAINT_RE = /\b(must|must not|should|shouldn't|don't|do not|avoid|never|only|at most|at least|no more than|no longer than|under \d+|maximum|minimum|limit|tone|style|voice|formal|casual|professional|friendly|concise|brief|detailed|without|exclude|include|require|deadline|budget|language:|in (english|spanish|french|german|hindi|bengali|chinese|japanese))\b/i
const EXAMPLE_RE = /\b(example|examples|e\.g\.|for instance|like this|such as|sample|here is how|here's how|similar to|modeled on|in the style of)\b/i
const CRITERIA_RE = /\b(success|criteria|good answer|should include|make sure|ensure|verify|check that|double[- ]check|the result should|i'll know it's good|accuracy|correct|cite|sources|evidence|test)\b/i

const VAGUE: Array<[RegExp, string]> = [
  [/\bstuff\b/gi, 'Name the specific things you mean instead of "stuff".'],
  [/\bthings?\b/gi, 'Say which thing exactly, or how many.'],
  [/\bsomething\b/gi, 'Replace "something" with a concrete noun.'],
  [/\bsomehow\b/gi, 'Describe the method or constraint instead of "somehow".'],
  [/\betc\.?(?=\s|$)/gi, 'List every item you want covered instead of "etc."'],
  [/\band so on\b/gi, 'List every item you want covered instead of "and so on".'],
  [/\bwhatever\b/gi, 'State the preference or the limit instead of "whatever".'],
  [/\b(good|nice|great|better|best|proper|decent)\b(?=\s+(answer|response|result|output|version|way|job|one))/gi, 'Define what "good" means here: length, tone, accuracy, audience.'],
  [/\bappropriate\b/gi, 'Say what makes it appropriate: for whom, in what setting.'],
  [/\brelevant\b/gi, 'Say what makes it relevant: which topic, time period, or source.'],
  [/\ba (few|couple|bunch|lot) of\b/gi, 'Give a number instead of a vague quantity.'],
  [/\bsome\b(?=\s+(examples|ideas|options|points|ways|tips|suggestions))/gi, 'Give a number: "three examples", "five options".'],
  [/\bvarious\b/gi, 'Name the specific kinds you mean instead of "various".'],
  [/\bimprove\b(?!\s+(the|this|my|our)\s+\w+\s+(by|so that|to))/gi, 'Say how it should improve: shorter, clearer, more persuasive, faster.'],
  [/\boptimi[sz]e\b(?!\s+for)/gi, 'Say what to optimize for: speed, cost, readability, conversions.'],
]

export function analyzePrompt(text: string): PromptReport {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const checks: PromptCheck[] = [
    { key: 'task', label: 'Clear task', ok: TASK_RE.test(text), hint: 'Start with what you want done: "Write…", "Explain…", "Compare…".' },
    { key: 'context', label: 'Context', ok: CONTEXT_RE.test(text) || words >= 60, hint: 'Add background: who you are, what this is for, what you already tried.' },
    { key: 'role', label: 'Role or audience', ok: ROLE_RE.test(text), hint: 'Tell the AI who it should be ("You are a senior editor") or who the output is for.' },
    { key: 'format', label: 'Output format', ok: FORMAT_RE.test(text), hint: 'Say what shape you want back: bullets, a table, JSON, 200 words, three options.' },
    { key: 'constraints', label: 'Constraints', ok: CONSTRAINT_RE.test(text), hint: 'State limits and must-haves: tone, length, what to avoid, language.' },
    { key: 'examples', label: 'Examples', ok: EXAMPLE_RE.test(text), hint: 'One example of a good answer is worth a paragraph of description.' },
    { key: 'criteria', label: 'Success criteria', ok: CRITERIA_RE.test(text), hint: 'Say how you will judge the result ("make sure it cites sources", "it must compile").' },
  ]
  const weights: Record<string, number> = { task: 3, context: 2, role: 1, format: 2, constraints: 2, examples: 1, criteria: 1 }
  let got = 0, total = 0
  for (const c of checks) { total += weights[c.key]; if (c.ok) got += weights[c.key] }
  const score = words === 0 ? 0 : Math.round((got / total) * 100)
  return { checks, score }
}

export function vagueWordIssues(text: string): RawIssue[] {
  const out: RawIssue[] = []
  let m: RegExpExecArray | null
  for (const [re, msg] of VAGUE) {
    re.lastIndex = 0
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length, category: 'prompt', title: 'Vague for an AI', message: msg, actual: m[0], replacements: [], ruleId: 'vague:' + m[0].toLowerCase() })
    }
  }
  return out
}

/**
 * Offline prompt scaffold: wraps the user's text in a structured prompt and
 * adds placeholders only for the parts the analysis found missing.
 */
export function buildPromptTemplate(text: string, report: PromptReport): string {
  const missing = new Set(report.checks.filter((c) => !c.ok).map((c) => c.key))
  const body = text.trim()
  const parts: string[] = []

  if (missing.has('role')) parts.push('# Role\nYou are an expert [DOMAIN, e.g. technical writer / senior developer / marketing strategist]. Work carefully and ask a clarifying question if anything below is ambiguous.')

  parts.push('# Task\n' + (missing.has('task') ? '[Start with the action you want: Write / Explain / Compare / Fix …]\n\n' : '') + body)

  if (missing.has('context')) parts.push('# Context\n- Who this is for: [AUDIENCE]\n- Why I need it: [GOAL]\n- What I already have or tried: [BACKGROUND]')

  if (missing.has('constraints')) parts.push('# Requirements\n- Tone: [formal / friendly / neutral]\n- Length: [e.g. under 300 words]\n- Must include: [KEY POINTS]\n- Avoid: [JARGON / TOPICS / ASSUMPTIONS]')

  if (missing.has('format')) parts.push('# Output format\n[e.g. Markdown with headings and bullet points / a numbered list of steps / a table with columns X, Y, Z / JSON matching { ... }]')

  if (missing.has('examples')) parts.push('# Example of what I like\n[Paste a short example of the kind of answer you want, or delete this section]')

  if (missing.has('criteria')) parts.push('# Success criteria\n- [How I will judge the result, e.g. "a non-expert can follow it", "it compiles and passes the tests"]')

  return parts.join('\n\n') + '\n'
}
