# Android WAN-First Quick Reference

Copy-paste code snippets for rapid WAN-First integration on Android.

## 1️⃣ Initialize WANFirstConfig

```kotlin
// For a 500MB file (use ~8 streams, aggressive pacing)
val config = WANFirstConfig.createForTransfer(500L * 1024L * 1024L)

println("Streams: ${config.streamCount}")                    // 8
println("Pacing: ${config.startupPacingBps / 1e9} GB/s")   // 1.0
println("Window: ${config.flowWindowBytes / 1e9} GB")      // 0.512
println("Parity: ${config.parityGroupSize}")                // 16
println("Loss threshold: ${config.adaptiveParityLossThreshold * 100}%")  // 0.1%
```

## 2️⃣ Create Profiler & Coordinator

```kotlin
val profiler = AndroidNetworkProfiler()
val coordinator = AndroidTransportCoordinator()

// Reset for new transfer
profiler.reset()
coordinator.reset()
```

## 3️⃣ Measure Network

```kotlin
// After measuring RTT via ping
profiler.recordRTT(rttMs)

// After calculating loss from SACK
profiler.recordLoss(lossPercent)

// After estimating bandwidth
profiler.recordBandwidth(bandwidthMbps)

// Get current profile
val profile = profiler.getProfile()
println("Recommended transport: ${profile.recommendedTransport}")  // native-udp or webrtc
println(profiler.getSummary())
```

## 4️⃣ Send with Coordinator

```kotlin
// Main transfer loop
val metrics = WANFirstMetrics()

for (chunk in fileInputStream.readBytes(config.streamCount, chunkSize)) {
    // Send via current transport
    val transport = coordinator.getCurrentTransport()
    val bytesSent = sendViaNative(chunk, transport)
    
    metrics.recordPacketSent(bytesSent)
    metrics.recordRTT(measureRTT())  // e.g., from ACK timing
    
    // Check health
    if (coordinator.checkForStall()) {
        println("Switched to: ${coordinator.getCurrentTransport()}")
    }
}
```

## 5️⃣ Handle ACKs and Loss

```kotlin
fun onRemoteACK(ackBytes: Long, lostPackets: Int) {
    // Record health
    metrics.recordAck(ackBytes)
    coordinator.recordAck(ackBytes)
    
    if (lostPackets > 0) {
        metrics.recordLoss()
        coordinator.recordLoss(lostPackets)
    }
    
    // Adapt parity
    val lossPercent = (lostPackets.toDouble() / totalPackets) * 100
    if (coordinator.shouldActivateParity(lossPercent)) {
        val multiplier = coordinator.getParityMultiplier(lossPercent)
        println("Parity: ${multiplier}x")  // Could be 2x or 3x
    }
}
```

## 6️⃣ Final Report

```kotlin
println(metrics.getFinalReport())

// Example output:
// ╔════════════════════════════════════════════╗
// ║     P2P Transfer Complete (Android)        ║
// ╠════════════════════════════════════════════╣
// ║ Size: 450.0 MB
// ║ Duration: 45.2 seconds
// ║ Throughput: 9.9 MB/s
// ║ Loss Rate: 0.15%
// ║ Median RTT: 28 ms
// ║ Packets Sent: 115200
// ║ Packets Repaired: 173
// ║ Parity Packets: 892
// ╚════════════════════════════════════════════╝
```

---

## Parameter Quick Reference

**WAN-First Tuning Applied to Android:**

| What | Value | Why |
|------|-------|-----|
| Default Transport | native-udp | Best for internet |
| Startup Pacing | 3.0x gain | Aggressive ramp |
| Flow Window | 512 MB | Handle jitter |
| Stream Count | 2-24 (file-aware) | Distribution |
| Parity Threshold | 0.1% loss | Early activation |
| Parity Group | 16 chunks | Fast repair |
| Stall Timeout | 30s | Don't fallback fast |

---

## Real-World Examples

### Example 1: Small File (10 MB)
```kotlin
val config = WANFirstConfig.createForTransfer(10L * 1024L * 1024L)
// → streamCount = 2
// → STARTUP_PACING_BPS = 1GB/s
// → flowWindowBytes = 512MB
// Expected: ~1-2 MB/s on typical internet, millisecond effect
```

### Example 2: Bulk Transfer (2 GB)
```kotlin
val config = WANFirstConfig.createForTransfer(2L * 1024L * 1024L * 1024L)
// → streamCount = 24
// → STARTUP_PACING_BPS = 2GB/s (aggressive!)
// → flowWindowBytes = 1GB
// Expected: 10-50 MB/s depending on internet speed
```

### Example 3: Lossy Network (1% packet loss)
```kotlin
profiler.recordLoss(1.0)  // 1% loss detected
coordinator.shouldActivateParity(1.0)  // true
coordinator.getParityMultiplier(1.0)   // 2 (2x parity)
// → Enables repair packets automatically
```

### Example 4: Stall Detection
```kotlin
// No ACK for 30 seconds
coordinator.checkForStall()  // returns true after 30s
// → Internally switches to WebRTC
// → UI updates to show "Failover: WebRTC"
```

---

## Integration Checklist

- [ ] Copy WANFirstOptimizer.kt to app/src/main/java/com/p2pshare/transfer/
- [ ] Copy AndroidNetworkProfiler.kt to app/src/main/java/com/p2pshare/transfer/
- [ ] Copy AndroidTransportCoordinator.kt to app/src/main/java/com/p2pshare/transfer/
- [ ] Update QuicStyleNativeTransport.kt to instantiate coordinator & profiler
- [ ] Apply config parameters to native UDP sender
- [ ] Hook onAckReceived() to coordinator.recordAck()
- [ ] Hook loss detection to profiler.recordLoss()
- [ ] Test on WiFi (should be fast, minimal loss)
- [ ] Test on cellular (higher latency, occasional loss)
- [ ] Test on high-loss network (should activate 2x parity)
- [ ] Verify stall timeout doesn't trigger incorrectly (give 30s+)

---

## Performance Expectations

**Before WAN-First:**
- 100 Mbps internet: 5-7 MB/s
- 500 Mbps internet: 25-30 MB/s  
- Lossy (1%): Retransmit storms

**After WAN-First:**
- 100 Mbps internet: 7-10 MB/s (+40%)
- 500 Mbps internet: 40-50 MB/s (+50%)
- Lossy (1%): Smooth 2x parity recovery

---

## Debugging Tips

**Check current profile:**
```kotlin
val profile = profiler.getProfile()
if (profile.recommendedTransport == "webrtc") {
    Log.w("P2P", "Network broken - WebRTC fallback: RTT=%.0f ms, Loss=%.1f%%",
        profile.rttMs, profile.lossPercent)
}
```

**Monitor coordinator health:**
```kotlin
val status = coordinator.getHealthStatus()
if (status.isStalled) {
    Log.e("P2P", "Transport stalled - fallback pending: ${status.toReadableString()}")
}
```

**Trace parity activation:**
```kotlin
if (coordinator.shouldActivateParity(lossPercent)) {
    val mult = coordinator.getParityMultiplier(lossPercent)
    Log.d("P2P", "Parity active: ${mult}x at ${String.format("%.2f", lossPercent)}% loss")
}
```

---

## Links

- [Full Integration Guide](./ANDROID-WAN-FIRST-INTEGRATION.md)
- [Desktop Version](../WAN-FIRST-QUICKSTART.md)
- [Architecture Reference](./WANFirstOptimizer.kt)
