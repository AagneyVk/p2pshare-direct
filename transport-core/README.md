# Shared QUIC core — staged v3 alpha

This is a working, independently tested Rust data plane, **not yet the transport
used by either application UI**. Do not advertise P2PShare as migrated to QUIC.

```sh
cargo test --locked --manifest-path transport-core/Cargo.toml
cargo run --locked --release --manifest-path transport-core/Cargo.toml --example loopback -- 64
```

The example prints JSON and uses temporary local files. Pass 4096 for a 4 GiB
smoke benchmark (requires over 8 GiB free space). This is warm-cache loopback,
not measured Android/Wi-Fi throughput. Source generation and certificate
generation are outside the timer; connection, prehashing, payload, receiver
verification, filesystem sync, and completion receipt are inside it.

## Responsibilities

- Quinn: actual QUIC packetization, congestion control, flow control, loss
  recovery, transport encryption and PMTU behavior.
- rustls: TLS 1.3 with mutual certificate validation; no accept-all verifier.
- Shared application layer: bounded manifest parsing, BLAKE3 block hashes,
  revalidated partial files, source mutation checks, quota check, verified
  completion receipt and no-overwrite final publication.
- Future platform adapters: certificate exchange bound to pairing, file chooser
  and consent, private storage, capacity checks, progress/cancellation, JNI and
  N-API integration, lifecycle, discovery and direct NAT traversal.

Quinn was chosen for its portable Rust implementation, runtime-independent
protocol layer, Tokio adapter and rustls support. This is a staging choice, not
a claim of superior throughput versus TCP or another QUIC library. Review
Android NDK builds and device measurements before committing both clients.

References: https://docs.rs/quinn/latest/quinn/ and
https://github.com/quinn-rs/quinn (MIT/Apache-2.0).

## Important limitations

- One file stream per connection; no custom congestion controller or parallel
  path bonding. Fixed 1 MiB application blocks are not UDP packet sizes.
- A conservative 512 KiB stream receive/send window avoids an observed Quinn
  gap-buffer abort with the earlier 8 MiB window in sustained loopback tests.
  This limits high-BDP throughput. Characterize receive draining and realistic
  loss/reordering before raising it; do not disable the library's safety bound.
- Whole-file prehash and receiver rehash cost extra disk passes. Measure total
  elapsed time; subsequent work should pipeline independently verifiable blocks.
- Resume requires the same source digest and application-private partial
  directory. Partial blocks are rehashed, not trusted from a persisted bitmap.
- Final publication uses hard links, so the destination filesystem must support
  them. Android SAF/document providers need a separate publication adapter.
- Existing completed destinations are refused, including retry after a lost
  completion receipt. Idempotent completed-transfer receipts remain necessary.
- Local storage must be app-private, not writable by an adversary. Metadata
  checks do not eliminate TOCTOU attacks in attacker-controlled directories.
- A per-call size quota is not total disk reservation or a global session quota.
- Peer certificates must already be trusted out of band. Ticket exchange,
  expiry, single-use acceptance and stable trust persistence are not implemented.
- Timeouts are transport idle timeouts, not complete application deadlines.
- No content-defined dedupe, adaptive compression, path learning, UI adapter,
  Android service, telemetry dashboard or multipath implementation yet.

Do not enable this by default until the gates in `../PRODUCTION-READINESS.md`
are met. The old application path remains experimental as well.
