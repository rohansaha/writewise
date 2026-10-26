# WriteWise for Google Docs

A Google Docs sidebar add-on that runs the WriteWise grammar engine **inside the sidebar**: spelling, grammar, clarity and style suggestions with one-click fixes, "Fix all safe", and "Make it a prompt" (turns the selection into a structured AI prompt). The engine, the Hunspell en-US dictionary and the UI are inlined into one HTML file, so the add-on makes **no network requests** and needs only two narrow OAuth scopes:

- `https://www.googleapis.com/auth/documents.currentonly` – read and edit the document the add-on is open in
- `https://www.googleapis.com/auth/script.container.ui` – show the sidebar

Everything here is MIT-licensed (see the repository [LICENSE](../LICENSE)); the bundled npm packages (retext, nspell, unified, …) are MIT and the dictionary is SCOWL-licensed ([public/dict/LICENSE-dictionary-en.txt](../public/dict/LICENSE-dictionary-en.txt)).

## Layout

```
docs-addon/
  appsscript.json        Apps Script manifest (scopes, V8 runtime)
  src/Code.js            server side: menu, sidebar, getDocumentText / applyFix / applyFixes / selectRange /
                         getPromptSource / insertPrompt / getSettings / saveSettings (DocumentApp + PropertiesService)
  src/Sidebar.html       sidebar template: UI + client logic, with placeholders for the engine and dictionary
  src/engine.ts          Vite entry that exposes the shared engine (src/engine/*) as window.WriteWiseEngine
  src/pluralize-shim.js  CommonJS/UMD interop for the `pluralize` package inside an IIFE bundle
  test/harness.html      fake "Google Doc" that drives dist/Sidebar.html in a normal browser (no Google needed)
  build/                 generated: engine.js (git-ignored)
  dist/                  generated: Sidebar.html, Code.js, appsscript.json – what clasp pushes (git-ignored)
  .clasp.json            created by `clasp create-script`; holds your script ID (git-ignored)
```

How the pieces talk: the sidebar asks `getDocumentText()` for every body paragraph (with its index), checks the joined text once, and maps each suggestion back to `(paragraphIndex, start, end)`. A fix calls `applyFix(paragraphIndex, start, end, replacement, expected)`; `Code.js` re-reads the paragraph, confirms the text still equals `expected`, and edits it in place (formatting is kept). If the document changed in between, the fix is skipped and the sidebar re-checks.

## Build

```bash
npm install
npm run build:docs-addon
```

This runs `vite build --config vite.docs-addon.config.ts` (engine → `docs-addon/build/engine.js`, ~315 KB minified) and then `scripts/build-docs-addon.mjs`, which inlines the engine and `public/dict/en-US.{aff,dic}` into `docs-addon/dist/Sidebar.html` (~930 KB, fully self-contained) and copies `Code.js` and `appsscript.json` next to it.

### Try it without Google

```bash
npm run dev
```

Then open `http://localhost:5173/docs-addon/test/harness.html` (use whatever port Vite prints). The left side is a fake document, the right side is the real `dist/Sidebar.html` talking to an in-page mock of `Code.js`. Click a paragraph to "select" it. Rebuild (`npm run build:docs-addon`) and reload after changing the sidebar.

## Push to Apps Script with clasp

`@google/clasp` (v3) is a dev dependency, so `npx clasp` works from the repo.

1. Turn on the Apps Script API for your Google account (once): <https://script.google.com/home/usersettings>.
2. Log in (opens a browser; credentials are stored in `~/.clasprc.json`):

   ```bash
   npx clasp login
   ```

3. Create the Apps Script project **once**, from inside `docs-addon/`. Pick one:

   ```bash
   cd docs-addon
   # a) quickest way to test: a new Google Doc with the script bound to it
   npx clasp create-script --type docs --title "WriteWise" --rootDir dist
   # b) for publishing: a standalone script (what the Marketplace listing points to)
   npx clasp create-script --type standalone --title "WriteWise" --rootDir dist
   ```

   This writes `docs-addon/.clasp.json` (`{"scriptId": "…", "rootDir": "dist"}`). To attach an existing project instead, create that file by hand with the script ID from the Apps Script editor (Project settings → IDs).

