// Windows-only smoke test for the UI Automation helper (native/build/axhelper.exe), run in CI after the
// Windows build: opens Notepad, has the helper focus its text box, write a sentence, read it back, measure
// a word and move the caret. Exits non-zero on the first failure.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') { console.log('smoke-axhelper-win: not Windows, skipping'); process.exit(0) }
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
await sleep(2500)
const helper = spawn(path.join(root, 'native', 'build', 'axhelper.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiting = new Map()
const events = []
helper.stdout.setEncoding('utf8')
helper.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) } else events.push(msg)
  }
})
let nextId = 1
const request = (obj) => new Promise((resolve, reject) => {
  const id = nextId++
  const t = setTimeout(() => reject(new Error(`timeout on ${obj.cmd}`)), 8000)
  waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
  helper.stdin.write(JSON.stringify({ ...obj, id }) + '\n')
})
function check(cond, what, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' ' + JSON.stringify(detail) : ''}`)
  if (!cond) { cleanup(); process.exit(1) }
}
function cleanup() { try { helper.kill() } catch {} try { process.kill(notepad.pid) } catch {} }

const sentence = 'Teh quick fox jumps.'
try {
  const focus = await request({ cmd: 'focus', match: '' })
  check(focus.ok && focus.editable, 'focus finds Notepad\'s text box', { role: focus.role, bundle: focus.bundle })
  const rep = await request({ cmd: 'replace', start: 0, length: (focus.text || '').length, text: sentence })
  check(rep.ok, 'replace writes the text', rep)
  const read = await request({ cmd: 'read' })
  check(read.ok && read.text === sentence, 'read returns it', { text: read.text })
  const b = await request({ cmd: 'bounds', ranges: [[0, 3]], lines: true })
  check(Array.isArray(b.rects[0]) && b.rects[0][2] > 0, 'bounds measures a word', b)
  const fix = await request({ cmd: 'replace', start: 0, length: 3, text: 'The' })
  const after = await request({ cmd: 'read' })
  check(fix.ok && after.text === 'The quick fox jumps.', 'replace fixes one word', { method: fix.method, text: after.text })
  const sel = await request({ cmd: 'select', start: 4, length: 0 })
  const caret = await request({ cmd: 'read' })
  check(sel.ok && caret.selStart === 4, 'select moves the caret', { selStart: caret.selStart })
  await request({ cmd: 'watch', on: true })
  await sleep(400)
  check(events.some((e) => e.type === 'focus' && e.editable), 'watch reports the focused box', events.map((e) => e.type))
  console.log('smoke-axhelper-win: all checks passed')
} catch (err) {
  check(false, 'helper responded', { error: err.message })
}
// Notepad asks to save on close; kill it outright.
cleanup()
process.exit(0)
