// Optional "cloud boost": LanguageTool's free public API. Only called when the
// user turns it on. Limits: ~20 requests/min, 20,000 characters/request.
import type { Category, Issue } from './types'

export const LT_ENDPOINT = 'https://api.languagetool.org/v2/check'
export const LT_MAX_CHARS = 20000

interface LtMatch {
  message: string
  shortMessage?: string
  offset: number
  length: number
  replacements: Array<{ value: string }>
  rule: { id: string; description?: string; issueType?: string; category: { id: string; name: string } }
}

function categorize(catId: string, issueType?: string): { category: Category; title: string } {
  switch (catId) {
    case 'TYPOS': return { category: 'correctness', title: 'Spelling' }
    case 'GRAMMAR': return { category: 'correctness', title: 'Grammar' }
    case 'PUNCTUATION': return { category: 'correctness', title: 'Punctuation' }
    case 'CASING': return { category: 'correctness', title: 'Capitalization' }
    case 'TYPOGRAPHY': return { category: 'correctness', title: 'Typography' }
    case 'CONFUSED_WORDS': return { category: 'correctness', title: 'Confused word' }
    case 'COMPOUNDING': return { category: 'correctness', title: 'Compound word' }
    case 'COLLOCATIONS': return { category: 'correctness', title: 'Word choice' }
    case 'NONSTANDARD_PHRASES': return { category: 'correctness', title: 'Phrase' }
    case 'SEMANTICS': return { category: 'correctness', title: 'Meaning' }
    case 'REDUNDANCY': return { category: 'clarity', title: 'Redundancy' }
    case 'WORDINESS': return { category: 'clarity', title: 'Wordiness' }
    case 'PLAIN_ENGLISH': return { category: 'clarity', title: 'Plain English' }
    case 'STYLE': return { category: 'clarity', title: 'Style' }
    case 'GENDER_NEUTRALITY': return { category: 'delivery', title: 'Inclusive language' }
    default:
      if (issueType === 'style') return { category: 'clarity', title: 'Style' }
      return { category: 'correctness', title: 'Grammar' }
  }
}

export async function checkWithLanguageTool(text: string, language: string, signal?: AbortSignal): Promise<Issue[]> {
  const slice = text.length > LT_MAX_CHARS ? text.slice(0, LT_MAX_CHARS) : text
  const body = new URLSearchParams({ text: slice, language, level: 'default' })
  const res = await fetch(LT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal })
  if (!res.ok) throw new Error(`LanguageTool ${res.status}`)
  const data = (await res.json()) as { matches: LtMatch[] }
  return data.matches
    .filter((m) => m.length > 0)
    .map((m, i) => {
      const { category, title } = categorize(m.rule.category.id, m.rule.issueType)
      return {
        id: `cloud:${m.rule.id}@${m.offset}-${m.offset + m.length}#${i}`,
        start: m.offset,
        end: m.offset + m.length,
        category,
        title,
        message: m.message,
        actual: slice.slice(m.offset, m.offset + m.length),
        replacements: m.replacements.slice(0, 5).map((r) => r.value),
        ruleId: `cloud:${m.rule.id}`,
        source: 'cloud' as const,
      }
    })
}
