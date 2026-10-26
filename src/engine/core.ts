// Platform-neutral grammar engine. Used by the browser Web Worker, the Node
// CLI / Claude Code hook / MCP server, and the Electron main process.
import { unified } from 'unified'
import retextEnglish from 'retext-english'
import retextSpell from 'retext-spell'
import retextRepeatedWords from 'retext-repeated-words'
import retextIndefiniteArticle from 'retext-indefinite-article'
import retextPassive from 'retext-passive'
import retextReadability from 'retext-readability'
import retextSentenceSpacing from 'retext-sentence-spacing'
import retextRedundantAcronyms from 'retext-redundant-acronyms'
import retextContractions from 'retext-contractions'
import retextEquality from 'retext-equality'
import retextSyntaxUrls from 'retext-syntax-urls'
import retextSyntaxMentions from 'retext-syntax-mentions'
import { VFile } from 'vfile'
import { visit } from 'unist-util-visit'
import { toString } from 'nlcst-to-string'
import type { CheckOptions, DocStats, Issue, PromptReport, Tone } from '../types'
import { runRules, type RawIssue } from './rules'
import { analyzePrompt, vagueWordIssues } from './prompt'
import { computeStats, detectTone } from './stats'
import { rankSuggestions } from './suggest'
import { TECH_WORDS } from './tech-words'

export interface Dictionary { aff: string; dic: string }

export interface CheckResult {
  issues: Issue[]
  stats: DocStats
  tone: Tone
  prompt: PromptReport | null
}

export interface Checker {
  check(text: string, options: CheckOptions): Promise<CheckResult>
}

export const DEFAULT_CHECK_OPTIONS: CheckOptions = {
  mode: 'writing', passive: true, readability: true, wordiness: true, equality: true, profanity: false, personal: [],
}

