# Direct P2P Architecture

## Non-negotiable invariant

File payload bytes travel directly between peers. Native pairing uses no
signaling database: a self-contained Base32 ticket encodes the public endpoint,
one-time secret, and checksum. TURN candidates are disabled. If no direct route
can be established, the connection fails visibly instead of relaying.

## Transport ladder

1. **Native UDP (preferred in installed desktop/Android apps)**
   - Gather every private IPv4 endpoint on the bound transfer socket.
   - Discover the socket's server-reflexive endpoint with STUN Binding requests.
   - Encode the public endpoint and one-time secret into a copyable ticket.
   - Authenticate HELLO/ACK with HMAC, derive a session key with HKDF, and
     protect subsequent packets with AES-256-GCM.
   - Transfer with pacing, flow credit, selective repair, adaptive parity, MTU
     probing, disk spooling, and SHA-256 validation.
2. **WebRTC DataChannel (direct-only compatibility path)**
   - ICE host and server-reflexive candidates only; no TURN/relay candidates.
   - Reliable unordered SCTP channels with application backpressure.
3. **Nearby direct-link upgrade (planned Android optimization)**
   - On nearby Android devices, negotiate Wi-Fi Direct/aware and run the same
     native UDP wire protocol over that link.

## Current implementation status

- Desktop native UDP: implemented, including STUN candidate discovery and
  simultaneous hole punching.
- Browser/Electron WebRTC: implemented as a direct-only fallback.
- Android native UDP: buildable application and protocol-v2-compatible transport
  implemented with STUN discovery, hole punching, flow control, selective
  repair, SHA-256 verification, Android file picking, and Downloads integration.

## Known direct-connect limit

Direct-only operation cannot guarantee a connection through every NAT or
firewall. Symmetric NATs and UDP-blocking networks can make direct connectivity
impossible. This project deliberately reports that failure instead of routing
payloads through TURN or another relay.

## Next protocol milestone

Protocol v3 should add an authenticated ephemeral key exchange over the DTLS
control channel and AEAD protection for every native UDP datagram. It should
also move fixed tuning constants into a measured path profile and add a
cross-platform conformance corpus shared by Node and Kotlin.

## Adaptive compression pipeline

Before transfer, both senders classify the file type and sample four regions
across the file. Compression is selected only when sampled DEFLATE output
predicts at least five percent wire savings. This avoids wasting CPU and startup
time on video, archives, encrypted data, APKs, and other packed formats.

Android compression streams through a bounded 1 MiB buffer into a repairable
temporary spool, so multi-gigabyte inputs do not need to fit in memory. The spool
is transferred through the normal encrypted flow-control and selective-repair
path. Receivers validate SHA-256 on the transmitted representation before
decompressing and validating the restored size.

This optimization is lossless. Its speedup is approximately the compression
ratio when the network is the bottleneck; already-compressed files correctly
fall back to raw transfer.

See [PERFORMANCE.md](PERFORMANCE.md) for the throughput changes, benchmark
matrix, and native-core/Wi-Fi-Aware roadmap.
