package com.p2pshare.android

import org.junit.Assert.*
import org.junit.Test

class ReplayWindowTest {
    @Test fun rejectsDuplicatesOldCountersAndZero() {
        val window = ReplayWindow()
        assertFalse(window.accept(0))
        assertTrue(window.accept(100))
        assertTrue(window.accept(99))
        assertFalse(window.accept(99))
        assertFalse(window.accept(36))
        assertTrue(window.accept(37))
        assertTrue(window.accept(100001))
        assertFalse(window.accept(100))
        window.clear()
        assertTrue(window.accept(1))
    }
}
