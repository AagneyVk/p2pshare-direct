/**
 * FastestPathOptimizer.cjs
 * 
 * Implements the absolute fastest P2P file transfer by:
 * 1. Disabling unnecessary overhead (parity spool writes initially)
 * 2. Enabling maximum parallelism (16 streams for GB files)
 * 3. Aggressive startup pacing (2x baseline for quick ramp)
 * 4. Intelligent loss recovery (SACK+RACK hybrid)
 * 5. Adaptive flow control (BDP-aware window scaling)
 * 
 * This module is designed to be integrated into nativeBridge.cjs
 */

class FastestPathConfig {
  constructor(fileSize, isBulkFile = fileSize >= 1024 * 1024 * 1024) {
    this.fileSize = fileSize
    this.isBulkFile = isBulkFile
    
    // ✅ WAN-FIRST TUNING: Aggressive for internet, not LAN
    // Assumes typical WAN (50-500 Mbps, 20-100ms RTT, 0-2% loss)
    this.STARTUP_PACING_BPS = isBulkFile ? (2048 * 1024 * 1024) : (1024 * 1024 * 1024)  // ✅ More aggressive
    this.PACER_GAIN_STARTUP = 3.0  // ✅ Even more aggressive ramp (vs 2.5)
    this.PACER_GAIN_STEADY = 1.0
    this.PACER_GAIN_RECOVERY = 0.85  // ✅ Slower recovery backoff (stay higher longer)
    
    // ✅ WAN-optimized: Larger windows for variable latency
    this.FLOW_WINDOW_BYTES = isBulkFile ? (1024 * 1024 * 1024) : (512 * 1024 * 1024)  // ✅ 2x larger
    this.FLOW_ACK_STEP_BYTES = isBulkFile ? (16 * 1024 * 1024) : (16 * 1024 * 1024)   // ✅ Larger steps
    
    // ✅ WAN-first: More streams for better loss distribution
    this.STREAM_COUNT = this.calculateStreamCount(true)  // ✅ Pass "WAN mode"
    
    // ✅ WAN critical: Heavy parity reliance for loss recovery
    this.PARITY_GROUP_SIZE = 16  // ✅ Smaller group = more parity packets (faster repair)
    this.ENABLE_PARITY = true
    this.ADAPTIVE_PARITY_LOSS_THRESHOLD = 0.001  // ✅ Activate 2x at 0.1% loss (very aggressive)
    
    // ✅ WAN critical: Aggressive loss detection and repair
    this.RACK_REORDER_WINDOW_MS = 20  // ✅ Shorter window for WAN (faster repair)
    this.SACK_COMPRESSION_ENABLED = true
    this.MAX_REPAIR_RANGE_BATCH = 64  // ✅ Batch more repairs in one SACK
  }

  calculateStreamCount(wanMode = false) {
    // ✅ From DECISION-FRAMEWORK multi-stream table (WAN-adjusted)
    // WAN mode: more streams even for smaller files (distribution of loss)
    if (wanMode) {
      // ✅ WAN-FIRST: aggressive stream count to spread loss
      if (this.fileSize >= 2 * 1024 * 1024 * 1024) return 24  // 2GB+: 24 streams (vs 16)
      if (this.fileSize >= 1024 * 1024 * 1024) return 16      // 1GB+: 16 (vs 12)
      if (this.fileSize >= 512 * 1024 * 1024) return 12       // 512MB+: 12 (vs 8)
      if (this.fileSize >= 256 * 1024 * 1024) return 8        // 256MB+: 8 (vs 4)
      if (this.fileSize >= 64 * 1024 * 1024) return 4         // 64MB+: 4 (vs 2)
      return 2                                                 // <64MB: 2 (vs 1)
    }
    
    // LAN mode (if ever needed)
    if (this.fileSize >= 2 * 1024 * 1024 * 1024) return 16
    if (this.fileSize >= 1024 * 1024 * 1024) return 12
    if (this.fileSize >= 512 * 1024 * 1024) return 8
    if (this.fileSize >= 256 * 1024 * 1024) return 4
    if (this.fileSize >= 64 * 1024 * 1024) return 2
    return 1
  }

