package io.github.kanzaki_chiya.nocturne.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadUrlsTest {
  @Test fun onlyReleaseApks() {
    val valid = "https://github.com/kanzaki-chiya/Nocturne/releases/download/v0.37.0/nocturne-0.37.0.apk"
    assertTrue(DownloadUrls.allowed(valid))
    assertEquals("nocturne-0.37.0.apk", DownloadUrls.fileName(valid))
    for (url in listOf("http://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com.evil/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com@evil/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com/kanzaki-chiya/Other/releases/download/v1/a.apk", "javascript:alert(1)", "https://github.com/kanzaki-chiya/Nocturne/releases/download/../evil", "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk?redirect=evil", "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk%0a")) {
      assertFalse(url, DownloadUrls.allowed(url))
      assertNull(url, DownloadUrls.fileName(url))
    }
  }

  @Test fun activeDownloadDeduplication() {
    val url = "https://github.com/kanzaki-chiya/Nocturne/releases/download/v0.39.0/nocturne-0.39.0.apk"
    val other = "https://github.com/kanzaki-chiya/Nocturne/releases/download/v0.38.0/nocturne-0.38.0.apk"
    for (status in listOf(1, 2, 4)) {
      assertTrue("status=$status", DownloadUrls.isActiveDownload(url, listOf(url to status)))
    }
    for (status in listOf(8, 16)) {
      assertFalse("status=$status", DownloadUrls.isActiveDownload(url, listOf(url to status)))
    }
    assertFalse(DownloadUrls.isActiveDownload(url, listOf(other to 2, null to 1)))
  }
}
