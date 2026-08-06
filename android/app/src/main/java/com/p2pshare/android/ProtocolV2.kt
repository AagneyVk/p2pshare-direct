package com.p2pshare.android

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID

enum class Role { HOST, GUEST }

object ProtocolV2 {
    const val MAGIC = 0x51325053
    const val VERSION: Byte = 2
    const val HEADER_BYTES = 6
    const val FILE_ID_BYTES = 16
    const val CHUNK_SIZE = 1400
    const val STREAM_COUNT = 16
    const val CAP_ZSTD: Byte = 1

    const val HELLO: Byte = 1
    const val HELLO_ACK: Byte = 2
    const val OFFER: Byte = 5
    const val CHUNK: Byte = 6
    const val DONE: Byte = 7
    const val FLOW: Byte = 8
    const val REPAIR: Byte = 9
    const val COMPLETE: Byte = 10
    const val MTU_PROBE: Byte = 12
    const val MTU_ACK: Byte = 13
    const val REPAIR_RANGE: Byte = 14
    const val ACK_FREQ: Byte = 15
    const val IMMEDIATE_ACK: Byte = 16

    fun packet(type: Byte, bodySize: Int = 0): ByteBuffer = ByteBuffer
        .allocate(HEADER_BYTES + bodySize).order(ByteOrder.BIG_ENDIAN)
        .putInt(MAGIC).put(VERSION).put(type)

    fun uuidBytes(id: UUID): ByteArray = ByteBuffer.allocate(16)
        .putLong(id.mostSignificantBits).putLong(id.leastSignificantBits).array()

    fun readUuid(buffer: ByteBuffer): UUID = UUID(buffer.long, buffer.long)

    fun sizedString(value: String): ByteArray {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= 65535)
        return ByteBuffer.allocate(2 + bytes.size).order(ByteOrder.BIG_ENDIAN)
            .putShort(bytes.size.toShort()).put(bytes).array()
    }

    fun readSizedString(buffer: ByteBuffer): String {
        val length = buffer.short.toInt() and 0xffff
        require(length <= buffer.remaining())
        return ByteArray(length).also(buffer::get).toString(StandardCharsets.UTF_8)
    }
}
