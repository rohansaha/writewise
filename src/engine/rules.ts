// Hand-written rules that complement the retext plugins. They operate on the
// raw text with regular expressions so positions map 1:1 onto the editor.
import type { Category, Issue } from '../types'

export type RawIssue = Omit<Issue, 'id' | 'source'>

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co', 'no',
  'fig', 'approx', 'dept', 'est', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'a.m', 'p.m', 'u.s', 'u.k', 'ph.d', 'm.d', 'b.a', 'm.a',
])

/** Common misused phrases that a spell checker cannot catch. */
const PHRASES: Array<[RegExp, string, string]> = [
  [/\balot\b/gi, 'a lot', '"alot" is not a word.'],
  [/\b(could|should|would|must|might) of\b/gi, '$1 have', 'Use "have" after a modal verb, not "of".'],
  [/\birregardless\b/gi, 'regardless', '"Irregardless" is nonstandard.'],
  [/\bfor all intensive purposes\b/gi, 'for all intents and purposes', 'The idiom is "for all intents and purposes".'],
  [/\bi could care less\b/gi, "I couldn't care less", 'The intended meaning is "couldn\'t care less".'],
  [/\bon accident\b/gi, 'by accident', 'The standard phrase is "by accident".'],
  [/\bsneak peak\b/gi, 'sneak peek', 'A quick look is a "peek".'],
  [/\bper say\b/gi, 'per se', 'The Latin phrase is "per se".'],
  [/\bcase and point\b/gi, 'case in point', 'The idiom is "case in point".'],
  [/\bfirst come first serve\b/gi, 'first come, first served', 'The expression is "first come, first served".'],
  [/\bdeep seeded\b/gi, 'deep-seated', 'The expression is "deep-seated".'],
  [/\bhone in on\b/gi, 'home in on', 'To zero in on something is to "home in on" it.'],
  [/\bwreck havoc\b/gi, 'wreak havoc', 'The verb is "wreak".'],
  [/\bbaited breath\b/gi, 'bated breath', 'The expression is "bated breath".'],
  [/\bexpresso\b/gi, 'espresso', 'The coffee is "espresso".'],
  [/\bsupposably\b/gi, 'supposedly', '"Supposably" is nonstandard here.'],
  [/\bmore better\b/gi, 'better', 'Double comparative.'],
  [/\bmost best\b/gi, 'best', 'Double superlative.'],
  [/\bvery unique\b/gi, 'unique', '"Unique" is absolute and cannot be qualified.'],
  [/\b(the|an?) ATM machine\b/gi, '$1 ATM', 'ATM already stands for Automated Teller Machine.'],
  [/\bPIN number\b/g, 'PIN', 'PIN already stands for Personal Identification Number.'],
  [/\bend result\b/gi, 'result', '"End" is redundant.'],
  [/\bfree gift\b/gi, 'gift', 'A gift is free by definition.'],
  [/\badvance planning\b/gi, 'planning', 'Planning is done in advance by definition.'],
  [/\bpast history\b/gi, 'history', '"Past" is redundant.'],
  [/\bclose proximity\b/gi, 'proximity', 'Proximity already means closeness.'],
  [/\bthe reason is because\b/gi, 'the reason is that', 'Use "the reason is that" or just "because".'],
  // High-precision confusable words (context makes the intended word unambiguous).
  [/\btheir (are|is|was|were|will|would|has|have|had)\b/gi, 'there $1', '"Their" is possessive. Before a verb like "are" or "is", use "there".'],
  [/\bthere (own|house|car|way|job|name|time|team|work|home|family|friends|children|kids|lives|money|data|users|code|product|needs|goals|rights|parents|phones?|hands|eyes)\b/gi, 'their $1', '"There" is a place. Before a noun that someone owns, use "their".'],
  [/\byour (going to|not going|doing (?:great|well|fine|good|it|this|that)|being|the best|the one|so (?:good|kind|right|welcome|sweet)|a (?:star|genius|legend|hero|lifesaver))\b/gi, "you're $1", '"Your" is possessive. Here you need "you\'re" (you are).'],
  [/\byour (welcome|right|wrong|sure|kidding|joking|awesome|amazing|late|early|done|here|there)\b(?=\s*(?:[.!?,;:)]|\n|$))/gi, "you're $1", '"Your" is possessive. Here you need "you\'re" (you are).'],
  [/\bits (a|an|the|not|going|time to|been|too|very|really|so|just|also|about|important|possible|likely|only)\b/gi, "it's $1", '"Its" is possessive. Here you need "it\'s" (it is / it has).'],
  [/\bit's (own|way to|self)\b/gi, 'its $1', '"It\'s" means "it is". The possessive is "its".'],
  [/\bloose (weight|the|my|your|our|their|his|her|track|control|sight|interest|money|hope|faith|patience)\b/gi, 'lose $1', '"Loose" is the opposite of tight. The verb you want is "lose".'],
  [/\bthen (I|we|you|they|he|she|it) (would|should|could|will|can|might|must)\b/g, 'than $1 $2', 'For a comparison, use "than"; "then" refers to time.'],
  [/\b(better|worse|more|less|rather|other|higher|lower|bigger|smaller|faster|slower|easier|harder|later|earlier|sooner) then\b/gi, '$1 than', 'For a comparison, use "than"; "then" refers to time.'],
  [/\bshould of (been|done|gone|had|known|seen|said|made)\b/gi, 'should have $1', 'Use "have" after "should", not "of".'],
  [/\beffect (the|our|your|my|their|his|her|its|how|what|people|us|them)\b/gi, 'affect $1', '"Affect" is the verb (to influence); "effect" is the noun.'],
  [/\ban affect on\b/gi, 'an effect on', '"Effect" is the noun; "affect" is the verb.'],
  [/\bwho's (name|car|house|idea|turn|fault|job|responsibility|book|phone)\b/gi, 'whose $1', '"Who\'s" means "who is". The possessive is "whose".'],
  [/\bmust of\b/gi, 'must have', 'Use "have" after "must", not "of".'],
  [/\bless (people|items|things|words|errors|problems|options|cars|students|employees|users|hours|days|minutes|times)\b/gi, 'fewer $1', 'Use "fewer" for things you can count.'],
  [/\bamount of (people|items|things|words|errors|problems|options|students|employees|users)\b/gi, 'number of $1', 'Use "number of" for things you can count.'],
]

/** Wordy phrases with crisper alternatives (Clarity). */
const WORDY: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bat the present time\b/gi, 'now'],
  [/\bin the event that\b/gi, 'if'],
  [/\bin the near future\b/gi, 'soon'],
  [/\ba large number of\b/gi, 'many'],
  [/\ba majority of\b/gi, 'most'],
  [/\bthe majority of\b/gi, 'most'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bwith respect to\b/gi, 'about'],
  [/\bin regards to\b/gi, 'regarding'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin close proximity to\b/gi, 'near'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bis able to\b/gi, 'can'],
  [/\bare able to\b/gi, 'can'],
  [/\bit is important to note that\b/gi, ''],
  [/\bit should be noted that\b/gi, ''],
  [/\bneedless to say,?\b/gi, ''],
  [/\bas a matter of fact\b/gi, 'in fact'],
  [/\bon a daily basis\b/gi, 'daily'],
  [/\bon a regular basis\b/gi, 'regularly'],
  [/\bin a timely manner\b/gi, 'promptly'],
  [/\butili[sz]e\b/gi, 'use'],
  [/\butili[sz]ation\b/gi, 'use'],
  [/\bcommence\b/gi, 'begin'],
  [/\bendeavou?r to\b/gi, 'try to'],
  [/\bin conjunction with\b/gi, 'with'],
  [/\bin the absence of\b/gi, 'without'],
  [/\bby means of\b/gi, 'by'],
  [/\bwhether or not\b/gi, 'whether'],
  [/\beach and every\b/gi, 'every'],
  [/\bfirst and foremost\b/gi, 'first'],
  [/\bbasic fundamentals\b/gi, 'fundamentals'],
  [/\bcompletely eliminate\b/gi, 'eliminate'],
  [/\bbrief summary\b/gi, 'summary'],
  [/\bfinal outcome\b/gi, 'outcome'],
  [/\bunexpected surprise\b/gi, 'surprise'],
]

