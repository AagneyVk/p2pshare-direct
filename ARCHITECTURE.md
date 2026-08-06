# Architecture

P2PShare is a direct-only file-transfer experiment for Electron desktops and
Android devices. Peers exchange file bytes over UDP; the project has no relay,
cloud storage, Firebase signaling, or TURN fallback.

## System overview

```text
React UI                         Android UI
   |                                 |
Electron preload                DirectUdpTransport
   |                                 |
NativeBridgeController  <---- encrypted UDP ---->
   |
Rust native core
```

The React process handles interaction and progress rendering. Electron's main
process owns sockets, files, congestion control, and recovery. The Rust N-API
addon accelerates packet encryption, replay checking, hashing, and Zstandard.
Android implements the same protocol in Kotlin and uses platform-native crypto
plus zstd-jni.

## Pairing and authentication

The host discovers its public IPv4 mapping with STUN and generates a Base32
connection ticket containing:

- the public IPv4 endpoint;
- an 80-bit random session secret;
- a checksum for transcription errors.

The guest decodes the ticket and sends authenticated UDP probes. HELLO and
HELLO_ACK messages carry random nonces and truncated HMAC-SHA256 authenticators.
Both peers derive a 256-bit session key with HKDF-SHA256. Every subsequent
protocol packet is protected with AES-256-GCM and a directional nonce prefix.
The Rust receiver maintains a bounded replay window.

Tickets should be treated as short-lived secrets and shared privately. There is
no identity account or central discovery service.

## Transfer protocol

Files move through a small binary protocol:

1. `OFFER` describes the file, chunk geometry, encoding, and original size.
2. `CHUNK` carries a sequence number, logical stream identifier, and payload.
3. `FLOW` grants sender credit and provides delivery-rate feedback.
4. `REPAIR` or `REPAIR_RANGE` requests missing sequences.
5. `DONE` supplies the SHA-256 digest of the transmitted representation.
6. `COMPLETE` confirms successful reconstruction and validation.

Large files use multiple logical repair stripes. They do not create separate
network paths; the stripes reduce recovery head-of-line effects while sharing
one authenticated UDP session.

## Throughput and congestion control

The sender uses a delivery-rate and minimum-RTT model inspired by BBR. It
controls both pacing and a bandwidth-delay-product-derived flow window.
Receiver credit prevents unbounded buffering, while ACK-frequency hints adjust
feedback overhead to the measured path.

Loss recovery combines selective retransmission, range-compressed repair
requests, reordering delay, tail probes, and adaptive XOR parity. Parity starts
disabled on clean paths and activates only after observed repair demand.

Electron sends user-selected, already-compressed files directly from disk in
the main process, avoiding per-chunk renderer IPC. Receivers coalesce contiguous
chunks into large disk writes.

## Compression

Likely-compressible files are sampled before transfer. Compression is skipped
when predicted savings do not justify CPU and startup cost. Android negotiates
native Zstandard level 1 with capable peers and falls back safely where needed.
Media, archives, APKs, encrypted content, and other packed formats normally use
the raw direct-disk path.

SHA-256 is checked before decompression, and the restored length is checked
against the original size.

## Platform components

- `electron/nativeBridge.cjs` — transport, packet protocol, flow control,
  repair, file I/O, and session lifecycle.
- `electron/preload.cjs` — isolated renderer API and fallback chunk batching.
- `native-core/src/lib.rs` — Rust crypto, replay window, hashing, and Zstd.
- `android/.../DirectUdpTransport.kt` — Android-compatible transport.
- `android/.../ConnectionTicket.kt` — Android ticket codec.
- `src/store/useP2PStore.ts` — native event/state adapter for the React UI.

## Network limitations

Direct-only communication cannot traverse every topology. Symmetric NAT,
carrier-grade NAT, UDP blocking, or strict firewalls can prevent a route. The
application reports failure instead of silently relaying user data.

## Future work

- Complete the Wi-Fi Aware/NAN discovery and socket path on supported Android
  hardware.
- Add cross-language packet conformance fixtures for Rust, Node, and Kotlin.
- Benchmark real devices and publish reproducible throughput/energy results.
- Replace heuristic tuning with versioned, measured path profiles.

See [PERFORMANCE.md](PERFORMANCE.md) for benchmark notes and tuning decisions.
