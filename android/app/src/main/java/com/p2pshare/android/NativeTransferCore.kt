package com.p2pshare.android

import android.os.ParcelFileDescriptor

/**
 * Coarse JNI boundary for the Rust transfer engine.
 *
 * JNI is intentionally session/region oriented: no per-datagram JNI calls are allowed
 * on the transfer hot path. The descriptor passed to Rust is a dup owned by this
 * object; Kotlin retains the provider descriptor and its close/error semantics.
 */
internal class NativeTransferCore private constructor() : AutoCloseable {
    private var handle: Long = nativeCreate()

    val available: Boolean get() = handle != 0L

    fun attachReadableFile(providerFd: ParcelFileDescriptor): NativeSource {
        check(available) { "native transfer core unavailable" }
        // fromFd() duplicates the raw descriptor. detachFd() transfers ownership of
        // that duplicate to Rust without detaching the provider-owned descriptor.
        val duplicate = ParcelFileDescriptor.fromFd(providerFd.fd)
        val nativeFd = duplicate.detachFd()
        val sourceId = nativeAttachReadableFd(handle, nativeFd)
        if (sourceId == 0L) {
            // Rust closes fd on every attach attempt, including failure.
            error("Rust core rejected file descriptor")
        }
        return NativeSource(sourceId)
    }

    fun probeSource(source: NativeSource, sampleBytes: Int = 4 * 1024 * 1024): SourceProbe {
        require(sampleBytes in 64 * 1024..32 * 1024 * 1024)
        val packed = nativeProbeSource(handle, source.id, sampleBytes)
        return SourceProbe(
            readable = packed and 1L != 0L,
            seekable = packed and 2L != 0L,
            regularFile = packed and 4L != 0L,
            sizeKnown = packed and 8L != 0L,
            size = nativeSourceSize(handle, source.id)
        )
    }

    fun readRegion(source: NativeSource, offset: Long, bytes: Int): ByteArray {
        require(offset >= 0 && bytes in 1..32 * 1024 * 1024)
        return nativeReadRegion(handle, source.id, offset, bytes)
    }

    fun release(source: NativeSource) {
        if (handle != 0L) nativeReleaseSource(handle, source.id)
    }

    override fun close() {
        val value = handle
        handle = 0
        if (value != 0L) nativeDestroy(value)
    }

    @JvmInline value class NativeSource internal constructor(internal val id: Long)
    data class SourceProbe(
        val readable: Boolean,
        val seekable: Boolean,
        val regularFile: Boolean,
        val sizeKnown: Boolean,
        val size: Long
    )

    companion object {
        private val loaded = runCatching {
            // Cargo package/native library name is p2pshare_android, producing
            // libp2pshare_android.so in jniLibs/arm64-v8a.
            System.loadLibrary("p2pshare_android")
            true
        }.getOrDefault(false)

        fun createOrNull(): NativeTransferCore? = if (loaded) NativeTransferCore() else null

        @JvmStatic private external fun nativeCreate(): Long
        @JvmStatic private external fun nativeDestroy(handle: Long)
        @JvmStatic private external fun nativeAttachReadableFd(handle: Long, fd: Int): Long
        @JvmStatic private external fun nativeReleaseSource(handle: Long, sourceId: Long)
        @JvmStatic private external fun nativeProbeSource(handle: Long, sourceId: Long, sampleBytes: Int): Long
        @JvmStatic private external fun nativeSourceSize(handle: Long, sourceId: Long): Long
        @JvmStatic private external fun nativeReadRegion(handle: Long, sourceId: Long, offset: Long, bytes: Int): ByteArray
    }
}
