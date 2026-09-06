# Production-readiness gates

Status: **not production ready**. Baseline inspected: `25d4479`.

## Current milestone: opt-in desktop integration

The original stage below is retained as history. Current desktop preview uses
the real Rust engine through `electron/QuicBridge.cjs`, with expiring one-guest
certificate-bound tickets, display names, completed-file retry, free-space
preflight, bounded session counts and user-confirmed export. Default desktop and
Android still use v2. See `QUIC-DESKTOP.md` and `RESEARCH-DIRECTION.md`.

Current local checks: 11 Rust transport/pairing tests; five Node security/IPC
tests; two native bridge tests (including bidirectional transfer, zero-payload
duplicate and fresh-process partial reuse); TypeScript/Vite build and Clippy.
The impairment test adds 20 ms RTT and deterministic 1% packet loss. The Electron
44.2.0 upgrade has a clean production-only npm audit; this is not a security audit
of the application or its development dependencies.

Still NOT verified: actual Electron window/file picker/save-dialog behavior,
Windows runtime and installer, Android compilation or JNI, Android lifecycle,
real-device Wi-Fi/energy performance and the full WAN matrix. Gradle 8.7 download
again failed with network unreachable. CI is configured, not asserted green.

Before a production release, also complete persistent peer identity/cache
partitioning, strict CSP/sandbox review, retention policy, independent security
review and modern development-tool dependency review. The preview's new process
boundary is not an OS sandbox. No new P2P routing infrastructure is introduced.

## Previous core-only stage

- v2 receivers now require authenticated envelopes for data-plane dispatch.
- Desktop Node replay protection no longer clears the history at 100,000
  packets; Node and Android use a bounded 64-counter window matching Rust.
- Android compressed sends hash the transmitted file, not the deleted original
  spool. Host connection notification is no longer bypassed by preassigning peer.
- Native N-API dynamic symbol loading enables standalone Rust tests on Linux.
- Separate shared Rust QUIC core with mutual TLS, bounded manifest parsing,
  BLAKE3 blocks, rehash-based partial resume and verified completion.
- Six QUIC integration/validation tests, four Node security tests and an
  Android replay regression test. Added Linux/Windows QUIC CI job.

## Verification performed locally

- `npm test`: four tests passed with Node fallback, then again with the compiled
  Rust native addon.
- `npm run build`: TypeScript and Vite passed.
- `cargo test --manifest-path native-core/Cargo.toml`: passed after N-API fix.
- `cargo test --locked --manifest-path transport-core/Cargo.toml`: six tests
  passed, including actual loopback QUIC transfer and untrusted certificate
  rejection.
- `cargo clippy --locked --manifest-path transport-core/Cargo.toml --all-targets -- -D warnings`: passed.
- Release loopback smoke: 4 GiB completed with verified BLAKE3 integrity; see
  `transport-core/benchmarks/linux-loopback-smoke.json`. Not a device benchmark.
- Android Gradle could not download Gradle 8.7: network unreachable in the Java
  process. Android tests and APK build are **not locally verified**.
- CI workflow is configured; no remote CI run or Windows/device pass is claimed.

## Required before switching application transport

1. Android NDK/JNI adapter; the desktop process adapter is implemented and native
   owns sockets, streaming and storage without per-packet UI callbacks.
2. Persistent peer trust, per-file consent choices and stable downgrade policy;
   expiring certificate-bound one-guest tickets are implemented for desktop.
3. Source abstraction for seekable Android descriptors and nonseekable SAF
   providers, and platform-correct durable destination publication.
4. Real process-kill/power-loss tests; fresh-process partial reuse and completed
   retries now pass, without overwriting existing completed files.
5. Aggregate storage/memory/session quotas, consent, deadlines, cancellation,
   safe cleanup and Android foreground-service/network lifecycle behavior.
6. Discovery and direct route creation, IPv6 and WAN NAT tests. QUIC alone does
   not solve NAT traversal. No relay infrastructure is added.
7. Differential v2/v3 device tests and phased migration with explicit version UI.

## Required before speed/innovation claims

- Controlled baseline comparison of v2 and v3, TCP/TLS reference and existing
  transfer tools on identical hardware, file corpus and network conditions.
- Four directions on real Android/desktop devices; 4+ GiB files, small-file
  batches, receiver pressure, thermal soak, sleep, handoff, RTT/loss sweeps.
- Record startup, p10/average goodput, CPU/RSS, energy/thermal, disk rates,
  wire bytes and loss overhead. Separate source-byte savings from wire speed.
- Implement and independently measure compression-time decisions, block cache
  reuse/content-defined chunking, and conservative profile hints. They are
  research work, not implemented features of the current alpha.
- Fuzzing/property suites, parser conformance fixtures, dependency/security
  review and independent security audit before a production support claim.

Do not remove these gates merely because builds pass. A loopback benchmark
cannot validate Android battery behavior, Wi-Fi throughput or internet reachability.
