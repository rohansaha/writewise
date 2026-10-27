# WriteWise browser extension

Manifest V3 extension (Chrome, Edge, Brave, Arc, Opera; Firefox needs the MV3 build loaded via `about:debugging`).

```bash
npm run icons        # once
npm run build:ext    # → extension-dist/
npm run pack:ext     # → release/writewise-chrome-extension-<version>.zip
```

Load it unpacked: `chrome://extensions` → Developer mode → "Load unpacked" → pick `extension-dist`.

## How it works

- `src/content.ts` runs on every page. When a text box gets focus it sends the text to the background worker, shows a badge with the number of suggestions, and opens a panel with one-click fixes. On AI chat sites (claude.ai, chatgpt.com, gemini.google.com, …) it also auto-applies safe fixes as you type, like a phone's autocorrect: only when the caret is at the end, and never on the word being typed.
- `src/background.ts` is the service worker. It loads the Hunspell dictionary once and answers `check` messages using the same engine as the desktop app (`src/engine/core.ts`).
- `src/popup.ts` is the toolbar popup: per-site switches and a paste-to-fix box.
- `test/harness.html` loads the content script with the engine running in-page so it can be exercised in a normal tab without installing the extension: `npm run dev`, then open `/extension/test/harness.html`.

Google Docs renders its editor on a canvas, so the badge cannot read Docs text; it works in Docs comments, Gmail, Google Chat, Forms and every normal text field.

## Claude (optional)

Off by default; the extension makes no network requests until it is on. In the popup, *Claude (optional)* has a switch, an API-key field and **Use the desktop app's key**. With it on, the suggestion panel and the popup's paste box get a **Fix with Claude** button that sends that text (only that text) to api.anthropic.com with the user's own key and replaces the box with the corrected version; nothing is replaced if the text changed while Claude was thinking, and the offline check runs again afterwards.

- `src/claude-constants.ts` — the settings (`claudeEnabled`, `claudeKey`, `claudeModel`), all in `chrome.storage.local` so the key is never synced; the popup imports only this file.
- `src/claude.ts` — runs in the background worker: reads the key and calls Claude through `@anthropic-ai/sdk` and the shared prompts in `src/ai-core.ts`. Content scripts never see the key; they send `{ type: 'claude-fix', text }` and get `{ fixed }` back.
- **Use the desktop app's key** asks for the optional `nativeMessaging` permission on the click, then calls `chrome.runtime.sendNativeMessage('app.writewise.desktop', { type: 'get-key' })`. The desktop app registers that host under **Tools → Connect the browser extension** (`electron/native-host.cjs`); the host process is `writewise native-host` (`cli/native-host.ts`), which uses `ANTHROPIC_API_KEY` if the browser was started with one, else asks the running app over its local socket, else reads `~/.config/writewise/config.json`. The host manifest only allows the store build's ID; for an unpacked build, add its ID (shown in the popup's error message) to `extensionIds` in `config.json` and connect again.

The manifest declares `nativeMessaging` under `optional_permissions`, so there is no install-time warning; `storage` already covers the local settings. Adding it, and the opt-in network use, means the next Chrome Web Store upload needs a version bump (`0.1.1`) and the updated disclosures in `STORE_LISTING.md`.
