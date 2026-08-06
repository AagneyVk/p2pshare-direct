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
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity(), DirectUdpTransport.Listener {
    private lateinit var transport: DirectUdpTransport
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var sessionCode = ""

    private lateinit var codeInput: EditText
    private lateinit var status: TextView
    private lateinit var session: TextView
    private lateinit var progress: ProgressBar
    private lateinit var transfer: TextView
    private lateinit var sendButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        transport = DirectUdpTransport(applicationContext, this)
        setContentView(buildUi())
        status.text = LocalLinkCapabilities.summary(this)
    }

    private fun buildUi(): LinearLayout {
        val pad = (20 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.rgb(8, 8, 8))

            addView(TextView(context).styled("P2P SHARE", 28f))
            addView(TextView(context).styled("DIRECT UDP • NO RELAY", 13f))

            codeInput = EditText(context).apply {
                hint = "SESSION CODE"
                setTextColor(Color.WHITE)
                setHintTextColor(Color.GRAY)
                textSize = 20f
                gravity = Gravity.CENTER
                isSingleLine = true
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
        sendButton.isEnabled = false
        onStatus("Discovering public endpoint…")
        worker.execute {
            try {
                sessionCode = transport.createTicket()
                runOnUiThread { session.text = "TICKET: $sessionCode" }
                onStatus("Waiting for a direct peer…")
            } catch (error: Throwable) { onError(error) }
        }
    }

    private fun joinSession() {
        val code = codeInput.text.toString().uppercase(Locale.US).trim()
        if (code.length < 20) {
            onStatus("Enter the full connection ticket")
            return
        }
        sessionCode = code
        session.text = "JOINING: $sessionCode"
        sendButton.isEnabled = false
        onStatus("Authenticating direct peer…")
        worker.execute { try { transport.joinTicket(code) } catch (error: Throwable) { onError(error) } }
    }

    override fun onStatus(status: String) = runOnUiThread { this.status.text = status }

    override fun onConnected(endpoint: java.net.InetSocketAddress) {
        runOnUiThread {
            status.text = "DIRECT: ${endpoint.address.hostAddress}:${endpoint.port}"
            sendButton.isEnabled = true
        }
    }

    override fun onProgress(name: String, received: Boolean, done: Long, total: Long) = runOnUiThread {
        progress.progress = if (total > 0) ((done.toDouble() / total) * progress.max).toInt() else progress.max
        val percent = if (total > 0) done * 100 / total else 100
        transfer.text = "${if (received) "RECEIVING" else "SENDING"} $name • $percent%"
    }

    override fun onReceived(file: File, name: String, mimeType: String) {
        worker.execute {
            try {
                saveToDownloads(file, name, mimeType)
                file.delete()
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
            contentResolver.openOutputStream(uri).use { output ->
                requireNotNull(output)
                source.inputStream().use { it.copyTo(output) }
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
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
        worker.shutdownNow()
        transport.close()
        super.onDestroy()
    }

    @Deprecated("Legacy result API keeps the app dependency-free")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILE_REQUEST && resultCode == RESULT_OK) {
            data?.data?.let(transport::sendFile)
        }
    }

    companion object {
        private const val PICK_FILE_REQUEST = 1001
    }
}
