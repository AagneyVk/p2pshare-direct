/**
 * WANFirstOptimizer.kt
 * 
 * Android equivalent of WAN-First optimization for P2PShare.
 * Applies the same tuning as desktop FastestPathOptimizer.cjs but for Kotlin/Android.
 * 
 * Targets: QuicStyleNativeTransport.kt and UDP sender implementation
 */

package com.p2pshare.transfer

/**
 * WAN-First configuration for Android UDP transport
 * 
 * Key changes from LAN-optimized defaults:
 * - Aggressive startup pacing (3.0x gain, 1GB/s default)
 * - Larger flow windows (512MB for typical internet)
 * - More parallel streams (2-24 based on file size)
 * - Faster parity activation (0.1% loss vs 0.5%)
 * - Smaller parity groups (16 chunks vs 32, faster local repair)
 */
class WANFirstConfig(
    val fileSize: Long,
    val isBulkFile: Boolean = fileSize >= 1024L * 1024L * 1024L
) {
    // ✅ WAN-FIRST PACING: Aggressive for internet (not LAN)
    // Assumes typical WAN: 50-500 Mbps, 20-100ms RTT, 0-2% loss
    val startupPacingBps: Long = when {
        isBulkFile -> 2048L * 1024L * 1024L  // 2 GB/s for 1GB+ files
        else -> 1024L * 1024L * 1024L         // 1 GB/s for smaller files
    }
    
    val pacerGainStartup: Double = 3.0      // ✅ Very aggressive ramp (vs 2.5)
    val pacerGainSteady: Double = 1.0
    val pacerGainRecovery: Double = 0.85    // ✅ Slower backoff (stay high longer)
    
    // ✅ WAN-OPTIMIZED FLOW CONTROL: Larger windows for variable latency
    val flowWindowBytes: Long = when {
        isBulkFile -> 1024L * 1024L * 1024L  // 1 GB for 1GB+ files
        else -> 512L * 1024L * 1024L         // 512 MB for typical internet
    }
    
    val flowAckStepBytes: Long = when {
        isBulkFile -> 16L * 1024L * 1024L    // 16 MB for bulk
        else -> 16L * 1024L * 1024L          // 16 MB default (larger ACK step)
    }
    
    // ✅ WAN-FIRST MULTI-STREAMING: More streams to distribute loss
    val streamCount: Int = calculateStreamCount(wanMode = true)
    
    // ✅ WAN CRITICAL: Heavy parity reliance for loss recovery
    val parityGroupSize: Int = 16           // ✅ Smaller group = more parity packets
    val enableParity: Boolean = true
    val adaptiveParityLossThreshold: Double = 0.001  // ✅ Activate 2x at 0.1% loss
    
    // ✅ WAN CRITICAL: Aggressive loss detection and repair
    val rackReorderWindowMs: Long = 20      // ✅ Faster loss detection
    val sackCompressionEnabled: Boolean = true
    val maxRepairRangeBatch: Int = 64       // ✅ Batch more repairs per SACK
    
    // ✅ Transport selection (Android equivalent of TransportCoordinator)
    val preferredTransport: String = "native-udp"  // Always start with native
    
    // ✅ Health monitoring: Give native longer to work on WAN
    val nativeStallTimeoutMs: Long = 30_000 // ✅ 30 seconds (vs 8s)
    
    private fun calculateStreamCount(wanMode: Boolean = false): Int {
        // ✅ WAN-FIRST: More streams even for smaller files (loss distribution)
        return when {
            wanMode && fileSize >= 2 * 1024L * 1024L * 1024L -> 24   // 2GB+: 24
            wanMode && fileSize >= 1024L * 1024L * 1024L -> 16       // 1GB+: 16
            wanMode && fileSize >= 512L * 1024L * 1024L -> 12        // 512MB+: 12
            wanMode && fileSize >= 256L * 1024L * 1024L -> 8         // 256MB+: 8
            wanMode && fileSize >= 64L * 1024L * 1024L -> 4          // 64MB+: 4
            wanMode -> 2                                             // <64MB: 2
            // LAN mode (if needed)
            fileSize >= 2 * 1024L * 1024L * 1024L -> 16
            fileSize >= 1024L * 1024L * 1024L -> 12
            fileSize >= 512L * 1024L * 1024L -> 8
            fileSize >= 256L * 1024L * 1024L -> 4
            fileSize >= 64L * 1024L * 1024L -> 2
            else -> 1
        }
    }
    
    companion object {
        fun createForTransfer(fileSize: Long): WANFirstConfig {
            val isBulk = fileSize >= 1024L * 1024L * 1024L
            return WANFirstConfig(fileSize, isBulk)
        }
    }
}

/**
 * Real-time transfer metrics tracking (Android equivalent)
 * 
 * Track throughput, loss, RTT, and parity events during transfer
 */
class WANFirstMetrics {
    private val startTimeMs = System.currentTimeMillis()
    private var totalBytesSent: Long = 0
    private var totalBytesAcked: Long = 0
    private var packetsSent: Int = 0
    private var packetsLost: Int = 0
    private var packetsRepaired: Int = 0
    private var parityPacketsSent: Int = 0
    private val rttSamples = mutableListOf<Long>()
    private var lastReportMs = startTimeMs
    
    fun recordPacketSent(bytes: Int) {
        totalBytesSent += bytes
        packetsSent += 1
    }
    
    fun recordAck(bytes: Int) {
        totalBytesAcked += bytes
    }
    
    fun recordLoss() {
        packetsLost += 1
    }
    
    fun recordRepair() {
        packetsRepaired += 1
    }
    
    fun recordParity() {
        parityPacketsSent += 1
    }
    
