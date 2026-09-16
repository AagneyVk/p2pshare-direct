package com.p2pshare.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdatesTest {
    @Test fun parsesStableAndReleaseCandidateVersions() {
        assertEquals(listOf(1, 2, 3, 1_000_000), AppUpdates.version("v1.2.3"))
        assertEquals(listOf(1, 2, 3, 7), AppUpdates.version("1.2.3-rc7"))
        assertNull(AppUpdates.version("latest"))
    }
}
