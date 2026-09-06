# Migration threat model

Current desktop preview details are in `QUIC-DESKTOP.md`. Its pairing mode uses
TLS server trust anchored in the private ticket, followed by a random one-use
bearer secret inside TLS. The low-level mTLS fixture remains separate. Display
names are bounded and never become private storage paths. IPC validates the
main frame and expected URL; received-file export is explicitly user-confirmed.
Paired peers can test possession of known cached content; cache partitioning by
persistent peer identity/capability remains a production gate.

Assets: file confidentiality/integrity, user-selected source and destination,
peer identity, pairing secrets, local capacity, completion correctness.

Trust boundaries: network to QUIC/TLS; authenticated peer to manifest parser;
manifest to disk; UI to native bridge; pairing material to certificate trust;
Android document provider to source/destination adapter.

| Threat | Current protection | Remaining gate |
| --- | --- | --- |
| Passive network observer | v2 AEAD; v3 QUIC TLS 1.3 | Endpoint compromise is out of scope |
| Untrusted network peer | v3 mutual certificate authentication | Bind certificates to expiring, consented pairing |
| Plaintext data injection | v2 data dispatch now requires encrypted envelope | Full v2 parser/state-machine audit |
| Replay | v2 bounded replay window; QUIC transport protection | Application-level pairing and completion replay policy |
| Path traversal | v3 paths use validated digest, no peer filename | Private directory and platform adapter enforcement |
| Oversized/malformed offer | v3 frame limit, geometry/hash checks, size quota | Fuzzing and aggregate capacity reservation |
| Corrupt partial or changed source | BLAKE3 blocks and whole-file check | Device crash/power-loss matrix |
| Concurrent transfer overwrite | OS lock, no-overwrite hard-link publication | SAF adapter and idempotent completion handling |
| Slow or malicious paired peer | Bounded file buffer and QUIC windows | Transfer deadlines, cancellation, global budgets |
| Local filesystem attacker | App-private storage required | Not safe in attacker-writable directories |

The remaining v2 path is not independently audited. The 64-counter replay
window can reject heavily reordered valid traffic; it is a bounded security
baseline, not a high-loss performance solution. Retire custom v2 recovery and
crypto after cross-platform v3 gates pass, rather than stacking new mechanisms.

No security claim is made for Android changes until compilation and device
tests are completed. No secrets or certificates should be exported in logs.
