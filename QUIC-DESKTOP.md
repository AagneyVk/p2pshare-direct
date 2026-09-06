# QUIC desktop preview

This is a working opt-in desktop path, not a production release. It keeps all
file data and QUIC processing in a separate Rust process. Electron exchanges
bounded JSON commands and throttled status events, never per-packet payloads.
The original v2 path remains the default; Android is still v2-only.

## Run on two desktops

Requirements: Node 22.12+ (24 recommended), current stable Rust, linker.

```sh
npm ci
npm run build:engine
npm run build
npm run desktop:quic
```

1. Connect both desktops to a mutually reachable LAN (or already configured
   direct overlay). The preview does not establish NAT traversal or a relay.
2. Create a session on one desktop. Privately copy its full `p2p3:` ticket to the
   other. Creating a session consents to receiving files from its ticket holder.
3. Join in QUIC preview on the second desktop. Tickets are case-sensitive,
   expire after five minutes, and authorize one successfully authenticated guest.
4. Send a local file with the file picker. Only one outbound file at a time is
   supported; simultaneous opposite-direction sends use the same connection.
5. After VERIFIED appears on the receiver, use SAVE to export the file. Existing
   destination files are refused rather than overwritten.
6. Disconnect cancels ongoing work and stops the engine. Reconnect with a NEW
   ticket and resend the same source to reuse verified partial blocks. Completed
   duplicates are reverified and acknowledged without transferring payload.

On Windows, allow the native engine's UDP traffic through the appropriate
private-network firewall prompt. The preview chooses an IPv4 interface; multiple
NIC/VPN systems may need future interface selection. Do not disable firewalls
globally. There is no server account, upload store or hosted relay.

`npm run desktop` still starts the original v2 transport. The preview deliberately
does not fall back to it silently. Chat and renderer-side compression are disabled
in preview. Real local files bypass renderer buffering entirely.

## Pairing and storage

`pairing.rs` generates a temporary TLS certificate and independent 256-bit random
secret. The ticket includes that certificate, secret, endpoint and expiry. The
guest validates the host against the ticket certificate BEFORE sending the secret
inside TLS. The host checks the secret in constant time, then closes acceptance
of new connections. This is certificate-authenticated TLS plus application-level
bearer authentication, **not mutual TLS client-certificate authentication**.
The separate low-level mTLS configuration remains for tests and pretrusted peers.

A ticket must arrive through a trusted channel: replacing the entire ticket is
outside this trust model. Tickets expose endpoint addresses and confer session
access. Do not log them, upload them to ticket decoders or post them publicly.

Verified and partial files live under Electron's private userData/quic-received
directory. Names on disk are digest-derived. UI display names never become native
storage paths. Export uses a user-confirmed save dialog and no-overwrite copying.
Retention is currently manual; no automatic expiry/cleanup of partial files is
implemented. The receiver caps a session at 1,024 files and 256 GiB of accounted
logical data, charging at least 4 KiB per file. Free-space checks are conservative
preflight checks, not atomic disk reservations.

## Verified here

- Two actual engine processes, driven through the same JS controller as Electron.
- Bidirectional file transfer and byte-for-byte comparison.
- Completed-file retry with zero payload bytes.
- Fresh-process partial reuse (2 MiB retained; remaining bytes transferred).
- Altered secret, substituted certificate, expired and oversized ticket rejection.
- 20 ms injected round-trip delay and deterministic 1% packet drops in a bounded
  test-only UDP proxy. This is not a full WAN emulation/performance matrix.
- TypeScript/Vite build, Rust tests and Clippy, IPC sender policy tests.

The Electron window/file picker/save dialog has NOT been manually exercised here.
Windows CI, Android builds/devices, real Wi-Fi speed, energy, sleep/handoff,
installed-app signing and packaging remain release gates. Electron was upgraded
from 31 to registry-current 44.2.0; GUI/runtime compatibility needs platform testing.

The 512 KiB stream window is still conservative and can constrain high-RTT
throughput. No general speedup or novel-algorithm claim follows from these tests.