/** Weak intensifiers and fillers (Engagement). */
const WEAK: Array<[RegExp, string]> = [
  [/\bvery\b/gi, 'This intensifier adds little. Consider a stronger word instead.'],
  [/\breally\b/gi, 'This intensifier adds little. Consider a stronger word instead.'],
  [/\bextremely\b/gi, 'Consider a more precise word than "extremely".'],
  [/\bbasically\b/gi, 'Filler word. It can usually be removed.'],
  [/\bactually\b/gi, 'Filler word. It can usually be removed.'],
  [/\bliterally\b/gi, 'Often used for emphasis only. Consider removing it.'],
  [/\btotally\b/gi, 'Vague intensifier. Consider removing it.'],
  [/\bdefinitely\b/gi, 'Vague intensifier. Consider removing it.'],
  [/\bquite\b/gi, '"Quite" is vague. Consider a more specific word.'],
]

/** Hedging phrases that undercut confidence (Delivery). */
const HEDGES: RegExp[] = [
  /\bI think that\b/g,
  /\bI think\b/g,
  /\bI believe that\b/g,
  /\bI feel like\b/g,
  /\bI guess\b/g,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
  /\bin my opinion\b/gi,
  /\bit seems like\b/gi,
  /\bto be honest\b/gi,
]

const PROFANITY: RegExp[] = [
  /\b(fuck\w*|shit\w*|bullshit|asshole|bitch\w*|damn|crap|bastard|piss\w*|wtf|stfu)\b/gi,
]

