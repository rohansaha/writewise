# Chrome Web Store listing (copy into the developer dashboard)

**Name:** WriteWise – grammar fixer & AI prompt helper

**Summary (132 chars max, taken from the manifest `description`):**
Free, private spelling and grammar fixes in any text box, auto-fix as you type on AI chat sites, and one-click structured prompts.

**Category:** Productivity → Writing

**Description:**
WriteWise checks whatever you type, wherever you type it: email, forms, social posts, and the message box of AI assistants such as Claude, ChatGPT and Gemini.

• A small badge appears on the text box you are using. Click it to see every spelling, grammar, punctuation, clarity and tone suggestion with one-click fixes.
• On AI chat sites, safe fixes (typos, missing apostrophes, doubled words, their/there mix-ups) are applied automatically as you type, so the assistant always gets clean text. Turn this on for any site in the popup.
• "Make it a prompt" turns rough notes into a structured prompt with Role, Task, Context, Requirements, Output format and Success criteria sections, with [brackets] for anything you still need to decide.
• The popup lets you paste any text, fix it, and copy the result.
• Optional: turn on Claude in the popup and a "Fix with Claude" button corrects the whole text box in context, using your own Anthropic API key. Paste the key, or fetch it with one click from the WriteWise desktop app if you use that too.

Privacy: everything runs inside your browser. The extension makes no network requests, collects no data, and has no account. The only exception is the optional Claude feature, off by default: when you turn it on and click "Fix with Claude", the text in that box is sent to Anthropic's API (api.anthropic.com) with your own key, and nowhere else. It is free and open source (MIT).

**Permission justifications (for the review form):**
- `storage`: saves your per-site preferences (enabled sites, auto-fix sites) and, if you opt in, your own Anthropic API key in local (unsynced) storage.
- `activeTab`: lets the popup show and change settings for the site you are on.
- `nativeMessaging` (optional, requested only when you click "Use the desktop app's key"): asks the WriteWise desktop app, if installed and running on the same computer, for the API key you already entered there, so you do not have to paste it twice. It exchanges nothing else.
- Content script on `<all_urls>`: needed to show the badge on text boxes on any website. No page data leaves the browser.

**Single purpose:** proofreading and improving text the user types.

**Data usage disclosure:** the developer collects no data. With the optional Claude feature switched on by the user, the text of the box the user asks to fix is sent to Anthropic's API using the user's own API key ("Website content" and "User activity: text the user chooses to submit", transmitted to a third party at the user's request, not to the developer). Nothing is sent while the feature is off, which is the default. Remote code: none (the Anthropic SDK is bundled).

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

## Dashboard status (2026-10-27)

Draft item under publisher rohansaha2222@gmail.com: ID `hmdpffagdonhmmgdcohmbkjcijiieicn`
(https://chrome.google.com/webstore/devconsole/8dd23e74-0276-4186-a8d8-5a23628e02df/hmdpffagdonhmmgdcohmbkjcijiieicn/edit).
Everything is filled and saved: package 0.1.0, description, homepage/support URLs, icon, 4 screenshots, small promo tile,
Category = Productivity > Tools (the store has no "Writing" subcategory), Language = English, single purpose + permission
justifications, "no remote code", no data collected + the three certifications, privacy policy URL, distribution free/public/all
regions. Settings: contact email verified, EEA trader declaration = non-trader. Submitted for review on 2026-10-27 with "publish automatically after review" ticked; status is now **Pending review**.
Google warned that the `<all_urls>` host permission may trigger an in-depth review, so expect days rather than hours.
The store listing will appear at https://chromewebstore.google.com/detail/hmdpffagdonhmmgdcohmbkjcijiieicn once approved.

**Next upload (after the 0.1.0 review):** the source now has the optional Claude feature and `optional_permissions: ["nativeMessaging"]`. The manifest version is still 0.1.0 on purpose while that review is pending; bump it to 0.1.1 (package.json + manifest) before `npm run pack:ext`, paste the updated Description, the `nativeMessaging` justification and the Data usage text above, untick "does not collect or transmit user data" in favour of the disclosure above, and keep the same privacy policy URL (its text was updated for the opt-in network use).

## Submitting (about 10 minutes in the dashboard)

1. Open https://chrome.google.com/webstore/devconsole and sign in with the Google account that will own the listing.
2. First time only: pay the one-time US$5 developer registration fee and accept the Developer Agreement. Then on the **Account** tab add and verify a contact email (required before publishing).
3. Click **New item** and upload `release/writewise-chrome-extension-0.1.0.zip`.
4. **Store listing** tab: paste the Summary and Description above, set Category = Productivity, Language = English, upload the 128×128 icon, the four screenshots and the promo tile, and set the Homepage URL.
5. **Privacy** tab: Single purpose = the sentence above; justify `storage`, `activeTab` and the host permission (`<all_urls>`) with the three bullet points above; for remote code choose "No, I am not using remote code"; in Data usage tick nothing (no data collected) and tick the three certifications; set the Privacy policy URL.
6. **Distribution** tab: Visibility = Public, all regions, free.
7. **Submit for review**. Review usually takes 1–3 days; you get an email either way. If it is rejected, the email quotes the policy section; reply from the item's page.
