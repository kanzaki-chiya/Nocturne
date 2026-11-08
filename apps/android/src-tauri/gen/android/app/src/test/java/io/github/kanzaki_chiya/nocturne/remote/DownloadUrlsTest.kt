package io.github.kanzaki_chiya.nocturne.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadUrlsTest {
  @Test fun onlyReleaseApks() {
    assertTrue(DownloadUrls.allowed("https://github.com/kanzaki-chiya/Nocturne/releases/download/v0.37.0/nocturne-0.37.0.apk"))
    for (url in listOf("http://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com.evil/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com@evil/kanzaki-chiya/Nocturne/releases/download/v1/a.apk", "https://github.com/kanzaki-chiya/Other/releases/download/v1/a.apk", "javascript:alert(1)", "https://github.com/kanzaki-chiya/Nocturne/releases/download/../evil", "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk?redirect=evil", "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1/a.apk%0a")) {
      assertFalse(url, DownloadUrls.allowed(url))
    }
  }
}
