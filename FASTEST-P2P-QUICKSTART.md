/**
 * FASTEST-P2P-QUICKSTART.md
 * 
 * Copy-paste ready code examples for implementing fastest P2P transfers
 */

# Fastest P2P Quick-Start Examples

## Example 1: Update useP2PStore for Transport Coordination

Add these imports to `src/store/useP2PStore.ts`:

```typescript
import { FastP2PSender } from '../webrtc/FastP2PSender'
import { TransportCoordinator } from '../webrtc/TransportCoordinator'
```

Update P2PStore interface:

```typescript
interface P2PStore {
  // ... existing fields
  transportCoordinator: TransportCoordinator | null
  fastSender: FastP2PSender | null
}
```

Update store initialization:

```typescript
export const useP2PStore = create<P2PStore>((set, get) => ({
  // ... existing
  transportCoordinator: null,
  fastSender: null,

  init() {
    // ... existing code
    const coordinator = new TransportCoordinator()
    set({ transportCoordinator: coordinator })
  },

  sendFile(file: File) {
    const { peer, transportCoordinator, nativeAttached } = get()
    if (!peer) return

    // ✅ Create FastP2PSender for intelligent routing
    const fastSender = new FastP2PSender(file, peer, {
      onProgress: (progress, speedMBps) => {
        set(s => ({
          transfers: {
            ...s.transfers,
            [file.name]: {
              ...s.transfers[file.name],
              progress,
              speed: speedMBps * 1024 * 1024,
            }
          }
        }))
      },
      onError: (error) => {
        set(s => ({
          transfers: {
            ...s.transfers,
            [file.name]: {
              ...s.transfers[file.name],
              done: true,
              valid: false,
            }
          },
          errorMsg: `Transfer failed: ${error.message}`
        }))
      }
    })

    set({ fastSender })

    // ✅ Get optimized transfer settings
    const settings = fastSender.getTransferSettings()
    console.log(`[P2P] Transport: ${settings.transportType}`)
    console.log(`[P2P] Streams: ${settings.multiStreamCount}`)
    console.log(`[P2P] Flow window: ${settings.flowWindowMB}MB`)

    // ✅ Route to appropriate transport
    if (settings.transportType === 'native-udp' && nativeAttached) {
      sendFileViaNative(file, fastSender)
    } else {
      sendFileViaWebRTC(file, fastSender)
    }
  },
}))
```

## Example 2: Update Native Bridge with FastestPath

In `electron/nativeBridge.cjs`, import and use the optimizer:

