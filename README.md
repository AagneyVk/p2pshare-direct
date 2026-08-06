<div align="center">

# P2PShare

**High-performance, encrypted, direct file transfer for desktop and Android.**

[![CI](https://github.com/AagneyVk/p2pshare-direct/actions/workflows/ci.yml/badge.svg)](https://github.com/AagneyVk/p2pshare-direct/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status: Experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#project-status)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Android-4c8bf5.svg)](#platform-support)

[Architecture](ARCHITECTURE.md) · [Performance](PERFORMANCE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

</div>

P2PShare sends files directly between peers over authenticated, encrypted UDP.
Pairing uses a self-contained connection ticket—there is no account, signaling
database, cloud upload, TURN server, or payload relay.

> [!IMPORTANT]
> P2PShare is experimental. It has not received an independent security audit,
> and direct-only connectivity cannot traverse every NAT or firewall.

## Why P2PShare?

- **Direct by design** — payload bytes travel only between the two peers.
- **Cross-platform protocol** — desktop-to-Android and same-platform transfers
  share one binary wire format.
- **Native hot path** — Rust accelerates desktop encryption, replay protection,
  SHA-256, and Zstandard operations.
- **Network-aware throughput** — delivery-rate pacing, BDP-derived flow control,
  selective repair, tail probes, and adaptive parity react to path conditions.
- **Compression that knows when to stop** — sampled compression is used only
  when predicted wire savings justify the CPU cost.
- **Large-file oriented** — direct disk streaming, bounded buffers, resumable
  receiver checkpoints, and coalesced writes avoid loading whole files in RAM.

## Project status

| Area | Status |
| --- | --- |
| Desktop native UDP | Implemented |
| Android native UDP | Implemented |
| Desktop ↔ Android interoperability | Implemented |
| AES-256-GCM packet protection | Implemented |
| Selective repair and adaptive pacing | Implemented |
| Zstandard negotiation | Implemented |
| Wi-Fi Aware/NAN data path | Capability detection only |
| Independent security audit | Not completed |
| Production support guarantee | Not provided |

## How it works

```text
Host                                      Guest
  |                                         |
  |-- Base32 ticket (IPv4 + secret) ------->|
  |<======= authenticated hole punch ======>|
  |<========= encrypted UDP session =======>|
  |--- OFFER / CHUNK / DONE ---------------->|
  |<-- FLOW / selective REPAIR / COMPLETE --|
```

1. The host discovers its public UDP mapping with STUN.
2. A short Base32 ticket encodes the endpoint, an 80-bit random secret, and a
   transcription checksum.
3. The peers authenticate random handshake nonces with HMAC-SHA256 and derive a
   session key with HKDF-SHA256.
4. Every data-plane packet is protected with AES-256-GCM and replay checking.
5. The receiver verifies SHA-256 before finalizing the file.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the packet lifecycle, trust
boundaries, congestion model, and platform responsibilities.

## Measured native performance

On the development Windows machine, the 200,000-packet AES-256-GCM benchmark
with 1,435-byte payloads measured:

| Engine | Throughput | Packet rate |
| --- | ---: | ---: |
| Node.js AES-GCM | 203.6 MiB/s | 148,788 packets/s |
| Rust AES-GCM | 382.4 MiB/s | 279,427 packets/s |

That is approximately **1.88× packet-crypto throughput** for the Rust path on
that machine. Results are hardware-dependent; run `npm run benchmark:native`
locally instead of treating this as an end-to-end network guarantee. Detailed
methodology and caveats are in [PERFORMANCE.md](PERFORMANCE.md).

## Platform support

| Sender | Receiver | Supported |
| --- | --- | :---: |
| Desktop | Desktop | Yes |
| Desktop | Android | Yes |
| Android | Desktop | Yes |
| Android | Android | Yes |

The current desktop build and native-addon workflow are tested on Windows.
Android requires API 26 or newer; the project compiles against SDK 35.

## Quick start

### Desktop

Requirements: Node.js 18+, Rust stable, and a C/C++ linker supported by Rust.

```bash
git clone https://github.com/AagneyVk/p2pshare-direct.git
cd p2pshare-direct
npm ci
npm run build:native
npm run build
npm run desktop
```

For UI development, run `npm run dev` and `npm run desktop` in separate
terminals. If the Rust addon is unavailable, Electron falls back to Node crypto.

### Android

Requirements: JDK 17, Android SDK 35, and a configured SDK path.

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The debug APK is generated at
`android/app/build/outputs/apk/debug/app-debug.apk`. Android Studio may create
`android/local.properties`; it is intentionally ignored by Git.

## Pairing and transfer

1. Choose **Create session** on the receiving or hosting peer.
2. Share the generated ticket privately with the other peer.
3. Enter the ticket and choose **Join session**.
4. Wait for direct route authentication, then select a file.

Tickets grant access to a pairing attempt. Do not post active tickets publicly.

## Direct-only limitation

Symmetric NAT, carrier-grade NAT, UDP blocking, and strict firewalls can make a
direct route impossible. P2PShare reports the failure instead of routing data
through a relay. This privacy property means connectivity is intentionally less
universal than services that operate TURN or upload infrastructure.

## Repository layout

```text
android/       Native Android application and Kotlin transport
electron/      Electron main process, preload API, and UDP transport
native-core/   Rust N-API crypto, hashing, replay, and Zstd core
src/           React interface and adaptive file preparation
```

## Development and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing protocol changes.
- Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in public
  issues.
- Performance claims should include topology, file type, RTT/loss, hardware,
  and repeatable commands.
- Protocol changes must be tested in both desktop-to-Android directions.

## License

P2PShare is licensed under the [MIT License](LICENSE).
