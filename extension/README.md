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
