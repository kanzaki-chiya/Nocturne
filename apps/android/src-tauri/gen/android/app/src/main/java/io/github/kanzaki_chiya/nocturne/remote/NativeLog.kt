package io.github.kanzaki_chiya.nocturne.remote

import android.content.Context
import java.io.File

/**
 * 探针的原生一侧：前台服务启停、Activity 前后台、渲染进程回收。写在 App 私有目录里，
 * 渲染进程或整个进程被回收后仍在；只记事件名与时间，不记会话内容。
 */
object NativeLog {
  private const val LIMIT = 200_000L
  private var file: File? = null

  fun init(context: Context) {
    if (file == null) file = File(context.applicationContext.filesDir, "probe-native.log")
  }

  @Synchronized
  fun add(event: String) {
    val target = file ?: return
    if (target.length() > LIMIT) {
      val keep = target.readLines().takeLast(500)
      target.writeText(keep.joinToString("\n", postfix = "\n"))
    }
    target.appendText("${System.currentTimeMillis()}\t$event\n")
  }

  @Synchronized
  fun read(): String = file?.takeIf { it.exists() }?.readText() ?: ""

  @Synchronized
  fun clear() {
    file?.writeText("")
  }
}
