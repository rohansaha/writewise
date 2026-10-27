// Settings for the optional Claude feature of the extension. Kept apart from claude.ts so the
// popup can import them without pulling the Anthropic SDK into its bundle.
export interface ClaudeSettings { claudeEnabled: boolean; claudeKey: string; claudeModel: string }
/** Stored in chrome.storage.local only: the key is never synced between browsers. */
export const CLAUDE_DEFAULTS: ClaudeSettings = { claudeEnabled: false, claudeKey: '', claudeModel: 'claude-opus-5-5' }
export const CLAUDE_MODELS: Array<[string, string]> = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (best quality)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (fast)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)'],
]
/** The native-messaging host the desktop app registers (electron/native-host.cjs, cli/native-host.ts). */
export const NATIVE_HOST = 'app.writewise.desktop'
/** The extension's Chrome Web Store ID; an unpacked build gets another ID, which the desktop app must be told about. */
export const STORE_EXTENSION_ID = 'hmdpffagdonhmmgdcohmbkjcijiieicn'
export const MAX_CLAUDE_CHARS = 20000
