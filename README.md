# WriteWise

An offline-first writing assistant in the spirit of Grammarly: it underlines spelling, grammar, punctuation, clarity, engagement and delivery issues as you type, explains each one, and fixes it in one click. It also has an **AI prompt mode** that scores text you plan to give to an AI (Claude, ChatGPT, etc.) and turns rough notes into a detailed, well-structured prompt.

Everything runs on your device. Nothing leaves your computer unless you switch on one of the two optional online features.

## Features

- **Writing mode** — real-time checks with colored wavy underlines, click-to-fix cards, "Accept all safe fixes", an overall score (0-100), tone detection (formal/casual, confident/tentative, friendly) and document statistics (reading time, readability, grade level, …).
- **AI prompt mode** — a 7-point prompt checklist (clear task, context, role/audience, output format, constraints, examples, success criteria), vague-wording warnings, and one-click conversion into a detailed prompt (offline template, or Claude-powered with your own key).
- **Cloud boost (optional)** — sends text to the free LanguageTool.org API for stronger grammar detection. Off by default.
- **AI rewrite (optional)** — "Improve", "Fix grammar", "Shorten", "Make formal/casual", "Sound confident", "Simplify", or a custom instruction, powered by the Claude API using **your own Anthropic API key** (stored only on your device).
- **Works everywhere** — a desktop app for macOS, Windows and Linux, or an installable web app (PWA) that works offline once loaded.
- **Browser extension** — grammar fixes and auto-correct in any text box on any site, including AI chat composers (Chrome/Edge/Brave).
- **Inside Claude** — a Claude Code hook that proofreads every prompt automatically, an MCP server for Claude Desktop, and, on macOS, Grammarly-style underlines plus an in-place fix hotkey inside any app, including Claude's chat box.
- Personal dictionary, dismiss-and-forget, keyboard shortcuts (⌘/Ctrl+S save, ⌘/Ctrl+O open, ⌘/Ctrl+N new), autosave, light/dark theme.

## Quick start (development)

```bash
npm install
npm run dev          # web app at http://localhost:5173
```

## Build the desktop app

```bash
npm run icons        # once: rasterize the icon
npm run dist         # builds the installer for the OS you are on into release/
```

- macOS → `release/WriteWise-<version>-mac-arm64.dmg` (and x64, and .zip)
- Windows → `release/WriteWise-<version>-win-x64.exe` (installer and portable)
- Linux → `release/WriteWise-<version>-linux-x86_64.AppImage` and `.deb`

Each OS must be built on that OS (electron-builder limitation). The included GitHub Actions workflow (`.github/workflows/release.yml`) builds all three when you push a tag like `v0.1.0` and attaches the files to a GitHub release, so you can download the app from anywhere.

The builds are unsigned. On macOS the first launch needs **right-click → Open** (or `xattr -d com.apple.quarantine WriteWise.app`); on Windows click **More info → Run anyway** in SmartScreen.

If `npm install` printed a warning that install scripts were blocked (newer npm versions do this), run `node node_modules/electron/install.js` once before `npm run dist`.

### Keep the Accessibility grant across rebuilds (macOS)

The desktop app is not signed with an Apple Developer ID, so by default every build gets a new code identity and macOS forgets the Accessibility permission you granted to the previous one (System Settings still shows the switch on, but the new build is refused; `tccutil reset Accessibility app.writewise.desktop` clears the stale entries so the app prompts again). To make the identity stable, create a local code-signing certificate once; `npm run dist:mac` then signs every build with it automatically (see `scripts/sign-mac.cjs`).

```bash
# 1. a self-signed certificate valid for code signing (10 years)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=WriteWise Local Signing" -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=codeSigning" -addext "basicConstraints=CA:false"
openssl pkcs12 -export -inkey key.pem -in cert.pem -out writewise-signing.p12 -passout pass:writewise-local -name "WriteWise Local Signing"
# 2. put it in your login keychain and let codesign use it
security import writewise-signing.p12 -k ~/Library/Keychains/login.keychain-db -P writewise-local -T /usr/bin/codesign -T /usr/bin/security
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
security find-identity -v -p codesigning   # should list "WriteWise Local Signing"
```

After that, build and install as usual, allow WriteWise under Accessibility one more time, and the grant survives future builds. `codesign -d -r- /Applications/WriteWise.app` shows the identity it is tied to. Keep the `.p12` and `key.pem` private and out of the repository.

## Deploy as a web app (PWA)

```bash
npm run build        # static site in dist/
```

Upload `dist/` to any static host (Vercel, Netlify, GitHub Pages, S3, …). Visitors can "Install app" from their browser on desktop and mobile; after the first load it works offline.

## Use it inside Claude

The same engine ships as a command-line tool (`bin/writewise.mjs`, built by `npm run build:cli`) with three integrations.

### 1. Claude Code: proofread every prompt automatically

```bash
npm run install:claude-code
```

