package com.p2pshare.android

import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.SecureRandom

data class ConnectionTicket(val endpoint: InetSocketAddress, val secret: ByteArray, val code: String)

object ConnectionTickets {
    const val FIXED_PORT = 45882
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun create(endpoint: InetSocketAddress): ConnectionTicket {
        val secret = ByteArray(10).also(SecureRandom()::nextBytes)
        val mapped = endpoint.port != FIXED_PORT
        val payload = ByteArray(4 + 1 + if (mapped) 2 else 0 + 10)
        endpoint.address.address.copyInto(payload, 0, 0, 4)
        payload[4] = if (mapped) 1 else 0
        var offset = 5
        if (mapped) {
            payload[offset++] = (endpoint.port ushr 8).toByte()
            payload[offset++] = endpoint.port.toByte()
        }
        secret.copyInto(payload, offset)
        val checksum = crc16(payload)
        val framed = payload + byteArrayOf((checksum ushr 8).toByte(), checksum.toByte())
        return ConnectionTicket(endpoint, secret, encode(framed))
    }

    fun parse(code: String): ConnectionTicket {
        val framed = decode(code)
        require(framed.size == 17 || framed.size == 19) { "Invalid ticket length" }
        val payload = framed.copyOf(framed.size - 2)
        val expected = ((framed[framed.size - 2].toInt() and 255) shl 8) or (framed.last().toInt() and 255)
        require(crc16(payload) == expected) { "Ticket checksum failed" }
        val mapped = payload[4].toInt() == 1
        require(mapped == (framed.size == 19)) { "Invalid ticket flags" }
        var offset = 5
        val port = if (mapped) {
            (((payload[offset++].toInt() and 255) shl 8) or (payload[offset++].toInt() and 255))
        } else FIXED_PORT
        val endpoint = InetSocketAddress(InetAddress.getByAddress(payload.copyOfRange(0, 4)), port)
        return ConnectionTicket(endpoint, payload.copyOfRange(offset, offset + 10), code)
    }

    private fun encode(bytes: ByteArray): String {
        var bits = 0; var value = 0
        val raw = buildString {
            bytes.forEach { byte ->
                value = (value shl 8) or (byte.toInt() and 255); bits += 8
                while (bits >= 5) { append(ALPHABET[(value ushr (bits - 5)) and 31]); bits -= 5 }
            }
            if (bits > 0) append(ALPHABET[(value shl (5 - bits)) and 31])
        }
        return raw.chunked(4).joinToString("-")
    }

    private fun decode(code: String): ByteArray {
        var bits = 0; var value = 0
        val out = ArrayList<Byte>()
        code.uppercase().filter(Char::isLetterOrDigit).forEach { char ->
            val normalized = when (char) { 'O' -> '0'; 'I', 'L' -> '1'; else -> char }
            val digit = ALPHABET.indexOf(normalized)
            require(digit >= 0) { "Invalid ticket character" }
            value = (value shl 5) or digit; bits += 5
            if (bits >= 8) { out += ((value ushr (bits - 8)) and 255).toByte(); bits -= 8 }
        }
        return out.toByteArray()
    }

    private fun crc16(bytes: ByteArray): Int {
        var crc = 0xffff
        bytes.forEach { byte ->
            crc = crc xor ((byte.toInt() and 255) shl 8)
            repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xffff else (crc shl 1) and 0xffff }
        }
        return crc
    }
}