```javascript
const { FastestPathConfig, FastestPathMetrics } = require('./FastestPathOptimizer.cjs')

class NativeBridge extends EventEmitter {
  async sendOffer(state) {
    const { meta, peer } = state
    
    // ✅ Create fastest-path configuration
    const fastestConfig = FastestPathConfig.createForTransfer(meta.size)
    const metrics = new FastestPathMetrics()
    
    console.log(`[BRIDGE] File size: ${(meta.size / 1024 / 1024).toFixed(1)}MB`)
    console.log(`[BRIDGE] Streams: ${fastestConfig.STREAM_COUNT}`)
    console.log(`[BRIDGE] Pacing: ${(fastestConfig.STARTUP_PACING_BPS / 1024 / 1024).toFixed(0)} MB/s startup`)
    console.log(`[BRIDGE] Flow window: ${(fastestConfig.FLOW_WINDOW_BYTES / 1024 / 1024).toFixed(0)}MB`)
    
    // Store config and metrics in state
    state.fastestPathConfig = fastestConfig
    state.transferMetrics = metrics
    
    // ✅ Apply tuning parameters to sender state
    state.STREAM_COUNT = fastestConfig.STREAM_COUNT
    state.FLOW_WINDOW_BYTES = fastestConfig.FLOW_WINDOW_BYTES
    state.FLOW_ACK_STEP_BYTES = fastestConfig.FLOW_ACK_STEP_BYTES
    state.ENABLE_PARITY = fastestConfig.ENABLE_PARITY
    state.PARITY_GROUP_SIZE = fastestConfig.PARITY_GROUP_SIZE
    
    // ... existing sendOffer code
    return fileId
  }

  async sendChunkPacket(state, fileId, seq, chunk, streamId = 0) {
    // Record metrics
    if (state.transferMetrics) {
      state.transferMetrics.recordPacketSent(chunk.length)
    }

    // ... existing sendChunkPacket code
  }

  async handleFlowAck(state, grantedBytes, rttMs) {
    // Record metrics
    if (state.transferMetrics) {
      state.transferMetrics.recordAck(grantedBytes)
      state.transferMetrics.recordRTT(rttMs)
      state.transferMetrics.reportProgress()
    }

    // ... existing handleFlowAck code
  }

  cleanupOutgoing(fileId) {
    const state = this.outgoing.get(fileId)
    if (!state) return
    
    // Report final metrics
    if (state.transferMetrics) {
      const stats = {
        duration: Date.now() - state.transferMetrics.startTimeMs,
        throughput: state.transferMetrics.getThroughputMBps(),
        loss: state.transferMetrics.getLossPercent(),
        repaired: state.transferMetrics.packetsRepaired,
      }
      console.log(`[BRIDGE] Transfer complete:`, stats)
    }

    // ... existing cleanup code
  }
}
```

## Example 3: Monitor Transport Health in Preload

In `electron/preload.cjs`:

```javascript
const HEALTH_CHECK_INTERVAL_MS = 1000
const STALL_TIMEOUT_MS = 8000

let healthCheckInterval = null
let lastPacketTime = Date.now()

function startHealthMonitoring(fileId) {
  lastPacketTime = Date.now()
  
  healthCheckInterval = setInterval(() => {
    const timeSinceLastPacket = Date.now() - lastPacketTime
    
    if (timeSinceLastPacket > STALL_TIMEOUT_MS) {
      console.warn(`[PRELOAD] Native transfer stalled for ${timeSinceLastPacket}ms`)
      
      // Notify main thread to switch to WebRTC fallback
      ipcRenderer.invoke('p2p:switch-transport', {
        fileId,
        reason: 'native-stall',
        stallDuration: timeSinceLastPacket,
      })
      
      clearInterval(healthCheckInterval)
      healthCheckInterval = null
    }
  }, HEALTH_CHECK_INTERVAL_MS)
}

function recordNativeChunk(fileId, bytes) {
  lastPacketTime = Date.now()
}

function stopHealthMonitoring() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
}

contextBridge.exposeInMainWorld('p2pHealth', {
  start: startHealthMonitoring,
  recordChunk: recordNativeChunk,
  stop: stopHealthMonitoring,
})
```

## Example 4: Flow Control Fine-Tuning

In `electron/nativeBridge.cjs`, enhance FLOW_ACK handling:

```javascript
async handleFlowAck(state, grantedBytes, rttMs) {
  const { fastestPathConfig } = state
  if (!fastestPathConfig) return
  
  // ✅ Adaptive ACK step based on RTT
  if (rttMs < 5) {
    state.FLOW_ACK_STEP_BYTES = 512 * 1024  // LAN: 512KB
  } else if (rttMs < 50) {
    state.FLOW_ACK_STEP_BYTES = 4 * 1024 * 1024  // Good: 4MB
  } else {
    state.FLOW_ACK_STEP_BYTES = fastestPathConfig.FLOW_ACK_STEP_BYTES  // Network: configured
  }
  
  // ✅ Update pacing based on FLOW grants
  const deliveryRateMBps = (grantedBytes * 1000) / (rttMs * 1024 * 1024)
  state.estimatedBandwidthMBps = deliveryRateMBps
  
  // ✅ Adaptive pacing gain
  if (deliveryRateMBps < 50) {
    state.PACER_GAIN = fastestPathConfig.PACER_GAIN_RECOVERY  // Congested
  } else {
    state.PACER_GAIN = fastestPathConfig.PACER_GAIN_STARTUP  // Good capacity
  }
  
  console.log(`[BRIDGE] RTT: ${rttMs}ms | Delivery: ${deliveryRateMBps.toFixed(0)}MB/s | ACK step: ${(state.FLOW_ACK_STEP_BYTES / 1024 / 1024).toFixed(1)}MB`)
}
```

