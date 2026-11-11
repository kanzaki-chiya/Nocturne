package io.github.kanzaki_chiya.nocturne.remote

import android.app.Activity
import android.provider.DocumentsContract
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException

@InvokeArg
class SaveFileArgs {
  var name: String = ""
  var mimeType: String = "application/octet-stream"
  var tempPath: String = ""
}

/** 经系统存储访问框架 `ACTION_CREATE_DOCUMENT` 将临时文件写入用户选定的 Uri。 */
@TauriPlugin
class SaveFilePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun save_file(invoke: Invoke) {
    val args = invoke.parseArgs(SaveFileArgs::class.java)
    if (args.name.isEmpty() || args.tempPath.isEmpty()) {
      invoke.reject("Invalid save arguments")
      return
    }
    val tempFile = File(args.tempPath)
    val allowedPrefix = activity.cacheDir.canonicalPath + File.separator
    val canonical = try {
      tempFile.canonicalPath
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Invalid temporary file")
      return
    }
    if (!canonical.startsWith(allowedPrefix) || !tempFile.isFile) {
      tempFile.delete()
      invoke.reject("Invalid temporary file")
      return
    }

    activity.runOnUiThread {
      val main = activity as? MainActivity
      if (main == null) {
        tempFile.delete()
        invoke.reject("MainActivity unavailable")
        return@runOnUiThread
      }
      main.createDocument(
        fileName = args.name,
        mimeType = args.mimeType.ifEmpty { "application/octet-stream" },
        callback = { resultCode, uri ->
          if (resultCode != Activity.RESULT_OK) {
            tempFile.delete()
            invoke.resolve(JSObject().put("cancelled", true))
            return@createDocument
          }
          if (uri == null) {
            tempFile.delete()
            invoke.reject("No destination selected")
            return@createDocument
          }
          Thread {
            try {
              val out = activity.contentResolver.openOutputStream(uri)
                ?: throw IOException("Unable to open destination")
              out.use { sink ->
                tempFile.inputStream().use { source ->
                  source.copyTo(sink)
                }
                sink.flush()
              }
              activity.runOnUiThread {
                invoke.resolve(JSObject().put("saved", true))
              }
            } catch (e: Exception) {
              try {
                DocumentsContract.deleteDocument(activity.contentResolver, uri)
              } catch (_: Exception) {
                // 清理失败不覆盖原始错误
              }
              activity.runOnUiThread {
                invoke.reject(e.message ?: "Failed to write file")
              }
            } finally {
              tempFile.delete()
            }
          }.start()
        },
        onLaunchError = { e ->
          tempFile.delete()
          invoke.reject(e.message ?: "Unable to launch document picker")
        },
      )
    }
  }
}
