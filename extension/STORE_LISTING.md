# Chrome Web Store listing (copy into the developer dashboard)

**Name:** WriteWise – grammar fixer & AI prompt helper

**Summary (132 chars max):**
Free, private spelling & grammar fixes in any text box, auto-fix as you type on AI chats, one-click structured prompts.

**Category:** Productivity → Writing

**Description:**
WriteWise checks whatever you type, wherever you type it: email, forms, social posts, and the message box of AI assistants such as Claude, ChatGPT and Gemini.

• A small badge appears on the text box you are using. Click it to see every spelling, grammar, punctuation, clarity and tone suggestion with one-click fixes.
• On AI chat sites, safe fixes (typos, missing apostrophes, doubled words, their/there mix-ups) are applied automatically as you type, so the assistant always gets clean text. Turn this on for any site in the popup.
• "Make it a prompt" turns rough notes into a structured prompt with Role, Task, Context, Requirements, Output format and Success criteria sections, with [brackets] for anything you still need to decide.
• The popup lets you paste any text, fix it, and copy the result.

Privacy: everything runs inside your browser. The extension makes no network requests, collects no data, and has no account. It is free and open source (MIT).

**Permission justifications (for the review form):**
- `storage`: saves your per-site preferences (enabled sites, auto-fix sites).
- `activeTab`: lets the popup show and change settings for the site you are on.
- Content script on `<all_urls>`: needed to show the badge on text boxes on any website. No page data leaves the browser.

**Single purpose:** proofreading and improving text the user types.

**Data usage disclosure:** does not collect or transmit user data.

**Privacy policy URL:** https://writewise-beta.vercel.app/privacy.html

**Homepage URL:** https://github.com/rohansaha/writewise

**Assets (all in `extension/store/`):**
- Store icon: `extension/public/icons/icon-128.png` (128×128)
- Screenshots (1280×800), in this order:
  1. `1-mail-suggestions.png` – badge and suggestion panel on an email, one-click fixes
  2. `2-chat-prompt-score.png` – prompt mode on an AI chat composer with the prompt score
  3. `3-chat-structured-prompt.png` – "Make it a prompt" result (Role / Task / Context…)
  4. `4-chat-autofix.png` – auto-fix as you type with the "4 fixes applied" toast
- Small promo tile: `promo-440x280.png` (440×280)
- Package: `release/writewise-chrome-extension-0.1.0.zip` (built with `npm run pack:ext`)

## Submitting (about 10 minutes in the dashboard)

1. Open https://chrome.google.com/webstore/devconsole and sign in with the Google account that will own the listing.
2. First time only: pay the one-time US$5 developer registration fee and accept the Developer Agreement. Then on the **Account** tab add and verify a contact email (required before publishing).
3. Click **New item** and upload `release/writewise-chrome-extension-0.1.0.zip`.
4. **Store listing** tab: paste the Summary and Description above, set Category = Productivity, Language = English, upload the 128×128 icon, the four screenshots and the promo tile, and set the Homepage URL.
5. **Privacy** tab: Single purpose = the sentence above; justify `storage`, `activeTab` and the host permission (`<all_urls>`) with the three bullet points above; for remote code choose "No, I am not using remote code"; in Data usage tick nothing (no data collected) and tick the three certifications; set the Privacy policy URL.
6. **Distribution** tab: Visibility = Public, all regions, free.
7. **Submit for review**. Review usually takes 1–3 days; you get an email either way. If it is rejected, the email quotes the policy section; reply from the item's page.
