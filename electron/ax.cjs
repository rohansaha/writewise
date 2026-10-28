// Client for the accessibility helper: native/axhelper.swift on macOS, native/axhelper-win.cs (UI
// Automation) on Windows; both speak the same protocol. Spawns the helper on first use, sends
// newline-delimited JSON commands, matches replies by id and re-emits the helper's events ('focus',
// 'text', 'moved', 'blur', 'ready', 'exit'). Everything is best effort: when the helper is missing
// (Linux, no compiler at build time) `available()` is false and callers fall back to the clipboard.
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { app, screen } = require('electron')

const IS_WIN = process.platform === 'win32'
const HELPER = IS_WIN ? 'axhelper.exe' : 'axhelper'

function helperPath() {
  return app.isPackaged ? path.join(process.resourcesPath, HELPER) : path.join(__dirname, '..', 'native', 'build', HELPER)
}

/**
 * The Windows helper reports physical pixels; Electron windows are placed in device-independent pixels, which
 * differ on any display scaled above 100%. macOS rects are already in points, so they pass through.
 */
function toDip(r) {
  if (!IS_WIN || !Array.isArray(r) || r.length !== 4) return r
  try {
    const d = screen.screenToDipRect(null, { x: Math.round(r[0]), y: Math.round(r[1]), width: Math.round(r[2]), height: Math.round(r[3]) })
    return [d.x, d.y, d.width, d.height]
  } catch { return r }
}
function convertRects(msg) {
  if (!IS_WIN) return msg
  if (msg.bounds) msg.bounds = toDip(msg.bounds)
  if (Array.isArray(msg.rects)) msg.rects = msg.rects.map(toDip)
  if (Array.isArray(msg.lines)) msg.lines = msg.lines.map((l) => (Array.isArray(l) ? l.map(toDip) : l))
  return msg
}

class AxHelper extends EventEmitter {
  constructor() {
    super()
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.ready = false
  }

  available() {
    return (process.platform === 'darwin' || IS_WIN) && existsSync(helperPath())
  }

  start() {
    if (this.proc || !this.available()) return
    // --own-pid lets the helper ignore WriteWise's own windows (the overlay panel, the editor).
    const proc = spawn(helperPath(), ['--own-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i)
        this.buffer = this.buffer.slice(i + 1)
        if (line.trim()) this.handleLine(line)
      }
    })
    proc.stderr.on('data', (d) => console.warn('[axhelper]', String(d).trim()))
    proc.on('error', (err) => console.warn('[axhelper] failed to start:', err.message))
    proc.on('exit', (code) => {
      this.proc = null
      this.ready = false
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Accessibility helper exited')) }
      this.pending.clear()
      this.emit('exit', code)
    })
  }

  handleLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    convertRects(msg)
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg)
      return
    }
    if (msg.type === 'ready') this.ready = true
    this.emit('message', msg)
    if (msg.type) this.emit(msg.type, msg)
  }

  send(obj) {
    if (!this.proc) this.start()
    if (!this.proc) return false
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
    return true
  }

  request(obj, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      if (!this.send({ ...obj, id })) return reject(new Error('Accessibility helper is not available'))
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Accessibility helper timed out on "${obj.cmd}"`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  stop() {
    if (!this.proc) return
    try { this.proc.stdin.end() } catch { /* already closed */ }
    const proc = this.proc
    setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, 300)
    this.proc = null
  }
}

module.exports = { AxHelper, helperPath }
