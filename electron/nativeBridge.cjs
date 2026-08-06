const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { encodeTicket, decodeTicket } = require('./ConnectionTicket.cjs')

let RustPacketCrypto = null
let rustSha256File = null
let rustZstdDecompressFile = null
try {
  const nativeCore = require('./p2pshare_native.node')
  RustPacketCrypto = nativeCore.PacketCrypto
  rustSha256File = nativeCore.sha256File
  rustZstdDecompressFile = nativeCore.zstdDecompressFile
} catch (_) {
  // Portable fallback for machines without a compiled native core.
}

// ══════════════════════════════════════════════════════════════════════════════
// 🎯 CONSTANTS CONFIGURATION FRAMEWORK
// ══════════════════════════════════════════════════════════════════════════════
// 
// These constants implement a "network-aware, file-size-aware" optimization strategy.
// Core Principle: "Adapt sender pacing, flow window, and repair strategy based on:
//                  (1) Network conditions (RTT, loss, BDP)
//                  (2) File size (GB-scale files use bulk tuning)
//                  (3) Transfer phase (startup → steady → recovery)"
//
// KEY DECISION BOUNDARIES:
// 
// ┌─ BANDWIDTH PROFILES (Pacing Rate)
// │  • LAN (RTT<5ms):        10GB/s   (wire-speed; no gain scaling)
// │  • Internet default:     768MB/s  (2.5x gain → quick ramp)
// │  • Bulk (≥1GB):          1536MB/s (aggressive startup for GB transfers)
// │  ↳ Rationale: Match observed delivery rate; startup 2.5x to fill network capacity
// │
// ├─ FLOW WINDOW PROFILES (Max in-flight data)
// │  • Internet default:    256MB    (handles ~100ms RTT + peer ACK loss)
// │  • LAN:                 512MB    (4× for high-BDP paths; reduce congestion oscillation)
// │  • Bulk (≥1GB):         768MB    (supports ~400ms RTT × 2Gbps estimated BW)
// │  ↳ Rationale: Window ≈ 2-3× (bandwidth × RTT). Larger window absorbs ACK droughts
// │
// ├─ ACK STEP PROFILES (Granularity of flow control)
// │  • LAN:                 512KB    (frequent ACKs; fine-grained pacing feedback)
// │  • Internet default:    8MB      (balanced; one ACK per 8MB received)
// │  • High-loss (>1%):     16MB (fewer ACKs reduce loss impact; less chatter)
// │  ↳ Rationale: Tradeoff between pacing responsiveness vs ACK overhead
// │
// ├─ LOSS RECOVERY (BitTorrent + QUIC hybrid)
// │  • Reorder window:      40ms  (RACK: wait before treating reordered as lost)
// │  • Loss backoff:        0.75x (apply RTT-based cooldown + pacing backoff)
// │  • Parity group:        32 chunks (1 parity per 32; 3.1% overhead; recovers 1 missing)
// │  • Adaptive parity:     1x normal → 2x under loss bursts (>0.5%)
// │  ↳ Rationale: Gradual backoff avoids packet storms; parity reduces retransmit overhead
// │
// ├─ MULTI-STREAM DECISION (Parallelizes SACK + FLOW credit)
// │  File size → Stream count (each stream = independent SACK + flow credit)
// │    <64MB:    1 stream  (simple path; single RTT sufficient)
// │    64-256MB: 2 streams (parallelizes repair routing)
// │    256-512MB:4 streams (reduces per-stream congestion window stalls)
// │    512MB-1GB:8 streams
// │    1GB+:     12 streams (bulk mode)
// │    2GB+:     16 streams (max practical parallelism)
// │  ↳ Rationale: Each stream gets independent repair/ACK flow; reduces head-of-line blocking
// │
// └─ COMPRESSION (Selective deflate based on file type heuristic)
//    Compress if first 32KB reduces by >10% after deflate
//    ↳ Rationale: 50-70% bandwidth savings on text; 0 cost on incompressible (images, video)
//
// ══════════════════════════════════════════════════════════════════════════════

const QUIC_MAGIC = 0x51325053
const UDP_PORT = 45882
const STUN_MAGIC_COOKIE = 0x2112A442
const STUN_BINDING_REQUEST = 0x0001
const STUN_BINDING_SUCCESS = 0x0101
const STUN_XOR_MAPPED_ADDRESS = 0x0020
const STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
]
const STUN_TIMEOUT_MS = 1500
const HOLE_PUNCH_INTERVAL_MS = 180
const HOLE_PUNCH_DURATION_MS = 8000
const CHUNK_SIZE = 1400  // ✅ Fits in 1500 MTU with headers; balance overhead vs latency
const ENABLE_SENDER_SPOOL = true
const ENABLE_PARITY = true
const FLOW_WINDOW_BYTES = 256 * 1024 * 1024  // ✅ Default: handles ~100ms RTT @ 2Gbps
const LAN_FLOW_WINDOW_BYTES = 512 * 1024 * 1024  // ✅ 4× larger on LAN/WiFi (lower congestion oscillation)
const BULK_FLOW_WINDOW_BYTES = 768 * 1024 * 1024  // ✅ GB-scale files need large window
const FLOW_ACK_STEP_BYTES = 4 * 1024 * 1024  // ✅ Was 4MB; being phased to 8MB for balanced ACK rate
const LAN_FLOW_ACK_STEP_BYTES = 512 * 1024  // ✅ Fine-grained on LAN (fast feedback loop)
const BULK_FLOW_ACK_STEP_BYTES = 8 * 1024 * 1024  // ✅ Large ACK step reduces ACK overhead on bulk transfers
const FLOW_ACK_STEP_MIN_BYTES = 512 * 1024  // ✅ Floor: prevent too-frequent ACKs starving sender
const FLOW_ACK_STEP_MAX_BYTES = 64 * 1024 * 1024  // ✅ Ceiling: prevent ACK drought stalling pacing
const FLOW_ACK_FAST_MS = 40  // ✅ Immediate ACK on gap detection (early loss signal)
const FLOW_ACK_SLOW_MS = 120  // ✅ Lazy ACK on full steps (batch acknowledgments)
const FLOW_ACK_MAX_INTERVAL_MS = 25  // ✅ Max wait before forced ACK (prevent stall)
const FLOW_ACK_MIN_INTERVAL_MS = 4  // ✅ Min interval between ACKs (rate-limit sender feedback loop)
const FLOW_ACK_TARGET_INTERVAL_MS = 12  // ✅ Auto-tuning target: 12ms between ACKs (balance responsiveness vs overhead)
const FLOW_GRANT_MAX_BURST_BYTES = FLOW_WINDOW_BYTES
const FLOW_GRANT_FUTURE_SLACK_BYTES = FLOW_WINDOW_BYTES * 2  // ✅ Preemptive credit on good conditions
const ACK_FREQ_RESEND_MS = 600  // ✅ Resend lost ACKs after 600ms
const IMMEDIATE_ACK_RESEND_MS = 24  // ✅ Rapid resend of critical ACKs
const PROGRESS_MS = 100  // ✅ Progress report interval
const ACK_TIMEOUT_MS = 30_000  // ✅ Declare stall if no ACK for 30s
const FLOW_CREDIT_WAIT_TIMEOUT_MS = 8_000  // ✅ Trigger WebRTC fallback if no FLOW grant for 8s
const UDP_SOCKET_BUFFER_BYTES = 32 * 1024 * 1024  // ✅ OS-level socket buffer (prevent OS drops)
const REPAIR_RETRY_MS = 120  // ✅ RTT-based cooldown after loss detected
const MAX_REPAIR_BATCH = 128  // ✅ Batch up to 128 missing seqs in one NACK
const OUTGOING_FINALIZE_TIMEOUT_MS = 120_000  // ✅ Give sender 2min to finish cleanup
const REORDER_BASE_MS = 40  // ✅ RACK reorder window base (wait 40ms before NACK)
const REORDER_MAX_MS = 250  // ✅ Don't wait >250ms (prevent timeout loops)
const LAN_REORDER_BASE_MS = 1  // ✅ Sub-millisecond reorder window on LAN (lower RTT variance)
const LAN_REORDER_MAX_MS = 5  // ✅ LAN cap: 5ms
const LOSS_BACKOFF_FACTOR = 0.75  // ✅ Reduce pacing by 25% on loss (smooth recovery)
const LAN_LOSS_BACKOFF_FACTOR = 0.95  // ✅ Almost no backoff on stable WiFi (RTT<5ms)
const LOSS_BACKOFF_MIN_INTERVAL_MS = 20  // ✅ Rate-limit loss backoff triggers
const PROBE_UP_FACTOR = 1.12  // ✅ Gentle recovery: +12% per good grant (avoid oscillation)
const PROBE_UP_MIN_INTERVAL_MS = 120  // ✅ Require 120ms stability before probe-up retry
const PROBE_UP_MIN_GRANTS = 2  // ✅ Require 2 consecutive good grants before recovering
const PARITY_GROUP_SIZE = 32  // ✅ 1 parity per 32 chunks (3.1% FEC overhead; recovers 1 missing)
const PACER_GAIN = 1.0
const PACER_MIN_BPS = 256 * 1024  // ✅ Floor: 256 KB/s (very slow paths)
const PACER_MAX_BPS = 2 * 1024 * 1024 * 1024  // ✅ Ceiling: 2 GB/s (prevent overflow on local loopback)
const PACER_DEFAULT_BPS = 32 * 1024 * 1024
const BULK_PACER_DEFAULT_BPS = 64 * 1024 * 1024
const LAN_PACER_DEFAULT_BPS = 256 * 1024 * 1024
const WAN_STARTUP_CREDIT_BYTES = 4 * 1024 * 1024
const LAN_STARTUP_CREDIT_BYTES = 16 * 1024 * 1024
const LAN_PACER_GAIN = 1.0  // ✅ No pacing gain scaling on LAN (already at capacity)
const BBR_MIN_WINDOW_BYTES = 512 * 1024  // ✅ Minimum congestion window (512KB, prevent tiny cwnd)
const BBR_CWND_GAIN = 2.0  // ✅ Multiplicative factor for estimated BDP in startup
const BBR_BW_DECAY = 0.97  // ✅ EWMA decay for bandwidth estimate (0.97 = 3% new, 97% old)
const BBR_MIN_RTT_FILTER_MS = 10_000  // ✅ Track min RTT over 10s window (ignore outliers)
const BBR_CYCLE_MIN_MS = 120  // ✅ Minimum time in each BBR gain phase
const BBR_PACING_GAINS = [1.4, 0.85, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]  // ✅ BBR gain cycle (startup 1.4x, drain 0.85x, steady 1.0x)
const UDP_SEND_MAX_INFLIGHT = 512  // ✅ OS queue limit before apply backpressure
const UDP_SEND_RESUME_THRESHOLD = 256  // ✅ Resume sending when queue drops below 256
const INCOMING_FLUSH_BYTES = 4 * 1024 * 1024  // ✅ Flush to disk every 4MB received
const INCOMING_FLUSH_INTERVAL_MS = 5  // ✅ Or every 5ms (whichever first)
const INCOMING_FLUSH_BYTES_MIN = 1024 * 1024  // ✅ Auto-tune floor: 1MB
const INCOMING_FLUSH_BYTES_MAX = 16 * 1024 * 1024  // ✅ Auto-tune ceiling: 16MB
const INCOMING_FLUSH_INTERVAL_MIN_MS = 2  // ✅ Auto-tune floor: 2ms
const INCOMING_FLUSH_INTERVAL_MAX_MS = 8  // ✅ Auto-tune ceiling: 8ms
const BULK_INCOMING_FLUSH_BYTES = 16 * 1024 * 1024  // ✅ Bulk files: 16MB chunks (larger for throughput)
const BULK_INCOMING_FLUSH_INTERVAL_MS = 8  // ✅ Bulk files: 8ms intervals
const LAN_INCOMING_FLUSH_BYTES = 16 * 1024 * 1024  // ✅ LAN: aggressive flush (low latency)
const LAN_INCOMING_FLUSH_INTERVAL_MS = 10  // ✅ LAN: 10ms interval
const RESEND_CACHE_MAX_BYTES = 128 * 1024 * 1024  // ✅ Keep 128MB in RAM (avoid disk re-reads on retransmit)
const PROTOCOL_VERSION = 2  // ✅ Wire protocol version (bump if packet format changes)
const FILE_ID_BYTES = 16  // ✅ 16-byte file UUID in each packet header
const HEADER_BYTES = 6  // ✅ 6-byte header (type + reserved)
const CHUNK_PACKET_OVERHEAD = HEADER_BYTES + FILE_ID_BYTES + 8  // ✅ 30 bytes total overhead per chunk packet
const MTU_PROBE_TIMEOUT_MS = 220  // ✅ Wait 220ms for MTU probe reply
const MTU_PROBE_CANDIDATE_CHUNKS = [8972, 4096, 1432, 1400, 1280]  // ✅ Try progressively smaller MTUs
const MAX_REPAIR_RANGE_BATCH = 32  // ✅ Compress up to 32 seq ranges in SACK (reduce ACK size)
const REPAIR_COALESCE_MS = 14  // ✅ Batch NACKs for 14ms before sending (reduce control traffic)
const PARITY_REPEAT_MIN = 1  // ✅ Minimum parity multiplicity (1x = send once)
const PARITY_REPEAT_MAX = 2  // ✅ Maximum parity multiplicity (2x = send twice under loss)
const ADAPTIVE_FEC_LOSS_HIGH_PCT = 0.05  // ✅ Trigger 2x parity if loss > 5%
const ADAPTIVE_FEC_LOSS_MEDIUM_PCT = 0.02  // ✅ Trigger adaptive tuning if loss > 2%
const ADAPTIVE_FEC_GROUP_MIN = 8  // ✅ Minimum FEC group size (reduce to adapt to high loss)
const ADAPTIVE_FEC_GROUP_MAX = 64  // ✅ Maximum FEC group size (increase for efficiency on good paths)
const STRIPED_TRANSFER_MODE = true  // ✅ Enable multi-stream striping for large files
const DEFAULT_STREAM_COUNT = 1
const CONGESTION_DETECTION_WINDOW = 5000
const CONGESTION_LOSS_THRESHOLD_PCT = 0.03

