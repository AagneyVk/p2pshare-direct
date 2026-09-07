package com.p2pshare.android

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Same bounded JSON command protocol and Rust data plane as desktop --quic. */
class QuicTransport(private val context: Context, private val listener: DirectUdpTransport.Listener) : Closeable {
    private external fun nativeRun(fd: Int): Int
    private external fun nativeRegister(fd: Int): Long
    private external fun nativeRelease(handle: Long)
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val closed = AtomicBoolean(false)
    private val sending = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    private val directory = File(context.filesDir, "quic-received").apply { mkdirs() }
    private val sockets: Array<ParcelFileDescriptor>
    private val input: ParcelFileDescriptor.AutoCloseInputStream
    private val output: ParcelFileDescriptor.AutoCloseOutputStream

    init {
        System.loadLibrary("p2pshare_transport")
        sockets = ParcelFileDescriptor.createSocketPair()
        input = ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(sockets[0].fileDescriptor))
        output = ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(sockets[0].fileDescriptor))
        val nativeFd = sockets[1].detachFd()
        Thread({
            val result = nativeRun(nativeFd)
            if (!closed.get()) fail(IllegalStateException("Native session ended ($result); reconnect"))
        }, "quic-native").start()
        Thread({
            try {
                val line = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (!closed.get()) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    for (i in 0 until count) {
                        if (buffer[i] == 10.toByte()) {
                            dispatch(JSONObject(line.toString("UTF-8")))
                            line.reset()
                        } else {
                            check(line.size() < 16384) { "Oversized native event" }
                            line.write(buffer[i].toInt())
                        }
                    }
                }
                if (!closed.get()) fail(IllegalStateException("Peer disconnected; reconnect to resume"))
            } catch (error: Exception) { if (!closed.get()) fail(error) }
        }, "quic-events").start()
    }

    private fun dispatch(event: JSONObject) {
        when (event.getString("event")) {
            "response" -> pending.remove(event.getString("id"))?.complete(event)
            "connected" -> listener.onConnected(InetSocketAddress("127.0.0.1", 0))
            "error" -> fail(IllegalStateException(event.getString("message")))
            "progress" -> listener.onProgress(event.optString("name", "file"), event.getBoolean("incoming"),
                event.getLong("bytes"), event.getLong("size"))
            "received" -> {
                val digest = event.getString("id")
                check(digest.matches(Regex("[0-9a-f]{64}")))
                val file = File(directory, digest)
                check(file.canonicalFile.parentFile == directory.canonicalFile && file.isFile)
                listener.onReceived(file, safeName(event.optString("name")), "application/octet-stream")
            }
        }
    }

    private fun request(command: JSONObject, timeoutSeconds: Long): JSONObject {
        check(!closed.get()) { "Session closed; create or join again" }
        val id = UUID.randomUUID().toString()
        command.put("id", id)
        val bytes = (command.toString() + "\n").toByteArray(Charsets.UTF_8)
        require(bytes.size <= 16384)
        val future = CompletableFuture<JSONObject>()
        pending[id] = future
        try {
            synchronized(output) { output.write(bytes); output.flush() }
            val response = future.get(timeoutSeconds, TimeUnit.SECONDS)
            check(!response.has("error")) { response.optString("error") }
            return response
        } finally { pending.remove(id) }
    }

    fun createTicket(advertisedIp: String? = null): String {
        val ip = advertisedIp ?: NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
            ?.hostAddress ?: error("Connect to a Wi-Fi network or hotspot first")
        return request(JSONObject().put("op", "host").put("ip", ip)
            .put("directory", directory.absolutePath), 15).getString("value")
    }

    fun joinTicket(ticket: String) {
        require(ticket.startsWith("p2p3:") && ticket.length <= 8192) { "Use a full desktop QUIC ticket" }
        request(JSONObject().put("op", "join").put("ticket", ticket)
            .put("directory", directory.absolutePath), 25)
    }

    fun sendFile(uri: Uri) {
        if (closed.get()) { listener.onStatus("Session closed; disconnect and reconnect"); return }
        if (!sending.compareAndSet(false, true)) { listener.onStatus("A file is already sending"); return }
        worker.execute {
            var staging: File? = null
            try {
                check(!closed.get())
                var name = "file"
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) name = safeName(it.getString(0))
                }
                // Native owns a duplicate until completion, even if Java cancels.
                // Pipe/cloud providers retain the bounded staging fallback below.
                val descriptor = runCatching { context.contentResolver.openFileDescriptor(uri, "r") }.getOrNull()
                descriptor?.use { fd ->
                    val handle = nativeRegister(fd.fd)
                    if (handle > 0) {
                        try {
                            listener.onStatus("Reading $name directly • No staging copy")
                            request(JSONObject().put("op", "send_descriptor").put("handle", handle).put("name", name), 24 * 60 * 60L)
                            listener.onStatus("Verified by peer: $name")
                            return@execute
                        } finally { nativeRelease(handle) }
                    }
                }
                staging = File(context.cacheDir, "quic-send-${UUID.randomUUID()}").apply { check(mkdir()) }
                val source = File(staging, name)
                listener.onStatus("Preparing $name… Keep P2P Share open")
                context.contentResolver.openInputStream(uri).use { incoming ->
                    requireNotNull(incoming)
                    source.outputStream().use { target ->
                        val buffer = ByteArray(1024 * 1024)
                        var total = 0L
                        while (true) {
                            check(!closed.get()) { "Transfer cancelled" }
                            val count = incoming.read(buffer)
                            if (count < 0) break
                            total += count
                            check(total <= 256L * 1024 * 1024 * 1024 && source.parentFile!!.usableSpace > count + 16L * 1024 * 1024) {
                                "Insufficient staging space or file exceeds 256 GiB"
                            }
                            target.write(buffer, 0, count)
                        }
                    }
                }
                request(JSONObject().put("op", "send").put("path", source.absolutePath), 24 * 60 * 60L)
                listener.onStatus("Verified by peer: $name")
            } catch (error: Exception) { if (!closed.get()) listener.onError(error) }
            finally { staging?.deleteRecursively(); sending.set(false) }
        }
    }

    private fun fail(error: Throwable) { close(); listener.onError(error) }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        pending.values.forEach { it.completeExceptionally(IllegalStateException("Session closed")) }
        pending.clear()
        runCatching { Os.shutdown(sockets[0].fileDescriptor, OsConstants.SHUT_RDWR) }
        runCatching { output.close() }; runCatching { input.close() }; runCatching { sockets[0].close() }
        worker.shutdownNow()
    }

    companion object {
        fun safeName(value: String?): String = value.orEmpty().map {
            if (it == '/' || it == '\\' || it.code < 32 || it in ":*?\"<>|") '_' else it
        }.joinToString("").take(60).trim().trim('.').ifBlank { "file" }
    }
}
