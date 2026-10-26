export type Category = 'correctness' | 'clarity' | 'engagement' | 'delivery' | 'prompt'

export type Mode = 'writing' | 'prompt'

export interface Issue {
  id: string
  start: number
  end: number
  category: Category
  /** Short title shown on the card, e.g. "Spelling" */
  title: string
  /** Full explanation */
  message: string
  /** The flagged text */
  actual: string
  /** Replacement candidates (may be empty for advice-only issues) */
  replacements: string[]
  ruleId: string
  source: 'local' | 'cloud'
}

export interface DocStats {
  words: number
  characters: number
  sentences: number
  paragraphs: number
  uniqueWords: number
  avgSentenceLength: number
  readingTimeMin: number
  speakingTimeMin: number
  fleschEase: number
  gradeLevel: number
  readabilityLabel: string
}

export interface Tone {
  formality: 'formal' | 'neutral' | 'casual'
  confidence: 'confident' | 'neutral' | 'tentative'
  friendly: boolean
}

export interface PromptCheck {
  key: string
  label: string
  ok: boolean
  hint: string
}

export interface PromptReport {
  checks: PromptCheck[]
  /** 0..100 */
  score: number
}

export interface CheckOptions {
  mode: Mode
  passive: boolean
  readability: boolean
  wordiness: boolean
  equality: boolean
  profanity: boolean
  /** Personal dictionary words, one per entry */
  personal: string[]
}

export interface Settings extends CheckOptions {
  cloud: boolean
  language: 'en-US' | 'en-GB' | 'en-AU' | 'en-CA'
  aiKey: string
  aiModel: string
}

export type WorkerRequest =
  | { type: 'init'; affUrl: string; dicUrl: string }
  | { type: 'check'; id: number; text: string; options: CheckOptions }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; issues: Issue[]; stats: DocStats; tone: Tone; prompt: PromptReport | null }
  | { type: 'error'; id?: number; message: string }
