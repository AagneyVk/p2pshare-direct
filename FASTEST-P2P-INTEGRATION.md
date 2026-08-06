/**
 * FASTEST-P2P-INTEGRATION.md
 * 
 * Integration guide for implementing fastest P2P file transfer
 * in P2PShare using the new optimization modules.
 */

# Fastest P2P File Transfer Implementation

## Architecture Overview

```
┌─ TransportCoordinator (intelligent T/O selection + health monitoring)
│   ├─ NetworkProfiler (RTT/loss/BW measurement)
│   └─ TransportStats (diagnostics)
│
├─ FastP2PSender (high-level sender orchestration)
│   ├─ Stream management (multi-streaming)
│   ├─ Progress tracking
│   └─ Transport health checks
│
├─ FastestPathOptimizer (native UDP tuning parameters)
│   ├─ FastestPathConfig (size-aware tuning)
│   └─ FastestPathMetrics (real-time diagnostics)
│
├─ WebRTC FileTransfer (existing, kept for fallback)
│
└─ Native nativeBridge (UDP sender, enhanced with FastestPath params)
```

## Implementation Steps

### 1. Initialize Transport Coordinator in Store

In `src/store/useP2PStore.ts`:

```typescript
import { TransportCoordinator } from '../webrtc/TransportCoordinator'

// Add to P2PStore interface
interface P2PStore {
  // ... existing fields
  transportCoordinator: TransportCoordinator | null
}

// In init() method, create coordinator
const coordinator = new TransportCoordinator()
set({ transportCoordinator: coordinator })
```

### 2. Use FastP2PSender for Transport Selection

In `src/store/useP2PStore.ts` sendFile method:

```typescript
async sendFile(file: File) {
  const { peer, transportCoordinator } = get()
  if (!peer || !transportCoordinator) return
  
  const fastSender = new FastP2PSender(file, peer, {
    onProgress: (progress, speedMBps) => {
      // Update UI progress
    },
    onError: (error) => {
      // Handle error
    }
  })
  
  // Get optimized settings
  const settings = fastSender.getTransferSettings()
  console.log(`[STORE] Using ${settings.transportType} transport`)
  console.log(`[STORE] Multi-stream: ${settings.multiStreamCount}`)
  console.log(`[STORE] Chunk size: ${settings.chunkSize} bytes`)
  console.log(`[STORE] Flow window: ${settings.flowWindowBytes} bytes`)
  
  // Route to appropriate transport
  if (settings.transportType === 'native-udp' && nativeBridge) {
    // Use native bridge with FastestPathConfig
    await sendViaFastestPath(file, settings)
  } else {
    // Fallback to WebRTC
    await sendFile(file, peer, onProgress, onDone, onError)
  }
}
```

### 3. Apply FastestPathOptimizer to Native Bridge

In `electron/nativeBridge.cjs`:

```javascript
const { FastestPathConfig, FastestPathMetrics } = require('./FastestPathOptimizer.cjs')

class NativeBridge {
  async sendOffer(state) {
    // Create config from file size
    const fastestConfig = FastestPathConfig.createForTransfer(state.meta.size)
    const metrics = new FastestPathMetrics()
    
    // Store in state for use during transfer
    state.fastestPathConfig = fastestConfig
    state.transferMetrics = metrics
    
    // Override tuning parameters
    state.STREAM_COUNT = fastestConfig.STREAM_COUNT
    state.FLOW_WINDOW_BYTES = fastestConfig.FLOW_WINDOW_BYTES
    state.FLOW_ACK_STEP_BYTES = fastestConfig.FLOW_ACK_STEP_BYTES
    
    // ... rest of sendOffer
  }
  
  async sendChunkPacket(state, fileId, seq, chunk, streamId = 0) {
    // Record metrics
    if (state.transferMetrics) {
      state.transferMetrics.recordPacketSent(chunk.length)
    }
    
    // ... existing code
  }
}
```

