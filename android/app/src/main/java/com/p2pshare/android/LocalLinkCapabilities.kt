package com.p2pshare.android

import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.aware.WifiAwareManager
import android.os.Build

/** Hardware-gated local-link capabilities; never makes Wi-Fi Aware mandatory. */
object LocalLinkCapabilities {
    fun hasWifiAware(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) return false
        return context.getSystemService(WifiAwareManager::class.java)?.isAvailable == true
    }

    fun summary(context: Context): String = if (hasWifiAware(context)) {
        "Wi-Fi Aware hardware ready • direct NAN path available"
    } else {
        "Direct UDP ready • Wi-Fi Aware unavailable on this device"
    }
}
