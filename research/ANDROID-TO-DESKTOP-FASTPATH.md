# Android -> Desktop Native Fast Path

## Goal

Maximize **verified source bytes/second** from an Android sender to a desktop receiver while preserving Protocol V2 security, repair semantics and bounded memory. Android must not become the slow endpoint after the desktop hot path moves to Rust.

## Current Android costs to remove

`DirectUdpTransport` is a correctness-first Kotlin implementation. The high-rate path currently includes Java `DatagramSocket`, a `copyOfRange` for every received datagram, per-packet `Cipher.getInstance("AES/GCM/NoPadding")`, `ByteBuffer`/`ByteArray` construction, a concurrent replay-counter set, one send executor, one receive executor, and sender-side spooling through a temporary file before transfer. These are explicit benchmark targets, not assumptions about which one dominates.

## Target sender path

```text
ContentResolver URI
       |
ParcelFileDescriptor (read-only)
       |
coarse JNI call: start_native_send(fd, metadata, session)
       |
       v
+---------------- shared Rust engine ----------------+
| fd reader / seekability probe                       |
| reusable aligned region arena                       |
| region classifier                                   |
|   raw | independent Zstd | later content reuse      |
| parallel region workers                             |
| incremental integrity tree/hash                     |
| optional FEC                                        |
| AES-GCM + protocol framing in batches               |
| pacing / credits / repair state                     |
| sendmmsg batches                                    |
| UDP_SEGMENT/GSO when runtime probe says supported   |
+-----------------------------------------------------+
       |
Android kernel / Wi-Fi or other selected network
       |
Desktop native Rust receive pipeline
```

Kotlin/Compose handles lifecycle, permissions, picker/UI and coarse progress. It must not marshal each packet through JNI.

## A1 - Eliminate sender spooling where safe

Open the selected content URI with a `ParcelFileDescriptor` and pass/duplicate its native fd to Rust. Android documents that content providers can return a file descriptor specifically so large blobs can be accessed without copying their entire content. The native engine must detect whether the fd is seekable.

Paths:

1. **seekable fd**: read directly with large reusable buffers; no cache-file copy.
2. **non-seekable pipe/provider**: stream sequentially into the pipeline. Features requiring rereads (late repair, pre-transfer hash) use a bounded spool or region cache rather than forcing every transfer to be copied first.
3. **provider with unknown length**: streaming offer extension is a later protocol experiment; retain compatibility fallback until negotiated.

Ownership must be explicit: duplicate the descriptor for native ownership or detach only when the native engine is responsible for closing it.

## A2 - One JNI transition per transfer, not per packet

JNI API shape should be coarse:

- create session / install negotiated key
- start send from fd
- pause/resume/cancel
- poll or receive coarse progress snapshots
- destroy session

No `seal(packet)` JNI loop. No packet-sized Java arrays crossing JNI. The Rust worker threads own the hot path after start.

## A3 - Native UDP batching

First native transport experiment: Linux/Android `sendmmsg` and `recvmmsg`.

Sweep batch sizes: 1, 4, 8, 16, 32, 64 datagrams.

Measure:
- verified MiB/s
- syscalls/s
- packets/s
- CPU time
- sender battery/thermal state in sustained physical-device tests
- p10 one-second goodput
- loss and repair amplification

A partial `sendmmsg` result is normal and must advance/retry the unsent suffix correctly.

## A4 - UDP GSO runtime fast path

Probe `UDP_SEGMENT`/UDP GSO at runtime. If available on the device/kernel/path, submit a larger payload whose segments remain protocol datagrams of the negotiated wire size. If the socket option/control message fails, immediately fall back to `sendmmsg`; never make GSO a protocol requirement.

GSO changes syscall/stack cost, **not** the peer-visible packet format. Desktop therefore remains wire compatible whether Android used GSO, `sendmmsg`, or ordinary sends.

## A5 - Buffer arena and copy budget

Preallocate a bounded native arena. Region buffers are recycled through read -> transform -> frame -> send queues. Track copy count as a benchmark metric.

Avoid:
- per-packet `Vec` growth where framing can target reserved slices
- Java/Kotlin packet copies
- whole-file in-memory buffering

Do not pursue literal zero-copy as a slogan: AES-GCM/compression transform data and require writable output. The target is **minimum necessary copies** with measured memory-bandwidth cost.

## A6 - ARM64 processing

Build the shared Rust core for `arm64-v8a` first. Benchmark independent-region Zstd workers and AES-GCM on physical ARM64 phones. Worker count is selected by measured source throughput and thermal sustainability, not `availableProcessors()` alone.

The Android sender should be able to run, for example:

- reader: 1 task
- compression/raw workers: N
- integrity/FEC: parallel where useful
- network batching: dedicated task

but the actual allocation is benchmark-derived.

## A7 - Overlap sender and desktop receiver

Android and desktop must be benchmarked as one pipeline. At steady state Android should be reading region N+K while workers transform N+1..N+K, the network sends N, and desktop concurrently receives/decrypts/decompresses/writes older regions.

Completion metric starts when the user initiates transfer and ends only when desktop has verified the output. A sender-only packet benchmark cannot graduate an optimization.

## A8 - Repair without rereading everything

Maintain a bounded recent-region cache sized from bandwidth-delay/recovery measurements. Fast repairs can be regenerated from cached source/encoded regions. For seekable fds, old regions can be reread by offset. For non-seekable providers, retain only the minimum spool/cache necessary to satisfy the negotiated recovery window.

This is required before removing the current full temporary-file spool for all providers.

## A9 - Thermal-aware performance ceiling

Run physical-device tests for short burst and sustained transfers (30 s, 2 min, and multi-GB). Record throughput over time, CPU time, thermal status and battery impact. A configuration that wins for five seconds and throttles below the baseline does not graduate for large files.

Adaptation is secondary: first identify the Pareto set of worker counts, region sizes, batch sizes and compression modes. Runtime policy may later choose among measured winners.

## A10 - Fast LAN discovery/path selection

For Android -> desktop LAN transfers, prefer the direct local candidate once connectivity is proven rather than forcing a public/STUN route. Future multipath work can bind native sockets to selected Android `Network` instances so Wi-Fi/cellular are explicit paths. This is separate from the first native hot-path milestone.

## Implementation sequence

1. Add Android NDK/Rust packaging for `arm64-v8a` while keeping Kotlin transport as fallback.
2. Expose coarse native session API.
3. Direct URI fd -> Rust reader with seekability and ownership tests.
4. Port protocol framing, replay window, AES-GCM and incremental hash into the shared engine.
5. Add reusable region/packet arenas.
6. Implement `sendmmsg`/`recvmmsg` backend and benchmark batch sweep.
7. Runtime-probe UDP GSO and benchmark it against `sendmmsg`.
8. Add independent-region compression pipeline and raw/compressed break-even tests on ARM64.
9. Implement desktop native receive counterpart and end-to-end benchmark harness.
10. Only after this baseline is proven: FEC alternatives, coded multipath and content reuse.

## Correctness gates

- byte-identical final file and authenticated packet format
- nonce uniqueness and replay protection preserved
- Android <-> existing desktop fallback interoperability
- cancellation closes native resources promptly
- bounded memory for arbitrarily large files
- seekable and non-seekable content-provider inputs tested
- GSO unavailable/failure path tested
- partial `sendmmsg` handling tested
- loss/repair tests pass

## Performance gate

A mechanism is retained only when physical-device Android -> desktop measurements show repeatable improvement in end-to-end verified completion time or a documented CPU/energy benefit at equivalent completion time. Emulator numbers are correctness-only.
