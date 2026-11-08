package io.github.kanzaki_chiya.nocturne.remote

/** 严格限制系统浏览器入口，禁止编码路径、查询和片段。 */
object DownloadUrls {
  private const val PREFIX = "https://github.com/kanzaki-chiya/Nocturne/releases/download/"
  private val apk = Regex("v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)/nocturne-\\1\\.\\2\\.\\3\\.apk")
  fun allowed(url: String): Boolean = url.startsWith(PREFIX) && apk.matches(url.removePrefix(PREFIX))
}
