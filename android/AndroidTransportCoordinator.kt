/**
 * AndroidTransportCoordinator.kt
 * 
 * Android equivalent of desktop TransportCoordinator.ts
 * Manages transport health, stall detection, and WAN-First fallback strategy
 */

package com.p2pshare.transfer

import java.util.concurrent.atomic.AtomicLong

/**
 * Coordinates transport selection and monitors health
 * ✅ WAN-FIRST: Starts with native-udp, gives it 30s before fallback
 */
class AndroidTransportCoordinator {
    
    // ✅ WAN-FIRST: Default to native UDP (not WebRTC)
    private var currentTransport: String = "native-udp"
    
    // ✅ WAN-FIRST: 30-second stall timeout (vs 8s for LAN)
    private val NATIVE_STALL_TIMEOUT_MS = 30_000L
    private val WEBRTC_FALLBACK_TIMEOUT_MS = 60_000L
    
    private var transportSwitchTimeMs = 0L
    private val lastAckTimeMs = AtomicLong(System.currentTimeMillis())
    private val bytesAckedSinceLastCheck = AtomicLong(0L)
    private var consecutiveStalls = 0
    
    private val MAX_CONSECUTIVE_STALLS = 3
    private var fallbackAttempted = false
    
    // Monitoring state
    private var totalBytesAcked = 0L
    private var totalPacketsLost = 0
    private var lossDetectionActive = false
    
    /**
     * Get current recommended transport
     * ✅ WAN-FIRST: Intelligent routing based on health
     */
    fun getCurrentTransport(): String {
        // Check health immediately when asked
        checkForStall()
        return currentTransport
    }
    
    /**
     * Record incoming ACK
     */
    fun recordAck(bytes: Long) {
        if (bytes <= 0) return
        
        lastAckTimeMs.set(System.currentTimeMillis())
        bytesAckedSinceLastCheck.addAndGet(bytes)
        totalBytesAcked += bytes
        consecutiveStalls = 0  // ✅ Reset stall counter on activity
    }
    
    /**
     * Record loss detection
     */
    fun recordLoss(count: Int = 1) {
        totalPacketsLost += count
        if (count > 5) {
            lossDetectionActive = true
        }
    }
    
    /**
     * Check for transport stall and potentially fallback
     * ✅ WAN-FIRST: Only fallback after 30s of no traffic or >2% sustained loss
     */
    fun checkForStall(): Boolean {
        val now = System.currentTimeMillis()
        val timeSinceLastAck = now - lastAckTimeMs.get()
        val acked = bytesAckedSinceLastCheck.getAndSet(0)
        
        if (acked > 0) {
            consecutiveStalls = 0
            lossDetectionActive = false
            return false
        }
        
        // ✅ WAN-FIRST: Generous timeout (30s)
        val timeout = if (currentTransport == "native-udp") {
            NATIVE_STALL_TIMEOUT_MS
        } else {
            WEBRTC_FALLBACK_TIMEOUT_MS
        }
        
        if (timeSinceLastAck > timeout) {
            consecutiveStalls++
            
            if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS && !fallbackAttempted) {
                // ✅ WAN-FIRST: Last resort fallback to WebRTC
                switchTransport("webrtc", "Stall timeout exceeded")
                fallbackAttempted = true
                return true
            }
        }
        
        return false
    }
    
    /**
     * Should use parity based on loss conditions?
     * ✅ WAN-FIRST: Activate at 0.1% loss (very aggressive)
     */
    fun shouldActivateParity(lossPercent: Double): Boolean {
        return lossPercent >= 0.1  // ✅ 0.1% activation threshold
    }
    
    /**
     * Get parity multiplier based on sustained loss
     * ✅ WAN-FIRST: Scale up repair capacity as loss increases
     */
    fun getParityMultiplier(lossPercent: Double): Int {
        return when {
            lossPercent > 2.0 -> 3    // Extreme: 3x parity
            lossPercent > 1.0 -> 2    // Severe: 2x parity
            lossPercent > 0.1 -> 2    // High: 2x parity
            else -> 1                 // Normal: 1x parity
        }
    }
    
    /**
     * Switch transport with explanation logging
     */
    private fun switchTransport(newTransport: String, reason: String) {
        if (newTransport == currentTransport) return
        
        val duration = System.currentTimeMillis() - transportSwitchTimeMs
        android.util.Log.i(
            "P2P-TRANSPORT",
            "[WAN-FIRST] Switch to $newTransport (prev: $currentTransport, reason: $reason, duration: ${duration}ms)"
        )
        
        currentTransport = newTransport
        transportSwitchTimeMs = System.currentTimeMillis()
    }
    
    /**
     * Manual override (e.g., user preference)
     */
    fun setTransport(transport: String) {
        switchTransport(transport, "User override")
    }
    
    /**
     * Get detailed health status
     */
    fun getHealthStatus(): TransportHealthStatus {
        val now = System.currentTimeMillis()
        val timeSinceLastAck = now - lastAckTimeMs.get()
        val isStalled = timeSinceLastAck > NATIVE_STALL_TIMEOUT_MS
        
        return TransportHealthStatus(
            currentTransport = currentTransport,
            timeSinceLastAckMs = timeSinceLastAck,
            isStalled = isStalled,
            consecutiveStalls = consecutiveStalls,
            fallbackAttempted = fallbackAttempted,
            totalBytesAcked = totalBytesAcked,
            totalPacketsLost = totalPacketsLost,
            lossDetectionActive = lossDetectionActive
        )
    }
    
    /**
     * Reset for new transfer
     */
    fun reset() {
        currentTransport = "native-udp"  // ✅ Always start with native for WAN
        transportSwitchTimeMs = System.currentTimeMillis()
        lastAckTimeMs.set(transportSwitchTimeMs)
        bytesAckedSinceLastCheck.set(0)
        consecutiveStalls = 0
        fallbackAttempted = false
        totalBytesAcked = 0L
        totalPacketsLost = 0
        lossDetectionActive = false
    }
}

data class TransportHealthStatus(
    val currentTransport: String,
    val timeSinceLastAckMs: Long,
    val isStalled: Boolean,
    val consecutiveStalls: Int,
    val fallbackAttempted: Boolean,
    val totalBytesAcked: Long,
    val totalPacketsLost: Int,
    val lossDetectionActive: Boolean
) {
    fun toReadableString(): String {
        return """
            Transport Health (${currentTransport.uppercase()}):
              Last ACK: ${timeSinceLastAckMs}ms ago ${if (isStalled) "[STALLED]" else "[OK]"}
              Stalls: $consecutiveStalls
              Total Sent: ${totalBytesAcked / (1024 * 1024)} MB
              Loss Events: $totalPacketsLost
              Status: ${if (isStalled) "FALLBACK NEEDED" else if (lossDetectionActive) "LOSS DETECTED" else "HEALTHY"}
        """.trimIndent()
    }
}
