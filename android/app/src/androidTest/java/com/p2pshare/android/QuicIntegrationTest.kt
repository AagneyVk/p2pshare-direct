package com.p2pshare.android

import android.net.Uri
import android.test.InstrumentationTestCase
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@Suppress("DEPRECATION")
class QuicIntegrationTest : InstrumentationTestCase() {
    private class Events : DirectUdpTransport.Listener {
        val connected = LinkedBlockingQueue<Boolean>()
        val files = LinkedBlockingQueue<File>()
        val errors = LinkedBlockingQueue<Throwable>()
        override fun onStatus(status: String) {}
        override fun onConnected(endpoint: InetSocketAddress) { connected.offer(true) }
        override fun onProgress(name: String, received: Boolean, done: Long, total: Long) {}
        override fun onReceived(file: File, name: String, mimeType: String) { files.offer(file) }
        override fun onError(error: Throwable) { errors.offer(error) }
    }

    fun testJniPairingAndFileBothDirections() {
        val context = instrumentation.targetContext
        val a = Events(); val b = Events()
        val host = QuicTransport(context, a)
        val guest = QuicTransport(context, b)
        val source = File.createTempFile("quic-test", ".bin", context.cacheDir)
        try {
            val payload = ByteArray(1024 * 1024 + 17) { (it % 251).toByte() }
            source.writeBytes(payload)
            guest.joinTicket(host.createTicket("127.0.0.1"))
            assertNotNull(a.connected.poll(20, TimeUnit.SECONDS))
            assertNotNull(b.connected.poll(20, TimeUnit.SECONDS))
            host.sendFile(Uri.fromFile(source))
            val received = b.files.poll(30, TimeUnit.SECONDS)
            assertNotNull("Receive failed: ${b.errors.peek()}", received)
            assertTrue(payload.contentEquals(received!!.readBytes()))
            guest.sendFile(Uri.fromFile(source))
            val returned = a.files.poll(30, TimeUnit.SECONDS)
            assertNotNull("Return failed: ${a.errors.peek()}", returned)
            assertTrue(payload.contentEquals(returned!!.readBytes()))
        } finally {
            host.close(); guest.close(); source.delete()
        }
    }
}
