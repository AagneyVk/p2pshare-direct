# Protocol v3-alpha (staged, not v2-compatible)

ALPN is `p2pshare/3-alpha`. TLS 1.3 requires mutual certificate authentication
against explicitly supplied peer trust roots. No plaintext data plane or 0-RTT
file operations are supported. Pairing must authenticate these certificates
before calling the core; discovery alone must never establish trust.

One sender opens one bidirectional QUIC stream. All lengths are unsigned
big-endian. File data stays on that stream; QUIC supplies reliable delivery and
backpressure. The receiver accepts only one concurrent bidirectional stream and
no unidirectional streams with the provided configuration.

1. Sender: four-byte manifest length followed by JSON (at most 24 MiB).
2. Manifest: `version` = 3, `size` <= 256 GiB, `block_size` = 1048576,
   lowercase 64-character BLAKE3 `digest`, and ordered block digests in `blocks`.
   Unknown fields, inconsistent geometry and invalid hashes are rejected.
3. Receiver: four-byte resume-map length, then one byte per block. `1` requests
   the block, `0` means its bytes have been rehashed and already match. No other
   values are valid. Map length must exactly match the manifest block count.
4. Sender: requested blocks in ascending index order, without extra framing.
   Each length follows from the manifest; only the last can be shorter than
   1 MiB. Sender rechecks requested source blocks to detect mutation.
5. Sender finishes its stream direction. Receiver rejects any excess bytes.
6. Receiver verifies each received block, syncs the partial, verifies the whole
   file, and publishes without replacing an existing file. It responds with the
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
to v2 is implemented. Version negotiation, completed-receipt persistence,
explicit cancellation frames, peer-wide quotas and platform-safe file
publication must be specified before production integration.
