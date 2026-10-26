// Runs the WriteWise engine inside the extension's background service worker
// (and inside the test harness page). Dictionary files ship with the extension.
import { createChecker, DEFAULT_CHECK_OPTIONS, type Checker } from '../../src/engine/core'
import { autoFix } from '../../src/engine/autofix'
import { analyzePrompt, buildPromptTemplate } from '../../src/engine/prompt'
import type { Issue, Mode } from '../../src/types'

export interface CheckRequest { type: 'check'; text: string; mode: Mode; personal?: string[] }
export interface CheckResponse {
  issues: Issue[]
  fixed: string
  edits: Array<{ start: number; end: number; replacement: string }>
  promptScore: number | null
  template?: string
}

let checkerPromise: Promise<Checker> | null = null

function assetUrl(p: string): string {
  const c = (globalThis as any).chrome
  if (c?.runtime?.getURL) return c.runtime.getURL(p)
  return new URL('/' + p, location.href).href
}

export function getChecker(): Promise<Checker> {
  checkerPromise ??= (async () => {
    const [aff, dic] = await Promise.all([
      fetch(assetUrl('dict/en-US.aff')).then((r) => r.text()),
      fetch(assetUrl('dict/en-US.dic')).then((r) => r.text()),
    ])
    return createChecker({ aff, dic })
  })()
  return checkerPromise
}

export async function handleCheck(req: CheckRequest): Promise<CheckResponse> {
  const checker = await getChecker()
  const options = { ...DEFAULT_CHECK_OPTIONS, mode: req.mode, personal: req.personal ?? [] }
  const result = await checker.check(req.text, options)
  const fx = autoFix(req.text, result.issues)
  const prompt = result.prompt ?? (req.mode === 'prompt' ? analyzePrompt(fx.text) : null)
  return {
    issues: result.issues,
    fixed: fx.text,
    edits: fx.edits,
    promptScore: prompt ? prompt.score : null,
    template: prompt ? buildPromptTemplate(fx.text, prompt) : undefined,
  }
}
