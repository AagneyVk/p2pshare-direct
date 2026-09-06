const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

class QuicBridgeController extends EventEmitter {
  constructor(app, options = {}) {
    super()
    this.app = app
    this.options = options
    this.child = null
    this.pending = new Map()
    this.directory = options.directory || path.join(app.getPath('userData'), 'quic-received')
    this.outbound = false
    this.received = new Map()
  }
  bindWindow() {}
  event(event) { this.emit('event', event) }
  start() {
    if (this.child) return
    const binary = process.platform === 'win32' ? 'p2pshare-engine.exe' : 'p2pshare-engine'
    const executable = this.options.executable || (this.app.isPackaged
      ? path.join(process.resourcesPath, binary)
      : path.join(__dirname, '..', 'transport-core', 'target', 'release', binary))
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (this.child !== child) return
      buffer += chunk
      if (buffer.length > 65536) { this.disconnect(); return }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        try { this.handle(JSON.parse(line)) } catch { this.event({ type: 'error', message: 'Invalid native engine response' }) }
      }
    })
    // Never relay stderr: native failure output could include private paths.
    child.stderr.resume()
    const closed = () => {
      if (this.child !== child) return
      this.child = null
      this.failPending('Native QUIC engine stopped. Build it with npm run build:engine.')
      this.event({ type: 'state', state: 'idle' })
      this.event({ type: 'error', message: 'QUIC engine stopped; reconnect to resume partial files.' })
    }
    child.on('error', closed)
    child.on('exit', closed)
    child.stdin.on('error', closed)
  }
  failPending(message) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.pending.clear()
  }
  handle(message) {
    if (message.event === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value)
    } else if (message.event === 'connected') {
      this.event({ type: 'state', state: 'connected' })
    } else if (message.event === 'progress' || message.event === 'received') {
      const done = message.event === 'received'
      if (done) this.received.set(message.id, { path: message.path, name: message.name })
      this.event({ type: 'transfer', transfer: { id: message.id, name: message.name || 'Received file',
        size: message.size, progress: done ? 1 : Math.min(0.999, message.size ? message.bytes / message.size : 0),
        speed: message.speed || 0, done, valid: done ? true : null, incoming: message.incoming ?? true } })
    } else if (message.event === 'error') {
      void this.disconnect()
      this.event({ type: 'error', message: message.message })
    }
  }
  request(op, args, id = randomUUID(), milliseconds = 20000) {
    this.start()
    if (this.pending.size >= 8) return Promise.reject(new Error('Too many pending operations'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native operation timed out')); this.disconnect() }, milliseconds)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ op, id, ...args }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Native engine unavailable')) }
      })
    })
  }
  async createSession() {
    const candidates = this.options.ip ? [] : Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && a.family === 'IPv4')
    const ip = this.options.ip || candidates.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address || candidates[0]?.address
    if (!ip) throw new Error('No LAN IPv4 interface found')
    const ticket = await this.request('host', { ip, directory: this.directory })
    this.event({ type: 'session_code', code: ticket })
    return ticket
  }
  async joinSession(ticket) {
    if (typeof ticket !== 'string' || !ticket.startsWith('p2p3:') || ticket.length > 8192) throw new Error('This mode needs a QUIC v3 ticket from another QUIC desktop')
    await this.request('join', { ticket, directory: this.directory })
  }
  async sendFilePath(source) {
    if (this.outbound) throw new Error('Wait for the current transfer to finish')
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Select a local file')
    this.outbound = true
    const id = randomUUID()
    try {
      const stat = await fs.stat(source)
      if (!stat.isFile()) throw new Error('Select a regular file')
      const result = await this.request('send', { path: source }, id, 6 * 60 * 60 * 1000)
      this.event({ type: 'transfer', transfer: { id, name: path.basename(source), size: stat.size,
        progress: 1, speed: 0, done: true, valid: true, incoming: false } })
      this.emit('verified', result)
      return id
    } finally { this.outbound = false }
  }
  async sendMessage() { throw new Error('QUIC preview supports files only; use legacy mode for chat') }
  async beginFile() { throw new Error('QUIC requires a real local file; renderer compression is disabled') }
  async disconnect() {
    const child = this.child; this.child = null
    this.received.clear()
    this.failPending('Disconnected')
    if (child) await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.stdin.end(); child.kill()
    })
    this.event({ type: 'state', state: 'idle' })
  }
}
module.exports = { QuicBridgeController }
