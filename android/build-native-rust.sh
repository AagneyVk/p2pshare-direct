#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to the Android NDK}"
API="${ANDROID_API:-26}"
TARGET="aarch64-linux-android"
HOST_TAG="${HOST_TAG:-linux-x86_64}"
TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/aarch64-linux-android${API}-clang"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${API}-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"

rustup target add "$TARGET"
cargo build --release --target "$TARGET" --manifest-path android/native-rust/Cargo.toml
mkdir -p android/app/src/main/jniLibs/arm64-v8a
cp "android/native-rust/target/$TARGET/release/libp2pshare_android.so" android/app/src/main/jniLibs/arm64-v8a/
echo "Installed Android Rust core -> android/app/src/main/jniLibs/arm64-v8a/libp2pshare_android.so"