## Example 5: Loss Detection & Adaptive Parity

In `electron/nativeBridge.cjs`, handle NACK/repair:

```javascript
async handleRepairRequest(state, missingSeqs) {
  // Record loss metrics
  if (state.transferMetrics) {
    missingSeqs.forEach(() => {
      state.transferMetrics.recordLoss()
    })
  }

  // ✅ Adaptive parity: bump from 1x to 2x if loss > threshold
  const lossPercent = state.transferMetrics?.getLossPercent() || 0
  if (lossPercent > 0.5 && !state.adaptiveParityActive) {
    console.log(`[BRIDGE] Loss ${lossPercent.toFixed(2)}% > 0.5% threshold; enabling 2x parity`)
    state.adaptiveParityActive = true
    state.PARITY_REPEAT = 2  // Send each parity packet twice
  } else if (lossPercent < 0.1 && state.adaptiveParityActive) {
    console.log(`[BRIDGE] Loss recovered to ${lossPercent.toFixed(2)}%; returning to 1x parity`)
    state.adaptiveParityActive = false
    state.PARITY_REPEAT = 1
  }

  // ... existing repair logic
}
```

## Example 6: Final Statistics Report

Create a metrics summary after transfer:

```javascript
function formatTransferReport(metrics, file) {
  const durationSec = (metrics.endTimeMs - metrics.startTimeMs) / 1000
  const fileSizeMB = file.size / 1024 / 1024
  const throughputMBps = fileSizeMB / durationSec
  
  return `
    ╔════════════════════════════════════════════╗
    ║     P2P Transfer Complete                  ║
    ╠════════════════════════════════════════════╣
    ║ File: ${file.name}
    ║ Size: ${fileSizeMB.toFixed(1)} MB
    ║ Duration: ${durationSec.toFixed(1)} seconds
    ║ Throughput: ${throughputMBps.toFixed(1)} MB/s
    ║ Loss Rate: ${metrics.getLossPercent().toFixed(2)}%
    ║ Median RTT: ${metrics.getMedianRTT().toFixed(0)} ms
    ║ Packets Sent: ${metrics.packetsSent}
    ║ Packets Repaired: ${metrics.packetsRepaired}
    ║ Parity Packets: ${metrics.parityPacketsSent}
    ╚════════════════════════════════════════════╝
  `
}
```

## Implementation Checklist

- [ ] Add TransportCoordinator to useP2PStore
- [ ] Create FastP2PSender instance in sendFile
- [ ] Pass optimization settings to native bridge
- [ ] Apply FastestPathConfig tuning parameters
- [ ] Enable health monitoring in preload
- [ ] Implement loss-based metric recording
- [ ] Add adaptive parity logic to repair handler
- [ ] Generate final metrics report
- [ ] Test on LAN (100+ MB/s expected)
- [ ] Test on Internet (measure loss, verify fallback)
- [ ] Monitor packet loss and adaptive behavior

## Performance Validation

After implementation, measure:

```bash
# Test 500MB LAN transfer (expect >100MB/s)
# Test 1GB LAN transfer (expect >200MB/s with multi-stream)
# Test 100MB Internet (measure and report loss)
# Test 1GB Internet with 1% packet loss (verify fallback)
```

Track final report metrics in console and compare against:
- LAN: 100-300 MB/s
- Internet: 50-100 MB/s
- Bulk (1GB): 150-300 MB/s
