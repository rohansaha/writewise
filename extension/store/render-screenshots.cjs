// Renders Chrome Web Store screenshots (1280x800) of the WriteWise extension UI
// by driving the extension test harness (dev server) inside Electron.
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('fs')
const path = require('path')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const OUT = process.argv[2]
const URL = (process.argv[3] || 'http://localhost:5173') + '/extension/test/harness.html'
app.setPath('userData', process.argv[4])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MAIL_TEXT = "Hi Sam,\n\nThanks for you're email. I recieved teh proposal yesterday and I think its definately worth persuing. Lets setup a quick call tommorow to go over the details."
const CHAT_TEXT = "write me a blog post about productivity, make it good and not to long. it should have some tips and stuff for remote workers."
const FIX_TEXT = "I could of sent teh report yesterday but I didnt have the the final numbers "

// ---- page-side helpers (serialized with toString) ----
function pageMail(a) {
  document.title = 'Mail'
  document.body.style.cssText = 'margin:0;background:#e9edf2;font-family:' + a.font
  document.body.innerHTML = `
  <div style="padding:16px 0 0 70px">
    <div style="width:720px;background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(20,30,50,.18);overflow:hidden">
      <div style="background:#1f2937;color:#fff;padding:13px 18px;font-weight:600;font-size:15px;display:flex;justify-content:space-between"><span>New message</span><span style="opacity:.6">— ✕</span></div>
      <div style="padding:10px 18px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px"><span style="color:#111827">To</span>&nbsp;&nbsp; sam@example.com</div>
      <div style="padding:10px 18px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px"><span style="color:#111827">Subject</span>&nbsp;&nbsp; Proposal follow-up</div>
      <textarea id="ta" spellcheck="false" style="display:block;width:100%;box-sizing:border-box;height:140px;border:0;padding:16px 18px;font:16px/1.55 ${a.font};color:#111827;resize:none;outline:none"></textarea>
      <div style="padding:12px 18px;border-top:1px solid #e5e7eb;display:flex;gap:10px;align-items:center"><button style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 22px;font-weight:600;font-size:14px">Send</button><span style="color:#9ca3af;font-size:13px">Aa &nbsp; 📎 &nbsp; 🔗 &nbsp; 😊</span></div>
    </div>
    <div style="margin:150px 0 0 6px;max-width:330px;color:#374151;font-size:17px;line-height:1.5"><b style="color:#111827">Works in any text box.</b><br>A small badge shows how many suggestions WriteWise has. Click it for one-click fixes, or fix everything at once.<br><span style="color:#6b7280;font-size:14px">Runs entirely in your browser — nothing is sent anywhere.</span></div>
  </div>`
  const ta = document.getElementById('ta')
  ta.focus()
  ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
  ta.value = a.text
  ta.setSelectionRange(a.text.length, a.text.length)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}
