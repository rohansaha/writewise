// Entry point for the Google Docs sidebar bundle. Vite wraps these exports in an
// IIFE and exposes them as window.WriteWiseEngine; the sidebar HTML inlines the
// result together with the dictionary, so no file is fetched at run time.
export { createChecker, DEFAULT_CHECK_OPTIONS } from '../../src/engine/core'
export type { Checker, CheckResult, Dictionary } from '../../src/engine/core'
export { autoFix, isSafeFix } from '../../src/engine/autofix'
export { analyzePrompt, buildPromptTemplate } from '../../src/engine/prompt'
export type { Issue, CheckOptions, Mode, PromptReport } from '../../src/types'
