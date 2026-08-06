const { contextBridge, ipcRenderer, webUtils } = require('electron')

const MIN_INFLIGHT_BYTES = 8 * 1024 * 1024
const MAX_INFLIGHT_BYTES = 256 * 1024 * 1024
const START_INFLIGHT_BYTES = 32 * 1024 * 1024
const TUNE_BATCH = 16
const FAST_ACK_MS = 12
const SLOW_ACK_MS = 80
const CHUNK_SIZE = 1400
const IPC_BATCH_CHUNKS = 384
const NATIVE_STALL_TIMEOUT_MS = 8000
const MB = 1024 * 1024
const ENABLE_MULTI_STREAM = true
const DEFAULT_STREAM_COUNT = 1

function recommendedStreamCount(fileSize) {
  if (!ENABLE_MULTI_STREAM) return 1
  if (fileSize >= 512 * MB) return 4
  if (fileSize >= 256 * MB) return 3
  if (fileSize >= 64 * MB) return 2
  return 1
}

function subscribe(cb) {
  const handler = (_event, payload) => cb(payload)
  ipcRenderer.on('p2p-native:event', handler)
  return () => ipcRenderer.removeListener('p2p-native:event', handler)
}

async function sendFile(file, encoding = 'none', originalSize = file.size, originalMimeType = file.type || 'application/octet-stream') {
  const chunkSize = CHUNK_SIZE
  const totalChunks = Math.ceil(file.size / chunkSize)
  const streamCount = Math.min(recommendedStreamCount(file.size), 255)
  
  const meta = {
    name: file.name,
    size: file.size,
    mimeType: originalMimeType,
    chunks: totalChunks,
    chunkSize,
    encoding,
    originalSize,
    streamCount,
  }

  // User-selected, already-compressed files can bypass renderer IPC entirely.
  // Electron returns an empty path for synthetic/compressed File objects, which
  // deliberately keeps those on the portable streaming path below.
  if (encoding === 'none' && webUtils?.getPathForFile) {
    const sourcePath = webUtils.getPathForFile(file)
    if (sourcePath) return ipcRenderer.invoke('p2p:file-path', { path: sourcePath, meta })
  }
  const id = await ipcRenderer.invoke('p2p:file-begin', meta)

  let globalSeq = 0
  const inflight = new Set()
  let inflightBytes = 0
  let inflightLimit = START_INFLIGHT_BYTES
  let latencyEma = 0
  let completedSinceTune = 0
  let lastDrainAt = Date.now()
  let stallError = null
  let watchdog = null
  
  const throwIfStalled = () => {
    if (stallError) throw stallError
    if (inflightBytes > 0 && Date.now() - lastDrainAt > NATIVE_STALL_TIMEOUT_MS) {
      throw new Error('native transfer stalled')
    }
  }

  const tuneInflight = (latencyMs) => {
    latencyEma = latencyEma === 0 ? latencyMs : (latencyEma * 0.85) + (latencyMs * 0.15)
    completedSinceTune += 1
    if (completedSinceTune < TUNE_BATCH) return
    if (latencyEma <= FAST_ACK_MS) {
      inflightLimit = Math.min(MAX_INFLIGHT_BYTES, inflightLimit + (2 * 1024 * 1024))
    } else if (latencyEma >= SLOW_ACK_MS) {
      inflightLimit = Math.max(MIN_INFLIGHT_BYTES, inflightLimit - (2 * 1024 * 1024))
    }
    completedSinceTune = 0
  }

  const pushBatch = (batch) => {
    if (batch.length === 0) return Promise.resolve()
    const startedAt = Date.now()
    const batchBytes = batch.reduce((sum, entry) => sum + entry.chunk.byteLength, 0)
    const p = ipcRenderer.invoke('p2p:file-chunks', { 
      id, 
      chunks: batch.map(({ seq, chunk, streamId }) => ({ 
        seq, 
        chunk: Buffer.from(chunk),
        streamId: streamId || 0,
      })) 
    })
    inflight.add(p)
    inflightBytes += batchBytes
    p.finally(() => {
      inflight.delete(p)
      inflightBytes = Math.max(0, inflightBytes - batchBytes)
      lastDrainAt = Date.now()
      tuneInflight(Date.now() - startedAt)
    })
    return p
  }

  try {
    watchdog = setInterval(() => {
      if (inflightBytes > 0 && Date.now() - lastDrainAt > NATIVE_STALL_TIMEOUT_MS) {
        stallError = new Error('native transfer stalled')
      }
    }, 500)

    let batch = []
    const reader = file.stream().getReader()
    let carry = new Uint8Array(0)

    const pushChunk = async (_byteOffset, chunk) => {
      // Stripe each sequence onto exactly one logical stream. Byte-range overlap
      // used to duplicate boundary chunks and corrupt sender accounting/hash.
      const streamId = globalSeq % streamCount
      batch.push({ seq: globalSeq, chunk, streamId })
      if (batch.length >= IPC_BATCH_CHUNKS) {
        await pushBatch(batch)
        batch = []
      }
      
      if (inflightBytes >= inflightLimit) {
        throwIfStalled()
        await Promise.race(inflight)
        throwIfStalled()
      }
      globalSeq++
    }

    let bytesSeen = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const next = value instanceof Uint8Array ? value : new Uint8Array(value)
      let merged
      if (carry.byteLength > 0) {
        merged = new Uint8Array(carry.byteLength + next.byteLength)
        merged.set(carry, 0)
        merged.set(next, carry.byteLength)
      } else {
        merged = next
      }

      let offset = 0
      while (offset + chunkSize <= merged.byteLength) {
        await pushChunk(bytesSeen, merged.slice(offset, offset + chunkSize))
        bytesSeen += chunkSize
        offset += chunkSize
      }

      carry = offset < merged.byteLength ? merged.slice(offset) : new Uint8Array(0)
    }

    if (carry.byteLength > 0) {
      await pushChunk(bytesSeen, carry)
    }

    if (batch.length > 0) await pushBatch(batch)

    if (inflight.size > 0) {
      throwIfStalled()
      await Promise.all(Array.from(inflight))
      throwIfStalled()
    }
    await ipcRenderer.invoke('p2p:file-done', { id })
    return id
  } catch (err) {
    throw err
  } finally {
    if (watchdog) clearInterval(watchdog)
  }
}

contextBridge.exposeInMainWorld('p2pNativeBridge', {
  createSession: () => ipcRenderer.invoke('p2p:create-session'),
  joinSession: (code) => ipcRenderer.invoke('p2p:join-session', code),
  sendMessage: (text) => ipcRenderer.invoke('p2p:send-message', text),
  sendFile,
  disconnect: () => ipcRenderer.invoke('p2p:disconnect'),
  subscribe,
})