4. Build and push (every time you change something):

   ```bash
   npm run build:docs-addon
   cd docs-addon && npx clasp push -f
   ```

   `-f` lets clasp overwrite the remote manifest with our `appsscript.json`. Expected output: `Pushed 3 files.` (`dist/appsscript.json`, `dist/Code.js`, `dist/Sidebar.html`; `npx clasp status` lists them beforehand).

5. `npx clasp open-script` opens the project in the Apps Script editor; for a bound script, `npx clasp open-container` opens the Google Doc.

Status of this checkout: the build and `clasp status` were verified; `clasp push` was not run because step 2 (`clasp login`) needs your Google account in a browser. After `npx clasp login` and step 3, step 4 is the only remaining command.

## Test it as an unpublished add-on

First run in any document: **Extensions → WriteWise → Open WriteWise**. Google shows an authorization dialog; because the app is not verified yet it also shows "Google hasn't verified this app" → **Advanced → Go to WriteWise (unsafe) → Allow**. The two permissions listed are "View and manage documents that this application has been installed in" and "Display and run third-party web content in prompts and sidebars inside Google applications".

Three ways to run it:

- **Bound script (no clasp)**: open a Google Doc → Extensions → Apps Script. Replace `Code.gs` with `dist/Code.js`, add an HTML file named `Sidebar` (File → + → HTML) and paste the contents of `dist/Sidebar.html` (it is ~930 KB; pasting takes a moment), save, then reload the Doc. The menu appears under Extensions.
- **Bound script with clasp**: `create-script --type docs` + `clasp push -f` as above, then `npx clasp open-container` and reload the Doc.
- **Standalone script as an add-on** (this is how it behaves once published): in the Apps Script editor choose **Deploy → Test deployments**, next to *Select type* click the gear and pick **Editor add-on**, then **Create new test** → version **Latest Code**, config **Installed and enabled** (or **Installed** to test the install flow), **Test document → select a Doc**, **Save test**, select it and **Execute**. The Doc opens in a new tab with the add-on under Extensions. With "Latest Code" you can push again and just reload the Doc.

### Manual test plan (about 5 minutes)

Paste this into a fresh Google Doc, one line per paragraph:

```
Teh quick brown fox jumps over the lazy dog. I could of done this better, but it is what it is.

This report was written by the team and it was reviewed by management before it was sent to the the client.
please write something good about our product and make it better.
We should hone in on the end result and avoid very unique ideas, irregardless of the cost.
```

| # | Step | Expected |
|---|------|----------|
| 1 | Extensions → WriteWise → Open WriteWise | Sidebar opens; status goes from "Loading dictionary…" to "Ready. Click Check document." within a few seconds |
| 2 | Click **Check document** | "10 suggestions in 70 words." Pills: Correctness 8, Clarity 2. First card: Spelling "Teh" with chips The / Tech / Ten and an **auto** tag; **Fix all safe (8)** is enabled |
| 3 | Click the **Word choice** card body ("could of") | The words "could of" are selected (highlighted) in the document |
| 4 | Click the **The** chip on the Spelling card | The document now reads "The quick brown fox…", the card disappears, status "Applied. 9 left.", Fix all shows (7) |
| 5 | Click **Fix all safe (7)** | Paragraphs become "could have", "the client", "Please write…", "home in on the result and avoid unique ideas, regardless of the cost". Status ends with "2 suggestions in 67 words." (the two passive-voice cards remain; they have no automatic fix) |
| 6 | Click **Ignore** on one Passive voice card | Card disappears and stays gone after another **Check document** |
| 7 | Put the cursor in "Please write something good…" (no selection) and click **Make it a prompt** | A blank line and a structured prompt (bold "# Role", "# Task", "# Requirements", …) are inserted right below that paragraph; status shows "score before: 42/100" |
| 8 | Select a few words and click **Make it a prompt** | The prompt is inserted below the paragraph containing the end of the selection and uses only the selected text as the task |
| 9 | Switch the dropdown to **AI prompt** | Suggestions re-run; a "prompt completeness" box with ✓/! checks appears above the cards and the vague word "something" gets an amber **Prompt** card ("Replace \"something\" with a concrete noun.") |
| 10 | Edit the document by hand (change a flagged word), then click a chip for the old suggestion | Status "That text has changed in the document. Checking again…" and a fresh list; nothing wrong is written into the document |
| 11 | On a Spelling card click **Add to dictionary** | Word appears under Settings → Personal dictionary and is no longer flagged after the next check; it is still there after closing and reopening the sidebar (stored per user with PropertiesService) |
| 12 | Open Settings, untick **Flag passive voice**, click **Check document** | No Passive voice cards |