function clean(reason: string): string {
  return reason.replace(/`([^`]*)`/g, '“$1”')
}

function mapMessage(source: string, msg: any, text: string, start: number, end: number): RawIssue | null {
  const actual: string = typeof msg.actual === 'string' ? msg.actual : text.slice(start, end)
  const expected: string[] = Array.isArray(msg.expected) ? msg.expected.filter((e: unknown) => typeof e === 'string') : []
  const base = { start, end, actual, replacements: expected, ruleId: `${source}:${msg.ruleId ?? ''}` }
  switch (source) {
    case 'retext-spell': {
      const ranked = rankSuggestions(actual, expected)
      return { ...base, replacements: ranked, category: 'correctness', title: 'Spelling', message: ranked.length ? `“${actual}” looks misspelled.` : `“${actual}” is not in the dictionary.` }
    }
    case 'retext-repeated-words':
      return { ...base, category: 'correctness', title: 'Repeated word', message: 'This word appears twice in a row. Remove one occurrence.' }
    case 'retext-indefinite-article':
      return { ...base, category: 'correctness', title: 'Article', message: expected[0] ? `Use “${expected[0]}” here instead of “${actual}”.` : clean(msg.reason) }
    case 'retext-sentence-spacing':
      return { ...base, category: 'correctness', title: 'Spacing', message: 'Use a single space between sentences.' }
    case 'retext-redundant-acronyms':
      return { ...base, category: 'correctness', title: 'Redundancy', message: clean(msg.reason) }
    case 'retext-contractions':
      return { ...base, category: 'correctness', title: 'Apostrophe', message: expected[0] ? `Did you mean “${expected[0]}”?` : clean(msg.reason) }
    case 'retext-passive':
      return { ...base, replacements: [], category: 'clarity', title: 'Passive voice', message: 'This sentence is in the passive voice. Consider rewriting it so the subject performs the action.' }
    case 'retext-readability':
      return { ...base, replacements: [], category: 'clarity', title: 'Hard to read', message: 'This sentence is hard to read. Try splitting it in two or using simpler words.' }
    case 'retext-equality':
      return { ...base, category: 'delivery', title: 'Inclusive language', message: clean(msg.reason) }
    default:
      return { ...base, category: 'correctness', title: 'Grammar', message: clean(msg.reason ?? 'Possible issue.') }
  }
}

const PRIORITY: Record<string, number> = { rules: 3, 'retext-equality': 2, 'retext-spell': 1 }

function dedupe(items: Array<RawIssue & { prio: number }>): RawIssue[] {
  items.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Array<RawIssue & { prio: number }> = []
  for (const it of items) {
    let drop = false
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i]
      if (k.end <= it.start) break
      if (k.start < it.end && it.start < k.end) {
        const sameKind = k.category === it.category || k.category === 'correctness' || it.category === 'correctness'
        if (!sameKind) continue
        if (it.prio > k.prio || (it.prio === k.prio && it.end - it.start > k.end - k.start)) {
          kept.splice(i, 1)
        } else {
          drop = true
          break
        }
      }
    }
    if (!drop) kept.push(it)
  }
  return kept.map(({ prio: _p, ...rest }) => rest)
}

export function createChecker(dictionary: Dictionary): Checker {
  const processors = new Map<string, any>()

  function getProcessor(options: CheckOptions) {
    const key = [options.passive, options.readability, options.equality, options.personal.join('|')].join('/')
    const cached = processors.get(key)
    if (cached) return cached
    // nspell accepts strings for aff/dic; retext-spell's TypeScript type says Uint8Array, so cast.
    const dict = dictionary as unknown as { aff: Uint8Array; dic: Uint8Array }
    let proc: any = unified()
      .use(retextEnglish)
      .use(retextSyntaxUrls)
      .use(retextSyntaxMentions)
      .use(retextSpell, { dictionary: dict, personal: [...TECH_WORDS, ...options.personal].join('\n'), max: 60 })
      .use(retextRepeatedWords)
      .use(retextIndefiniteArticle)
      .use(retextSentenceSpacing)
      .use(retextRedundantAcronyms)
      .use(retextContractions, { straight: true })
    if (options.passive) proc = proc.use(retextPassive)
    if (options.readability) proc = proc.use(retextReadability, { age: 18, minWords: 8 })
    if (options.equality) proc = proc.use(retextEquality)
    proc = proc.freeze()
    if (processors.size >= 3) processors.delete(processors.keys().next().value as string)
    processors.set(key, proc)
    return proc
  }

  async function check(text: string, options: CheckOptions): Promise<CheckResult> {
    const proc = getProcessor(options)
    const tree = proc.parse(text)
    const file = new VFile({ value: text })
    await proc.run(tree, file)

    const words: string[] = []
    let sentences = 0
    visit(tree, (node: any) => {
      if (node.type === 'SentenceNode') sentences++
      else if (node.type === 'WordNode') words.push(toString(node))
    })

    const raw: Array<RawIssue & { prio: number }> = []
    for (const msg of file.messages as any[]) {
      const place = msg.place
      if (!place || !('start' in place)) continue
      const start = place.start?.offset
      const end = place.end?.offset
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue
      const source = String(msg.source ?? '')
      const mapped = mapMessage(source, msg, text, start, end)
      if (mapped) raw.push({ ...mapped, prio: PRIORITY[source] ?? 1 })
    }
    for (const r of runRules(text, { wordiness: options.wordiness, profanity: options.profanity })) raw.push({ ...r, prio: PRIORITY.rules })

    let prompt: PromptReport | null = null
    if (options.mode === 'prompt') {
      prompt = analyzePrompt(text)
      for (const r of vagueWordIssues(text)) raw.push({ ...r, prio: 2 })
    }

    const issues: Issue[] = dedupe(raw).map((r, i) => ({ ...r, id: `${r.ruleId}@${r.start}-${r.end}#${i}`, source: 'local' }))
    return { issues, stats: computeStats(text, words, sentences), tone: detectTone(text, words.length), prompt }
  }

  return { check }
}
