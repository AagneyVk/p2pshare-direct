# Android hot-path plan

Desktop Rust acceleration must not make Android the slow endpoint. The wire protocol stays cross-platform, but both endpoints get native hot paths.

## Current Android bottlenecks to measure

`DirectUdpTransport` currently uses `DatagramSocket`, allocates/copies received datagrams, creates a fresh AES/GCM `Cipher` for packet sealing/opening, keeps replay state in a `ConcurrentHashMap`, performs transfer preparation through Java/Kotlin streams, and uses a single send executor plus a single receive executor. These are correctness-friendly baselines, not the intended performance ceiling.

## Target architecture

Keep Kotlin/Compose for UI, Android permissions, URI/document access, lifecycle and foreground-service integration. Move bulk byte processing to a shared Rust crate compiled for Android arm64 through the NDK.

The JNI boundary is coarse-grained:

- create/destroy native transfer session
- give native code a file descriptor or bounded direct buffer
- configure negotiated protocol/coding parameters
- start/pause/cancel transfer
- poll/callback coarse progress and terminal state

Never cross JNI once per packet. Android's own JNI guidance recommends minimizing marshalling and transition frequency.

## Shared Rust core

The same protocol-core modules should serve desktop and Android:

- framing and packet counters
- AES-256-GCM
- replay window
- region compression/decompression
- hashing / integrity tree
- FEC (when selected)
- bounded buffer arena
- packet batching
- congestion/pacing state

Platform adapters own socket/file primitives.

## Android/Linux native I/O experiments

1. `sendmmsg` / `recvmmsg` batching through libc on supported Android kernels.
2. UDP GSO (`UDP_SEGMENT`) capability probe; use only when the kernel/socket path accepts it, otherwise batch ordinary datagrams.
3. Direct file-descriptor I/O from `ParcelFileDescriptor` to Rust, avoiding a Kotlin copy/spool when seekability and permissions permit.
4. Reusable aligned/native buffers; no `ByteArray.copyOfRange` in the packet hot path.
5. Independent region workers sized to measured phone CPU/thermal capacity rather than logical-core count alone.

All accelerators require runtime capability detection and a portable fallback.

## Android-specific constraints

Phones are thermally and energy constrained. A benchmark winner must include sustained throughput (not only the first seconds), CPU time, battery/energy proxy where measurable, memory, and thermal throttling state. Maximum CPU occupancy is not itself a win.

Do not use `@FastNative`/`@CriticalNative` for long-running I/O or locks. They are only candidates for tiny bounded control primitives on supported API levels. Bulk transfer should remain inside a long-lived native worker/session with infrequent JNI interaction.

## Cross-platform correctness gate

Every protocol-core change must pass:

- Rust unit tests
- Windows desktop build/test
- Android unit/build CI
- desktop -> Android fixture/packet compatibility
- Android -> desktop fixture/packet compatibility
- encrypted packet golden vectors
- region compression golden vectors

## Benchmark matrix

Android tests must include at least one modern arm64 physical device. Emulator CI proves build/correctness, not radio, kernel, thermal or native-network performance.

Measure:

- Kotlin baseline vs Rust core
- single-message send vs `sendmmsg`
- ordinary datagrams vs GSO where supported
- Kotlin AES/GCM vs Rust AES/GCM in coarse batches
- stream/spool input vs direct FD input
- 1/2/4/6+ native workers
- 256 KiB / 1 / 4 / 16 MiB processing regions
- 30 s, 2 min and large-file sustained runs

The Android endpoint graduates to the shared Rust engine only when physical-device measurements show an end-to-end gain and interoperability remains exact.
