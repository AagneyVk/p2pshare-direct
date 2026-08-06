# Performance engineering plan

## Rust native core

The desktop packet encryption hot path now uses a Rust N-API addon with an
automatic Node fallback. On the development Windows machine, a 200,000-packet
release benchmark with 1,435-byte payloads measured 384.0 MiB/s (280,608
packets/s) for Rust versus 201.7 MiB/s (147,409 packets/s) for Node AES-GCM,
about 1.9x the packet-crypto throughput. Run `npm run benchmark:native` to
measure the current machine rather than treating this result as universal.

The core also provides streaming Zstandard level-1 compression/decompression.
A 16 MiB synthetic text-like corpus compressed to roughly 1 KiB in 6.2 ms on
the development machine. Android advertises Zstd support during its authenticated
peer handshake and falls back to deflate for older receivers. Files already
compressed by their format still bypass compression entirely.

## Local-link path

Android now detects Wi-Fi Aware/NAN hardware at runtime and declares the feature
as optional. This is the capability foundation for an access-point-free local
data path; unsupported phones continue using direct UDP without installation or
runtime failure.

## What was optimized

- User-selected incompressible files bypass renderer IPC and stream directly
  from disk in Electron's main process. Synthetic compressed files retain the
  portable batched IPC path.
- One IPC batch queue replaces per-stream queues, reducing startup latency and
  renderer memory while preserving logical repair stripes.
- Desktop and Android use identical stream-count selection.
- AES-GCM nonce prefixes are derived once per session instead of HMACing every
  datagram.
- Android coalesces contiguous chunks into 1 MiB disk writes.
- Initial flight credit is bounded to 4 MiB on WAN and 16 MiB on LAN.
- Android uses delivery-rate feedback to pace at 1.10x measured goodput.
- Desktop starts at 32 MiB/s on WAN and grows using delivery feedback rather
  than initially blasting several gigabytes per second.
- Parity is disabled on clean paths and activates after observed repair demand.
- Transfer speed reports now contain measured bytes per second.

## Benchmark matrix

Every release should test a minimum 4 GiB incompressible file and a 4 GiB
compressible corpus in both directions.

| Path | Devices | Metrics |
|---|---|---|
| Loopback | desktop to desktop | crypto/protocol CPU ceiling |
| Wired LAN | two desktops | goodput, CPU, disk utilization |
| Wi-Fi LAN | Android and desktop | goodput, loss, thermal throttling |
| Android direct link | two Android devices | setup time and sustained goodput |
| WAN emulator | 10–200 ms RTT, 0–3% loss | goodput, repair bytes, completion time |

Record:

- source bytes and transmitted bytes;
- compression time and ratio;
- time to first payload byte;
- average and p10 one-second goodput;
- retransmitted and parity bytes;
- sender/receiver CPU usage;
- peak resident memory;
- SHA-256 result and final restored size.

## Next high-impact upgrades

1. Move encryption, packet framing, hashing, and file I/O into one shared native
   Rust core. JavaScript IPC and per-datagram `Cipher` construction will
   eventually become the ceiling on multi-gigabit links.
2. Add Zstandard fast modes and multi-threaded desktop compression. Zstd's
   reference benchmarks show materially higher compression and decompression
   throughput than zlib at comparable ratios.
3. Add Wi-Fi Aware/Wi-Fi Direct path creation on Android. When available, use
   the resulting direct network for the existing encrypted UDP protocol.
4. Replace the custom recovery controller with a well-tested QUIC recovery/BBR
   implementation once a single embeddable library is selected for Windows and
   Android. Keep connection tickets as the discovery/authentication layer.
5. Add content-defined chunking and an opt-in receiver block cache for repeated
   backups and VM images; send hashes first and transfer only missing blocks.

Performance claims should be made only from this matrix and should distinguish
raw goodput from effective goodput after lossless compression or deduplication.
