# Protocol v3-alpha (staged, not v2-compatible)

Low-level mTLS ALPN is `p2pshare/3-alpha2` (changed for the display-name field).
Desktop ticket pairing uses `p2pshare/3-ticket-alpha1`, with server certificate
trust from the ticket and application-level bearer authentication inside TLS.
These are explicit distinct configurations, not silent authentication fallback.
No plaintext data plane or 0-RTT file operations are supported.

Desktop first stream: guest sends the 32-byte random ticket secret and FIN;
host validates it in constant time before ticket expiry and sends `OK` + FIN.
Only then are file streams accepted. Host accepts one authenticated connection
and removes its server configuration. The URL-safe, case-sensitive `p2p3:` ticket
contains version 1, endpoint, expiry (five minutes), certificate and secret.
It is bounded at 8,192 characters. Share the whole ticket through a trusted channel.
Guest-side plausibility checks allow 60 seconds of clock skew; the host still
enforces the original five-minute deadline using its own clock.

One sender opens one bidirectional QUIC stream. All lengths are unsigned
big-endian. File data stays on that stream; QUIC supplies reliable delivery and
backpressure. The receiver accepts only one concurrent bidirectional stream and
no unidirectional streams with the provided configuration.

1. Sender: four-byte manifest length followed by JSON (at most 24 MiB).
2. Manifest: `version` = 3, `size` <= 256 GiB, `block_size` = 1048576,
   lowercase 64-character BLAKE3 `digest`, and ordered block digests in `blocks`.
   Optional `name` is display-only, bounded at 255 UTF-8 bytes with no controls.
   Unknown fields, inconsistent geometry and invalid hashes are rejected.
3. Receiver: four-byte resume-map length, then one byte per block. `1` requests
   the block, `0` means its bytes have been rehashed and already match. No other
   values are valid. Map length must exactly match the manifest block count.
4. Sender: requested blocks in ascending index order, without extra framing.
   Each length follows from the manifest; only the last can be shorter than
   1 MiB. Sender rechecks requested source blocks to detect mutation.
5. Sender finishes its stream direction. Receiver rejects any excess bytes.
6. Receiver verifies each received block, syncs the partial, verifies the whole
   file, and publishes without replacing an existing file. A matching completed
   destination is reverified and acknowledged again with an all-zero resume map.
   It responds with the
   64-byte whole-file digest and finishes its direction.
7. Sender reports completion only after receiving that exact receipt.

Empty files have no block hashes and use the BLAKE3 digest of the empty string.
No remote filename becomes a filesystem path. Partial and final storage names
derive only from a validated whole-file hash.

Resume: reconnect through authenticated pairing and offer the same manifest.
An OS file lock serializes writers for the digest. Existing partial blocks are
rehash-checked, including after unclean exit; stale on-disk bitmap state is not
used. This is fixed-block partial reuse, **not content-defined deduplication**.

This experimental ALPN may change before stabilization. No automatic downgrade
to v2 is implemented. Stable version negotiation, persistent peer identity,
explicit per-file cancellation, peer-wide cache authorization and Android-safe
file publication must be specified before production integration.