### 4. Monitor Transport Health

In `electron/preload.cjs`:

```javascript
// Periodically check native transport health
const healthCheckInterval = setInterval(() => {
  const coordinator = getTransportCoordinator() // from main thread
  const currentTransport = coordinator.checkForStall()
  
  if (currentTransport === 'webrtc') {
    console.warn('[PRELOAD] Native stalled; activating WebRTC fallback')
    // Signal native bridge to stop; switch to WebRTC channels
  }
}, 1000)
```

## Performance Expectations

Based on DECISION-FRAMEWORK optimization levels:

### LAN Path (RTT<5ms, loss<0.01%)
- **Throughput**: 100-500 MB/s (NIC-limited)
- **Profile**: 512MB window, 512KB ACK step, 1.0x pacing gain
- **Streams**: Network-determined (1-4)

### Internet Path (RTT 20-100ms, loss <0.5%)
- **Throughput**: 50-200 MB/s (network-limited)
- **Profile**: 256MB window, 8MB ACK step, 2.5x pacing gain
- **Streams**: File-size determined (1-4)

### Bulk Path (file ≥1GB)
- **Throughput**: 100-300 MB/s (optimized for large transfers)
- **Profile**: 768MB window, 8MB ACK step, 2.5x pacing gain
- **Streams**: Aggressive parallel (8-16)

## Diagnostic Output

When transfer completes, log:

```
[TRANSPORT] Final Report:
  Transport: native-udp | webrtc
  Duration: 12.3s
  Throughput: 145.6 MB/s
  Total: 1792 MB
  Loss: 0.02%
  Streams: 4
  Fallbacks: 0
```

## Fallback Strategy

1. **Native stall detected** (no packets for 8s)
   → Log warning, signal WebRTC to take over
   
2. **High loss detected** (>1%)
   → Try adaptive parity 2x, increase ACK step
   → If still failing after 30s, fallback to WebRTC
   
3. **WebRTC fallback engaged**
   → Use existing reliable WebRTC path (slower but guaranteed)
   → No restart needed; pick up where native left off (checkpoint)

## Testing Checklist

- [ ] 100MB file: LAN (should use native UDP, >100MB/s)
- [ ] 500MB file: LAN (should use native UDP, multi-stream, >200MB/s)
- [ ] 1GB file: LAN (should use 12-16 streams, 768MB window, >300MB/s)
- [ ] 100MB file: Internet (may use WebRTC if loss >1%)
- [ ] Monitor loss & parity: verify adaptive parity bumps on loss >0.5%
- [ ] Verify fallback: pull network cable during native transfer, should switch to WebRTC

## Advanced Tuning

### For ultra-fast LAN (single switch, <1ms):
- Increase `FLOW_WINDOW_BYTES` to 1GB
- Increase `STREAM_COUNT` to 32
- Reduce `FLOW_ACK_STEP_BYTES` to 256KB (very frequent ACKs)

### For high-loss networks (>2%):
- Keep adaptive parity 2x permanently
- Reduce `STREAM_COUNT` to 2-4 (easier to manage repairs)
- Increase ACK frequency (smaller step size)

### For satellite/geosync links (RTT>100ms):
- Increase window proportionally: `window ≈ bandwidth × RTT × 2`
- Use very aggressive startup pacing to fill the pipe quickly
- Enable BBR mode (already default in FastestPathOptimizer)

## Monitoring & Observability

Key metrics to track:

1. **Per-stream statistics**
   - Sequence numbers sent/acked per stream
   - Loss rate per stream
   - Repair rate per stream

2. **Aggregate statistics**
   - Overall throughput
   - Packet loss rate
   - Median RTT

3. **Pacing metrics**
   - Instantaneous pacing rate (Mbps)
   - Delivery rate EWMA
   - Congestion window size

4. **Transport events**
   - Native stall detected
   - Fallback trigger
   - Recovery event

Store these in FastestPathMetrics for emit after transfer completes.
