# P2PShare

Experimental, direct peer-to-peer file transfer for desktop and Android. The
primary transport is encrypted UDP with short connection tickets; file payloads
are never uploaded to a relay or storage service.

## Features

- Desktop ↔ Android, Android ↔ Android, and Desktop ↔ Desktop transfers
- Direct UDP hole punching with STUN endpoint discovery
- AES-256-GCM authentication and encryption
- Rust desktop hot path for packet crypto, replay protection, SHA-256, and Zstd
- Adaptive pacing, BDP-based flow control, selective repair, and optional parity
- Capability-negotiated Zstandard compression with safe deflate fallback
- Direct disk-to-network Electron path for already-compressed files
- Optional Wi-Fi Aware hardware detection on Android

Direct-only networking has an unavoidable limitation: some symmetric or
carrier-grade NAT combinations cannot establish an inbound peer route. This
project intentionally does not fall back to TURN or another relay.

## Requirements

- Node.js 18+
- Rust stable (for the accelerated desktop addon)
- Android Studio/JDK 17 and Android SDK 35 (for Android builds)

## Desktop development

```bash
npm ci
npm run build:native
npm run build
npm run desktop
```

During UI development, run `npm run dev` and `npm run desktop` in separate
terminals. The native addon is optional at runtime: the desktop automatically
falls back to Node crypto when it has not been built.

Useful checks:

```bash
npm run benchmark:native
cargo test --release --manifest-path native-core/Cargo.toml
```

## Android

Create `android/local.properties` with your local SDK path, then run:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.

## Pairing

1. Select **Create session** on one peer.
2. Share the generated connection ticket with the other peer.
3. Enter the ticket on the joining peer.
4. The peers authenticate the ticket secret and attempt a direct UDP route.

The ticket contains the public IPv4 endpoint and a random 80-bit session secret.
It is not a reusable account credential.

The React interface is hosted by Electron and intentionally has no browser-only
signaling backend. Firebase and TURN are not used or included because this
repository enforces a direct-only, no-relay policy.

## Repository layout

- `electron/` — desktop process, preload bridge, and direct UDP transport
- `native-core/` — Rust N-API acceleration module
- `android/` — native Android client
- `src/` — React interface and adaptive compression preparation
- `DIRECT-P2P-ARCHITECTURE.md` — protocol and security architecture
- `PERFORMANCE.md` — tuning decisions and measured benchmarks

## Security

- Never publish a live `.env`, signing keystore, or connection ticket.
- Connection tickets grant access to one pairing attempt; share them privately.
- Received files are verified with SHA-256 before finalization.
- This is experimental software and has not received an independent security
  audit.

## License

No license has been selected yet. Add a `LICENSE` file before inviting external
contributors or distributing binaries.
