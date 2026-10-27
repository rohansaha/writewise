// Applies the fixes that are safe to make without asking: punctuation and
// spacing slips, capitalization, repeated words, misused phrases, confusable
// words, and spelling corrections that are one edit away from the typed word.
import type { Issue } from '../types'
import { editDistance, isCommon, knownTypo } from './suggest'

export interface AutoFixResult {
  text: string
  applied: Issue[]
  /** Issues that were left for a human to decide. */
  remaining: Issue[]
  /** The exact edits that were applied, in document order (offsets refer to the original text). */
  edits: Array<{ start: number; end: number; replacement: string }>
}

export function isSafeFix(issue: Issue): string | null {
  if (issue.category !== 'correctness') return null
  const rep = issue.replacements[0]
  if (rep === undefined) return null
  if (issue.ruleId.startsWith('retext-spell:') || issue.ruleId.startsWith('cloud:MORFOLOGIK')) {
    if (!rep) return null
    // Acronyms, codes and anything with a digit ("DMG", "B2B", "v2") are not typos: never rewrite them.
    if (/^[A-Z][A-Z0-9]+$/.test(issue.actual) || /\d/.test(issue.actual)) return null
    const typo = knownTypo(issue.actual)
    if (typo) return typo
    // Never turn a lowercase word into a capitalized one ("repo" -> "Reno"): that is a proper noun, not a fix.
    const actualIsLower = issue.actual[0] === issue.actual[0].toLowerCase()
    const repIsCapitalized = rep[0] !== rep[0].toLowerCase()
    if (actualIsLower && repIsCapitalized) return null
    // Only auto-correct to a frequent word that is one edit away; rare words ("docent") stay as suggestions.
    const typed = issue.actual.toLowerCase()
    const close = (s: string) => s.length >= 3 && isCommon(s) && editDistance(typed, s.toLowerCase()) <= 1
    if (!close(rep)) return null
    // When several frequent words are one edit away ("shud" -> shed / shut / stud), picking one is a guess: leave it to the user.
    if (issue.replacements.some((s) => s.toLowerCase() !== rep.toLowerCase() && close(s))) return null
    return rep
  }
  if (issue.replacements.length !== 1) return null
  return rep
}

export function autoFix(text: string, issues: Issue[]): AutoFixResult {
  const candidates = issues
    .map((issue) => ({ issue, rep: isSafeFix(issue) }))
    .filter((c): c is { issue: Issue; rep: string } => c.rep !== null)
    .sort((a, b) => a.issue.start - b.issue.start)
  const applied: Issue[] = []
  const appliedIds = new Set<string>()
  let lastEnd = -1
  const edits: Array<{ start: number; end: number; rep: string }> = []
  for (const { issue, rep } of candidates) {
    if (issue.start < lastEnd) continue
    edits.push({ start: issue.start, end: issue.end, rep })
    applied.push(issue)
    appliedIds.add(issue.id)
    lastEnd = issue.end
  }
  let out = text
  for (const e of [...edits].reverse()) out = out.slice(0, e.start) + e.rep + out.slice(e.end)
  return { text: out, applied, remaining: issues.filter((i) => !appliedIds.has(i.id)), edits: edits.map((e) => ({ start: e.start, end: e.end, replacement: e.rep })) }
}