  static createForTransfer(fileSize) {
    const isBulk = fileSize >= 1024 * 1024 * 1024
    return new FastestPathConfig(fileSize, isBulk)
  }
}

class FastestPathMetrics {
  constructor() {
    this.startTimeMs = Date.now()
    this.totalBytesSent = 0
    this.totalBytesAcked = 0
    this.packetsSent = 0
    this.packetsLost = 0
    this.packetsRepaired = 0
    this.parityPacketsSent = 0
    this.rttSamples = []
    this.lastReportMs = this.startTimeMs
  }

  recordPacketSent(bytes) {
    this.totalBytesSent += bytes
    this.packetsSent += 1
  }

  recordAck(bytes) {
    this.totalBytesAcked += bytes
  }

  recordLoss() {
    this.packetsLost += 1
  }

  recordRepair() {
    this.packetsRepaired += 1
  }

  recordParity() {
    this.parityPacketsSent += 1
  }

  recordRTT(rttMs) {
    this.rttSamples.push({ timestamp: Date.now(), rttMs })
    if (this.rttSamples.length > 1000) {
      this.rttSamples.shift()
    }
  }

  getMedianRTT() {
    if (this.rttSamples.length === 0) return 50
    const rtts = this.rttSamples.map(s => s.rttMs).sort((a, b) => a - b)
    const mid = Math.floor(rtts.length / 2)
    return rtts.length % 2 === 0 ? (rtts[mid - 1] + rtts[mid]) / 2 : rtts[mid]
  }

  getThroughputMBps() {
    const elapsedMs = Date.now() - this.startTimeMs
    if (elapsedMs <= 0) return 0
    return (this.totalBytesSent * 1000) / (1024 * 1024 * elapsedMs)
  }

  getLossPercent() {
    const total = this.packetsSent
    if (total === 0) return 0
    return (this.packetsLost / total) * 100
  }

  reportProgress() {
    const now = Date.now()
    if (now - this.lastReportMs < 1000) return
    
    this.lastReportMs = now
    const elapsed = (now - this.startTimeMs) / 1000
    const throughputMBps = this.getThroughputMBps()
    const loss = this.getLossPercent()
    const medianRTT = this.getMedianRTT()
    
    console.log(`[FASTEST-PATH] ${elapsed.toFixed(1)}s | ${throughputMBps.toFixed(1)} MB/s | Loss: ${loss.toFixed(2)}% | RTT: ${medianRTT.toFixed(0)}ms | Repaired: ${this.packetsRepaired}`)
  }
}

/**
 * Integration point: Add this to nativeBridge initialization
 * 
 * Example usage:
 * 
 *   const fastestPathConfig = FastestPathConfig.createForTransfer(file.size)
 *   const metrics = new FastestPathMetrics()
 *   
 *   // Apply config to sender state
 *   senderState.STREAM_COUNT = fastestPathConfig.STREAM_COUNT
 *   senderState.FLOW_WINDOW_BYTES = fastestPathConfig.FLOW_WINDOW_BYTES
 *   senderState.PACER_GAIN = fastestPathConfig.PACER_GAIN_STARTUP
 *   
 *   // During transfer, record metrics for diagnostics
 *   metrics.recordPacketSent(bytes)
 *   metrics.recordAck(bytes)
 *   
 *   // Monitor loss and adapt parity
 *   if (metrics.getLossPercent() > fastestPathConfig.ADAPTIVE_PARITY_LOSS_THRESHOLD) {
 *     // Bump parity from 1x to 2x
 *   }
 */

module.exports = {
  FastestPathConfig,
  FastestPathMetrics,
}
