# Research decisions and evidence gates

Primary references reviewed for this milestone:

- Quinn transport configuration:
  https://docs.rs/quinn/latest/quinn/struct.TransportConfig.html
- Iroh tickets and their security properties:
  https://docs.iroh.computer/concepts/tickets
- Electron privileged IPC and security guidance:
  https://www.electronjs.org/docs/latest/tutorial/security
- Electron release catalogue: https://releases.electronjs.org/
- Android foreground-service timeouts:
  https://developer.android.com/develop/background-work/services/fgs/timeout
- Android user-initiated data-transfer jobs:
  https://developer.android.com/develop/background-work/background-tasks/uidt

## Decisions applied

1. Keep proven QUIC recovery/congestion control. Window tuning depends on RTT,
   bandwidth and memory, so no more unmeasured huge-window presets. The observed
   large-window gap-buffer failure remains an investigation, not a reason to
   remove library resource defenses.
2. Treat a dialing ticket as address information PLUS explicit authentication.
   Unlike generic reusable endpoint tickets, our preview ticket has a five-minute
   deadline, certificate trust anchor and one-use bearer capability. This is
   conventional secure composition, not claimed cryptographic novelty.
3. Put sockets, reads, block verification and writes in Rust. A process boundary
   avoids coupling QUIC to Electron's embedded Node ABI and isolates failures.
   No native file bytes pass through renderer IPC.
4. Validate the sender frame of privileged IPC and disallow navigation/popups.
   Upgrade the unsupported Electron 31 dependency to 44.2.0 (registry and official
   release catalogue checked); keep platform GUI verification as an explicit gate.
5. Do not assume an Android dataSync foreground service may run indefinitely.
   Evaluate user-initiated transfer jobs on supporting API levels, with a lifecycle
   adapter for older devices, rather than introducing an untested service now.

## Research experiments still required

- Receive pipeline draining, block size, bounded concurrent block streams and
  QUIC window/controller choice: measure completed-file time, memory and fairness
  against a TCP/TLS reference, not just one favorable throughput run.
- Compression: implement only when sampled CPU cost plus reduced wire time beats
  raw transfer. Include decompression and disk effects in the decision.
- Content-defined chunking: compare shifted/edited corpora against fixed-block
  resume, including fingerprinting startup cost and cache indexing overhead.
- Cache privacy: before general cross-peer dedupe, add persistent peer identity
  and cache partitioning/capability authorization. Even a cache-hit response can
  disclose possession of known content to a paired peer.
- True independent-path scheduling: establish whether interfaces share a radio,
  access point or bottleneck before treating their capacities as additive.
- Run physical Android/Windows/Linux measurements: 4+ GiB raw data, tiny-file
  batches, 10–200 ms RTT, 0–3% loss, thermal soak, interrupted writes, sleep,
  reauthentication and network change. Publish raw repetitions and machine specs.

No algorithmic novelty, state-of-the-art ranking or production security assurance
is claimed yet. Each proposed optimization must survive ablation against the
unmodified shared core on the same topology and corpus.
