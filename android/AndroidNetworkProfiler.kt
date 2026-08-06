/**
 * AndroidNetworkProfiler.kt
 * 
 * Android equivalent of desktop NetworkProfiler.ts
 * Real-time network measurement (RTT, loss, bandwidth) with WAN-First recommendations
 */

package com.p2pshare.transfer

import kotlin.math.min
import kotlin.math.max

/**
 * Measures real-time network conditions and recommends optimal transport
 * ✅ WAN-FIRST: Defaults to native-udp unless network is broken (slow + lossy)
 */
class AndroidNetworkProfiler {
    private val rttSamples = mutableListOf<Long>()
    private val lossSamples = mutableListOf<Double>()
    private val bandwidthSamples = mutableListOf<Double>()
    
    private var lastMeasurementMs = 0L
    private val SAMPLE_HISTORY_SIZE = 100
    private val EWMA_ALPHA = 0.25  // Exponential weighted moving average
    
    // ✅ WAN-First thresholds
    private var ewmaRttMs: Long = 50
    private var ewmaLossPercent: Double = 0.0
    private var ewmaBandwidthMbps: Double = 100.0
    
    /**
     * Record RTT sample (e.g., from PING or PONG packet timing)
     */
    fun recordRTT(rttMs: Long) {
        if (rttMs <= 0) return
        
        rttSamples.add(rttMs)
        if (rttSamples.size > SAMPLE_HISTORY_SIZE) {
            rttSamples.removeAt(0)
        }
        
        // Update EWMA
        ewmaRttMs = ((EWMA_ALPHA * rttMs) + ((1 - EWMA_ALPHA) * ewmaRttMs)).toLong()
    }
    
    /**
     * Record loss metric (e.g., from SACK feedback)
     * lossPercent should be 0.0-100.0
     */
    fun recordLoss(lossPercent: Double) {
        val clamped = max(0.0, min(100.0, lossPercent))
        
        lossSamples.add(clamped)
        if (lossSamples.size > SAMPLE_HISTORY_SIZE) {
            lossSamples.removeAt(0)
        }
        
        // Update EWMA
        ewmaLossPercent = (EWMA_ALPHA * clamped) + ((1 - EWMA_ALPHA) * ewmaLossPercent)
    }
    
    /**
     * Record bandwidth estimate (e.g., from delivery rate measurement)
     * bandwidthMbps should be realistic (10-10000)
     */
    fun recordBandwidth(bandwidthMbps: Double) {
        if (bandwidthMbps <= 0) return
        
        bandwidthSamples.add(bandwidthMbps)
        if (bandwidthSamples.size > SAMPLE_HISTORY_SIZE) {
            bandwidthSamples.removeAt(0)
        }
        
        // Update EWMA
        ewmaBandwidthMbps = (EWMA_ALPHA * bandwidthMbps) + ((1 - EWMA_ALPHA) * ewmaBandwidthMbps)
    }
    
    /**
     * Get current network profile with WAN-aware recommendations
     * ✅ WAN-FIRST: Defaults to native-udp, only suggests WebRTC if slow + lossy
     */
    fun getProfile(): NetworkProfile {
        val isHighLoss = ewmaLossPercent > 2.0
        val isSlowPath = ewmaBandwidthMbps < 50  // Less than 50 Mbps is slow
        
        // ✅ WAN-FIRST transport selection
        val recommendedTransport = when {
            isSlowPath && isHighLoss -> "webrtc"  // Last resort: both slow and lossy
            else -> "native-udp"                   // Prefer native for all other cases
        }
        
        return NetworkProfile(
            rttMs = ewmaRttMs,
            lossPercent = ewmaLossPercent,
            bandwidthMbps = ewmaBandwidthMbps,
            isLAN = ewmaRttMs < 5 && ewmaLossPercent < 0.01,
            isBulkPath = ewmaRttMs > 50 || ewmaBandwidthMbps > 500,
            recommendedTransport = recommendedTransport
        )
    }
    
    /**
     * Get human-readable summary for debugging
     */
    fun getSummary(): String {
        val profile = getProfile()
        return """
            Network Profile (WAN-First):
              RTT: ${profile.rttMs} ms (${if (profile.isLAN) "LAN" else "WAN"})
              Loss: ${String.format("%.2f", profile.lossPercent)}%
              Bandwidth: ${String.format("%.1f", profile.bandwidthMbps)} Mbps
              Recommended: ${profile.recommendedTransport.uppercase()}
              Path Type: ${if (profile.isBulkPath) "Bulk/Internet" else "Direct/LAN"}
        """.trimIndent()
    }
    
    /**
     * Reset metrics for a new transfer
     */
    fun reset() {
        rttSamples.clear()
        lossSamples.clear()
        bandwidthSamples.clear()
        ewmaRttMs = 50
        ewmaLossPercent = 0.0
        ewmaBandwidthMbps = 100.0
    }
}