const PKT_HELLO = 1
const PKT_HELLO_ACK = 2
const PKT_CHAT = 3
const PKT_CHAT_ACK = 4
const PKT_OFFER = 5
const PKT_CHUNK = 6
const PKT_DONE = 7
const PKT_FLOW = 8
const PKT_REPAIR = 9
const PKT_COMPLETE = 10
const PKT_PARITY = 11
const PKT_MTU_PROBE = 12
const PKT_MTU_ACK = 13
const PKT_REPAIR_RANGE = 14
const PKT_ACK_FREQ = 15
const PKT_IMMEDIATE_ACK = 16
const PKT_ENCRYPTED = 17
const CAP_ZSTD = 1

function encodeFixedString(text, length) {
  const out = Buffer.alloc(length)
  Buffer.from(String(text), 'utf8').copy(out, 0, 0, length)
  return out
}

function normalizeFileId(fileId) {
  const compact = String(fileId || '').replace(/-/g, '').trim().toLowerCase()
  if (compact.length !== 32) return Buffer.alloc(FILE_ID_BYTES)
  return Buffer.from(compact, 'hex')
}

function decodeFileId(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== FILE_ID_BYTES) return ''
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function decodeFixedString(buf, offset, length) {
  return Buffer.from(buf.subarray(offset, offset + length)).toString('utf8').replace(/\0+$/g, '').trim()
}

function encodeSizedString(text) {
  const bytes = Buffer.from(String(text), 'utf8')
  const out = Buffer.alloc(2 + bytes.length)
  out.writeUInt16BE(bytes.length, 0)
  bytes.copy(out, 2)
  return out
}

function readSizedString(buf, offset) {
  if (offset + 2 > buf.length) return null
  const len = buf.readUInt16BE(offset)
  const start = offset + 2
  const end = start + len
  if (end > buf.length) return null
  return { value: Buffer.from(buf.subarray(start, end)).toString('utf8'), next: end }
}

function looksLikeSha256Hex(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

function computeFileSha256HexSync(filePath) {
  if (rustSha256File) return rustSha256File(filePath)
  const fd = fs.openSync(filePath, 'r')
  const hasher = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      hasher.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hasher.digest('hex')
}

function getCheckpointPath(fileId) {
  return path.join(os.tmpdir(), `p2pshare_checkpoint_${fileId}.json`)
}

function saveCheckpoint(fileId, checkpoint) {
  const checkpointPath = getCheckpointPath(fileId)
  try {
    const data = {
      fileId,
      timestamp: Date.now(),
      incomingSeqs: checkpoint.receivedSeqs ? Array.from(checkpoint.receivedSeqs).sort((a, b) => a - b) : [],
      receivedBytes: checkpoint.receivedBytes || 0,
      totalChunks: checkpoint.chunks || 0,
      tempPath: checkpoint.tempPath || '',
      encoding: checkpoint.encoding || 'none',
      sentBytes: checkpoint.sentBytes || 0,
      highestSentSeq: checkpoint.highestSentSeq || -1,
    }
    fs.writeFileSync(checkpointPath, JSON.stringify(data, null, 2))
  } catch (err) {
    console.warn(`Failed to save checkpoint ${fileId}: ${err.message || err}`)
  }
}

function loadCheckpoint(fileId) {
  const checkpointPath = getCheckpointPath(fileId)
  try {
    if (!fs.existsSync(checkpointPath)) return null
    const data = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
    if (!data.timestamp || Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(checkpointPath)
      return null
    }
    return data
  } catch (err) {
    console.warn(`Failed to load checkpoint ${fileId}: ${err.message || err}`)
    return null
  }
}

function clearCheckpoint(fileId) {
  const checkpointPath = getCheckpointPath(fileId)
  try {
    if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath)
  } catch (err) {
    console.warn(`Failed to clear checkpoint ${fileId}: ${err.message || err}`)
  }
}

function computeAdaptiveFecGroupSize(observedLossPct) {
  if (observedLossPct > ADAPTIVE_FEC_LOSS_HIGH_PCT) {
    return Math.min(ADAPTIVE_FEC_GROUP_MAX, PARITY_GROUP_SIZE * 2)
  } else if (observedLossPct > ADAPTIVE_FEC_LOSS_MEDIUM_PCT) {
    return PARITY_GROUP_SIZE
  } else {
    return Math.max(ADAPTIVE_FEC_GROUP_MIN, Math.floor(PARITY_GROUP_SIZE / 2))
  }
}

function xorIntoBuffer(target, source) {
  const wordLen = source.length >>> 2
  if (wordLen > 0) {
    const t32 = new Uint32Array(target.buffer, target.byteOffset, wordLen)
    const s32 = new Uint32Array(source.buffer, source.byteOffset, wordLen)
    for (let i = 0; i < wordLen; i++) {
      t32[i] ^= s32[i]
    }
  }
  for (let i = wordLen << 2; i < source.length; i++) {
    target[i] ^= source[i]
  }
}

function encodePacket(type, parts = []) {
  return Buffer.concat([Buffer.alloc(5).fill(0), Buffer.from([type]), ...parts])
}

function setMagic(buffer) {
  buffer.writeUInt32BE(QUIC_MAGIC, 0)
}

function makeEndpoint(address, port) {
  if (!address || !port) return null
  return { address, port }
}

function endpointKey(endpoint) {
  return endpoint ? `${endpoint.address}:${endpoint.port}` : ''
}

function getLocalIPv4() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    const entries = nets[name] || []
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function getLocalIPv4Candidates(port) {
  const endpoints = []
  const seen = new Set()
  const nets = os.networkInterfaces()
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const key = `${entry.address}:${port}`
      if (seen.has(key)) continue
      seen.add(key)
      endpoints.push(makeEndpoint(entry.address, port))
    }
  }
  return endpoints.filter(Boolean)
}

function buildStunBindingRequest(transactionId) {
  const packet = Buffer.alloc(20)
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  packet.writeUInt16BE(0, 2)
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  transactionId.copy(packet, 8)
  return packet
}

function parseStunMappedEndpoint(packet) {
  if (packet.length < 20 || packet.readUInt16BE(0) !== STUN_BINDING_SUCCESS) return null
  if (packet.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2))
  for (let offset = 20; offset + 4 <= end;) {
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 2)
    const value = offset + 4
    if (value + length > end) return null
    if (type === STUN_XOR_MAPPED_ADDRESS && length >= 8 && packet.readUInt8(value + 1) === 0x01) {
      const port = packet.readUInt16BE(value + 2) ^ (STUN_MAGIC_COOKIE >>> 16)
      const address = [0, 1, 2, 3]
        .map((i) => packet.readUInt8(value + 4 + i) ^ ((STUN_MAGIC_COOKIE >>> (24 - i * 8)) & 0xff))
        .join('.')
      return makeEndpoint(address, port)
    }
    offset = value + ((length + 3) & ~3)
  }
  return null
}

function isLanPeer(localIp, remoteIp) {
  if (!localIp || !remoteIp) return false
  try {
    const local = localIp.split('.').map(Number)
    const remote = remoteIp.split('.').map(Number)
    // Same /24 subnet check (simple LAN heuristic)
    return local[0] === remote[0] && local[1] === remote[1] && local[2] === remote[2]
  } catch (_) {
    return false
  }
}

function isPublicIPv4(address) {
  const p = String(address || '').split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n))) return false
  return !(p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127))
}

function recommendedStreamCount(fileSize) {
  if (!STRIPED_TRANSFER_MODE) return 1
  if (fileSize >= 512 * 1024 * 1024) return 4
  if (fileSize >= 256 * 1024 * 1024) return 3
  if (fileSize >= 64 * 1024 * 1024) return 2
  return 1
}

class NativeBridgeController extends EventEmitter {
  constructor(electronApp) {
    super()
    this.app = electronApp
    this.window = null
    this.role = 'host'
    this.sessionCode = ''
    this.socket = null
    this.peerEndpoint = null
    this.currentLocalEndpoint = null
    this.outgoing = new Map()
    this.incoming = new Map()
    this.pendingCredits = new Map()
    this.creditWaiters = new Map()
    this.pendingAcks = new Map()
    this.pendingMtuProbes = new Map()
    this.pendingStun = new Map()
    this.localCandidates = []
    this.remoteCandidates = []
    this.holePunchTimer = null
    this.socketReady = null
    this.ticketSecret = null
    this.localHandshakeNonce = null
    this.remoteHandshakeNonce = null
    this.sessionKey = null
    this.rustCrypto = null
    this.sendNoncePrefix = null
    this.receiveNoncePrefix = null
    this.sendCounter = 0n
    this.receivedCounters = new Set()
    this.peerCapabilities = 0
    this.peerChunkSizeCache = new Map()
    this.pendingRepairSeqs = new Map()
    this.pendingRepairTimers = new Map()
    this.udpSendInflight = 0
    this.udpSendWaiters = []
    this.status = 'idle'
  }

  bindWindow(win) {
    this.window = win
  }

  emitState(state) {
    this.status = state
    this.emitToRenderer({ type: 'state', state })
  }

  emitSessionCode(code) {
    this.sessionCode = code
    this.emitToRenderer({ type: 'session_code', code })
  }

  emitError(message) {
    this.emitToRenderer({ type: 'error', message })
  }

