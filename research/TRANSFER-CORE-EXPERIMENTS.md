# Transfer Core Experiments

This branch treats P2PShare as a measured transfer-engine research project. The objective is minimum wall-clock time from sender selection to receiver verification, not maximum utilization or a single synthetic throughput number.

## Rule

Do not merge a mechanism because it sounds faster. Every mechanism must beat the current protocol under a reproducible workload or provide a clearly measured benefit in a specific operating region.

## Baseline

The current v2 transport is the control: native AES-256-GCM where available, 1400-byte default chunks, adaptive MTU probes, Zstandard support, selective repair, XOR parity, striped logical streams, direct disk streaming and receiver coalescing.

## E1 — Compression pipeline

Test independent-region compression rather than whole-file serial preprocessing.

Variables:
- region: 256 KiB, 1 MiB, 4 MiB, 16 MiB, 32 MiB
- workers: 1, 2, 4, 8, logical CPU count
- mode: raw, Zstd level 1, Zstd fast modes when exposed
- corpus: text/source, mixed files, zeros/repetitive, executable/binary, JPEG/MP4/archive

Measure source MiB/s, encoded MiB/s, compression ratio, wall time, CPU time and peak memory. The useful result is effective transfer completion time at simulated link rates, not compression ratio alone.

## E2 — Wire datagram sweep

Decouple logical transfer regions from UDP datagram size and benchmark payload candidates 512, 768, 1024, 1200, 1280, 1360, 1400, 1432 and path-probed larger values.

Measure goodput, packets/s, CPU, send-call rate, loss/repair amplification and fragmentation/failure. Never assume a larger datagram is Internet-safe merely because a local path accepts it.

## E3 — Native hot path

Measure and progressively remove JS/native crossings and transient buffer copies. Compare current per-packet N-API sealing with batched native packet processing. The long-term candidate owns file read, region processing, hashing, packet framing, encryption and I/O scheduling in Rust while UI/state remains outside the hot path.

## E4 — Fully overlapped pipeline

Prototype bounded stages:

read -> classify -> compress/raw -> integrity -> FEC -> encrypt/frame -> send

Each stage operates concurrently with backpressure. Benchmark queue depth and worker count. The target is a steady-state pipeline whose rate approaches its slowest unavoidable resource rather than the sum of serial stage times.

## E5 — Recovery coding

Compare current XOR parity against no FEC, Reed-Solomon and a production-quality fountain/RaptorQ implementation if a suitable maintained library is selected. Measure CPU cost, wire overhead and completion time under random and burst loss separately.

## E6 — True multipath

Use simultaneous usable interfaces as distinct paths, not merely fallbacks. Compare best-single-path, weighted striping and concurrent paths. Detect shared bottlenecks so nominal interface bandwidth is not incorrectly summed.

## E7 — Coded multipath

Schedule erasure/fountain symbols rather than assigning irreplaceable sequential chunks to paths. Test path failure, heterogeneous RTT/loss and rapid bandwidth changes.

## E8 — Path roles

Test asymmetric roles: fastest path for source symbols; secondary/reliable path for ACK/control/repair/parity. Compare against ordinary weighted striping. This is a first-class experiment rather than an assumed optimization.

## E9 — Content reuse

Compare fixed blocks, FastCDC/Gear-style content-defined chunking and receiver-known block filters. Measure metadata cost as well as bytes avoided. Add dictionary-assisted compression only after dedup baselines exist.

## E10 — Filesystem-aware transfer

Detect sparse extents where supported and represent holes without reading/compressing/transmitting zero-filled ranges. Add small-file packing and streaming metadata as separate experiments.

## Benchmark matrix

At minimum, evaluate loopback CPU ceiling, wired LAN, Wi-Fi LAN, Android/desktop, and emulated WAN profiles. Include clean, random-loss, burst-loss, high-RTT and bandwidth-change cases.

For every run record:
- source bytes
- wire bytes
- verified output bytes
- wall-clock completion time
- time to first payload
- average and p10 one-second goodput
- effective source throughput
- CPU time/utilization where available
- peak memory
- repair/FEC bytes
- compression ratio/time
- final integrity result

## Merge gate

A research mechanism graduates only when its benchmark data identifies a repeatable operating region where it improves end-to-end completion time or another explicitly targeted resource without breaking protocol correctness, Android/Desktop interoperability, bounded memory, encryption or integrity.

## First implementation order

1. Extend the benchmark harness so results are machine-readable and reproducible.
2. Add native compression-region benchmarks and worker/region sweeps.
3. Add datagram-size and packet/batch crypto microbenchmarks.
4. Build the bounded overlapped native pipeline prototype.
5. Only then introduce alternative FEC and multipath, so their results are not hidden by avoidable CPU/copy bottlenecks.
