# P2P Share Android

This is a buildable Android client for the desktop native protocol. Pairing is
serverless: a self-contained connection ticket carries the host's public IPv4,
an optional NAT-mapped port, a one-time secret, and a typo checksum. File
payloads travel directly over encrypted UDP; TURN and payload relays are not used.

## Build

Open `android/` in Android Studio, or run:

```powershell
cd android
.\gradlew.bat assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## Test matrix

1. Install the debug APK on one or two Android devices.
2. Start the Electron desktop with `npm run build` followed by `npm run desktop`.
3. Select **Create Session** on either device and enter its code on the other.
4. Wait until the UI reports `DIRECT: address:port`.
5. Select and send a file in either direction.

Supported native combinations:

- Android to Android
- Android to desktop
- Desktop to Android
- Desktop to desktop

The receiving Android device verifies SHA-256 and saves completed files under
`Downloads/P2PShare` on Android 10 and later.

## Direct-only behavior

The host discovers its UDP socket's public mapping with STUN and encodes it in
the ticket. The guest authenticates directly to that endpoint. HMAC protects the
handshake, HKDF derives a unique session key, and AES-256-GCM protects protocol
packets. Networks that prohibit a direct route fail rather than use a relay.

## Protocol compatibility

The Android transport implements desktop protocol v2 packet types for HELLO,
OFFER, CHUNK, DONE, FLOW, REPAIR, REPAIR_RANGE, COMPLETE, MTU probing,
ACK-frequency compatibility, and immediate flow acknowledgments. Transfers use
1,400-byte payload chunks, 16 logical stripes, random-access repair reads,
bounded flow credit, and SHA-256 completion validation.

## Adaptive compression

The sender samples the beginning, two interior regions, and the end of likely
compressible files. It uses streaming fast DEFLATE only when predicted savings
are at least five percent. Large inputs are compressed into a temporary spool
with a bounded 1 MiB working buffer; repair and resume logic operate on that
spool. Packed media, archives, APKs, and similarly incompressible formats bypass
compression.