  emitToRenderer(event) {
    this.emit('event', event)
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('p2p-native:event', event)
    }
  }

  ensureSocket() {
    if (this.socket && !this.socket.closed) return this.socket
    const socket = dgram.createSocket('udp4')
    socket.on('message', (msg, rinfo) => {
      if (!this.handleStunPacket(msg)) this.handlePacket(msg, rinfo)
    })
    socket.on('error', (err) => this.emitError(String(err.message || err)))
    socket.on('listening', () => {
      try {
        socket.setRecvBufferSize(UDP_SOCKET_BUFFER_BYTES)
        socket.setSendBufferSize(UDP_SOCKET_BUFFER_BYTES)
      } catch (e) {
        this.emitError(`UDP socket buffer tuning failed: ${e.message || e}`)
      }
    })
    this.socketReady = new Promise((resolve, reject) => {
      socket.once('listening', resolve)
      socket.once('error', reject)
    })
    socket.bind(UDP_PORT)
    this.socket = socket
    this.currentLocalEndpoint = makeEndpoint(getLocalIPv4(), UDP_PORT)
    return socket
  }

  handleStunPacket(msg) {
    if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return false
    const transactionId = msg.subarray(8, 20).toString('hex')
    const pending = this.pendingStun.get(transactionId)
    if (!pending) return true
    const endpoint = parseStunMappedEndpoint(msg)
    if (endpoint) pending(endpoint)
    return true
  }

  async discoverPublicEndpoint(server) {
    const socket = this.ensureSocket()
    await this.socketReady
    const transactionId = crypto.randomBytes(12)
    const key = transactionId.toString('hex')
    const request = buildStunBindingRequest(transactionId)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingStun.delete(key)
        resolve(null)
      }, STUN_TIMEOUT_MS)
      this.pendingStun.set(key, (endpoint) => {
        clearTimeout(timer)
        this.pendingStun.delete(key)
        resolve(endpoint)
      })
      socket.send(request, server.port, server.host, (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pendingStun.delete(key)
        resolve(null)
      })
    })
  }

  async gatherNativeCandidates() {
    this.ensureSocket()
    await this.socketReady
    const port = this.socket.address().port
    const candidates = getLocalIPv4Candidates(port)
    const publicResults = await Promise.all(STUN_SERVERS.map((server) => this.discoverPublicEndpoint(server)))
    for (const endpoint of publicResults) if (endpoint) candidates.push(endpoint)
    const unique = new Map(candidates.filter(Boolean).map((endpoint) => [endpointKey(endpoint), endpoint]))
    this.localCandidates = Array.from(unique.values())
    this.currentLocalEndpoint = this.localCandidates[0] || makeEndpoint(getLocalIPv4(), port)
    return this.localCandidates
  }

  startHolePunch(candidates) {
    const unique = new Map((candidates || []).filter((endpoint) => endpoint?.address && endpoint?.port)
      .map((endpoint) => [endpointKey(endpoint), makeEndpoint(endpoint.address, Number(endpoint.port))]))
    this.remoteCandidates = Array.from(unique.values())
    if (this.remoteCandidates.length === 0) return
    if (this.holePunchTimer) clearInterval(this.holePunchTimer)
    const startedAt = Date.now()
    const probe = () => {
      if (this.status === 'connected' || Date.now() - startedAt >= HOLE_PUNCH_DURATION_MS) {
        clearInterval(this.holePunchTimer)
        this.holePunchTimer = null
        return
      }
      for (const endpoint of this.remoteCandidates) {
        this.sendHelloTo(endpoint).catch(() => undefined)
      }
    }
    probe()
    this.holePunchTimer = setInterval(probe, HOLE_PUNCH_INTERVAL_MS)
    this.emitState('connecting')
  }

  async createSession() {
    this.role = 'host'
    this.emitState('creating')
    const candidates = await this.gatherNativeCandidates()
    const publicEndpoint = candidates.find(endpoint => isPublicIPv4(endpoint.address))
    if (!publicEndpoint) throw new Error('Could not discover a public IPv4 endpoint')
    const ticket = encodeTicket(publicEndpoint)
    this.ticketSecret = ticket.secret
    this.sessionCode = ticket.code
    this.emitSessionCode(ticket.code)
    this.emitState('waiting')
    return ticket.code
  }

  async joinSession(code) {
    this.role = 'guest'
    const ticket = decodeTicket(code)
    this.sessionCode = String(code || '').toUpperCase().trim()
    this.ticketSecret = ticket.secret
    this.emitState('joining')
    this.ensureSocket()
    this.startHolePunch([ticket.endpoint])
    return true
  }

  async sendMessage(text) {
    const id = crypto.randomUUID()
    const peer = this.peerEndpoint
    if (!peer) throw new Error('Peer not connected')

    const payload = Buffer.from(String(text), 'utf8')
    const msg = Buffer.concat([
      this.makeHeader(PKT_CHAT),
      encodeFixedString(id, 36),
      encodeSizedString(payload.toString('utf8')),
    ])
    await this.sendBuffer(msg, peer)
    this.pendingAcks.set(id, Date.now())
    setTimeout(() => {
      if (this.pendingAcks.has(id)) this.pendingAcks.delete(id)
    }, ACK_TIMEOUT_MS)
    return id
  }

  async beginFile(meta) {
    const id = crypto.randomUUID()
    const peer = this.peerEndpoint
    if (!peer) throw new Error('Peer not connected')
    const requestedChunkSize = Number(meta?.chunkSize) > 0 ? Number(meta.chunkSize) : CHUNK_SIZE
    const chunkSize = await this.negotiateChunkSize(peer, requestedChunkSize)
    const chunks = Number(meta?.chunks) > 0 ? Number(meta.chunks) : Math.ceil(Number(meta?.size || 0) / chunkSize)
    const normalizedMeta = {
      ...meta,
      chunkSize,
      chunks,
    }
    const isLan = isLanPeer(this.currentLocalEndpoint?.address, peer.address)
    const isBulk = Number(normalizedMeta.size) >= 1024 * 1024 * 1024
    const streamCount = recommendedStreamCount(normalizedMeta.size)
    const tempPath = ENABLE_SENDER_SPOOL ? path.join(os.tmpdir(), `p2pshare_out_${id}.tmp`) : null
    const fd = ENABLE_SENDER_SPOOL ? fs.openSync(tempPath, 'w+') : null
    const flowWindow = isLan ? LAN_FLOW_WINDOW_BYTES : isBulk ? BULK_FLOW_WINDOW_BYTES : FLOW_WINDOW_BYTES
    const startupCredit = isLan ? LAN_STARTUP_CREDIT_BYTES : WAN_STARTUP_CREDIT_BYTES
    const state = {
      id,
      idBytes: normalizeFileId(id),
      meta: normalizedMeta,
      peer,
      isLan,
      isBulk,
      seq: 0,
      credits: startupCredit,
      waiting: [],
      done: false,
      doneSent: false,
      doneSentAt: 0,
      finalizeTimer: null,
      lastProgressAt: 0,
      sentBytes: 0,
      lastSpeedWindowAt: Date.now(),
      speedBytes: 0,
      measuredSpeedBps: 0,
      pacerNextAt: 0,
      pacingBps: isLan ? LAN_PACER_DEFAULT_BPS : isBulk ? BULK_PACER_DEFAULT_BPS : PACER_DEFAULT_BPS,
      lastFlowAt: 0,
      tempPath,
      fd,
      streamCount,
      parityGroupIndex: 0,
      parityCount: 0,
      ackFreqStepBytes: isLan ? LAN_FLOW_ACK_STEP_BYTES : isBulk ? BULK_FLOW_ACK_STEP_BYTES : FLOW_ACK_STEP_BYTES,
      parityBuffer: Buffer.alloc(chunkSize),
      sendQueue: Promise.resolve(),
      resendCache: new Map(),
      resendOrder: [],
      resendCacheBytes: 0,
      smoothedRttMs: 90,
      lastLossBackoffAt: 0,
      consecutiveFlowGrants: 0,
      lastProbeUpAt: 0,
      parityRepeat: PARITY_REPEAT_MIN,
      bbrMinRttMs: 0,
      bbrMinRttStamp: 0,
      bbrBwBps: isLan ? LAN_PACER_DEFAULT_BPS : isBulk ? BULK_PACER_DEFAULT_BPS : PACER_DEFAULT_BPS,
      bbrCycleIndex: 0,
      bbrCycleStamp: 0,
      dynamicWindowBytes: flowWindow,
      totalGrantedBytes: startupCredit,
      lastAckFreqSentAt: 0,
      ackFreqStepBytes: FLOW_ACK_STEP_BYTES,
      ackFreqMinIntervalMs: FLOW_ACK_MIN_INTERVAL_MS,
      ackFreqMaxIntervalMs: FLOW_ACK_MAX_INTERVAL_MS,
      highestSentSeq: -1,
      lastImmediateAckAt: 0,
      lastTailProbeAt: 0,
      fileHasher: crypto.createHash('sha256'),
      adaptiveFecGroupSize: PARITY_GROUP_SIZE,
      parityEnabled: false,
      observedLossPct: 0,
      streamId: 0,
      streamByteOffset: 0,
      streamByteLength: 0,
      congestionDetectionActive: false,
      lastRepairCountSample: 0,
    }
    this.outgoing.set(id, state)
    await this.sendOffer(id, normalizedMeta)
    await this.maybeSendAckFrequency(id, state, true)
    return id
  }

  async sendFilePath(filePath, meta) {
    const resolved = path.resolve(String(filePath || ''))
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('Selected path is not a file')
    const normalized = {
      ...meta,
      name: String(meta?.name || path.basename(resolved)),
      size: stat.size,
      originalSize: stat.size,
      encoding: 'none',
    }
    const id = await this.beginFile(normalized)
    // Return immediately so the renderer can track progress while disk and
    // network work stays wholly in the main process.
    setImmediate(() => {
      this.pumpFilePath(id, resolved).catch((error) => {
        this.cleanupOutgoing(id)
        this.emitError(`native file send failed: ${error?.message || error}`)
      })
    })
    return id
  }

  async pumpFilePath(fileId, filePath) {
    const state = this.outgoing.get(fileId)
    if (!state) throw new Error(`Unknown outgoing transfer ${fileId}`)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(state.meta.chunkSize)
    let seq = 0
    try {
      for (;;) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
        if (bytesRead <= 0) break
        const chunk = Buffer.from(buffer.subarray(0, bytesRead))
        await this.sendChunkPacket(state, fileId, seq, chunk, seq % state.streamCount)
        seq++
      }
    } finally {
      fs.closeSync(fd)
    }
    await this.finishFile(fileId)
  }

  enqueueFileSend(state, work) {
    const run = async () => work()
    state.sendQueue = state.sendQueue.then(run, run)
    return state.sendQueue
  }

  cacheChunkForResend(state, seq, data) {
    const existing = state.resendCache.get(seq)
    if (existing) {
      state.resendCacheBytes -= existing.length
    } else {
      state.resendOrder.push(seq)
    }
    const copy = Buffer.from(data)
    state.resendCache.set(seq, copy)
    state.resendCacheBytes += copy.length

    while (state.resendCacheBytes > RESEND_CACHE_MAX_BYTES && state.resendOrder.length > 0) {
      const oldestSeq = state.resendOrder.shift()
      if (oldestSeq === undefined) break
      const oldest = state.resendCache.get(oldestSeq)
      if (!oldest) continue
      state.resendCache.delete(oldestSeq)
      state.resendCacheBytes -= oldest.length
    }
  }

  async sendChunkPacket(state, fileId, seq, chunk, streamId = 0, isRetransmit = false) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (!isRetransmit) state.fileHasher.update(data)
    if (!isRetransmit) this.cacheChunkForResend(state, seq, data)
    if (!isRetransmit && state.fd !== null) {
      const writeOffset = seq * state.meta.chunkSize
      fs.write(state.fd, data, 0, data.length, writeOffset, (err) => {
        if (err) this.emitError(`sender spool write failed: ${err.message || err}`)
      })
    }
    if (!isRetransmit) await this.waitForCredits(state, data.length)
    await this.waitForPacer(state, data.length)
    const packet = Buffer.allocUnsafe(HEADER_BYTES + FILE_ID_BYTES + 4 + 1 + 4 + data.length)
    packet.writeUInt32BE(QUIC_MAGIC, 0)
    packet.writeUInt8(PROTOCOL_VERSION, 4)
    packet.writeUInt8(PKT_CHUNK, 5)
    state.idBytes.copy(packet, HEADER_BYTES)
    packet.writeUInt32BE(seq >>> 0, HEADER_BYTES + FILE_ID_BYTES)
    packet.writeUInt8(streamId >>> 0, HEADER_BYTES + FILE_ID_BYTES + 4)
    packet.writeUInt32BE(data.length >>> 0, HEADER_BYTES + FILE_ID_BYTES + 5)
    data.copy(packet, HEADER_BYTES + FILE_ID_BYTES + 9)
    await this.sendBufferFast(packet, state.peer)

    if (ENABLE_PARITY && state.parityEnabled && !isRetransmit) {
      xorIntoBuffer(state.parityBuffer, data)
      state.parityCount++
      if (state.parityCount >= state.adaptiveFecGroupSize) {
        await this.sendParityBurst(state, fileId, state.parityGroupIndex, Buffer.from(state.parityBuffer))
        state.parityBuffer = Buffer.alloc(state.meta.chunkSize)
        state.parityCount = 0
        state.parityGroupIndex++
      }
    }
    if (!isRetransmit) state.credits -= data.length
    if (seq > state.highestSentSeq) state.highestSentSeq = seq
    if (!isRetransmit) state.sentBytes += data.length
    if (!isRetransmit) state.speedBytes += data.length
    const now = Date.now()
    if (now - state.lastSpeedWindowAt >= 500) {
      state.measuredSpeedBps = Math.round(state.speedBytes * 1000 / Math.max(1, now - state.lastSpeedWindowAt))
      state.lastSpeedWindowAt = now
      state.speedBytes = 0
    }
    if (now - state.lastProgressAt >= PROGRESS_MS) {
      state.lastProgressAt = now
      const progress = state.meta.size > 0 ? state.sentBytes / state.meta.size : 1
      this.emitTransfer({
        id: fileId,
        name: state.meta.name,
        size: state.meta.size,
        progress,
        speed: state.measuredSpeedBps,
        done: false,
        valid: null,
        incoming: false,
      })
    }
    return true
  }

  async sendFileChunk(fileId, seq, chunk) {
    const state = this.outgoing.get(fileId)
    if (!state) throw new Error(`Unknown outgoing transfer ${fileId}`)
    const streamCount = Math.max(1, Number(state.streamCount) || 1)
    const streamId = seq % streamCount
    return this.enqueueFileSend(state, () => this.sendChunkPacket(state, fileId, seq, chunk, streamId))
  }

  async sendFileChunks(fileId, chunks) {
    const state = this.outgoing.get(fileId)
    if (!state) throw new Error(`Unknown outgoing transfer ${fileId}`)
    if (!Array.isArray(chunks) || chunks.length === 0) return 0
    return this.enqueueFileSend(state, async () => {
      let sent = 0
      const streamCount = Math.max(1, Number(state.streamCount) || 1)
      for (const entry of chunks) {
        if (!entry) continue
        const streamId = Number(entry.streamId) >= 0 ? Number(entry.streamId) : (Number(entry.seq) % streamCount)
        await this.sendChunkPacket(state, fileId, entry.seq, entry.chunk, streamId)
        sent++
      }
      return sent
    })
  }

  async finishFile(fileId) {
    const state = this.outgoing.get(fileId)
    if (!state) throw new Error(`Unknown outgoing transfer ${fileId}`)
    await state.sendQueue
    if (ENABLE_PARITY && state.parityEnabled && state.parityCount > 0) {
      await this.sendParityBurst(state, fileId, state.parityGroupIndex, Buffer.from(state.parityBuffer))
      state.parityBuffer = Buffer.alloc(state.meta.chunkSize)
      state.parityCount = 0
      state.parityGroupIndex++
    }
    const hash = state.fileHasher.digest('hex')
    const packet = Buffer.concat([
      this.makeHeader(PKT_DONE),
      normalizeFileId(fileId),
      encodeFixedString(hash, 64),
    ])
    await this.sendBuffer(packet, state.peer)
    state.doneSent = true
    state.doneSentAt = Date.now()
    if (!state.finalizeTimer) {
      state.finalizeTimer = setTimeout(() => {
        this.cleanupOutgoing(fileId)
      }, OUTGOING_FINALIZE_TIMEOUT_MS)
    }
    this.emitTransfer({
      id: fileId,
      name: state.meta.name,
      size: state.meta.size,
      progress: 1,
      speed: 0,
      done: true,
      valid: true,
      incoming: false,
    })
    return true
  }

  async disconnect() {
    this.outgoing.forEach((state, fileId) => {
      this.cleanupOutgoing(fileId)
    })
    this.outgoing.clear()
    this.incoming.forEach((t) => {
      try { fs.closeSync(t.fd) } catch (_) {}
      try { fs.unlinkSync(t.tempPath) } catch (_) {}
    })
    this.incoming.clear()
    this.pendingCredits.clear()
    this.creditWaiters.clear()
    this.pendingAcks.clear()
    this.pendingMtuProbes.forEach((resolve) => {
      try { resolve(0) } catch (_) {}
    })
    this.pendingMtuProbes.clear()
    this.pendingRepairTimers.forEach((timer) => {
      try { clearTimeout(timer) } catch (_) {}
    })
    this.pendingRepairTimers.clear()
    this.pendingRepairSeqs.clear()
    this.udpSendInflight = 0
    if (this.udpSendWaiters.length > 0) {
      const waiters = this.udpSendWaiters.splice(0)
      waiters.forEach((resolve) => {
        try { resolve() } catch (_) {}
      })
    }
    if (this.socket) {
      try { this.socket.close() } catch (_) {}
      this.socket = null
    }
    if (this.holePunchTimer) {
      clearInterval(this.holePunchTimer)
      this.holePunchTimer = null
    }
    this.pendingStun.clear()
    this.localCandidates = []
    this.remoteCandidates = []
    this.peerEndpoint = null
    this.ticketSecret = null
    this.localHandshakeNonce = null
    this.remoteHandshakeNonce = null
    this.sessionKey = null
    this.rustCrypto = null
    this.sendNoncePrefix = null
    this.receiveNoncePrefix = null
    this.sendCounter = 0n
    this.receivedCounters.clear()
    this.peerCapabilities = 0
    this.emitState('idle')
  }

  subscribe(cb) {
    const handler = (event) => cb(event)
    this.on('event', handler)
    return () => this.off('event', handler)
  }

  async sendHello() {
    const peer = this.peerEndpoint
    if (!peer) throw new Error('Peer endpoint unavailable')
    await this.sendHelloTo(peer)
  }

  handshakeMac(label, ...parts) {
    if (!this.ticketSecret) throw new Error('Connection ticket secret unavailable')
    return crypto.createHmac('sha256', this.ticketSecret)
      .update(label).update(Buffer.concat(parts)).digest().subarray(0, 16)
  }

  async sendHelloTo(endpoint) {
    if (!this.ticketSecret) return
    if (!this.localHandshakeNonce) this.localHandshakeNonce = crypto.randomBytes(16)
    const packet = Buffer.concat([
      this.makeHeader(PKT_HELLO),
      this.localHandshakeNonce,
      this.handshakeMac('hello', this.localHandshakeNonce),
      Buffer.from([rustZstdDecompressFile ? CAP_ZSTD : 0]),
    ])
    await this.sendBufferRaw(packet, endpoint)
  }

  establishSessionKey(guestNonce, hostNonce) {
    this.sessionKey = Buffer.from(crypto.hkdfSync(
      'sha256', this.ticketSecret, Buffer.concat([guestNonce, hostNonce]), Buffer.from('p2pshare-native-v3'), 32
    ))
    this.sendCounter = 0n
    this.receivedCounters.clear()
    const remoteRole = this.role === 'host' ? 'guest' : 'host'
    this.sendNoncePrefix = crypto.createHmac('sha256', this.sessionKey)
      .update(`nonce:${this.role}`).digest().subarray(0, 4)
    this.receiveNoncePrefix = crypto.createHmac('sha256', this.sessionKey)
      .update(`nonce:${remoteRole}`).digest().subarray(0, 4)
    this.rustCrypto = RustPacketCrypto ? new RustPacketCrypto(this.sessionKey, this.role) : null
    console.log(`[CRYPTO] packet engine: ${this.rustCrypto ? 'Rust native' : 'Node fallback'}`)
  }

  async sendHelloAck(guestNonce) {
    const peer = this.peerEndpoint
    if (!peer) return
    if (!this.localHandshakeNonce) this.localHandshakeNonce = crypto.randomBytes(16)
    const packet = Buffer.concat([
      this.makeHeader(PKT_HELLO_ACK),
      this.localHandshakeNonce,
      this.handshakeMac('ack', guestNonce, this.localHandshakeNonce),
      Buffer.from([rustZstdDecompressFile ? CAP_ZSTD : 0]),
    ])
    await this.sendBufferRaw(packet, peer)
  }

  async sendOffer(fileId, meta) {
    const peer = this.peerEndpoint
    if (!peer) throw new Error('Peer endpoint unavailable')
    const chunkSize = Number(meta?.chunkSize) > 0 ? Number(meta.chunkSize) : CHUNK_SIZE
    const chunks = Number(meta?.chunks) > 0 ? Number(meta.chunks) : Math.ceil(Number(meta?.size || 0) / chunkSize)
    const encoding = String(meta?.encoding || 'none')
    const originalSize = Number(meta?.originalSize || meta?.size || 0)
    const packet = Buffer.concat([
      this.makeHeader(PKT_OFFER),
      normalizeFileId(fileId),
      encodeSizedString(meta.name),
      encodeSizedString(meta.mimeType || 'application/octet-stream'),
      this.u64(meta.size),
      this.u32(chunks),
      this.u32(chunkSize),
      encodeSizedString(encoding),
      this.u64(originalSize),
    ])
    await this.sendBufferFast(packet, peer)
  }

  async sendParity(fileId, groupIndex, payload) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_PARITY),
      normalizeFileId(fileId),
      this.u32(groupIndex),
      this.u32(payload.length),
      payload,
    ])
    await this.sendBuffer(packet, peer)
  }

  async sendParityBurst(state, fileId, groupIndex, payload) {
    const repeats = Math.max(PARITY_REPEAT_MIN, Math.min(PARITY_REPEAT_MAX, Number(state?.parityRepeat) || PARITY_REPEAT_MIN))
    for (let i = 0; i < repeats; i++) {
      await this.sendParity(fileId, groupIndex, payload)
    }
  }

  async sendFlow(fileId, grantedBytes) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_FLOW),
      normalizeFileId(fileId),
      this.u64(grantedBytes),
    ])
    await this.sendBuffer(packet, peer)
  }

  async sendAckFrequency(fileId, ackStepBytes, minIntervalMs, maxIntervalMs) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_ACK_FREQ),
      normalizeFileId(fileId),
      this.u64(ackStepBytes),
      this.u16(minIntervalMs),
      this.u16(maxIntervalMs),
    ])
    await this.sendBuffer(packet, peer)
  }

  async sendImmediateAck(fileId) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_IMMEDIATE_ACK),
      normalizeFileId(fileId),
    ])
    await this.sendBuffer(packet, peer)
  }

  async sendRepair(fileId, seqs) {
    const peer = this.peerEndpoint
    if (!peer || !Array.isArray(seqs) || seqs.length === 0) return
    const ranges = this.buildRepairRanges(seqs)
    if (ranges.length > 0 && ranges.length * 2 <= Math.min(MAX_REPAIR_BATCH, seqs.length)) {
      const count = Math.min(MAX_REPAIR_RANGE_BATCH, ranges.length)
      const header = Buffer.concat([
        this.makeHeader(PKT_REPAIR_RANGE),
        normalizeFileId(fileId),
        this.u16(count),
      ])
      const body = Buffer.alloc(count * 8)
      for (let i = 0; i < count; i++) {
        const [start, end] = ranges[i]
        body.writeUInt32BE(start >>> 0, i * 8)
        body.writeUInt32BE(end >>> 0, i * 8 + 4)
      }
      await this.sendBuffer(Buffer.concat([header, body]), peer)
      return
    }
    const count = Math.min(MAX_REPAIR_BATCH, seqs.length)
    const header = Buffer.concat([
      this.makeHeader(PKT_REPAIR),
      normalizeFileId(fileId),
      this.u16(count),
    ])
    const body = Buffer.alloc(count * 4)
    for (let i = 0; i < count; i++) {
      body.writeUInt32BE(seqs[i] >>> 0, i * 4)
    }
    await this.sendBuffer(Buffer.concat([header, body]), peer)
  }

  async sendMtuAck(peer, nonce, acceptedChunkSize) {
    const packet = Buffer.alloc(HEADER_BYTES + 6)
    packet.writeUInt32BE(QUIC_MAGIC, 0)
    packet.writeUInt8(PROTOCOL_VERSION, 4)
    packet.writeUInt8(PKT_MTU_ACK, 5)
    packet.writeUInt32BE(Number(nonce) >>> 0, HEADER_BYTES)
    packet.writeUInt16BE(Math.max(512, Math.min(65535, Number(acceptedChunkSize) || CHUNK_SIZE)), HEADER_BYTES + 4)
    await this.sendBuffer(packet, peer)
  }

  async sendComplete(fileId) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_COMPLETE),
      normalizeFileId(fileId),
    ])
    await this.sendBuffer(packet, peer)
  }

  async sendChatAck(id) {
    const peer = this.peerEndpoint
    if (!peer) return
    const packet = Buffer.concat([
      this.makeHeader(PKT_CHAT_ACK),
      encodeFixedString(id, 36),
    ])
    await this.sendBuffer(packet, peer)
  }

  emitTransfer(transfer) {
    this.emitToRenderer({ type: 'transfer', transfer })
  }

  async waitForCredits(state, bytes) {
    while (state.credits < bytes) {
      this.maybeProbeCreditStall(state)
      await new Promise((resolve, reject) => {
        let wake = null
        const timer = setTimeout(() => {
          if (!wake) return
          const idx = state.waiting.indexOf(wake)
          if (idx >= 0) state.waiting.splice(idx, 1)
          reject(new Error('flow credit stall timeout'))
        }, FLOW_CREDIT_WAIT_TIMEOUT_MS)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
        state.waiting.push(wake)
      })
    }
  }

  maybeProbeCreditStall(state) {
    if (!state || state.done) return
    const now = Date.now()
    const rttMs = Math.max(12, Math.min(500, Math.round(Number(state.smoothedRttMs) || 90)))
    const immediateIntervalMs = Math.max(IMMEDIATE_ACK_RESEND_MS, Math.round(rttMs * 0.35))
    if (now - (state.lastImmediateAckAt || 0) >= immediateIntervalMs) {
      state.lastImmediateAckAt = now
      this.sendImmediateAck(state.id).catch(() => undefined)
    }

    const tailProbeIntervalMs = Math.max(40, Math.min(900, Math.round(rttMs * 1.5)))
    const flowSilenceMs = state.lastFlowAt > 0 ? now - state.lastFlowAt : Number.POSITIVE_INFINITY
    if (
      state.highestSentSeq >= 0 &&
      flowSilenceMs >= tailProbeIntervalMs &&
      now - (state.lastTailProbeAt || 0) >= tailProbeIntervalMs
    ) {
      state.lastTailProbeAt = now
      this.resendChunk(state.id, state.highestSentSeq).catch(() => undefined)
      if (now - (state.lastImmediateAckAt || 0) >= IMMEDIATE_ACK_RESEND_MS) {
        state.lastImmediateAckAt = now
        this.sendImmediateAck(state.id).catch(() => undefined)
      }
    }
  }

  resolveCredits(fileId, bytes) {
    const state = this.outgoing.get(fileId)
    if (!state) return
    const now = Date.now()
    const grantedBytes = this.validateGrantedBytes(state, bytes)
    if (grantedBytes <= 0) return
    let elapsedMs = 0
    if (state.lastFlowAt > 0) {
      elapsedMs = Math.max(1, now - state.lastFlowAt)
      const deliveryBps = (grantedBytes * 1000) / elapsedMs
      if (state.bbrBwBps > 0) {
        state.bbrBwBps = Math.max(deliveryBps, state.bbrBwBps * BBR_BW_DECAY)
      } else {
        state.bbrBwBps = deliveryBps
      }

      if (
        state.bbrMinRttMs <= 0 ||
        elapsedMs < state.bbrMinRttMs ||
        now - (state.bbrMinRttStamp || 0) >= BBR_MIN_RTT_FILTER_MS
      ) {
        state.bbrMinRttMs = elapsedMs
        state.bbrMinRttStamp = now
      }

      state.smoothedRttMs = state.smoothedRttMs > 0
        ? (state.smoothedRttMs * 0.875) + (elapsedMs * 0.125)
        : elapsedMs

      const cycleInterval = Math.max(
        BBR_CYCLE_MIN_MS,
        Math.round(state.bbrMinRttMs || state.smoothedRttMs || 90),
      )
      if (state.bbrCycleStamp <= 0) state.bbrCycleStamp = now
      if (now - state.bbrCycleStamp >= cycleInterval) {
        state.bbrCycleIndex = (state.bbrCycleIndex + 1) % BBR_PACING_GAINS.length
        state.bbrCycleStamp = now
      }

      const pacingGain = BBR_PACING_GAINS[state.bbrCycleIndex] || 1.0
      const modelBw = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, state.bbrBwBps || PACER_DEFAULT_BPS))
      const targetBps = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, modelBw * pacingGain))
      state.pacingBps = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, state.pacingBps * 0.2 + targetBps * 0.8))

      const minRttMs = Math.max(4, Math.round(state.bbrMinRttMs || state.smoothedRttMs || 90))
      const bdpBytes = Math.max(BBR_MIN_WINDOW_BYTES, Math.round((modelBw * minRttMs) / 1000))
      state.dynamicWindowBytes = Math.max(
        BBR_MIN_WINDOW_BYTES,
        Math.min(FLOW_WINDOW_BYTES, Math.round(bdpBytes * BBR_CWND_GAIN)),
      )
    }

    if (elapsedMs > 0 && elapsedMs <= Math.max(4, Math.round((state.smoothedRttMs || 90) * 1.5))) {
      state.consecutiveFlowGrants = (state.consecutiveFlowGrants || 0) + 1
    } else {
      state.consecutiveFlowGrants = 0
    }
    if (
      state.consecutiveFlowGrants >= PROBE_UP_MIN_GRANTS &&
      now - (state.lastProbeUpAt || 0) >= PROBE_UP_MIN_INTERVAL_MS &&
      now - (state.lastLossBackoffAt || 0) >= Math.max(PROBE_UP_MIN_INTERVAL_MS, Math.round((state.smoothedRttMs || 90) * 2))
    ) {
      state.bbrCycleIndex = 0
      state.bbrCycleStamp = now
      state.pacingBps = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, state.pacingBps * PROBE_UP_FACTOR))
      state.lastProbeUpAt = now
      state.consecutiveFlowGrants = 0
      state.parityRepeat = PARITY_REPEAT_MIN
    }

    state.lastFlowAt = now
    state.lastTailProbeAt = 0
    const creditCap = Math.max(
      BBR_MIN_WINDOW_BYTES,
      Math.min(FLOW_WINDOW_BYTES, Number(state.dynamicWindowBytes) || FLOW_WINDOW_BYTES),
    )
    state.credits = Math.min(creditCap, state.credits + grantedBytes)
    state.totalGrantedBytes += grantedBytes
    if (state.waiting.length > 0) {
      const waiters = state.waiting.splice(0)
      waiters.forEach((resolve) => resolve())
    }
    this.maybeSendAckFrequency(fileId, state).catch(() => undefined)
  }

  validateGrantedBytes(state, bytes) {
    const granted = Math.max(0, Number(bytes) || 0)
    if (granted <= 0) return 0
    const creditCap = Math.max(
      BBR_MIN_WINDOW_BYTES,
      Math.min(FLOW_WINDOW_BYTES, Number(state.dynamicWindowBytes) || FLOW_WINDOW_BYTES),
    )
    const maxBurst = Math.max(FLOW_ACK_STEP_MAX_BYTES * 2, Math.min(FLOW_GRANT_MAX_BURST_BYTES, creditCap * 2))
    if (granted > maxBurst) return 0

    const sentBytes = Math.max(0, Number(state.sentBytes) || 0)
    const grantedSoFar = Math.max(0, Number(state.totalGrantedBytes) || FLOW_WINDOW_BYTES)
    const futureCap = sentBytes + Math.max(FLOW_ACK_STEP_MAX_BYTES, creditCap + FLOW_GRANT_FUTURE_SLACK_BYTES)
    if (grantedSoFar >= futureCap) return 0
    return Math.min(granted, futureCap - grantedSoFar)
  }

  computeAckFrequencyPolicy(state) {
    const rttMs = Math.max(FLOW_ACK_MIN_INTERVAL_MS, Math.min(250, Math.round(Number(state.smoothedRttMs) || 90)))
    const minIntervalMs = Math.max(FLOW_ACK_MIN_INTERVAL_MS, Math.min(FLOW_ACK_MAX_INTERVAL_MS, Math.round(rttMs * 0.2)))
    const maxIntervalMs = Math.max(minIntervalMs, Math.min(120, Math.round(rttMs * 0.8)))
    const pacing = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, Number(state.pacingBps) || PACER_DEFAULT_BPS))
    const stepFromRate = Math.round((pacing * maxIntervalMs) / 1000)
    const step = Math.max(
      FLOW_ACK_STEP_MIN_BYTES,
      Math.min(
        FLOW_ACK_STEP_MAX_BYTES,
        Math.max((Number(state.meta?.chunkSize) || CHUNK_SIZE) * 2, stepFromRate),
      ),
    )
    return { step, minIntervalMs, maxIntervalMs }
  }

  async maybeSendAckFrequency(fileId, state, force = false) {
    if (!state || state.done) return
    const now = Date.now()
    const nextPolicy = this.computeAckFrequencyPolicy(state)
    const changed =
      Math.abs((state.ackFreqStepBytes || 0) - nextPolicy.step) >= Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.floor(nextPolicy.step * 0.2)) ||
      Math.abs((state.ackFreqMinIntervalMs || 0) - nextPolicy.minIntervalMs) >= 2 ||
      Math.abs((state.ackFreqMaxIntervalMs || 0) - nextPolicy.maxIntervalMs) >= 2
    if (!force && !changed && now - (state.lastAckFreqSentAt || 0) < ACK_FREQ_RESEND_MS) return
    state.ackFreqStepBytes = nextPolicy.step
    state.ackFreqMinIntervalMs = nextPolicy.minIntervalMs
    state.ackFreqMaxIntervalMs = nextPolicy.maxIntervalMs
    state.lastAckFreqSentAt = now
    await this.sendAckFrequency(fileId, nextPolicy.step, nextPolicy.minIntervalMs, nextPolicy.maxIntervalMs)
  }

  applyAckFrequency(transfer, ackStepBytes, minIntervalMs, maxIntervalMs) {
    if (!transfer) return
    const step = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.min(FLOW_ACK_STEP_MAX_BYTES, Math.round(Number(ackStepBytes) || 0)))
    const minMs = Math.max(FLOW_ACK_MIN_INTERVAL_MS, Math.min(120, Math.round(Number(minIntervalMs) || FLOW_ACK_MIN_INTERVAL_MS)))
    const maxMsRaw = Math.max(minMs, Math.round(Number(maxIntervalMs) || FLOW_ACK_MAX_INTERVAL_MS))
    const maxMs = Math.max(minMs, Math.min(240, maxMsRaw))
    transfer.remoteAckStep = step
    transfer.remoteAckMinIntervalMs = minMs
    transfer.remoteAckMaxIntervalMs = maxMs
  }

  flowAckPolicy(transfer) {
    const remoteStep = Math.max(0, Number(transfer.remoteAckStep) || 0)
    const remoteMin = Math.max(0, Number(transfer.remoteAckMinIntervalMs) || 0)
    const remoteMax = Math.max(0, Number(transfer.remoteAckMaxIntervalMs) || 0)
    const step = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.min(FLOW_ACK_STEP_MAX_BYTES, Math.max(Number(transfer.flowAckStep) || FLOW_ACK_STEP_BYTES, remoteStep)))
    const minIntervalMs = Math.max(FLOW_ACK_MIN_INTERVAL_MS, Math.min(120, Math.max(FLOW_ACK_MIN_INTERVAL_MS, remoteMin || FLOW_ACK_MIN_INTERVAL_MS)))
    const maxIntervalMs = Math.max(minIntervalMs, Math.min(240, Math.max(FLOW_ACK_MAX_INTERVAL_MS, remoteMax || FLOW_ACK_MAX_INTERVAL_MS)))
    const targetIntervalMs = Math.max(minIntervalMs, Math.min(maxIntervalMs, Math.max(FLOW_ACK_TARGET_INTERVAL_MS, Math.round(maxIntervalMs * 0.6))))
    return { step, minIntervalMs, targetIntervalMs, maxIntervalMs }
  }

  applyLossBackoff(fileId, lossCount) {
    const state = this.outgoing.get(fileId)
    if (!state) return
    const now = Date.now()
    const minInterval = Math.max(LOSS_BACKOFF_MIN_INTERVAL_MS, Math.min(1000, Math.round(state.smoothedRttMs || 90)))
    if (now - state.lastLossBackoffAt < minInterval) return
    const baseFactor = state.isLan ? LAN_LOSS_BACKOFF_FACTOR : LOSS_BACKOFF_FACTOR
    const factor = Math.max(state.isLan ? 0.85 : 0.5, baseFactor - (Math.min(8, Number(lossCount) || 1) * 0.02))
    state.pacingBps = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, state.pacingBps * factor))
    state.bbrBwBps = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, (state.bbrBwBps || PACER_DEFAULT_BPS) * 0.9))
    const maxWindow = state.isLan ? LAN_FLOW_WINDOW_BYTES : FLOW_WINDOW_BYTES
    state.dynamicWindowBytes = Math.max(
      BBR_MIN_WINDOW_BYTES,
      Math.min(maxWindow, Math.round((state.dynamicWindowBytes || maxWindow) * 0.85)),
    )
    state.bbrCycleIndex = 1
    state.bbrCycleStamp = now
    state.lastLossBackoffAt = now
    state.consecutiveFlowGrants = 0
    state.parityRepeat = Math.min(PARITY_REPEAT_MAX, PARITY_REPEAT_MIN + (Number(lossCount) >= 2 ? 1 : 0))
    state.parityEnabled = true
  }

  async waitForPacer(state, bytes) {
    const rate = Math.max(PACER_MIN_BPS, Math.min(PACER_MAX_BPS, Number(state.pacingBps) || PACER_DEFAULT_BPS))
    const now = Date.now()
    if (state.pacerNextAt <= 0 || state.pacerNextAt < now) {
      state.pacerNextAt = now
    }
    const spacingMs = Math.max(0, (Number(bytes) / rate) * 1000 / PACER_GAIN)
    const waitMs = Math.max(0, state.pacerNextAt - now)
    state.pacerNextAt += spacingMs
    if (waitMs <= 0) return
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  chunkLength(meta, seq) {
    const base = seq * meta.chunkSize
    const remaining = Math.max(0, Number(meta.size) - base)
    return Math.min(meta.chunkSize, remaining)
  }

  getMissingSeqs(transfer, maxCount = MAX_REPAIR_BATCH) {
    if (!transfer || transfer.chunks <= 0) return []
    const missing = []
    for (let i = 0; i < transfer.chunks; i++) {
      if (!transfer.receivedSeqs.has(i)) {
        missing.push(i)
        if (missing.length >= maxCount) break
      }
    }
    return missing
  }

  getMissingFromContiguous(transfer, maxCount = MAX_REPAIR_BATCH) {
    if (!transfer || transfer.chunks <= 0) return []
    if (transfer.contiguousSeq > transfer.highestSeqSeen) return []
    const upper = Math.min(transfer.chunks - 1, transfer.highestSeqSeen)
    const missing = []
    for (let seq = transfer.contiguousSeq; seq <= upper; seq++) {
      if (!transfer.receivedSeqs.has(seq)) {
        missing.push(seq)
        if (missing.length >= maxCount) break
      }
    }
    return missing
  }

  scheduleRepair(fileId, seqs, immediate = false) {
    if (!Array.isArray(seqs) || seqs.length === 0) return
    const transfer = this.incoming.get(fileId)
    if (!transfer) return
    let pending = this.pendingRepairSeqs.get(fileId)
    if (!pending) {
      pending = new Set()
      this.pendingRepairSeqs.set(fileId, pending)
    }
    for (const seq of seqs) {
      pending.add(Number(seq) >>> 0)
      if (pending.size >= MAX_REPAIR_BATCH * 2) break
    }
    if (immediate) {
      this.flushScheduledRepair(fileId)
      return
    }
    if (this.pendingRepairTimers.has(fileId)) return
    const timer = setTimeout(() => {
      this.pendingRepairTimers.delete(fileId)
      this.flushScheduledRepair(fileId)
    }, REPAIR_COALESCE_MS)
    this.pendingRepairTimers.set(fileId, timer)
  }

  flushScheduledRepair(fileId) {
    const pending = this.pendingRepairSeqs.get(fileId)
    if (!pending || pending.size === 0) return
    const transfer = this.incoming.get(fileId)
    if (transfer) {
      transfer.repairCount++
      const now = Date.now()
      if (!transfer.lastRepairCountSample) transfer.lastRepairCountSample = now
      const sampleWindow = now - transfer.lastRepairCountSample
      if (sampleWindow >= CONGESTION_DETECTION_WINDOW) {
        const repairsInWindow = transfer.repairCount
        const estimatedLoss = repairsInWindow > 0 ? 0.05 : 0
        if (estimatedLoss > CONGESTION_LOSS_THRESHOLD_PCT) {
          transfer.congestionDetectionActive = true
        }
        transfer.lastRepairCountSample = now
        transfer.repairCount = 0
      }
    }
    this.pendingRepairSeqs.delete(fileId)
    const seqs = Array.from(pending).sort((a, b) => a - b).slice(0, MAX_REPAIR_BATCH)
    this.sendRepair(fileId, seqs).catch(() => undefined)
  }

  clearScheduledRepair(fileId) {
    const timer = this.pendingRepairTimers.get(fileId)
    if (timer) {
      try { clearTimeout(timer) } catch (_) {}
      this.pendingRepairTimers.delete(fileId)
    }
    this.pendingRepairSeqs.delete(fileId)
  }

  computeReorderWindowMs(transfer) {
    return Math.max(
      REORDER_BASE_MS,
      Math.min(REORDER_MAX_MS, Math.round((transfer.avgInterChunkMs || REORDER_BASE_MS) * 4)),
    )
  }

  tuneIncomingReceiver(transfer, now) {
    const interChunkMs = Math.max(1, Number(transfer.avgInterChunkMs) || 1)
    const targetAckStep = Math.max(
      FLOW_ACK_STEP_MIN_BYTES,
      Math.min(FLOW_ACK_STEP_MAX_BYTES, Math.round((transfer.chunkSize || CHUNK_SIZE) * (FLOW_ACK_TARGET_INTERVAL_MS / interChunkMs))),
    )
    const smoothed = Math.round((Number(transfer.flowAckStep) || FLOW_ACK_STEP_BYTES) * 0.8 + targetAckStep * 0.2)
    transfer.flowAckStep = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.min(FLOW_ACK_STEP_MAX_BYTES, smoothed))

    const pending = Math.max(0, Number(transfer.pendingChunkBytes) || 0)
    if (transfer.isLan) {
      transfer.flushTargetBytes = LAN_INCOMING_FLUSH_BYTES
      transfer.flushTargetIntervalMs = LAN_INCOMING_FLUSH_INTERVAL_MS
    } else if (transfer.isBulk) {
      transfer.flushTargetBytes = BULK_INCOMING_FLUSH_BYTES
      transfer.flushTargetIntervalMs = BULK_INCOMING_FLUSH_INTERVAL_MS
    } else if (pending >= 12 * 1024 * 1024) {
      transfer.flushTargetBytes = INCOMING_FLUSH_BYTES_MIN
      transfer.flushTargetIntervalMs = INCOMING_FLUSH_INTERVAL_MIN_MS
    } else if (pending >= 6 * 1024 * 1024) {
      transfer.flushTargetBytes = 4 * 1024 * 1024
      transfer.flushTargetIntervalMs = 6
    } else {
      transfer.flushTargetBytes = INCOMING_FLUSH_BYTES
      transfer.flushTargetIntervalMs = INCOMING_FLUSH_INTERVAL_MS
    }

    const policy = this.flowAckPolicy(transfer)
    if (!transfer.isLan && now - (transfer.lastFlowAckAt || 0) >= policy.maxIntervalMs && transfer.flowPending > 0) {
      transfer.flowAckStep = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.floor(transfer.flowAckStep * 0.9))
    }
  }

  shouldSendFlowAck(transfer, now) {
    const pending = Number(transfer.flowPending) || 0
    if (pending <= 0) return false
    const policy = this.flowAckPolicy(transfer)
    const sinceLast = transfer.lastFlowAckAt > 0 ? now - transfer.lastFlowAckAt : Number.POSITIVE_INFINITY
    if (pending >= Math.max(FLOW_ACK_STEP_MIN_BYTES * 2, policy.step)) return true
    if (pending >= FLOW_ACK_STEP_MIN_BYTES && sinceLast >= policy.targetIntervalMs) return true
    if (sinceLast < policy.minIntervalMs) return false
    return sinceLast >= policy.maxIntervalMs
  }

  buildRepairRanges(seqs, maxRanges = MAX_REPAIR_RANGE_BATCH) {
    if (!Array.isArray(seqs) || seqs.length === 0) return []
    const normalized = Array.from(new Set(seqs.map((n) => Number(n) >>> 0))).sort((a, b) => a - b)
    const ranges = []
    let start = normalized[0]
    let prev = normalized[0]
    for (let i = 1; i < normalized.length; i++) {
      const cur = normalized[i]
      if (cur === prev + 1) {
        prev = cur
        continue
      }
      ranges.push([start, prev])
      if (ranges.length >= maxRanges) return ranges
      start = cur
      prev = cur
    }
    ranges.push([start, prev])
    return ranges.slice(0, maxRanges)
  }

  async probeChunkSize(peer, chunkSize) {
    const wantedChunk = Math.max(512, Math.min(65535, Number(chunkSize) || CHUNK_SIZE))
    const nonce = (crypto.randomBytes(4).readUInt32BE(0) >>> 0)
    const packetBytes = Math.max(HEADER_BYTES + 6, wantedChunk + CHUNK_PACKET_OVERHEAD)
    const packet = Buffer.alloc(packetBytes)
    packet.writeUInt32BE(QUIC_MAGIC, 0)
    packet.writeUInt8(PROTOCOL_VERSION, 4)
    packet.writeUInt8(PKT_MTU_PROBE, 5)
    packet.writeUInt32BE(nonce, HEADER_BYTES)
    packet.writeUInt16BE(wantedChunk & 0xffff, HEADER_BYTES + 4)

    return new Promise(async (resolve) => {
      const timer = setTimeout(() => {
        this.pendingMtuProbes.delete(nonce)
        resolve(0)
      }, MTU_PROBE_TIMEOUT_MS)
      this.pendingMtuProbes.set(nonce, (acceptedChunk) => {
        clearTimeout(timer)
        this.pendingMtuProbes.delete(nonce)
        resolve(Number(acceptedChunk) || 0)
      })
      try {
        await this.sendBuffer(packet, peer)
      } catch (_) {
        clearTimeout(timer)
        this.pendingMtuProbes.delete(nonce)
        resolve(0)
      }
    })
  }

  async negotiateChunkSize(peer, requestedChunkSize) {
    const fallback = Math.max(1024, Math.min(1432, Number(requestedChunkSize) || CHUNK_SIZE))
    const peerKey = endpointKey(peer)
    const cached = this.peerChunkSizeCache.get(peerKey)
    if (Number.isFinite(cached) && cached >= 1024) {
      return Math.max(1024, Math.min(1432, Math.min(cached, fallback)))
    }

    const candidates = Array.from(new Set([
      ...MTU_PROBE_CANDIDATE_CHUNKS,
      fallback,
    ])).filter((n) => n >= 1024 && n <= 1432).sort((a, b) => b - a)

    for (const candidate of candidates) {
      const accepted = await this.probeChunkSize(peer, candidate)
      if (accepted >= candidate) {
        this.peerChunkSizeCache.set(peerKey, candidate)
        return candidate
      }
    }
    this.peerChunkSizeCache.set(peerKey, fallback)
    return fallback
  }

  async resendChunk(fileId, seq) {
    const state = this.outgoing.get(fileId)
    if (!state || !state.peer) return
    let payload = state.resendCache.get(seq)
    if (!payload) {
      if (state.fd === null) return
      const len = this.chunkLength(state.meta, seq)
      if (len <= 0) return
      const data = Buffer.alloc(len)
      const readOffset = seq * state.meta.chunkSize
      const read = fs.readSync(state.fd, data, 0, len, readOffset)
      if (read <= 0) return
      payload = read === len ? data : data.subarray(0, read)
    }
    // ✅ FIX: Calculate correct streamId based on seq % streamCount
    // Previously: always passed 0, breaking multi-stream repair routing
    const streamId = state.streamCount > 1 ? (seq % state.streamCount) : 0
    await this.sendChunkPacket(state, fileId, seq, payload, streamId, true)
  }

  cleanupOutgoing(fileId) {
    const state = this.outgoing.get(fileId)
    if (!state) return
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer)
      state.finalizeTimer = null
    }
    if (state.fd !== null) {
      try { fs.closeSync(state.fd) } catch (_) {}
    }
    if (state.tempPath) {
      try { fs.unlinkSync(state.tempPath) } catch (_) {}
    }
    state.resendCache?.clear()
    state.resendOrder = []
    state.resendCacheBytes = 0
    this.outgoing.delete(fileId)
  }

  handlePacket(msg, rinfo) {
    if (msg.length < HEADER_BYTES) return
    const magic = msg.readUInt32BE(0)
    if (magic !== QUIC_MAGIC) return
    if (msg.readUInt8(4) !== PROTOCOL_VERSION) return
    let type = msg.readUInt8(5)
    if (type === PKT_ENCRYPTED) {
      msg = this.openEncryptedPacket(msg)
      if (!msg || msg.length < HEADER_BYTES) return
      type = msg.readUInt8(5)
    }
    const body = msg.subarray(HEADER_BYTES)
    const endpoint = makeEndpoint(rinfo.address, rinfo.port)

    if (type === PKT_HELLO && endpoint && this.role === 'host' && body.length >= 32) {
      const guestNonce = body.subarray(0, 16)
      const mac = body.subarray(16, 32)
      if (!crypto.timingSafeEqual(mac, this.handshakeMac('hello', guestNonce))) return
      this.peerCapabilities = body.length > 32 ? body.readUInt8(32) : 0
      this.peerEndpoint = endpoint
      this.remoteHandshakeNonce = Buffer.from(guestNonce)
      if (!this.localHandshakeNonce) this.localHandshakeNonce = crypto.randomBytes(16)
      this.sendHelloAck(guestNonce).then(() => {
        if (!this.sessionKey) this.establishSessionKey(guestNonce, this.localHandshakeNonce)
        this.emitState('connected')
      }).catch(() => undefined)
      return
    }
    if (type === PKT_HELLO_ACK && endpoint && this.role === 'guest' && body.length >= 32 && this.localHandshakeNonce) {
      const hostNonce = body.subarray(0, 16)
      const mac = body.subarray(16, 32)
      if (!crypto.timingSafeEqual(mac, this.handshakeMac('ack', this.localHandshakeNonce, hostNonce))) return
      this.peerCapabilities = body.length > 32 ? body.readUInt8(32) : 0
      this.peerEndpoint = endpoint
      this.remoteHandshakeNonce = Buffer.from(hostNonce)
      if (!this.sessionKey) this.establishSessionKey(this.localHandshakeNonce, hostNonce)
      this.emitState('connected')
      return
    }

    if (type === PKT_CHAT) {
      const id = decodeFixedString(body, 0, 36)
      const textInfo = readSizedString(body, 36)
      if (!textInfo) return
      const text = textInfo.value
      this.emitToRenderer({ type: 'chat', id, text, ts: Date.now(), self: false, acked: false })
      this.sendChatAck(id).catch(() => undefined)
      return
    }

    if (type === PKT_CHAT_ACK) {
      const id = decodeFixedString(body, 0, 36)
      this.emitToRenderer({ type: 'chat_ack', id })
      this.pendingAcks.delete(id)
      return
    }

    if (type === PKT_OFFER) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      let offset = FILE_ID_BYTES
      const nameInfo = readSizedString(body, offset); if (!nameInfo) return
      offset = nameInfo.next
      const mimeInfo = readSizedString(body, offset); if (!mimeInfo) return
      offset = mimeInfo.next
      if (offset + 8 + 4 + 4 > body.length) return
      const size = Number(body.readBigUInt64BE(offset)); offset += 8
      const chunks = body.readUInt32BE(offset); offset += 4
      const chunkSize = body.readUInt32BE(offset); offset += 4
      const encodingInfo = readSizedString(body, offset); if (!encodingInfo) return
      offset = encodingInfo.next
      if (offset + 8 > body.length) return
      const originalSize = Number(body.readBigUInt64BE(offset)); offset += 8
      const name = nameInfo.value
      const mimeType = mimeInfo.value
      const isBulk = !isLanPeer(this.currentLocalEndpoint?.address, this.peerEndpoint?.address)
      const streamCount = recommendedStreamCount(size)
      const tempPath = path.join(os.tmpdir(), `p2pshare_${fileId}.tmp`)
      const fd = fs.openSync(tempPath, 'w')
      fs.writeSync(fd, Buffer.alloc(0), 0, 0, 0)
      const transfer = {
        id: fileId,
        name,
        size,
        mimeType,
        chunks,
        chunkSize,
        encoding: encodingInfo.value || 'none',
        originalSize,
        tempPath,
        fd,
        receivedSeqs: new Set(),
        parityGroups: new Map(),
        receivedBytes: 0,
        doneSeen: false,
        doneHash: '',
        repairRequestedAt: 0,
        flowPending: 0,
        flowAckStep: isBulk ? BULK_FLOW_ACK_STEP_BYTES : FLOW_ACK_STEP_BYTES,
        lastFlowAckAt: 0,
        remoteAckStep: FLOW_ACK_STEP_MIN_BYTES,
        remoteAckMinIntervalMs: FLOW_ACK_MIN_INTERVAL_MS,
        remoteAckMaxIntervalMs: FLOW_ACK_MAX_INTERVAL_MS,
        lastProgressAt: 0,
        speedBytes: 0,
        measuredSpeedBps: 0,
        speedWindowAt: Date.now(),
        avgInterChunkMs: 0,
        lastChunkAt: 0,
        repairNotBefore: 0,
        highestSeqSeen: -1,
        contiguousSeq: 0,
        gapSince: 0,
        lastEarlyRepairAt: 0,
        pendingWrites: 0,
        pendingChunkWrites: new Map(),
        pendingChunkBytes: 0,
        lastFlushAt: Date.now(),
        flushTargetBytes: INCOMING_FLUSH_BYTES,
        flushTargetIntervalMs: INCOMING_FLUSH_INTERVAL_MS,
        isBulk,
        streamCount,
        isLan: isLanPeer(this.currentLocalEndpoint?.address, this.peerEndpoint?.address),
        writeCursorSeq: 0,
        writeError: null,
        lastCheckpointAt: 0,
        repairCount: 0,
        adaptiveParityGroupSize: PARITY_GROUP_SIZE,
        streamId: 0,
        streamByteOffset: 0,
        streamByteLength: 0,
        congestionDetectionActive: false,
        lastRepairCountSample: 0,
      }
      const checkpoint = loadCheckpoint(fileId)
      if (checkpoint && checkpoint.tempPath === tempPath && checkpoint.totalChunks === chunks) {
        for (const seq of checkpoint.incomingSeqs) {
          if (seq >= 0 && seq < chunks) transfer.receivedSeqs.add(seq)
        }
        transfer.receivedBytes = Math.min(checkpoint.receivedBytes, size)
      }
      this.incoming.set(fileId, transfer)
      this.emitTransfer({ id: fileId, name, size, progress: 0, speed: 0, done: false, valid: null, incoming: true })
      return
    }

    if (type === PKT_PARITY) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      let offset = FILE_ID_BYTES
      if (offset + 4 + 4 > body.length) return
      const groupIndex = body.readUInt32BE(offset); offset += 4
      const len = body.readUInt32BE(offset); offset += 4
      if (offset + len > body.length) return
      const payload = Buffer.from(body.subarray(offset, offset + len))
      const transfer = this.incoming.get(fileId)
      if (!transfer) return
      transfer.parityGroups.set(groupIndex, payload)
      transfer.speedBytes += payload.length
      const now = Date.now()
      this.tuneIncomingReceiver(transfer, now)
      if (
        this.shouldSendFlowAck(transfer, now) ||
        transfer.receivedBytes >= transfer.size ||
        (transfer.flowPending >= FLOW_ACK_STEP_MIN_BYTES && now - transfer.lastFlowAckAt >= FLOW_ACK_MAX_INTERVAL_MS)
      ) {
        const grant = transfer.flowPending
        transfer.flowPending = 0
        this.sendFlow(fileId, grant).catch(() => undefined)
        if (transfer.lastFlowAckAt > 0) {
          const delta = now - transfer.lastFlowAckAt
          if (delta <= FLOW_ACK_FAST_MS) {
            transfer.flowAckStep = Math.min(FLOW_ACK_STEP_MAX_BYTES, transfer.flowAckStep * 2)
          } else if (delta >= FLOW_ACK_SLOW_MS) {
            transfer.flowAckStep = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.floor(transfer.flowAckStep / 2))
          }
        }
        transfer.lastFlowAckAt = now
      }
      return
    }

    if (type === PKT_CHUNK) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      let offset = FILE_ID_BYTES
      if (offset + 4 + 1 + 4 > body.length) return
      const seq = body.readUInt32BE(offset); offset += 4
      const streamId = body.readUInt8(offset); offset += 1
      const len = body.readUInt32BE(offset); offset += 4
      if (offset + len > body.length) return
      const payload = body.subarray(offset, offset + len)
      const transfer = this.incoming.get(fileId)
      if (!transfer) return
      const expectedStreamId = transfer.streamCount > 1 ? (seq % transfer.streamCount) : 0
      if (streamId !== expectedStreamId) return
      if (transfer.receivedSeqs.has(seq)) return
      const arrivalNow = Date.now()
      if (transfer.lastChunkAt > 0) {
        const gap = Math.max(1, arrivalNow - transfer.lastChunkAt)
        transfer.avgInterChunkMs = transfer.avgInterChunkMs > 0
          ? transfer.avgInterChunkMs * 0.8 + gap * 0.2
          : gap
      }
      transfer.lastChunkAt = arrivalNow
      transfer.receivedSeqs.add(seq)
      if (seq > transfer.highestSeqSeen) transfer.highestSeqSeen = seq
      if (seq === transfer.contiguousSeq) {
        while (transfer.contiguousSeq < transfer.chunks && transfer.receivedSeqs.has(transfer.contiguousSeq)) {
          transfer.contiguousSeq++
        }
      }
      transfer.pendingChunkWrites.set(seq, Buffer.from(payload))
      transfer.pendingChunkBytes += payload.length
      transfer.receivedBytes += payload.length
      transfer.flowPending += payload.length
      transfer.speedBytes += payload.length
      const now = Date.now()
      this.tuneIncomingReceiver(transfer, now)
      if (now - transfer.speedWindowAt >= 500) {
        transfer.measuredSpeedBps = Math.round(transfer.speedBytes * 1000 / Math.max(1, now - transfer.speedWindowAt))
        transfer.speedWindowAt = now
        transfer.speedBytes = 0
      }
      if (now - transfer.lastProgressAt >= PROGRESS_MS || transfer.receivedBytes >= transfer.size) {
        transfer.lastProgressAt = now
        this.emitTransfer({
          id: fileId,
          name: transfer.name,
          size: transfer.size,
          progress: transfer.size > 0 ? transfer.receivedBytes / transfer.size : 1,
          speed: transfer.measuredSpeedBps,
          done: false,
          valid: null,
          incoming: true,
        })
      }
      if (
        this.shouldSendFlowAck(transfer, now) ||
        transfer.receivedBytes >= transfer.size ||
        (transfer.flowPending >= FLOW_ACK_STEP_MIN_BYTES && now - transfer.lastFlowAckAt >= FLOW_ACK_MAX_INTERVAL_MS)
      ) {
        const grant = transfer.flowPending
        transfer.flowPending = 0
        this.sendFlow(fileId, grant).catch(() => undefined)
        if (transfer.lastFlowAckAt > 0) {
          const delta = now - transfer.lastFlowAckAt
          if (delta <= FLOW_ACK_FAST_MS) {
            transfer.flowAckStep = Math.min(FLOW_ACK_STEP_MAX_BYTES, transfer.flowAckStep * 2)
          } else if (delta >= FLOW_ACK_SLOW_MS) {
            transfer.flowAckStep = Math.max(FLOW_ACK_STEP_MIN_BYTES, Math.floor(transfer.flowAckStep / 2))
          }
        }
        transfer.lastFlowAckAt = now
      }

      if (transfer.contiguousSeq <= transfer.highestSeqSeen) {
        if (transfer.gapSince === 0) transfer.gapSince = now
        const reorderWindowMs = this.computeReorderWindowMs(transfer)
        if (
          now - transfer.gapSince >= reorderWindowMs &&
          now - transfer.lastEarlyRepairAt >= REPAIR_RETRY_MS
        ) {
          const missingEarly = this.getMissingFromContiguous(transfer)
          if (missingEarly.length > 0) {
            transfer.lastEarlyRepairAt = now
            transfer.repairRequestedAt = now
            this.scheduleRepair(fileId, missingEarly)
          }
        }
      } else {
        transfer.gapSince = 0
      }

      if (transfer.doneSeen) {
        const missing = this.getMissingSeqs(transfer)
        if (
          missing.length > 0 &&
          now >= transfer.repairNotBefore &&
          now - transfer.repairRequestedAt >= REPAIR_RETRY_MS
        ) {
          transfer.repairRequestedAt = now
          this.scheduleRepair(fileId, missing)
        }
      }
      this.flushIncomingWrites(fileId)
      const checkpointNow = Date.now()
      if (checkpointNow - transfer.lastCheckpointAt >= 10000 || transfer.receivedSeqs.size % 50 === 0) {
        transfer.lastCheckpointAt = checkpointNow
        saveCheckpoint(fileId, transfer)
      }
      this.maybeFinalizeIncoming(fileId)
      return
    }

    if (type === PKT_DONE) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      const hash = decodeFixedString(body, FILE_ID_BYTES, 64)
      const transfer = this.incoming.get(fileId)
      if (!transfer) return
      transfer.doneSeen = true
      transfer.doneHash = hash
      const reorderWindowMs = this.computeReorderWindowMs(transfer)
      transfer.repairNotBefore = Date.now() + reorderWindowMs
      const missing = this.getMissingSeqs(transfer)
      if (missing.length > 0 && Date.now() >= transfer.repairNotBefore) {
        transfer.repairRequestedAt = Date.now()
        this.scheduleRepair(fileId, missing)
      }
      this.flushIncomingWrites(fileId)
      this.maybeFinalizeIncoming(fileId)
      return
    }

    if (type === PKT_FLOW) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      if (body.length < FILE_ID_BYTES + 8) return
      const granted = Number(body.readBigUInt64BE(FILE_ID_BYTES))
      this.resolveCredits(fileId, granted)
      return
    }

    if (type === PKT_ACK_FREQ) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      if (body.length < FILE_ID_BYTES + 12) return
      const ackStepBytes = Number(body.readBigUInt64BE(FILE_ID_BYTES))
      const minIntervalMs = body.readUInt16BE(FILE_ID_BYTES + 8)
      const maxIntervalMs = body.readUInt16BE(FILE_ID_BYTES + 10)
      const transfer = this.incoming.get(fileId)
      if (!transfer) return
      this.applyAckFrequency(transfer, ackStepBytes, minIntervalMs, maxIntervalMs)
      return
    }

    if (type === PKT_IMMEDIATE_ACK) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      const transfer = this.incoming.get(fileId)
      if (!transfer) return
      const now = Date.now()
      if (transfer.flowPending > 0) {
        const grant = transfer.flowPending
        transfer.flowPending = 0
        this.sendFlow(fileId, grant).catch(() => undefined)
        transfer.lastFlowAckAt = now
      }
      this.flushIncomingWrites(fileId)
      this.maybeFinalizeIncoming(fileId)
      return
    }

    if (type === PKT_REPAIR) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      if (body.length < FILE_ID_BYTES + 2) return
      const count = body.readUInt16BE(FILE_ID_BYTES)
      this.applyLossBackoff(fileId, count)
      let offset = FILE_ID_BYTES + 2
      for (let i = 0; i < count; i++) {
        if (offset + 4 > body.length) break
        const seq = body.readUInt32BE(offset)
        offset += 4
        this.resendChunk(fileId, seq).catch(() => undefined)
      }
      return
    }

    if (type === PKT_REPAIR_RANGE) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      if (body.length < FILE_ID_BYTES + 2) return
      const count = body.readUInt16BE(FILE_ID_BYTES)
      let offset = FILE_ID_BYTES + 2
      let total = 0
      for (let i = 0; i < count; i++) {
        if (offset + 8 > body.length) break
        const start = body.readUInt32BE(offset)
        const end = body.readUInt32BE(offset + 4)
        offset += 8
        if (end < start) continue
        for (let seq = start; seq <= end && total < MAX_REPAIR_BATCH; seq++) {
          this.resendChunk(fileId, seq).catch(() => undefined)
          total++
        }
        if (total >= MAX_REPAIR_BATCH) break
      }
      this.applyLossBackoff(fileId, Math.max(1, total))
      return
    }

    if (type === PKT_MTU_PROBE) {
      if (!endpoint || body.length < 6) return
      const nonce = body.readUInt32BE(0)
      const requestedChunk = body.readUInt16BE(4)
      const acceptedChunk = Math.max(1024, Math.min(1432, requestedChunk || CHUNK_SIZE))
      this.sendMtuAck(endpoint, nonce, acceptedChunk).catch(() => undefined)
      return
    }

    if (type === PKT_MTU_ACK) {
      if (body.length < 6) return
      const nonce = body.readUInt32BE(0)
      const acceptedChunk = body.readUInt16BE(4)
      const waiter = this.pendingMtuProbes.get(nonce)
      if (waiter) waiter(acceptedChunk)
      return
    }

    if (type === PKT_COMPLETE) {
      const fileId = decodeFileId(body.subarray(0, FILE_ID_BYTES))
      this.cleanupOutgoing(fileId)
      return
    }
  }

  maybeFinalizeIncoming(fileId) {
    const transfer = this.incoming.get(fileId)
    if (!transfer || !transfer.doneSeen) return
    if (transfer.pendingWrites > 0) return
    this.flushIncomingWrites(fileId, true)
    if (transfer.writeError) {
      this.emitError(String(transfer.writeError.message || transfer.writeError))
      return
    }
    this.tryRecoverParity(transfer)
    if (transfer.receivedSeqs.size !== transfer.chunks) return

    try {
      fs.closeSync(transfer.fd)
      if (looksLikeSha256Hex(transfer.doneHash)) {
        const actualHash = computeFileSha256HexSync(transfer.tempPath)
        if (actualHash.toLowerCase() !== transfer.doneHash.toLowerCase()) {
          throw new Error('sha256 mismatch before finalize')
        }
      }
      clearCheckpoint(fileId)
      const downloads = this.app.getPath('downloads')
      const target = path.join(downloads, transfer.name)
      if (transfer.encoding === 'zstd') {
        if (!rustZstdDecompressFile) throw new Error('zstd native decoder unavailable')
        rustZstdDecompressFile(transfer.tempPath, target)
        const restoredSize = fs.statSync(target).size
        if (transfer.originalSize > 0 && restoredSize !== transfer.originalSize) {
          throw new Error(`size mismatch after zstd decompression: expected ${transfer.originalSize}, got ${restoredSize}`)
        }
      } else if (transfer.encoding === 'deflate') {
        const compressed = fs.readFileSync(transfer.tempPath)
        const restored = zlib.inflateSync(compressed)
        if (transfer.originalSize > 0 && restored.length !== transfer.originalSize) {
          throw new Error(`size mismatch after decompression: expected ${transfer.originalSize}, got ${restored.length}`)
        }
        fs.writeFileSync(target, restored)
      } else {
        fs.copyFileSync(transfer.tempPath, target)
      }
      fs.unlinkSync(transfer.tempPath)
      this.incoming.delete(fileId)
      clearCheckpoint(fileId)
      this.clearScheduledRepair(fileId)
      this.sendComplete(fileId).catch(() => undefined)
      this.emitTransfer({
        id: fileId,
        name: transfer.name,
        size: transfer.size,
        progress: 1,
        speed: 0,
        done: true,
        valid: true,
        incoming: true,
      })
    } catch (err) {
      try { fs.unlinkSync(transfer.tempPath) } catch (_) {}
      this.incoming.delete(fileId)
      clearCheckpoint(fileId)
      this.clearScheduledRepair(fileId)
      this.emitTransfer({
        id: fileId,
        name: transfer.name,
        size: transfer.size,
        progress: 1,
        speed: 0,
        done: true,
        valid: false,
        incoming: true,
      })
      this.emitError(String(err.message || err))
    }
  }

  tryRecoverParity(transfer) {
    if (!transfer || !transfer.parityGroups || transfer.parityGroups.size === 0) return false
    const damageEstimate = transfer.repairCount > 0 ? 0.05 : 0
    transfer.adaptiveParityGroupSize = computeAdaptiveFecGroupSize(damageEstimate)
    const actualGroupSize = transfer.adaptiveParityGroupSize
    let recoveredAny = false
    const groupCount = Math.ceil(transfer.chunks / actualGroupSize)
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
      const parity = transfer.parityGroups.get(groupIndex)
      if (!parity) continue
      const startSeq = groupIndex * actualGroupSize
      const endSeq = Math.min(transfer.chunks, startSeq + actualGroupSize)
      const missing = []
      for (let seq = startSeq; seq < endSeq; seq++) {
        if (!transfer.receivedSeqs.has(seq)) missing.push(seq)
      }
      if (missing.length !== 1) continue
      const missingSeq = missing[0]
      const recovered = Buffer.from(parity)
      for (let seq = startSeq; seq < endSeq; seq++) {
        if (seq === missingSeq) continue
        const len = this.chunkLength(transfer, seq)
        if (len <= 0) continue
        const offset = seq * transfer.chunkSize
        const data = Buffer.alloc(len)
        const read = fs.readSync(transfer.fd, data, 0, len, offset)
        if (read > 0) {
          for (let i = 0; i < Math.min(recovered.length, read); i++) {
            recovered[i] ^= data[i]
          }
        }
      }
      const missingLen = this.chunkLength(transfer, missingSeq)
      if (missingLen <= 0) continue
      const writeOffset = missingSeq * transfer.chunkSize
      fs.writeSync(transfer.fd, recovered, 0, missingLen, writeOffset)
      transfer.receivedSeqs.add(missingSeq)
      transfer.receivedBytes += missingLen
      recoveredAny = true
    }
    return recoveredAny
  }

  chunkLength(transfer, seq) {
    const offset = seq * transfer.chunkSize
    const remaining = Math.max(0, transfer.size - offset)
    return Math.min(transfer.chunkSize, remaining)
  }

  flushIncomingWrites(fileId, force = false) {
    const transfer = this.incoming.get(fileId)
    if (!transfer || !transfer.pendingChunkWrites || transfer.pendingChunkWrites.size === 0) return
    if (!force) {
      const now = Date.now()
      const flushBytes = Math.max(
        INCOMING_FLUSH_BYTES_MIN,
        Math.min(INCOMING_FLUSH_BYTES_MAX, Number(transfer.flushTargetBytes) || INCOMING_FLUSH_BYTES),
      )
      const flushIntervalMs = Math.max(
        INCOMING_FLUSH_INTERVAL_MIN_MS,
        Math.min(INCOMING_FLUSH_INTERVAL_MAX_MS, Number(transfer.flushTargetIntervalMs) || INCOMING_FLUSH_INTERVAL_MS),
      )
      if (
        transfer.pendingChunkBytes < flushBytes &&
        now - (transfer.lastFlushAt || 0) < flushIntervalMs
      ) {
        return
      }
    }
    const writeOne = (seq, payload) => {
      const writeOffset = seq * transfer.chunkSize
      const written = fs.writeSync(transfer.fd, payload, 0, payload.length, writeOffset)
      if (written !== payload.length) {
        throw new Error(`short write: expected ${payload.length}, wrote ${written}`)
      }
      transfer.pendingChunkBytes = Math.max(0, transfer.pendingChunkBytes - payload.length)
    }

    transfer.lastFlushAt = Date.now()

    try {
      // Fast path: write contiguous chunks in-order to minimize random seeks.
      while (transfer.pendingChunkWrites.has(transfer.writeCursorSeq)) {
        const seq = transfer.writeCursorSeq
        const payload = transfer.pendingChunkWrites.get(seq)
        transfer.pendingChunkWrites.delete(seq)
        if (!payload) break
        writeOne(seq, payload)
        transfer.writeCursorSeq++
      }

      if (!force) return

      // Finalization path: flush any remaining sparse/out-of-order chunks.
      const remaining = Array.from(transfer.pendingChunkWrites.entries()).sort((a, b) => a[0] - b[0])
      for (const [seq, payload] of remaining) {
        writeOne(seq, payload)
        transfer.pendingChunkWrites.delete(seq)
      }
    } catch (err) {
      transfer.writeError = err
    }
  }

  makeHeader(type) {
    const buf = Buffer.alloc(HEADER_BYTES)
    buf.writeUInt32BE(QUIC_MAGIC, 0)
    buf.writeUInt8(PROTOCOL_VERSION, 4)
    buf.writeUInt8(type, 5)
    return buf
  }

  u32(value) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(Number(value) >>> 0, 0)
    return buf
  }

  u16(value) {
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(Number(value) >>> 0, 0)
    return buf
  }

  u64(value) {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(Math.max(0, Number(value))), 0)
    return buf
  }

  nonceFor(counter, senderRole) {
    const prefix = senderRole === this.role ? this.sendNoncePrefix : this.receiveNoncePrefix
    if (!prefix) throw new Error('Session nonce prefix unavailable')
    const nonce = Buffer.alloc(12)
    prefix.copy(nonce)
    nonce.writeBigUInt64BE(counter, 4)
    return nonce
  }

  sealPacket(buffer) {
    if (!this.sessionKey) return buffer
    if (this.rustCrypto) return Buffer.from(this.rustCrypto.seal(buffer))
    const counter = ++this.sendCounter
    const counterBytes = Buffer.alloc(8)
    counterBytes.writeBigUInt64BE(counter)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sessionKey, this.nonceFor(counter, this.role))
    cipher.setAAD(counterBytes)
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()])
    return Buffer.concat([this.makeHeader(PKT_ENCRYPTED), counterBytes, ciphertext, cipher.getAuthTag()])
  }

  openEncryptedPacket(buffer) {
    if (!this.sessionKey || buffer.length < HEADER_BYTES + 8 + 16) return null
    if (this.rustCrypto) {
      const opened = this.rustCrypto.open(buffer)
      return opened ? Buffer.from(opened) : null
    }
    try {
      const counterBytes = buffer.subarray(HEADER_BYTES, HEADER_BYTES + 8)
      const counter = counterBytes.readBigUInt64BE()
      const counterKey = counter.toString()
      if (this.receivedCounters.has(counterKey)) return null
      const senderRole = this.role === 'host' ? 'guest' : 'host'
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, this.nonceFor(counter, senderRole))
      decipher.setAAD(counterBytes)
      decipher.setAuthTag(buffer.subarray(buffer.length - 16))
      const plain = Buffer.concat([
        decipher.update(buffer.subarray(HEADER_BYTES + 8, buffer.length - 16)), decipher.final(),
      ])
      this.receivedCounters.add(counterKey)
      if (this.receivedCounters.size > 100_000) this.receivedCounters.clear()
      return plain
    } catch (_) {
      return null
    }
  }

  async sendBufferRaw(buffer, peer) {
    const socket = this.ensureSocket()
    return new Promise((resolve, reject) => {
      socket.send(buffer, peer.port, peer.address, (err) => err ? reject(err) : resolve(true))
    })
  }

  async sendBuffer(buffer, peer) {
    return this.sendBufferRaw(this.sealPacket(buffer), peer)
  }

  async sendBufferFast(buffer, peer) {
    while (this.udpSendInflight >= UDP_SEND_MAX_INFLIGHT) {
      await new Promise((resolve) => {
        this.udpSendWaiters.push(resolve)
      })
    }
    const socket = this.ensureSocket()
    buffer = this.sealPacket(buffer)
    this.udpSendInflight++
    socket.send(buffer, peer.port, peer.address, (err) => {
      this.udpSendInflight = Math.max(0, this.udpSendInflight - 1)
      if (err) this.emitError(`udp send failed: ${err.message || err}`)
      if (this.udpSendInflight <= UDP_SEND_RESUME_THRESHOLD && this.udpSendWaiters.length > 0) {
        const waiters = this.udpSendWaiters.splice(0)
        waiters.forEach((resolve) => {
          try { resolve() } catch (_) {}
        })
      }
    })
    return true
  }

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = crypto.randomBytes(6)
    return Array.from(bytes).map((b) => chars[b % chars.length]).join('')
  }
}

module.exports = { NativeBridgeController, CHUNK_SIZE }
