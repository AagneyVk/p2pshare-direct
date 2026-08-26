# Android Rust fast path

This crate is the first coarse JNI bridge for the Android transfer hot path. It deliberately does not expose per-packet JNI calls.

Current primitives prove direct descriptor ownership/probing and native large-region reads. The next stage replaces `nativeRead`'s Java byte-array return with a long-lived native session and reusable native arenas so file bytes do not bounce through the JVM.

Build with `ANDROID_NDK_HOME` set and run `./android/build-native-rust.sh`. The resulting arm64-v8a shared library is copied into the app's `jniLibs` directory for packaging.

Performance work belongs below this boundary: region compression, hashing, crypto, packetization, sendmmsg/GSO and retransmission caches. Kotlin owns lifecycle, permissions, UI and URI acquisition only.
