import type { DocStats, Tone } from '../types'

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return 0
  if (w.length <= 3) return 1
  let s = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
  const groups = s.match(/[aeiouy]{1,2}/g)
  let n = groups ? groups.length : 1
  if (/le$/.test(w) && !/[aeiouy]le$/.test(w)) n++ // "table", "little"
  return Math.max(1, n)
}

function readabilityLabel(score: number): string {
  if (score >= 90) return 'Very easy'
  if (score >= 80) return 'Easy'
  if (score >= 70) return 'Fairly easy'
  if (score >= 60) return 'Standard'
  if (score >= 50) return 'Fairly difficult'
  if (score >= 30) return 'Difficult'
  return 'Very difficult'
}

export function computeStats(text: string, words: string[], sentences: number): DocStats {
  const wordCount = words.length
  const sentenceCount = Math.max(sentences, wordCount > 0 ? 1 : 0)
  const paragraphs = text.split(/\n[^\S\n]*\n/).filter((p) => p.trim().length > 0).length
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0)
  const wps = wordCount / Math.max(1, sentenceCount)
  const spw = syllables / Math.max(1, wordCount)
  const flesch = wordCount === 0 ? 0 : 206.835 - 1.015 * wps - 84.6 * spw
  const grade = wordCount === 0 ? 0 : 0.39 * wps + 11.8 * spw - 15.59
  const unique = new Set(words.map((w) => w.toLowerCase())).size
  return {
    words: wordCount,
    characters: text.length,
    sentences: wordCount === 0 ? 0 : sentenceCount,
    paragraphs,
    uniqueWords: unique,
    avgSentenceLength: wordCount === 0 ? 0 : Math.round(wps * 10) / 10,
    readingTimeMin: wordCount / 225,
    speakingTimeMin: wordCount / 140,
    fleschEase: Math.round(Math.max(0, Math.min(100, flesch))),
    gradeLevel: Math.max(0, Math.round(grade * 10) / 10),
    readabilityLabel: wordCount === 0 ? '—' : readabilityLabel(flesch),
  }
}

const FORMAL = /\b(therefore|however|furthermore|moreover|regarding|hence|accordingly|consequently|pursuant|whereas|notwithstanding|nevertheless|in accordance with|sincerely|kindly|please find|attached|hereby|thus)\b/gi
const CASUAL = /\b(gonna|wanna|gotta|kinda|sorta|lol|lmao|omg|btw|yeah|yep|nope|cool|awesome|super|stuff|guys|hey|hi there|ya|dude|folks|totally|crazy|whatever)\b/gi
const HEDGE = /\b(i think|i guess|maybe|perhaps|probably|possibly|might|sort of|kind of|somewhat|i'm not sure|not sure|seems|apparently|i believe|i feel like)\b/gi
const ASSERT = /\b(will|must|certainly|definitely|clearly|always|never|guarantee|absolutely|without doubt|we recommend|the answer is|is|are)\b/gi
const FRIENDLY = /\b(thanks|thank you|appreciate|happy to|glad|great to|love|welcome|please|cheers|looking forward|hope you|have a (great|good|nice))\b/gi

function count(re: RegExp, text: string): number {
  re.lastIndex = 0
  const m = text.match(re)
  return m ? m.length : 0
}

export function detectTone(text: string, wordCount: number): Tone {
  const per100 = (n: number) => (n / Math.max(wordCount, 40)) * 100
  const contractions = count(/\b\w+'(t|re|ll|ve|d|m|s)\b/gi, text)
  const exclaims = count(/!/g, text)
  const formalScore = per100(count(FORMAL, text)) * 2 - per100(count(CASUAL, text)) * 2 - per100(contractions) * 0.6 - per100(exclaims)
  const formality: Tone['formality'] = formalScore > 1.2 ? 'formal' : formalScore < -1.2 ? 'casual' : 'neutral'

  const hedges = per100(count(HEDGE, text))
  const asserts = per100(count(ASSERT, text))
  const confidence: Tone['confidence'] = hedges >= 2 && hedges > asserts * 0.25 ? 'tentative' : hedges === 0 && asserts >= 2 ? 'confident' : 'neutral'

  const friendly = per100(count(FRIENDLY, text)) >= 1.5 || (exclaims >= 2 && formality !== 'formal')
  return { formality, confidence, friendly }
}
