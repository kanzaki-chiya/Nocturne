package io.github.kanzaki_chiya.nocturne.remote

/** 严格限制下载地址，禁止编码路径、查询和片段。 */
object DownloadUrls {
  private const val PREFIX = "https://github.com/kanzaki-chiya/Nocturne/releases/download/"
  private val apk = Regex("v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)/(nocturne-\\1\\.\\2\\.\\3\\.apk)")
  fun fileName(url: String): String? =
    if (url.startsWith(PREFIX)) apk.matchEntire(url.removePrefix(PREFIX))?.groupValues?.get(4) else null
  fun allowed(url: String): Boolean = fileName(url) != null
  fun isActiveDownload(url: String, entries: Iterable<Pair<String?, Int>>): Boolean =
    entries.any { (uri, status) -> uri == url && (status == 1 || status == 2 || status == 4) }
}