function push(out: RawIssue[], start: number, end: number, category: Category, title: string, message: string, actual: string, replacements: string[], ruleId: string) {
  if (end <= start) return
  out.push({ start, end, category, title, message, actual, replacements, ruleId })
}

function isAbbreviationBefore(text: string, periodIndex: number): boolean {
  let i = periodIndex - 1
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) i--
  const word = text.slice(i + 1, periodIndex).toLowerCase()
  if (!word) return false
  if (word.length === 1) return true // initials: "J. Smith"
  return ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\.$/, ''))
}

export interface RuleOptions {
  wordiness: boolean
  profanity: boolean
}

export function runRules(text: string, options: RuleOptions): RawIssue[] {
  const out: RawIssue[] = []
  let m: RegExpExecArray | null

  // 1. Sentence-initial capitalization.
  const sentenceStart = /(^|[.!?]["')\]]?[^\S\n]+|\n[^\S\n]*\n[^\S\n]*|^[^\S\n]*)([a-z])(?=[a-z']*\b)/gm
  while ((m = sentenceStart.exec(text))) {
    const prefix = m[1]
    const letterIndex = m.index + prefix.length
    if (prefix[0] === '.' && isAbbreviationBefore(text, m.index)) continue
    const wordMatch = /^[a-z][a-z']*/.exec(text.slice(letterIndex))
    if (!wordMatch) continue
    const word = wordMatch[0]
    const after = text[letterIndex + word.length]
    if (after === '.' && /[a-z]/.test(text[letterIndex + word.length + 1] ?? '')) continue // domain or module path
    if (after === '/' || after === ':' || after === '@') continue // url, time, email
    push(out, letterIndex, letterIndex + word.length, 'correctness', 'Capitalization',
      'Sentences should start with a capital letter.', word, [word[0].toUpperCase() + word.slice(1)], 'sentence-capitalization')
  }

  // 2. Lowercase standalone "i".
  const lowerI = /(^|[\s("'])i(?=[\s,.!?;:'")]|$)/gm
  while ((m = lowerI.exec(text))) {
    const idx = m.index + m[1].length
    push(out, idx, idx + 1, 'correctness', 'Capitalization', 'The pronoun "I" is always capitalized.', 'i', ['I'], 'pronoun-i')
  }

  // 3. Doubled spaces inside a sentence (spacing after a sentence end is handled by retext-sentence-spacing).
  const doubleSpace = /[^\S\n]{2,}/g
  while ((m = doubleSpace.exec(text))) {
    const before = text[m.index - 1]
    if (m.index === 0 || before === '\n' || before === undefined) continue // indentation
    if (/[.!?]/.test(before)) continue
    push(out, m.index, m.index + m[0].length, 'correctness', 'Spacing', 'Use a single space between words.', m[0], [' '], 'double-space')
  }

  // 4. Space before punctuation: "word ," / "word ."
  const spaceBeforePunct = /(\S)([^\S\n]+)([,.;:!?])(?=\s|$)/g
  while ((m = spaceBeforePunct.exec(text))) {
    const start = m.index + 1
    const end = start + m[2].length + 1
    if (m[3] === '.' && text[end] === '.') continue
    if (/[-*\d]/.test(m[1]) && m[3] === '.') continue // list markers like "1 ." are rare; "- ." skip
    push(out, start, end, 'correctness', 'Punctuation', 'Remove the space before the punctuation mark.', m[2] + m[3], [m[3]], 'space-before-punctuation')
  }

  // 5. Missing space after a comma between letters: "word,word" (not numbers like 1,000).
  const commaNoSpace = /([A-Za-z]),([A-Za-z])/g
  while ((m = commaNoSpace.exec(text))) {
    const idx = m.index + 1
    push(out, idx, idx + 1, 'correctness', 'Punctuation', 'Add a space after the comma.', ',', [', '], 'comma-space')
  }

  // 6. Missing space after a period when the next sentence starts with a capital: "end.Start"
  const periodNoSpace = /([a-z]{2,})\.([A-Z][a-z]+)/g
  while ((m = periodNoSpace.exec(text))) {
    const idx = m.index + m[1].length
    push(out, idx, idx + 1, 'correctness', 'Punctuation', 'Add a space after the period.', '.', ['. '], 'period-space')
  }

  // 7. Repeated punctuation ",," or ";;"
  const doublePunct = /([,;:])\1+/g
  while ((m = doublePunct.exec(text))) {
    push(out, m.index, m.index + m[0].length, 'correctness', 'Punctuation', 'Repeated punctuation mark.', m[0], [m[1]], 'double-punctuation')
  }

  // 8. Misused phrases.
  for (const [re, replacement, why] of PHRASES) {
    re.lastIndex = 0
    while ((m = re.exec(text))) {
      const fix = m[0].replace(re, replacement)
      re.lastIndex = m.index + m[0].length
      push(out, m.index, m.index + m[0].length, 'correctness', 'Word choice', why, m[0], [fix], 'phrase:' + replacement)
    }
  }

  if (options.wordiness) {
    for (const [re, replacement] of WORDY) {
      re.lastIndex = 0
      while ((m = re.exec(text))) {
        const msg = replacement
          ? `Wordy phrase. "${replacement}" says the same thing more directly.`
          : 'This phrase adds length without meaning. Consider removing it.'
        push(out, m.index, m.index + m[0].length, 'clarity', 'Wordiness', msg, m[0], [replacement], 'wordy:' + m[0].toLowerCase())
      }
    }
    for (const [re, msg] of WEAK) {
      re.lastIndex = 0
      while ((m = re.exec(text))) {
        push(out, m.index, m.index + m[0].length, 'engagement', 'Weak word', msg, m[0], [''], 'weak:' + m[0].toLowerCase())
      }
    }
    for (const re of HEDGES) {
      re.lastIndex = 0
      while ((m = re.exec(text))) {
        push(out, m.index, m.index + m[0].length, 'delivery', 'Hedging', 'This phrase sounds uncertain. Removing it makes the statement more confident.', m[0], [''], 'hedge:' + m[0].toLowerCase())
      }
    }
  }

  if (options.profanity) {
    for (const re of PROFANITY) {
      re.lastIndex = 0
      while ((m = re.exec(text))) {
        push(out, m.index, m.index + m[0].length, 'delivery', 'Profanity', 'This word may come across as offensive in most contexts.', m[0], [], 'profanity')
      }
    }
  }

  return out
}