## Publish on the Google Workspace Marketplace (free listing)

There is no developer fee for the Marketplace. A public listing is reviewed by Google; a consumer `@gmail.com` account can only publish publicly (private listings need a Workspace organization). Steps, in order:

1. **Google Cloud project.** Create one at <https://console.cloud.google.com> (billing is not needed) and link it to the script: Apps Script editor → **Project settings** → *Google Cloud Platform (GCP) Project* → **Change project** → paste the project *number*.
2. **OAuth consent screen** (Cloud console → *Google Auth Platform*, formerly *APIs & Services → OAuth consent screen*):
   - *Branding*: app name **WriteWise**, support email, 120×120 logo, app home page, privacy policy URL, terms of service URL, authorized domain (the domain of those pages; GitHub Pages works).
   - *Audience*: **External**. While the status is *Testing* you can add up to 100 test users who can install the add-on from a test deployment without verification.
   - *Data access / Scopes*: add exactly the two scopes from `appsscript.json`: `…/auth/documents.currentonly` and `…/auth/script.container.ui`.
   - `documents.currentonly` is a *sensitive* scope, so a public listing requires Google's **OAuth app verification** (free): you submit a justification for the scope and a short YouTube video showing the consent screen and the sidebar editing the document. Verification usually takes a few days to a couple of weeks; the listing can be prepared in parallel.
3. **Version the script.** Apps Script editor → **Deploy → New deployment** → type **Add-on** → description such as `v0.1.0` → **Deploy**. The Marketplace needs the script's *script ID* (Project settings → IDs) and this *version number* (Deploy → Manage deployments → Configuration).
4. **Google Workspace Marketplace SDK.** Cloud console → *APIs & Services → Library* → **Google Workspace Marketplace SDK** → **Enable**, then open its **App Configuration** tab:
   - *App visibility*: **Public** (this cannot be changed later). *Installation settings*: **Individual + Admin install**.
   - *App integration*: **Editor add-on → Google Docs add-on**; enter the script ID and the version from step 3.
   - *OAuth scopes*: the same two scopes.
   - *Developer information*: name, website, contact email, trader status (required for EEA users).
   - **Save draft**.
5. **Store listing** tab: language, app name, short and detailed description (the text in [../extension/STORE_LISTING.md](../extension/STORE_LISTING.md) is a good start; mention that nothing leaves the document), category *Productivity*, graphics (128×128 app icon, 220×140 card banner, at least one 1280×800 screenshot of the sidebar in a Doc), support links (terms of service, privacy policy, support page), **Pricing: Free**, regions. **Publish**.
6. Google reviews the listing (and the OAuth verification, if still pending). Once approved it appears at <https://workspace.google.com/marketplace> and users install it from Docs via **Extensions → Add-ons → Get add-ons**.

To ship an update later: `clasp push -f`, create a new version (step 3), update the version number in the Marketplace SDK app configuration and save; listing-text changes go through a short re-review.

## Limitations and notes

- The add-on checks the paragraphs of the document body (list items included). Headers, footers, footnotes and comments are not checked.
- Suggestions never cross a paragraph boundary. Each fix is verified against the live paragraph text before it is applied, so a stale suggestion is skipped rather than corrupting text; paragraphs with inline images or footnotes may report slightly different offsets to Apps Script and will simply be skipped in that case.
- There is no live checking: Google Docs does not give add-ons an edit event, so click **Check document** after editing. A long document is checked in one pass; expect a few seconds for very long ones.
- Replacement text takes the formatting of the text around it (Apps Script `Text.insertText` behaviour).
- Settings (mode, toggles, personal dictionary) are stored per user in the script's `PropertiesService` and are limited to a few hundred words.
- The sidebar is ~930 KB because the dictionary and engine are inlined; Google serves it from its own CDN, so the first open takes a second or two. Nothing is fetched from anywhere else.