This registers a `UserPromptSubmit` hook in `~/.claude/settings.json` and the MCP server with the `claude` CLI. From then on, every prompt you submit in Claude Code is checked before Claude sees it. When something was fixed, Claude receives a context block like:

```
[WriteWise prompt assist]
Corrected version of the user's message (3 spelling/grammar fixes applied automatically; treat this as what the user meant):
"""
Please refactor the login flow so it doesn't crash when the token is expired
"""
Vague wording to interpret carefully or ask about: "stuff".
```

For longer prompts that leave out context, output format, constraints or success criteria, it also asks Claude to pose one short clarifying question when that would change the result. Hooks cannot rewrite the prompt itself (Claude Code only lets them add context), so the original stays in your transcript and Claude works from the corrected version. Slash commands, `!` shell lines, pasted code and very long inputs are left alone. Set `WRITEWISE_HOOK_NUDGE=0` in the hook's environment to keep the corrections but drop the clarifying-question nudge. Remove everything with `npm run uninstall:claude-code`.

Keep the project in a permanent folder before installing: the hook points at the absolute path of `bin/writewise.mjs`.

### 2. Claude Desktop / claude.ai: an MCP tool Claude can call

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config; on macOS the file is `~/Library/Application Support/Claude/claude_desktop_config.json`), then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "writewise": { "command": "node", "args": ["/absolute/path/to/bin/writewise.mjs", "mcp"] }
  }
}
```

Tools exposed: `proofread_text`, `analyze_prompt` (prompt score, missing elements, vague words, structured version) and `check_text`. To make Claude use it on every message, add a line to your profile preferences or project instructions such as: *"Before answering, call writewise's `analyze_prompt` on my message and work from the corrected, structured version."*

### 3. Any app, including Claude's chat box: underlines and in-place fixes (macOS)

With the desktop app running on macOS, WriteWise works inside other apps the way Grammarly does, through the macOS Accessibility API:

- **Sentence suggestions as you type.** Pause for a moment in any text box (Claude, Slack, Mail, Chrome, a native text view) and each sentence with a problem is highlighted in place, with the flagged words underlined inside it. Click the sentence for a card that shows the corrected sentence as a whole (changes marked) and applies it with one click; findings without a fix (passive voice, hard to read) are listed as notes. With an Anthropic API key in Settings, the card leads with Claude's correction: as soon as it opens, Claude corrects the sentence using the whole message as context, so "their/there", tense and agreement are judged in context, and **Fix sentence** applies that version (the offline fix stays one click away). Each sentence is sent once; nothing is sent until you open its card. **Dismiss** hides that sentence's suggestions. Turn the feature off or on under **Tools → Underline suggestions in other apps**.
- **⌘⇧G** fixes the text box that has focus, in place, keeping your caret where it was. Select part of the text first to fix only that part. **⌘⇧P** rewrites the box (or the selection) into a structured AI prompt with `[placeholders]` for whatever is missing.

The first time, macOS asks you to allow WriteWise under **System Settings → Privacy & Security → Accessibility**; nothing works in other apps until that switch is on (the Tools menu has a shortcut to it). Password fields are never read or changed, and everything runs offline. Where no text box has focus, or on Windows and Linux, both hotkeys fall back to fixing the clipboard: copy, press the hotkey, paste.

### Command line

```bash
node bin/writewise.mjs fix notes.txt            # corrected text
node bin/writewise.mjs fix --prompt < draft.md  # corrected text wrapped as a structured prompt
node bin/writewise.mjs check --prompt draft.md  # every suggestion with line:column
```

## Browser extension (Chrome, Edge, Brave, Arc)

The same engine runs as a free browser extension that works in any text box on any site, including the message box on claude.ai, chatgpt.com and gemini.google.com:

- a badge on the focused text box shows the number of suggestions; click it for one-click fixes, "Fix all" and "Make it a prompt";
- on AI chat sites, safe fixes are applied automatically as you type (autocorrect-style, never on the word you are still typing); switch it on for any other site from the popup;
- the popup has a paste-to-fix box;
- no network requests, no account, nothing leaves the browser.

```bash
npm run build:ext     # builds extension-dist/
npm run pack:ext      # zips it into release/ for the Chrome Web Store
```

Try it now: `chrome://extensions` → Developer mode → Load unpacked → choose `extension-dist`. Details in [extension/README.md](extension/README.md); the store listing text is in [extension/STORE_LISTING.md](extension/STORE_LISTING.md).

Google Docs draws its editor on a canvas, so the badge cannot read the document body there (it works in Docs comments, Gmail, Forms and ordinary fields). For the document body itself, use the Google Docs add-on below.

## Google Docs add-on

The same engine also runs as a Google Docs sidebar add-on (Apps Script). The sidebar lists suggestions for every paragraph, applies one-click fixes in place, has "Fix all safe", and "Make it a prompt" inserts a structured AI prompt below the selection. The engine and dictionary are inlined into the sidebar HTML, so it makes no network requests and only asks for the `documents.currentonly` and `script.container.ui` scopes.

