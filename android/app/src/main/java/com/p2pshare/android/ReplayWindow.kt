package com.p2pshare.android

/** Bounded v2 replay tracking; commit counters only after authenticating the packet. */
internal class ReplayWindow {
    private var highest: ULong = 0u
    private var bits: ULong = 0u

    @Synchronized fun clear() { highest = 0u; bits = 0u }

    @Synchronized fun accept(counterBits: Long): Boolean {
        val counter = counterBits.toULong()
        if (counter == 0uL) return false
        if (counter > highest) {
            val shift = counter - highest
            bits = if (shift >= 64u) 1u else (bits shl shift.toInt()) or 1u
            highest = counter
            return true
        }
        val behind = highest - counter
        if (behind >= 64u) return false
        val bit = 1uL shl behind.toInt()
        if ((bits and bit) != 0uL) return false
        bits = bits or bit
        return true
    }
}