    fun recordRTT(rttMs: Long) {
        rttSamples.add(rttMs)
        if (rttSamples.size > 1000) {
            rttSamples.removeAt(0)
        }
    }
    
    fun getMedianRTT(): Long {
        if (rttSamples.isEmpty()) return 50
        val sorted = rttSamples.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 0) {
            (sorted[mid - 1] + sorted[mid]) / 2
        } else {
            sorted[mid]
        }
    }
    
    fun getThroughputMBps(): Double {
        val elapsedMs = System.currentTimeMillis() - startTimeMs
        if (elapsedMs <= 0) return 0.0
        return (totalBytesSent * 1000.0) / (1024.0 * 1024.0 * elapsedMs)
    }
    
    fun getLossPercent(): Double {
        val total = packetsSent
        if (total == 0) return 0.0
        return (packetsLost.toDouble() / total) * 100.0
    }
    
    fun reportProgress() {
        val now = System.currentTimeMillis()
        if (now - lastReportMs < 1000) return
        
        lastReportMs = now
        val elapsed = (now - startTimeMs) / 1000.0
        val throughputMBps = getThroughputMBps()
        val loss = getLossPercent()
        val medianRTT = getMedianRTT()
        
        android.util.Log.d(
            "P2P-TRANSFER",
            "[WAN-FIRST] %.1fs | %.1f MB/s | Loss: %.2f%% | RTT: %dms | Repaired: %d".format(
                elapsed,
                throughputMBps,
                loss,
                medianRTT,
                packetsRepaired
            )
        )
    }
    
    fun getFinalReport(): String {
        val elapsedMs = System.currentTimeMillis() - startTimeMs
        val elapsedSec = elapsedMs / 1000.0
        val fileSizeMB = totalBytesSent / (1024.0 * 1024.0)
        val throughputMBps = getThroughputMBps()
        val loss = getLossPercent()
        val medianRTT = getMedianRTT()
        
        return """
            ╔════════════════════════════════════════════╗
            ║     P2P Transfer Complete (Android)        ║
            ╠════════════════════════════════════════════╣
            ║ Size: %.1f MB
            ║ Duration: %.1f seconds
            ║ Throughput: %.1f MB/s
            ║ Loss Rate: %.2f%%
            ║ Median RTT: %d ms
            ║ Packets Sent: %d
            ║ Packets Repaired: %d
            ║ Parity Packets: %d
            ╚════════════════════════════════════════════╝
        """.trimIndent().format(
            fileSizeMB,
            elapsedSec,
            throughputMBps,
            loss,
            medianRTT,
            packetsSent,
            packetsRepaired,
            parityPacketsSent
        )
    }
}

/**
 * Android Network Detection (equivalent to NetworkProfiler.ts)
 * 
 * Determines network type and tuning recommendations
 */
data class NetworkProfile(
    val rttMs: Long,
    val lossPercent: Double,
    val bandwidthMbps: Double,
    val isLAN: Boolean = rttMs < 5 && lossPercent < 0.01,
    val isBulkPath: Boolean = rttMs > 50 || bandwidthMbps > 500,
    val recommendedTransport: String = when {
        // ✅ WAN-FIRST: Default to native UDP unless truly broken
        lossPercent > 2.0 && bandwidthMbps < 50 -> "webrtc"
        else -> "native-udp"
    }
)

object AndroidWANFirstHelper {
    /**
     * Integrate WAN-First config into QuicStyleNativeTransport
     * 
     * Usage in QuicStyleNativeTransport.kt:
     * 
     *   override fun sendFile(file: File, callback: TransferCallback) {
     *       val config = WANFirstConfig.createForTransfer(file.length())
     *       val metrics = WANFirstMetrics()
     *       
     *       sender.STREAM_COUNT = config.streamCount
     *       sender.PACING_RATE_MBPS = config.startupPacingBps / (1024 * 1024)
     *       sender.FLOW_WINDOW_BYTES = config.flowWindowBytes.toInt()
     *       sender.ACK_STEP_BYTES = config.flowAckStepBytes.toInt()
     *       // ... etc
     *   }
     */
    
    /**
     * Detect network conditions and return profile
     */
    fun profileNetwork(rttMs: Long, lossPercent: Double, bandwidthMbps: Double): NetworkProfile {
        return NetworkProfile(rttMs, lossPercent, bandwidthMbps)
    }
    
    /**
     * Should fallback to WebRTC?
     * ✅ WAN-First: Only after 30s stall or >2% sustained loss
     */
    fun shouldFallbackToWebRTC(
        nativeStallTimeMs: Long,
        currentLossPercent: Double,
        config: WANFirstConfig
    ): Boolean {
        return (nativeStallTimeMs >= config.nativeStallTimeoutMs) ||
               (currentLossPercent > 2.0)  // ✅ Only very high loss
    }
    
    /**
     * Calculate adaptive parity multiplier
     * ✅ WAN-First: Activate 2x at 0.1% loss (vs 0.5%)
     */
    fun getParityMultiplier(lossPercent: Double, config: WANFirstConfig): Int {
        return when {
            lossPercent > config.adaptiveParityLossThreshold -> 2  // 2x parity
            else -> 1  // 1x parity
        }
    }
    
    /**
     * Format Android logging output
     */
    fun formatTransferLog(metrics: WANFirstMetrics, config: WANFirstConfig): String {
        return """
            [BRIDGE-ANDROID] Transfer metrics:
              Throughput: %.1f MB/s
              Loss: %.2f%%
              RTT: %dms
              Streams: %d
              Parity: %d packets
              Repaired: %d packets
        """.trimIndent().format(
            metrics.getThroughputMBps(),
            metrics.getLossPercent(),
            metrics.getMedianRTT(),
            config.streamCount,
            metrics.parityPacketsSent,
            metrics.packetsRepaired
        )
    }
}