function pageChat(a) {
  document.title = 'Assistant'
  document.body.style.cssText = 'margin:0;background:#1b1d22;color:#e6e8ee;font-family:' + a.font
  document.body.innerHTML = `
  <div style="position:absolute;inset:0;display:flex;flex-direction:column">
    <div style="padding:14px 22px;border-bottom:1px solid #2b2f37;font-weight:600;font-size:15px;display:flex;gap:10px;align-items:center"><span style="width:10px;height:10px;border-radius:50%;background:#15c39a;display:inline-block"></span>Assistant</div>
    <div style="flex:1;padding:28px 0 0;display:flex;flex-direction:column;gap:18px;align-items:center;overflow:hidden">
      <div style="width:720px;align-self:center;background:#262a33;border-radius:14px;padding:14px 18px;font-size:15px;line-height:1.5;color:#c9cdd6">Hi! What would you like to work on today?</div>
      <div style="width:720px;align-self:center;display:flex;justify-content:flex-end"><div style="max-width:520px;background:rgba(21,195,154,.14);border:1px solid rgba(21,195,154,.35);border-radius:14px;padding:12px 16px;font-size:15px;line-height:1.5;color:#dfe3ea">Can you help me with a blog post?</div></div>
      <div style="width:720px;align-self:center;background:#262a33;border-radius:14px;padding:14px 18px;font-size:15px;line-height:1.5;color:#c9cdd6">Of course. Tell me the audience, the length you want and the main points, and I'll draft an outline.</div>
    </div>
    <div style="padding:0 0 34px;display:flex;justify-content:center">
      <div style="width:720px;background:#262a33;border:1px solid #343945;border-radius:16px;padding:14px 16px 12px;box-shadow:0 10px 30px rgba(0,0,0,.35)">
        <div id="ce" contenteditable="true" spellcheck="false" style="min-height:72px;max-height:220px;overflow:auto;outline:none;font-size:16px;line-height:1.55;color:#eef0f4;white-space:pre-wrap"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#8b93a3;font-size:13px"><span>＋ &nbsp; Attach</span><span style="background:#15c39a;color:#062b22;border-radius:8px;padding:6px 14px;font-weight:600">Send ↑</span></div>
      </div>
    </div>
  </div>`
  const ce = document.getElementById('ce')
  if (a.promptMode) { const o = window.__writewiseCheck; window.__writewiseCheck = (t) => o(t, 'prompt') }
  ce.focus()
  ce.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
  ce.textContent = a.text
  const range = document.createRange(); range.selectNodeContents(ce); range.collapse(false)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  ce.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.text }))
}
async function pageReady(maxMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (window.__writewiseStarted && typeof window.__writewiseCheck === 'function') {
      try {
        const r = await window.__writewiseCheck('I recieved teh report.', 'writing')
        return { ms: Date.now() - t0, issues: r.issues.length, fixed: r.fixed }
      } catch (e) { return { error: String(e) } }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { timeout: true, started: !!window.__writewiseStarted, check: typeof window.__writewiseCheck }
}
async function pageWaitBadge(maxMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const host = document.querySelector('[data-writewise-ui]')
    const b = host && host.shadowRoot.querySelector('.badge')
    if (b && /^\d+$/.test(b.textContent)) return b.textContent
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}
function pageOpenPanel(opts) {
  const host = document.querySelector('[data-writewise-ui]')
  if (!host) return { error: 'no host' }
  const sr = host.shadowRoot
  if (opts && opts.maxPanel && !sr.querySelector('#shot-style')) { const st = document.createElement('style'); st.id = 'shot-style'; st.textContent = `.panel{max-height:${opts.maxPanel}px}`; sr.appendChild(st) }
  sr.querySelector('.badge').click()
  if (opts && opts.host) for (const b of sr.querySelectorAll('button')) if (b.textContent.startsWith('Turn off on ')) b.textContent = 'Turn off on ' + opts.host
  return { title: sr.querySelector('.panel header b')?.textContent, buttons: [...sr.querySelectorAll('.panel header button')].map((b) => b.textContent) }
}
function pageClickButton(label) {
  const sr = document.querySelector('[data-writewise-ui]').shadowRoot
  const b = [...sr.querySelectorAll('button')].find((x) => x.textContent === label)
  if (b) b.click()
  return !!b
}
async function pageWaitToast(maxMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const host = document.querySelector('[data-writewise-ui]')
    const t = host && host.shadowRoot.querySelector('.toast')
    if (t && t.style.display === 'block') return t.textContent
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}
function pageState(id) {
  const host = document.querySelector('[data-writewise-ui]')
  return { active: document.activeElement && document.activeElement.id, hasFocus: document.hasFocus(), host: !!host, badge: host && host.shadowRoot.querySelector('.badge').textContent, badgeDisplay: host && host.shadowRoot.querySelector('.badge').style.display, len: (document.getElementById(id).value || '').length }
}
function pageText(id) { const el = document.getElementById(id); return el.value ?? el.innerText }

async function run() {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, webPreferences: { offscreen: true } })
  const wc = win.webContents
  wc.on('console-message', (e, level, message) => { if (!/HMR|vite\] connect/.test(message)) console.log('[renderer]', message.slice(0, 300)) })
  const js = (fn, ...args) => wc.executeJavaScript(`(${fn.toString()})(${args.map((x) => JSON.stringify(x)).join(',')})`, true)
  const load = async () => {
    await win.loadURL(URL)
    const ready = await js(pageReady, 30000)
    console.log('ready:', JSON.stringify(ready))
  }
  const shot = async (name) => {
    const img = await wc.capturePage()
    const { width, height } = img.getSize()
    const out = width === 1280 && height === 800 ? img : img.resize({ width: 1280, height: 800 })
    fs.writeFileSync(path.join(OUT, name), out.toPNG())
    console.log('saved', name, width + 'x' + height)
  }

  // 1. Mail compose, writing mode, panel open
  nativeTheme.themeSource = 'light'
  await load()
  await js(pageMail, { text: MAIL_TEXT, font: FONT })
  console.log('mail badge:', await js(pageWaitBadge, 12000))
  console.log('mail state:', JSON.stringify(await js(pageState, 'ta')))
  console.log('mail panel:', await js(pageOpenPanel, { maxPanel: 420, host: 'mail.example.com' }))
  await sleep(500)
  await shot('1-mail-suggestions.png')

  // 2. Chat composer, prompt mode, panel with prompt score
  nativeTheme.themeSource = 'dark'
  await load()
  await js(pageChat, { text: CHAT_TEXT, font: FONT, promptMode: true })
  console.log('chat badge:', await js(pageWaitBadge, 12000))
  console.log('chat panel:', await js(pageOpenPanel, { host: 'assistant.example.com' }))
  await sleep(500)
  await shot('2-chat-prompt-score.png')

  // 3. Make it a prompt
  console.log('clicked make-it-a-prompt:', await js(pageClickButton, 'Make it a prompt'))
  await sleep(2500)
  console.log('composer now:', (await js(pageText, 'ce')).slice(0, 120).replace(/\n/g, ' | '))
  await shot('3-chat-structured-prompt.png')

  // 4. Auto-fix as you type (toast)
  await load()
  await wc.executeJavaScript(`localStorage.setItem('writewise:ext', JSON.stringify({ autoFixEverywhere: true }))`)
  await load()
  await js(pageChat, { text: FIX_TEXT, font: FONT, promptMode: true })
  console.log('toast:', await js(pageWaitToast, 12000))
  await sleep(700)
  await shot('4-chat-autofix.png')
  console.log('composer after autofix:', await js(pageText, 'ce'))
  await wc.executeJavaScript(`localStorage.removeItem('writewise:ext')`)

  // 5. Promo tile 440x280
  const base = (process.argv[3] || 'http://localhost:5173')
  const tileHtml = `<!doctype html><body style="margin:0;width:440px;height:280px;background:linear-gradient(135deg,#0f172a 0%,#0f3d3a 100%);font-family:${FONT};color:#fff;display:flex;align-items:center;justify-content:center">
    <div style="display:flex;gap:24px;align-items:center;padding:0 28px">
      <img src="${base}/extension/public/icons/icon-128.png" width="104" height="104" style="border-radius:24px;box-shadow:0 12px 30px rgba(0,0,0,.45)">
      <div><div style="font-size:32px;font-weight:700;letter-spacing:-.5px">WriteWise</div>
      <div style="font-size:15px;line-height:1.45;color:#c7f5e8;margin-top:6px">Grammar fixes in any text box.<br>Prompt builder for Claude, ChatGPT &amp; more.</div>
      <div style="font-size:13px;color:#8ad9c3;margin-top:8px">Free · private · works offline</div></div>
    </div></body>`
  const tile = new BrowserWindow({ width: 440, height: 280, useContentSize: true, show: false, webPreferences: { offscreen: true } })
  await tile.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(tileHtml))
  await sleep(1200)
  const timg = await tile.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, 'promo-440x280.png'), timg.toPNG())
  console.log('saved promo-440x280.png', JSON.stringify(timg.getSize()))
}

app.whenReady().then(() => run().then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1) }))
