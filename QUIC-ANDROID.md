# Android / desktop QUIC preview

The Android launcher now uses the same Rust engine and v3 ticket ALPN as
`npm run desktop:quic`. Desktop's default `npm run desktop` remains v2 and
cannot pair with this Android preview. Legacy Android v2 sources are retained.

## Connect

Install the `android-quic-debug` APK from a successful CI run. Use ARM64 Android
8+ or an x86-64 emulator. Run the desktop QUIC preview on the same reachable LAN
or hotspot. Create on either device, privately copy the FULL case-sensitive
`p2p3:` ticket, and join on the other within five minutes. One ticket admits one
guest. Hosting consents to receiving that guest's files.

Select a file on either side. Android stages document-provider input to private
disk using a bounded 1 MiB buffer, then Rust handles QUIC, hashes and disk IO.
This supports nonseekable providers but costs one local copy and needs extra
free space; it is not zero-copy. Received verified files are exported to Downloads
on Android 10+, or app-specific external Downloads on Android 8–9. Desktop uses
its SAVE dialog. Display names are sanitized; native storage uses content hashes.

Keep the app open during transfers. Disconnect cancels the engine. A new ticket
and resend reuse verified blocks in private storage. Activity destruction (such
as rotation) closes the session. There is no foreground service or automatic
network handoff yet. Partials and verified native files are retained; automatic
retention and peer-separated caches remain release work. Staging files normally
delete after sending, but a killed process can leave staging data in app cache.

## Build and validation

Install JDK 17, Android SDK 35, NDK 28.0.13004108, stable Rust with targets
`aarch64-linux-android` and `x86_64-linux-android`, and
`cargo install cargo-ndk --version 4.1.2 --locked`. Then run in `android/`:

```sh
./gradlew testDebugUnitTest assembleDebug
./gradlew connectedDebugAndroidTest
```

Gradle builds the shared library automatically. Native payloads are packaged for
both ABIs with 16 KiB ELF alignment and extracted-library packaging. This is not
a complete 16 KiB-device certification of all bundled third-party libraries.

`tests/android-native-interop.py` exercises the exact exported JNI primitive ABI
over a socketpair against the desktop executable on Linux: both host roles,
bidirectional byte comparison, completed retries, and runtime shutdown. Android
instrumentation separately checks Java linkage, native loading and transfers.
These are correctness tests, not physical Wi-Fi throughput measurements.

Local build validation was blocked by missing Rust and unreachable Gradle
downloads. CI is configured to build both Android ABIs, run emulator integration,
and test desktop/native interoperability; consult the specific run for results.

Primary API/build references:
- https://developer.android.com/reference/android/os/ParcelFileDescriptor
- https://developer.android.com/guide/practices/page-sizes
