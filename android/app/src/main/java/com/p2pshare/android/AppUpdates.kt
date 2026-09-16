package com.p2pshare.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

object AppUpdates {
    data class Release(val tag: String, val url: String, val digest: String, val size: Long)

    private const val API = "https://api.github.com/repos/AagneyVk/p2pshare-direct/releases?per_page=30"
    private const val PREFIX = "https://github.com/AagneyVk/p2pshare-direct/releases/download/"
    private const val ASSET = "P2PShare.apk"
    private const val MAX_METADATA = 1024 * 1024
    private const val MAX_APK = 200L * 1024 * 1024

    internal fun version(value: String): List<Int>? {
        val match = Regex("v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-rc(\\d+))?").matchEntire(value) ?: return null
        return listOf(match.groupValues[1].toInt(), match.groupValues[2].toInt(),
            match.groupValues[3].toInt(), match.groupValues[4].toIntOrNull() ?: 1_000_000)
    }

    private fun newer(left: String, right: String): Boolean {
        val a = version(left) ?: return false
        val b = version(right) ?: return false
        for (index in a.indices) if (a[index] != b[index]) return a[index] > b[index]
        return false
    }

    private fun connection(initialUrl: String): HttpsURLConnection {
        var current = initialUrl
        repeat(7) {
            require(current.startsWith("https://")) { "Insecure update redirect" }
            val connection = URL(current).openConnection() as HttpsURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("User-Agent", "P2PShare-updater")
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            when (connection.responseCode) {
                301, 302, 303, 307, 308 -> {
                    val location = connection.getHeaderField("Location") ?: error("Missing update redirect")
                    current = URL(URL(current), location).toString()
                    connection.disconnect()
                }
                200 -> return connection
                else -> {
                    val status = connection.responseCode
                    connection.disconnect()
                    error("Update server returned $status")
                }
            }
        }
        error("Too many update redirects")
    }

    fun check(currentVersion: String = BuildConfig.VERSION_NAME): Release? {
        val connection = connection(API)
        val releases = try {
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= MAX_METADATA) { "Update metadata is too large" }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            JSONArray(String(bytes, Charsets.UTF_8))
        } finally { connection.disconnect() }

        var best: Release? = null
        for (index in 0 until releases.length()) {
            val release = releases.getJSONObject(index)
            val tag = release.optString("tag_name")
            if (release.optBoolean("draft") || !newer(tag, best?.tag ?: currentVersion)) continue
            val assets = release.optJSONArray("assets") ?: continue
            for (assetIndex in 0 until assets.length()) {
                val asset = assets.getJSONObject(assetIndex)
                val digest = asset.optString("digest")
                val url = asset.optString("browser_download_url")
                val size = asset.optLong("size")
                if (asset.optString("name") == ASSET && url.startsWith(PREFIX) &&
                    Regex("sha256:[0-9a-f]{64}").matches(digest) && size in 1..MAX_APK) {
                    best = Release(tag, url, digest.removePrefix("sha256:"), size)
                }
            }
        }
        return best
    }

    fun download(context: Context, release: Release): File {
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        val partial = File(directory, "$ASSET.partial")
        val target = File(directory, ASSET)
        partial.delete()
        val connection = connection(release.url)
        val hash = MessageDigest.getInstance("SHA-256")
        try {
            var total = 0L
            connection.inputStream.use { input -> partial.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= release.size && total <= MAX_APK) { "APK size mismatch" }
                    hash.update(buffer, 0, count)
                    output.write(buffer, 0, count)
                }
            } }
            require(total == release.size && hash.digest().joinToString("") { "%02x".format(it) } == release.digest) {
                "Update verification failed; nothing was installed"
            }
            validateApk(context, partial)
            target.delete()
            check(partial.renameTo(target)) { "Could not save verified update" }
            return target
        } finally {
            connection.disconnect()
            partial.delete()
        }
    }

    @Suppress("DEPRECATION")
    private fun signingIdentity(info: PackageInfo): Set<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet().orEmpty()
    } else info.signatures?.map { it.toCharsString() }?.toSet().orEmpty()

    @Suppress("DEPRECATION")
    private fun validateApk(context: Context, file: File) {
        val manager = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
            PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = manager.getPackageArchiveInfo(file.path, flags) ?: error("Invalid update APK")
        val installed = manager.getPackageInfo(context.packageName, flags)
        val archiveCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archive.longVersionCode else archive.versionCode.toLong()
        val installedCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) installed.longVersionCode else installed.versionCode.toLong()
        require(archive.packageName == context.packageName && archiveCode > installedCode) { "APK is not a newer P2PShare version" }
        val expected = signingIdentity(installed)
        require(expected.isNotEmpty() && signingIdentity(archive) == expected) {
            "Update signing identity changed; install the official release manually once"
        }
    }

    fun install(context: Context, file: File): Boolean {
        validateApk(context, file)
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")))
            return false
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return true
    }
}