```bash
npm run build:docs-addon   # builds docs-addon/dist/ (Sidebar.html, Code.js, appsscript.json)
cd docs-addon && npx clasp login && npx clasp create-script --type docs --title WriteWise --rootDir dist && npx clasp push -f
```

Build, clasp, how to test it as an unpublished add-on, a manual test plan and the Workspace Marketplace listing steps are in [docs-addon/README.md](docs-addon/README.md).

## Publishing it for free

Everything is MIT-licensed (see [LICENSE](LICENSE)), so you can give it away. Each channel is free apart from the one-time Chrome developer fee:

| Channel | How | Cost |
|---|---|---|
| Desktop installers | push a tag `v0.1.0` to a GitHub repo; the workflow builds macOS/Windows/Linux and attaches them to a Release | free |
| Web app (PWA) | live at https://writewise-beta.vercel.app. Redeploy with `npx vercel deploy --prod`, or connect the repo so pushes to `main` deploy automatically (see below). `dist/` also hosts on Netlify, Cloudflare Pages or GitHub Pages | free tiers |
| Chrome Web Store | `npm run pack:ext`, upload the zip at https://chrome.google.com/webstore/devconsole, paste the listing text, submit for review (usually 1–3 days) | one-time US$5 developer registration |
| Edge Add-ons | same zip at https://partner.microsoft.com/dashboard/microsoftedge | free |
| Claude Code / Claude Desktop | users run `npm run install:claude-code` from a clone | free |
| Google Docs add-on | `npm run build:docs-addon`, `clasp push`, then a Google Workspace Marketplace listing (steps in [docs-addon/README.md](docs-addon/README.md)) | free; Google reviews public listings |

### Automatic deploys on push

Two ways, pick one:

1. **Vercel GitHub app (recommended)**: install it for the repository at https://github.com/apps/vercel/installations/new, then run `npx vercel git connect` in the project folder (or Vercel dashboard → project → Settings → Git → Connect). Every push to `main` becomes a production deploy; pull requests get preview URLs.
2. **GitHub Actions** (`.github/workflows/deploy-web.yml`): add the repository secrets `VERCEL_TOKEN` (create one at https://vercel.com/account/tokens), `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (both printed by `cat .vercel/project.json`). The workflow stays idle until the token secret exists.

## How the checking works

| Layer | What it catches | Runs where |
|---|---|---|
| Hunspell dictionary (`dictionary-en`) + `nspell` | spelling, with suggestions re-ranked by edit distance and a common-typo list | in a Web Worker, offline |
| `retext` plugins | repeated words, a/an, passive voice, hard-to-read sentences, sentence spacing, redundant acronyms, apostrophes in contractions, insensitive language | offline |
| Hand-written rules (`src/engine/rules.ts`) | sentence capitalization, "i", spacing and punctuation slips, 30+ misused phrases, 40+ wordy phrases, weak words, hedging, confusable words (their/there, your/you're, its/it's, then/than, …) | offline |
| Prompt analysis (`src/engine/prompt.ts`) | missing prompt elements, vague wording | offline |
| LanguageTool.org | 5,000+ grammar and style rules | cloud, opt-in |
| Claude API | rewrites and prompt conversion | cloud, opt-in, your key |

Categories follow Grammarly's: **Correctness** (red), **Clarity** (blue), **Engagement** (green), **Delivery** (purple), plus **Prompt** (amber) in AI prompt mode.

## Project layout

```
index.html            app shell
src/main.ts           UI wiring, panel, dialogs
src/editor.ts         CodeMirror 6 editor, underline decorations, inline cards
src/engine/worker.ts  grammar engine (runs in a Web Worker)
src/engine/rules.ts   hand-written rules
src/engine/prompt.ts  prompt-mode analysis and offline template
src/engine/suggest.ts spelling-suggestion ranking (edit distance + 10k-word frequency list + typo map)
src/engine/autofix.ts the fixes that are safe to apply without asking
cli/index.ts          CLI, Claude Code hook, installer
cli/mcp.ts            MCP server (proofread_text, analyze_prompt, check_text)
src/cloud.ts          LanguageTool client
src/ai.ts             Claude rewrite (Anthropic SDK)
electron/main.cjs     desktop wrapper
docs-addon/           Google Docs sidebar add-on (Apps Script; the engine and dictionary are inlined into Sidebar.html)
public/dict/          Hunspell en-US dictionary (SCOWL license in LICENSE-dictionary-en.txt)
```

## Privacy

- Local checks never touch the network.
- Cloud boost sends the document text to LanguageTool.org only while the toggle is on.
- AI rewrite sends only the text you choose to rewrite to api.anthropic.com, with your key. The key is saved in the app's local storage on your device.
