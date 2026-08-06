# P2PShare native core

This Rust N-API module accelerates the desktop transfer hot path. It provides
AES-256-GCM packet sealing/opening with a bounded replay window and 1 MiB
streaming SHA-256 file hashing. `npm run build:native` builds and installs the
platform addon; the desktop automatically falls back to Node crypto if it is
not present.

It also exposes streaming Zstandard file compression/decompression used by the
negotiated `zstd` transfer encoding.

The packet envelope is identical to the Android implementation, so Rust
desktop peers interoperate with Android's hardware/native-backed cryptography
provider. An Android Rust build can be added when an NDK and Rust Android
targets are available, but it should first be benchmarked against that provider:
crossing JNI for each small datagram can cost more than it saves.
