package com.p2pshare.android

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import java.io.ByteArrayOutputStream
import java.io.RandomAccessFile
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.BitSet
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.LockSupport
import java.util.zip.InflaterInputStream
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import com.github.luben.zstd.ZstdInputStream
import com.github.luben.zstd.ZstdOutputStream
import kotlin.math.ceil
import kotlin.math.min

class DirectUdpTransport(
    private val context: Context,
    private val listener: Listener
) : AutoCloseable {
    interface Listener {
        fun onStatus(status: String)
        fun onConnected(endpoint: InetSocketAddress)
        fun onProgress(name: String, received: Boolean, done: Long, total: Long)
        fun onReceived(file: File, name: String, mimeType: String)
        fun onError(error: Throwable)
    }

    private data class Incoming(
        val id: UUID,
        val name: String,
        val mimeType: String,
        val size: Long,
        val chunks: Int,
        val chunkSize: Int,
        val encoding: String,
        val originalSize: Long,
        val file: File,
        val output: RandomAccessFile,
        val received: BitSet = BitSet(chunks),
        var receivedBytes: Long = 0,
        var flowPending: Long = 0,
        var lastFlowAt: Long = 0,
        var doneHash: String? = null,
        var repairTask: ScheduledFuture<*>? = null,
        val pendingWrites: MutableMap<Int, ByteArray> = HashMap(),
        val writeBuffer: ByteArrayOutputStream = ByteArrayOutputStream(DISK_FLUSH_BYTES),
        var writeCursor: Int = 0
    )

    private data class Outgoing(
        val id: UUID,
        val name: String,
        val mimeType: String,
        val size: Long,
        val chunks: Int,
        val chunkSize: Int,
        val file: File,
        val input: RandomAccessFile,
        val encoding: String,
        val originalSize: Long,
        val streamCount: Int,
        val credits: AtomicLong = AtomicLong(INITIAL_CREDIT),
        @Volatile var pacingBytesPerSecond: Double = INITIAL_PACING_BPS,
        @Volatile var lastFlowNanos: Long = 0,
        @Volatile var nextSendNanos: Long = 0
    )

    private data class PreparedFile(val file: File, val encoding: String, val originalSize: Long)

    private val socket = DatagramSocket(null).apply {
        reuseAddress = true
        receiveBufferSize = 16 * 1024 * 1024
        sendBufferSize = 16 * 1024 * 1024
        bind(InetSocketAddress(PORT))
    }
    private val running = AtomicBoolean(true)
    private val receiveExecutor = Executors.newSingleThreadExecutor()
    private val sendExecutor = Executors.newSingleThreadExecutor()
    private val scheduler = Executors.newScheduledThreadPool(2)
    private val stunWaiters = ConcurrentHashMap<String, CompletableFuture<InetSocketAddress>>()
    private val incoming = ConcurrentHashMap<UUID, Incoming>()
    private val outgoing = ConcurrentHashMap<UUID, Outgoing>()
    @Volatile private var peer: InetSocketAddress? = null
    @Volatile private var punchTask: ScheduledFuture<*>? = null
    @Volatile private var role = Role.HOST
    @Volatile private var ticketSecret: ByteArray? = null
    @Volatile private var localNonce: ByteArray? = null
    @Volatile private var sessionKey: ByteArray? = null
    @Volatile private var sendNoncePrefix: ByteArray? = null
    @Volatile private var receiveNoncePrefix: ByteArray? = null
    private val sendCounter = AtomicLong(0)
    private val receivedCounters = ConcurrentHashMap.newKeySet<Long>()
    @Volatile private var peerCapabilities: Int = 0

    init {
        receiveExecutor.execute(::receiveLoop)
    }

    fun gatherCandidates(): List<InetSocketAddress> {
        val candidates = linkedMapOf<String, InetSocketAddress>()
        NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { network ->
            if (!network.isUp || network.isLoopback) return@forEach
            network.inetAddresses.toList().filterIsInstance<Inet4Address>().forEach { address ->
                val endpoint = InetSocketAddress(address, socket.localPort)
                candidates[endpoint.toString()] = endpoint
            }
        }
        STUN_SERVERS.mapNotNull { discoverPublicEndpoint(it.first, it.second) }.forEach { endpoint ->
            candidates[endpoint.toString()] = endpoint
        }
        return candidates.values.toList()
    }

    fun createTicket(): String {
        role = Role.HOST
        val publicEndpoint = gatherCandidates().firstOrNull { isPublic(it.address.hostAddress) }
            ?: error("Could not discover a public IPv4 endpoint")
        return ConnectionTickets.create(publicEndpoint).also { ticketSecret = it.secret }.code
    }

    fun joinTicket(code: String) {
        role = Role.GUEST
        val ticket = ConnectionTickets.parse(code)
        ticketSecret = ticket.secret
        startHolePunch(listOf(ticket.endpoint))
    }

    fun startHolePunch(candidates: List<InetSocketAddress>) {
        val targets = candidates.distinctBy { "${it.address.hostAddress}:${it.port}" }
        if (targets.isEmpty()) return
        punchTask?.cancel(false)
        val started = System.currentTimeMillis()
        punchTask = scheduler.scheduleAtFixedRate({
            if (peer != null || System.currentTimeMillis() - started > 8_000) {
                punchTask?.cancel(false)
                return@scheduleAtFixedRate
            }
            targets.forEach(::sendHello)
        }, 0, 180, TimeUnit.MILLISECONDS)
        listener.onStatus("Punching ${targets.size} direct route(s)…")
    }

    fun sendFile(uri: Uri) {
        sendExecutor.execute {
            try {
                val endpoint = peer ?: error("No direct peer connected")
                val metadata = queryMetadata(uri)
                val spool = File.createTempFile("p2pshare-send-", ".bin", context.cacheDir)
                context.contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "Cannot open selected file" }
                    FileOutputStream(spool).use(input::copyTo)
                }
                val prepared = prepareForTransfer(spool, metadata.first, metadata.second)
                val id = UUID.randomUUID()
                val size = prepared.file.length()
                val chunks = ceil(size.toDouble() / ProtocolV2.CHUNK_SIZE).toInt()
                val transfer = Outgoing(id, metadata.first, metadata.second, size, chunks,
                    ProtocolV2.CHUNK_SIZE, prepared.file, RandomAccessFile(prepared.file, "r"),
                    prepared.encoding, prepared.originalSize, recommendedStreamCount(size))
                outgoing[id] = transfer
                sendOffer(transfer, endpoint)
                val buffer = ByteArray(transfer.chunkSize)
                for (seq in 0 until chunks) {
                    waitForCredit(transfer)
                    val length = transfer.input.read(buffer)
                    if (length <= 0) break
                    sendChunk(transfer, seq, buffer, length, false)
                    listener.onProgress(transfer.name, false,
                        min(size, (seq + 1L) * transfer.chunkSize), size)
                }
                val hash = sha256(spool)
                val done = ProtocolV2.packet(ProtocolV2.DONE, 16 + 64)
                    .put(ProtocolV2.uuidBytes(id))
                    .put(hash.toByteArray(Charsets.US_ASCII)).array()
                repeat(3) { send(done, endpoint) }
            } catch (error: Throwable) {
                listener.onError(error)
            }
        }
    }

    private fun receiveLoop() {
        val storage = ByteArray(65_535)
        while (running.get()) {
            try {
                val datagram = DatagramPacket(storage, storage.size)
                socket.receive(datagram)
                var bytes = datagram.data.copyOfRange(datagram.offset, datagram.offset + datagram.length)
                if (handleStun(bytes)) continue
                if (bytes.size >= 6 && bytes[5] == ENCRYPTED) bytes = openPacket(bytes) ?: continue
                handlePacket(bytes, InetSocketAddress(datagram.address, datagram.port))
            } catch (error: Throwable) {
                if (running.get()) listener.onError(error)
            }
        }
    }

    private fun handlePacket(bytes: ByteArray, source: InetSocketAddress) {
        if (bytes.size < ProtocolV2.HEADER_BYTES) return
        val body = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        if (body.int != ProtocolV2.MAGIC || body.get() != ProtocolV2.VERSION) return
        when (val type = body.get()) {
            ProtocolV2.HELLO -> {
                if (role != Role.HOST || body.remaining() < 32) return
                val guestNonce = ByteArray(16).also(body::get)
                val mac = ByteArray(16).also(body::get)
                if (!MessageDigest.isEqual(mac, handshakeMac("hello", guestNonce))) return
                peerCapabilities = if (body.hasRemaining()) body.get().toInt() and 0xff else 0
                peer = source
                val hostNonce = localNonce ?: ByteArray(16).also { SecureRandom().nextBytes(it); localNonce = it }
                val ack = ProtocolV2.packet(ProtocolV2.HELLO_ACK, 33).put(hostNonce)
                    .put(handshakeMac("ack", guestNonce, hostNonce)).put(ProtocolV2.CAP_ZSTD).array()
                sendRaw(ack, source)
                if (sessionKey == null) establishKey(guestNonce, hostNonce)
                selectPeer(source)
            }
            ProtocolV2.HELLO_ACK -> {
                val guestNonce = localNonce ?: return
                if (role != Role.GUEST || body.remaining() < 32) return
                val hostNonce = ByteArray(16).also(body::get)
                val mac = ByteArray(16).also(body::get)
                if (!MessageDigest.isEqual(mac, handshakeMac("ack", guestNonce, hostNonce))) return
                peerCapabilities = if (body.hasRemaining()) body.get().toInt() and 0xff else 0
                if (sessionKey == null) establishKey(guestNonce, hostNonce)
                selectPeer(source)
            }
            ProtocolV2.OFFER -> receiveOffer(body)
            ProtocolV2.CHUNK -> receiveChunk(body)
            ProtocolV2.DONE -> receiveDone(body)
            ProtocolV2.FLOW -> receiveFlow(body)
            ProtocolV2.REPAIR -> receiveRepair(body)
            ProtocolV2.REPAIR_RANGE -> receiveRepairRanges(body)
            ProtocolV2.COMPLETE -> completeOutgoing(body)
            ProtocolV2.MTU_PROBE -> replyMtuProbe(body, source)
            ProtocolV2.IMMEDIATE_ACK -> immediateFlow(body)
            ProtocolV2.ACK_FREQ -> Unit
            else -> listener.onStatus("Ignored protocol packet $type")
        }
    }

    private fun selectPeer(source: InetSocketAddress) {
        if (peer == null) {
            peer = source
            punchTask?.cancel(false)
            listener.onConnected(source)
        }
    }

    private fun sendHello(endpoint: InetSocketAddress) {
        val nonce = localNonce ?: ByteArray(16).also { SecureRandom().nextBytes(it); localNonce = it }
        val packet = ProtocolV2.packet(ProtocolV2.HELLO, 33).put(nonce)
            .put(handshakeMac("hello", nonce)).put(ProtocolV2.CAP_ZSTD).array()
        sendRaw(packet, endpoint)
    }

    private fun handshakeMac(label: String, vararg parts: ByteArray): ByteArray {
        val secret = requireNotNull(ticketSecret)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        mac.update(label.toByteArray())
        parts.forEach(mac::update)
        return mac.doFinal().copyOf(16)
    }

    private fun establishKey(guestNonce: ByteArray, hostNonce: ByteArray) {
        val secret = requireNotNull(ticketSecret)
        val saltMac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(guestNonce + hostNonce, "HmacSHA256"))
        }
        val prk = saltMac.doFinal(secret)
        val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
        sessionKey = expand.doFinal("p2pshare-native-v3".toByteArray() + byteArrayOf(1)).copyOf(32)
        val key = requireNotNull(sessionKey)
        fun prefix(sender: Role): ByteArray {
            val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
            return mac.doFinal("nonce:${sender.name.lowercase()}".toByteArray()).copyOf(4)
        }
        sendNoncePrefix = prefix(role)
        receiveNoncePrefix = prefix(if (role == Role.HOST) Role.GUEST else Role.HOST)
        sendCounter.set(0)
        receivedCounters.clear()
    }

    private fun nonce(counter: Long, senderRole: Role): ByteArray {
        val prefix = if (senderRole == role) sendNoncePrefix else receiveNoncePrefix
        requireNotNull(prefix)
        return ByteBuffer.allocate(12).put(prefix).putLong(counter).array()
    }

    private fun sealPacket(bytes: ByteArray): ByteArray {
        val key = sessionKey ?: return bytes
        val counter = sendCounter.incrementAndGet()
        val counterBytes = ByteBuffer.allocate(8).putLong(counter).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(counter, role)))
        cipher.updateAAD(counterBytes)
        val encrypted = cipher.doFinal(bytes)
        return ProtocolV2.packet(ENCRYPTED, 8 + encrypted.size).put(counterBytes).put(encrypted).array()
    }

    private fun openPacket(bytes: ByteArray): ByteArray? {
        return try {
            val key = sessionKey ?: return null
            val body = ByteBuffer.wrap(bytes, 6, bytes.size - 6)
            val counter = body.long
            if (receivedCounters.contains(counter)) return null
            val counterBytes = ByteBuffer.allocate(8).putLong(counter).array()
            val encrypted = ByteArray(body.remaining()).also(body::get)
            val sender = if (role == Role.HOST) Role.GUEST else Role.HOST
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(counter, sender)))
            cipher.updateAAD(counterBytes)
            cipher.doFinal(encrypted).also { receivedCounters.add(counter) }
        } catch (_: Throwable) { null }
    }

    private fun receiveOffer(body: ByteBuffer) {
        val id = ProtocolV2.readUuid(body)
        if (incoming.containsKey(id)) return
        val name = ProtocolV2.readSizedString(body)
        val mime = ProtocolV2.readSizedString(body)
        val size = body.long
        val chunks = body.int
        val chunkSize = body.int
        val encoding = ProtocolV2.readSizedString(body)
        val originalSize = body.long
        require(size >= 0 && chunks >= 0 && chunkSize in 512..65_535)
        val file = File.createTempFile("p2pshare-recv-", ".part", context.cacheDir)
        incoming[id] = Incoming(id, name, mime, size, chunks, chunkSize, encoding,
            originalSize, file, RandomAccessFile(file, "rw"))
        listener.onProgress(name, true, 0, size)
    }

    private fun receiveChunk(body: ByteBuffer) {
        val id = ProtocolV2.readUuid(body)
        val seq = body.int
        body.get() // logical stream id
        val length = body.int
        if (length < 0 || length > body.remaining()) return
        val transfer = incoming[id] ?: return
        if (seq !in 0 until transfer.chunks) return
        val payload = ByteArray(length).also(body::get)
        synchronized(transfer) {
            if (transfer.received[seq]) return
            transfer.received.set(seq)
            transfer.pendingWrites[seq] = payload
            drainWrites(transfer)
            transfer.receivedBytes += length
            transfer.flowPending += length
            val now = System.currentTimeMillis()
            if (transfer.flowPending >= FLOW_STEP || now - transfer.lastFlowAt >= FLOW_INTERVAL_MS ||
                transfer.receivedBytes >= transfer.size) sendFlow(transfer, now)
        }
        listener.onProgress(transfer.name, true, transfer.receivedBytes, transfer.size)
        maybeFinalize(transfer)
    }

    private fun receiveDone(body: ByteBuffer) {
        val id = ProtocolV2.readUuid(body)
        val hashBytes = ByteArray(min(64, body.remaining())).also(body::get)
        val transfer = incoming[id] ?: return
        transfer.doneHash = hashBytes.toString(Charsets.US_ASCII).trim()
        requestMissing(transfer)
        transfer.repairTask?.cancel(false)
        transfer.repairTask = scheduler.scheduleAtFixedRate({ requestMissing(transfer) }, 120, 120, TimeUnit.MILLISECONDS)
        maybeFinalize(transfer)
    }

    private fun sendFlow(transfer: Incoming, now: Long = System.currentTimeMillis()) {
        val grant = transfer.flowPending
        if (grant <= 0) return
        transfer.flowPending = 0
        transfer.lastFlowAt = now
        val packet = ProtocolV2.packet(ProtocolV2.FLOW, 24)
            .put(ProtocolV2.uuidBytes(transfer.id)).putLong(grant).array()
        peer?.let { send(packet, it) }
    }

    private fun drainWrites(transfer: Incoming, force: Boolean = false) {
        while (true) {
            val payload = transfer.pendingWrites.remove(transfer.writeCursor) ?: break
            transfer.writeBuffer.write(payload)
            transfer.writeCursor++
            if (transfer.writeBuffer.size() >= DISK_FLUSH_BYTES) flushWriteBuffer(transfer)
        }
        if (force) flushWriteBuffer(transfer)
    }

    private fun flushWriteBuffer(transfer: Incoming) {
        if (transfer.writeBuffer.size() == 0) return
        transfer.writeBuffer.writeTo(object : java.io.OutputStream() {
            override fun write(value: Int) = transfer.output.write(value)
            override fun write(bytes: ByteArray, offset: Int, length: Int) = transfer.output.write(bytes, offset, length)
        })
        transfer.writeBuffer.reset()
    }

    private fun immediateFlow(body: ByteBuffer) {
        val transfer = incoming[ProtocolV2.readUuid(body)] ?: return
        synchronized(transfer) { sendFlow(transfer) }
    }

    private fun requestMissing(transfer: Incoming) {
        if (transfer.doneHash == null) return
        val missing = synchronized(transfer) {
            buildList {
                var seq = transfer.received.nextClearBit(0)
                while (seq < transfer.chunks && size < 128) {
                    add(seq)
                    seq = transfer.received.nextClearBit(seq + 1)
                }
            }
        }
        if (missing.isEmpty()) {
            maybeFinalize(transfer)
            return
        }
        val packet = ProtocolV2.packet(ProtocolV2.REPAIR, 18 + missing.size * 4)
            .put(ProtocolV2.uuidBytes(transfer.id)).putShort(missing.size.toShort())
        missing.forEach(packet::putInt)
        peer?.let { send(packet.array(), it) }
    }

    private fun receiveFlow(body: ByteBuffer) {
        val transfer = outgoing[ProtocolV2.readUuid(body)] ?: return
        val granted = body.long.coerceAtLeast(0)
        val now = System.nanoTime()
        if (transfer.lastFlowNanos > 0 && granted > 0) {
            val elapsed = (now - transfer.lastFlowNanos).coerceAtLeast(1)
            val delivered = granted * 1_000_000_000.0 / elapsed
            val target = (delivered * 1.10).coerceIn(MIN_PACING_BPS, MAX_PACING_BPS)
            transfer.pacingBytesPerSecond = transfer.pacingBytesPerSecond * 0.25 + target * 0.75
        }
        transfer.lastFlowNanos = now
        transfer.credits.addAndGet(granted)
    }

    private fun receiveRepair(body: ByteBuffer) {
        val id = ProtocolV2.readUuid(body)
        val transfer = outgoing[id] ?: return
        val count = body.short.toInt() and 0xffff
        repeat(min(count, 128)) { resend(transfer, body.int) }
    }

    private fun receiveRepairRanges(body: ByteBuffer) {
        val transfer = outgoing[ProtocolV2.readUuid(body)] ?: return
        val count = body.short.toInt() and 0xffff
        var sent = 0
        repeat(min(count, 32)) {
            val start = body.int
            val end = body.int
            for (seq in start..end) {
                if (sent++ >= 128) break
                resend(transfer, seq)
            }
        }
    }

    private fun resend(transfer: Outgoing, seq: Int) {
        if (seq !in 0 until transfer.chunks) return
        synchronized(transfer.input) {
            transfer.input.seek(seq.toLong() * transfer.chunkSize)
            val length = min(transfer.chunkSize.toLong(), transfer.size - seq.toLong() * transfer.chunkSize).toInt()
            val data = ByteArray(length)
            transfer.input.readFully(data)
            sendChunk(transfer, seq, data, length, true)
        }
    }

    private fun completeOutgoing(body: ByteBuffer) {
        val transfer = outgoing.remove(ProtocolV2.readUuid(body)) ?: return
        transfer.input.close()
        transfer.file.delete()
        listener.onProgress(transfer.name, false, transfer.size, transfer.size)
    }

    private fun sendOffer(transfer: Outgoing, endpoint: InetSocketAddress) {
        val name = ProtocolV2.sizedString(transfer.name)
        val mime = ProtocolV2.sizedString(transfer.mimeType)
        val encoding = ProtocolV2.sizedString(transfer.encoding)
        val packet = ProtocolV2.packet(ProtocolV2.OFFER,
            16 + name.size + mime.size + 8 + 4 + 4 + encoding.size + 8)
            .put(ProtocolV2.uuidBytes(transfer.id)).put(name).put(mime)
            .putLong(transfer.size).putInt(transfer.chunks).putInt(transfer.chunkSize)
            .put(encoding).putLong(transfer.originalSize).array()
        repeat(3) { send(packet, endpoint) }
    }

    private fun sendChunk(transfer: Outgoing, seq: Int, data: ByteArray, length: Int, retransmit: Boolean) {
        pace(transfer, length)
        val packet = ProtocolV2.packet(ProtocolV2.CHUNK, 16 + 4 + 1 + 4 + length)
            .put(ProtocolV2.uuidBytes(transfer.id)).putInt(seq)
            .put((seq % transfer.streamCount).toByte()).putInt(length)
            .put(data, 0, length).array()
        peer?.let { send(packet, it) }
        if (!retransmit) transfer.credits.addAndGet(-length.toLong())
    }

    private fun pace(transfer: Outgoing, bytes: Int) {
        val now = System.nanoTime()
        if (transfer.nextSendNanos < now) transfer.nextSendNanos = now
        val wait = transfer.nextSendNanos - now
        if (wait > 0) LockSupport.parkNanos(wait)
        transfer.nextSendNanos += (bytes * 1_000_000_000.0 / transfer.pacingBytesPerSecond).toLong()
    }

    private fun waitForCredit(transfer: Outgoing) {
        val deadline = System.currentTimeMillis() + 15_000
        while (transfer.credits.get() < transfer.chunkSize) {
            if (System.currentTimeMillis() >= deadline) error("Flow credit timed out")
            Thread.sleep(2)
        }
    }

    private fun maybeFinalize(transfer: Incoming) {
        if (transfer.doneHash == null || transfer.received.cardinality() != transfer.chunks) return
        synchronized(transfer) {
            if (!incoming.remove(transfer.id, transfer)) return
            transfer.repairTask?.cancel(false)
            drainWrites(transfer, true)
            transfer.output.fd.sync()
            transfer.output.close()
        }
        sendExecutor.execute {
            try {
                val actual = sha256(transfer.file)
                require(actual.equals(transfer.doneHash, true)) { "SHA-256 mismatch for ${transfer.name}" }
                val completed = when (transfer.encoding) {
                    "zstd" -> decompressZstd(transfer)
                    "deflate" -> inflate(transfer)
                    else -> transfer.file
                }
                if (transfer.originalSize > 0) require(completed.length() == transfer.originalSize)
                val complete = ProtocolV2.packet(ProtocolV2.COMPLETE, 16)
                    .put(ProtocolV2.uuidBytes(transfer.id)).array()
                peer?.let { repeat(3) { _ -> send(complete, it) } }
                listener.onProgress(transfer.name, true, transfer.size, transfer.size)
                listener.onReceived(completed, transfer.name, transfer.mimeType)
            } catch (error: Throwable) {
                listener.onError(error)
            }
        }
    }

    private fun inflate(transfer: Incoming): File {
        val target = File.createTempFile("p2pshare-inflated-", ".bin", context.cacheDir)
        transfer.file.inputStream().use { input ->
            InflaterInputStream(input).use { inflater -> FileOutputStream(target).use(inflater::copyTo) }
        }
        transfer.file.delete()
        return target
    }

    private fun decompressZstd(transfer: Incoming): File {
        val target = File.createTempFile("p2pshare-zstd-restored-", ".bin", context.cacheDir)
        transfer.file.inputStream().buffered(1024 * 1024).use { input ->
            ZstdInputStream(input).use { decoder -> FileOutputStream(target).use(decoder::copyTo) }
        }
        transfer.file.delete()
        return target
    }

    private fun replyMtuProbe(body: ByteBuffer, source: InetSocketAddress) {
        if (body.remaining() < 6) return
        val nonce = body.int
        val accepted = (body.short.toInt() and 0xffff).coerceIn(1024, 1432)
        val packet = ProtocolV2.packet(ProtocolV2.MTU_ACK, 6)
            .putInt(nonce).putShort(accepted.toShort()).array()
        send(packet, source)
    }

    private fun discoverPublicEndpoint(host: String, port: Int): InetSocketAddress? {
        val transaction = ByteArray(12).also(java.security.SecureRandom()::nextBytes)
        val key = transaction.joinToString("") { "%02x".format(it) }
        val future = CompletableFuture<InetSocketAddress>()
        stunWaiters[key] = future
        val request = ByteBuffer.allocate(20).order(ByteOrder.BIG_ENDIAN)
            .putShort(0x0001).putShort(0).putInt(STUN_COOKIE).put(transaction).array()
        send(request, InetSocketAddress(host, port))
        return try { future.get(1500, TimeUnit.MILLISECONDS) }
        catch (_: Throwable) { null }
        finally { stunWaiters.remove(key) }
    }

    private fun handleStun(bytes: ByteArray): Boolean {
        if (bytes.size < 20) return false
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        if ((buffer.short.toInt() and 0xffff) != 0x0101) return false
        val messageLength = buffer.short.toInt() and 0xffff
        if (buffer.int != STUN_COOKIE) return false
        val transaction = ByteArray(12).also(buffer::get)
        val key = transaction.joinToString("") { "%02x".format(it) }
        val end = min(bytes.size, 20 + messageLength)
        while (buffer.position() + 4 <= end) {
            val type = buffer.short.toInt() and 0xffff
            val length = buffer.short.toInt() and 0xffff
            if (buffer.position() + length > end) break
            if (type == 0x0020 && length >= 8) {
                buffer.get()
                if (buffer.get().toInt() != 0x01) return true
                val port = (buffer.short.toInt() and 0xffff) xor (STUN_COOKIE ushr 16)
                val address = ByteArray(4)
                for (i in 0..3) address[i] = (buffer.get().toInt() xor
                    ((STUN_COOKIE ushr (24 - i * 8)) and 0xff)).toByte()
                stunWaiters[key]?.complete(InetSocketAddress(InetAddress.getByAddress(address), port))
                return true
            }
            buffer.position(buffer.position() + ((length + 3) and 3.inv()))
        }
        return true
    }

    private fun queryMetadata(uri: Uri): Pair<String, String> {
        var name = "shared-file"
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) name = it.getString(0) ?: name
        }
        return name to (context.contentResolver.getType(uri) ?: "application/octet-stream")
    }

    private fun prepareForTransfer(source: File, name: String, mimeType: String): PreparedFile {
        val originalSize = source.length()
        if (originalSize < 4 * 1024 || !isLikelyCompressible(name, mimeType)) {
            return PreparedFile(source, "none", originalSize)
        }
        return try {
        val ratio = estimateDeflateRatio(source)
        if (ratio >= MIN_SAVINGS_RATIO) return PreparedFile(source, "none", originalSize)

        listener.onStatus("Compressing $name (${String.format("%.1f", ratio * 100)}% estimated)…")
        val useZstd = peerCapabilities and ProtocolV2.CAP_ZSTD.toInt() != 0
        val encoding = if (useZstd) "zstd" else "deflate"
        val compressed = File.createTempFile("p2pshare-$encoding-", ".bin", context.cacheDir)
        source.inputStream().buffered(1024 * 1024).use { input ->
            FileOutputStream(compressed).buffered(1024 * 1024).use { fileOutput ->
                if (useZstd) {
                    ZstdOutputStream(fileOutput, 1).use { output -> input.copyTo(output, 1024 * 1024) }
                } else {
                    DeflaterOutputStream(fileOutput, Deflater(Deflater.BEST_SPEED), 1024 * 1024).use { output ->
                        input.copyTo(output, 1024 * 1024)
                    }
                }
            }
        }
        if (compressed.length() >= (originalSize * MIN_SAVINGS_RATIO).toLong()) {
            compressed.delete()
            return PreparedFile(source, "none", originalSize)
        }
        source.delete()
        listener.onStatus("Compressed ${formatBytes(originalSize)} → ${formatBytes(compressed.length())}")
        PreparedFile(compressed, encoding, originalSize)
        } catch (error: Throwable) {
            listener.onStatus("Compression unavailable; sending original file")
            PreparedFile(source, "none", originalSize)
        }
    }

    private fun estimateDeflateRatio(file: File): Double {
        val sampleSize = 64 * 1024
        val starts = if (file.length() <= sampleSize * 2L) listOf(0L) else listOf(
            0L,
            (file.length() - sampleSize) / 3,
            (file.length() - sampleSize) * 2 / 3,
            file.length() - sampleSize,
        )
        var raw = 0L
        var packed = 0L
        RandomAccessFile(file, "r").use { input ->
            for (start in starts.distinct()) {
                input.seek(start.coerceAtLeast(0))
                val bytes = ByteArray(min(sampleSize.toLong(), file.length() - start).toInt())
                input.readFully(bytes)
                raw += bytes.size
                val deflater = Deflater(Deflater.BEST_SPEED)
                deflater.setInput(bytes); deflater.finish()
                val output = ByteArray(bytes.size + 256)
                packed += deflater.deflate(output)
                deflater.end()
            }
        }
        return packed.toDouble() / raw.coerceAtLeast(1)
    }

    private fun isLikelyCompressible(name: String, mimeType: String): Boolean {
        val lowerMime = mimeType.lowercase()
        if (lowerMime.startsWith("image/") || lowerMime.startsWith("audio/") || lowerMime.startsWith("video/")) return false
        val extension = name.substringAfterLast('.', "").lowercase()
        if (extension in setOf("zip", "gz", "7z", "rar", "jpg", "jpeg", "png", "webp", "avif",
                "gif", "mp4", "mov", "mkv", "mp3", "aac", "ogg", "flac", "pdf", "apk", "jar")) return false
        return lowerMime.startsWith("text/") || extension in setOf("txt", "md", "csv", "json", "xml", "html",
            "css", "js", "ts", "log", "sql", "yaml", "yml", "toml", "ini", "svg")
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024 * 1024 -> String.format("%.2f GB", bytes / (1024.0 * 1024 * 1024))
        bytes >= 1024L * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024))
        else -> String.format("%.1f KB", bytes / 1024.0)
    }

    private fun recommendedStreamCount(size: Long): Int = when {
        size >= 512L * 1024 * 1024 -> 4
        size >= 256L * 1024 * 1024 -> 3
        size >= 64L * 1024 * 1024 -> 2
        else -> 1
    }

    private fun send(bytes: ByteArray, endpoint: InetSocketAddress) {
        sendRaw(sealPacket(bytes), endpoint)
    }

    private fun sendRaw(bytes: ByteArray, endpoint: InetSocketAddress) {
        try { socket.send(DatagramPacket(bytes, bytes.size, endpoint)) }
        catch (error: Throwable) { if (running.get()) listener.onError(error) }
    }

    override fun close() {
        running.set(false)
        punchTask?.cancel(true)
        incoming.values.forEach { runCatching { it.output.close() } }
        outgoing.values.forEach { runCatching { it.input.close() } }
        socket.close()
        receiveExecutor.shutdownNow()
        sendExecutor.shutdownNow()
        scheduler.shutdownNow()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val PORT = 45882
        private const val STUN_COOKIE = 0x2112A442
        private const val INITIAL_CREDIT = 4L * 1024 * 1024
        private const val INITIAL_PACING_BPS = 32.0 * 1024 * 1024
        private const val MIN_PACING_BPS = 256.0 * 1024
        private const val MAX_PACING_BPS = 2.0 * 1024 * 1024 * 1024
        private const val FLOW_STEP = 512L * 1024
        private const val FLOW_INTERVAL_MS = 25L
        private const val ENCRYPTED: Byte = 17
        private const val MIN_SAVINGS_RATIO = 0.95
        private const val DISK_FLUSH_BYTES = 1024 * 1024
        private val STUN_SERVERS = listOf("stun.l.google.com" to 19302, "stun1.l.google.com" to 19302)
    }

    private fun isPublic(address: String): Boolean {
        val p = address.split('.').mapNotNull(String::toIntOrNull)
        if (p.size != 4) return false
        return !(p[0] == 10 || p[0] == 127 || p[0] == 0 ||
            (p[0] == 169 && p[1] == 254) || (p[0] == 172 && p[1] in 16..31) ||
            (p[0] == 192 && p[1] == 168) || (p[0] == 100 && p[1] in 64..127))
    }
}
