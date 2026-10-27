// Client for the macOS Accessibility helper (native/axhelper.swift). Spawns the helper on first
// use, sends newline-delimited JSON commands, matches replies by id and re-emits the helper's
// events ('focus', 'text', 'moved', 'blur', 'ready', 'exit'). Everything is best effort: when the
// helper is missing (other platforms, no Swift toolchain) `available()` is false and callers fall
// back to the clipboard.
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { app } = require('electron')

function helperPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'axhelper') : path.join(__dirname, '..', 'native', 'build', 'axhelper')
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
    return process.platform === 'darwin' && existsSync(helperPath())
  }

  start() {
    if (this.proc || !this.available()) return
    const proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] })
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
