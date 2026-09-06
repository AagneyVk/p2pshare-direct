package com.p2pshare.android

import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.app.Activity
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

class MainActivity : Activity(), DirectUdpTransport.Listener {
    private var transport: QuicTransport? = null
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var sessionCode = ""
    private var generation = 0L

    private lateinit var codeInput: EditText
    private lateinit var status: TextView
    private lateinit var session: TextView
    private lateinit var progress: ProgressBar
    private lateinit var transfer: TextView
    private lateinit var sendButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(android.widget.ScrollView(this).apply { addView(buildUi()) })
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        status.text = "QUIC preview • Same Wi-Fi or hotspot • Keep the app open"
    }

    private fun buildUi(): LinearLayout {
        val pad = (20 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.rgb(8, 8, 8))

            addView(TextView(context).styled("P2P SHARE", 28f))
            addView(TextView(context).styled("DIRECT QUIC • DESKTOP COMPATIBLE", 13f))

            codeInput = EditText(context).apply {
                hint = "SESSION CODE"
                setTextColor(Color.WHITE)
                setHintTextColor(Color.GRAY)
                textSize = 20f
                gravity = Gravity.CENTER
                maxLines = 4
                filters = arrayOf(android.text.InputFilter.LengthFilter(8192))
            }
            addView(codeInput, rowParams())

            addView(Button(context).apply {
                text = "CREATE SESSION"
                setOnClickListener { createSession() }
            }, rowParams())
            addView(Button(context).apply {
                text = "JOIN SESSION"
                setOnClickListener { joinSession() }
            }, rowParams())

            session = TextView(context).styled("", 24f)
            addView(session, rowParams())
            session.textSize = 12f
            session.maxLines = 4
            session.setTextIsSelectable(true)
            addView(Button(context).apply {
                text = "COPY PRIVATE TICKET"
                setOnClickListener {
                    if (sessionCode.isNotEmpty()) {
                        val clipboard = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        val clip = android.content.ClipData.newPlainText("P2P Share ticket", sessionCode)
                        if (Build.VERSION.SDK_INT >= 33) clip.description.extras = android.os.PersistableBundle().apply {
                            putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
                        }
                        clipboard.setPrimaryClip(clip)
                        onStatus("Private ticket copied • Expires in five minutes • One guest")
                    }
                }
            }, rowParams())
            addView(Button(context).apply {
                text = "DISCONNECT"
                setOnClickListener {
                    generation++
                    transport?.close(); transport = null
                    sessionCode = ""; session.text = ""; sendButton.isEnabled = false
                    onStatus("Disconnected • Create a new ticket to resume")
                }
            }, rowParams())
            status = TextView(context).styled("Ready", 15f)
            addView(status, rowParams())

            sendButton = Button(context).apply {
                text = "SELECT FILE"
                isEnabled = false
                setOnClickListener {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }, PICK_FILE_REQUEST)
                }
            }
            addView(sendButton, rowParams())

            progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 10_000
            }
            addView(progress, rowParams())
            transfer = TextView(context).styled("", 14f)
            addView(transfer, rowParams())
        }
    }

    private fun TextView.styled(value: String, size: Float) = apply {
        text = value
        textSize = size
        setTextColor(Color.WHITE)
        gravity = Gravity.CENTER
        setPadding(0, 12, 0, 12)
    }

    private fun rowParams() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = 10 }

    private fun createSession() {
        if (transport != null) { onStatus("Disconnect before starting a new session"); return }
        sendButton.isEnabled = false
        onStatus("Creating private LAN ticket…")
        val next = try { newTransport() } catch (error: Throwable) { onError(error); return }
        transport = next
        worker.execute {
            try {
                val ticket = next.createTicket()
                runOnUiThread { if (transport === next && !isDestroyed) {
                    sessionCode = ticket
                    session.text = "TICKET: $ticket"
                    if (!sendButton.isEnabled) onStatus("Waiting for a direct peer…")
                } }
            } catch (error: Throwable) { runOnUiThread { if (transport === next && !isDestroyed) onError(error) } }
        }
    }

    private fun joinSession() {
        val code = codeInput.text.toString().trim()
        if (!code.startsWith("p2p3:") || code.length > 8192) {
            onStatus("Enter the full case-sensitive QUIC ticket from desktop preview")
            return
        }
        if (transport != null) { onStatus("Disconnect before starting a new session"); return }
        sessionCode = code
        session.text = "JOINING: $sessionCode"
        sendButton.isEnabled = false
        onStatus("Authenticating direct peer…")
        val next = try { newTransport() } catch (error: Throwable) { onError(error); return }
        transport = next
        worker.execute { try {
            next.joinTicket(code)
        } catch (error: Throwable) { runOnUiThread { if (transport === next && !isDestroyed) onError(error) } } }
    }

    private fun newTransport(): QuicTransport {
        val epoch = ++generation
        return QuicTransport(applicationContext, object : DirectUdpTransport.Listener {
            private fun deliver(block: () -> Unit) = runOnUiThread {
                if (generation == epoch && !isDestroyed) block()
            }
            override fun onStatus(status: String) = deliver { this@MainActivity.onStatus(status) }
            override fun onConnected(endpoint: java.net.InetSocketAddress) = deliver { this@MainActivity.onConnected(endpoint) }
            override fun onProgress(name: String, received: Boolean, done: Long, total: Long) = deliver {
                this@MainActivity.onProgress(name, received, done, total)
            }
            override fun onReceived(file: File, name: String, mimeType: String) = deliver {
                this@MainActivity.onReceived(file, name, mimeType)
            }
            override fun onError(error: Throwable) = deliver { this@MainActivity.onError(error) }
        })
    }

    override fun onStatus(status: String) = runOnUiThread { this.status.text = status }

    override fun onConnected(endpoint: java.net.InetSocketAddress) {
        runOnUiThread {
            status.text = "Authenticated QUIC peer connected • Keep the app open"
            sendButton.isEnabled = true
        }
    }

    override fun onProgress(name: String, received: Boolean, done: Long, total: Long) = runOnUiThread {
        progress.progress = if (total > 0) ((done.toDouble() / total) * progress.max).toInt() else progress.max
        val percent = if (total > 0) done * 100 / total else 100
        transfer.text = "${if (received) "RECEIVING" else "SENDING"} $name • $percent%${if (done >= total) " • Verifying…" else ""}"
    }

    override fun onReceived(file: File, name: String, mimeType: String) {
        worker.execute {
            try {
                saveToDownloads(file, name, mimeType)
                // Keep the verified native cache for zero-payload retry/resume.
                onStatus("Saved $name to Downloads")
            } catch (error: Throwable) {
                onError(error)
            }
        }
    }

    override fun onError(error: Throwable) {
        runOnUiThread { status.text = "ERROR: ${error.message ?: error.javaClass.simpleName}" }
    }

    private fun saveToDownloads(source: File, name: String, mimeType: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/P2PShare")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = requireNotNull(contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
            try {
                contentResolver.openOutputStream(uri).use { output ->
                    requireNotNull(output)
                    source.inputStream().use { it.copyTo(output) }
                }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                check(contentResolver.update(uri, values, null, null) == 1)
            } catch (error: Throwable) {
                contentResolver.delete(uri, null, null)
                throw error
            }
        } else {
            val directory = requireNotNull(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS))
            val target = uniqueFile(directory, name)
            source.inputStream().use { input -> FileOutputStream(target).use(input::copyTo) }
        }
    }

    private fun uniqueFile(directory: File, name: String): File {
        var candidate = File(directory, name)
        var index = 1
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val suffix = if (dot > 0) name.substring(dot) else ""
        while (candidate.exists()) candidate = File(directory, "$stem ($index)${suffix}").also { index++ }
        return candidate
    }

    override fun onDestroy() {
        generation++
        worker.shutdownNow()
        transport?.close()
        super.onDestroy()
    }

    @Deprecated("Legacy result API keeps the app dependency-free")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILE_REQUEST && resultCode == RESULT_OK) {
            data?.data?.let { transport?.sendFile(it) }
        }
    }

    companion object {
        private const val PICK_FILE_REQUEST = 1001
    }
}
