package io.github.kanzaki_chiya.nocturne.remote

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ServiceArgs {
  var title: String = ""
  var body: String = ""
  var shortCriticalText: String = ""
  var promoted: Boolean = false
  var hostId: String = ""
  var sessionId: String = ""

  fun toNotice() = ServiceNotice(
    title = title,
    body = body,
    shortCriticalText = shortCriticalText,
    promoted = promoted,
    hostId = hostId,
    sessionId = sessionId,
  )
}

@InvokeArg
class UrlArgs {
  var url: String = ""
}

@InvokeArg
class SystemBarsArgs {
  var light: Boolean = false
}

@InvokeArg
class SettingsArgs {
  var target: String = "app"
}

@InvokeArg
class NotificationArgs {
  var hostId: String = ""
  var sessionId: String = ""
  var title: String = ""
  var body: String = ""
  var kind: String = "done"
}

/** 前端经 `plugin:background|call` 调用的命令（Rust 侧 background.rs 只转发白名单内的名字）。 */
@TauriPlugin
class BackgroundPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    NativeLog.init(activity)
  }

  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(ServiceArgs::class.java)
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      // 没有通知权限时前台服务照常运行，只是常驻通知不显示；这里请求一次
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
    KeepAliveService.start(activity, args.toNotice())
    invoke.resolve(state())
  }

  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(ServiceArgs::class.java)
    KeepAliveService.update(activity, args.toNotice())
    invoke.resolve(state())
  }

  @Command
  fun stop(invoke: Invoke) {
    KeepAliveService.stop(activity)
    invoke.resolve(state())
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(state())
  }

  @Command
  fun open_settings(invoke: Invoke) {
    val args = invoke.parseArgs(SettingsArgs::class.java)
    val intents = when (args.target) {
      "battery" -> listOf(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      // 小米 / MIUI / HyperOS 的自启动管理；其他系统没有这个页面，退回应用详情
      "autostart" -> listOf(
        Intent().setClassName(
          "com.miui.securitycenter",
          "com.miui.permcenter.autostart.AutoStartManagementActivity",
        ),
        appDetails(),
      )
      else -> listOf(appDetails())
    }
    for (intent in intents) {
      try {
        activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve(JSObject().put("opened", true))
        return
      } catch (_: Exception) {
        // 试下一个
      }
    }
    invoke.reject("无法打开系统设置")
  }

  @Command
  fun log(invoke: Invoke) {
    invoke.resolve(JSObject().put("text", NativeLog.read()))
  }

  @Command
  fun clear_log(invoke: Invoke) {
    NativeLog.clear()
    invoke.resolve(JSObject())
  }

  @Command
  fun notification_status(invoke: Invoke) {
    invoke.resolve(JSObject().put("enabled", SessionNotifications.enabled(activity)))
  }

  @Command
  fun activity_state(invoke: Invoke) {
    invoke.resolve(JSObject().put("foreground", (activity as? MainActivity)?.isActivityForeground() == true))
  }

  @Command
  fun notify_show(invoke: Invoke) {
    val args = invoke.parseArgs(NotificationArgs::class.java)
    if (args.hostId.isEmpty() || args.sessionId.isEmpty() || args.title.isEmpty() || args.kind !in listOf("attention", "error", "done")) {
      invoke.reject("通知参数无效")
      return
    }
    invoke.resolve(JSObject().put("shown", SessionNotifications.show(activity, args.hostId, args.sessionId, args.title, args.body, args.kind)))
  }

  @Command
  fun notify_dismiss(invoke: Invoke) {
    val args = invoke.parseArgs(NotificationArgs::class.java)
    if (args.hostId.isNotEmpty() && args.sessionId.isNotEmpty()) SessionNotifications.dismiss(activity, args.hostId, args.sessionId)
    invoke.resolve(JSObject())
  }

  @Command
  fun notification_target(invoke: Invoke) {
    val target = (activity as? MainActivity)?.consumeNotificationTarget()
    invoke.resolve(if (target == null) JSObject() else JSObject().put("hostId", target.first).put("sessionId", target.second))
  }

  @Command
  fun move_to_back(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve(JSObject())
  }

  @Command
  fun scan_qr(invoke: Invoke) {
    activity.runOnUiThread {
      val main = activity as? MainActivity
      if (main == null) { invoke.reject("scan_qr unavailable"); return@runOnUiThread }
      main.scanQr { text, denied ->
        invoke.resolve(when {
          denied -> JSObject().put("denied", true)
          text != null -> JSObject().put("text", text)
          else -> JSObject().put("cancelled", true)
        })
      }
    }
  }

  @Command
  fun download_apk(invoke: Invoke) {
    val url = invoke.parseArgs(UrlArgs::class.java).url
    val fileName = DownloadUrls.fileName(url)
    if (!DownloadUrls.allowed(url) || fileName == null) { invoke.reject("Invalid download URL"); return }
    val uri = Uri.parse(url)
    try {
      val manager = activity.getSystemService(DownloadManager::class.java) ?: throw IllegalStateException("DownloadManager unavailable")
      val query = DownloadManager.Query().setFilterByStatus(
        DownloadManager.STATUS_PENDING or DownloadManager.STATUS_RUNNING or DownloadManager.STATUS_PAUSED,
      )
      val entries = mutableListOf<Pair<String?, Int>>()
      manager.query(query)?.use { cursor ->
        val uriIdx = cursor.getColumnIndex(DownloadManager.COLUMN_URI)
        val statusIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
        while (cursor.moveToNext()) {
          entries.add((if (uriIdx >= 0) cursor.getString(uriIdx) else null) to (if (statusIdx >= 0) cursor.getInt(statusIdx) else 0))
        }
      }
      if (!DownloadUrls.isActiveDownload(url, entries)) {
        manager.enqueue(
          DownloadManager.Request(uri)
            .setMimeType("application/vnd.android.package-archive")
            .setTitle(fileName)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName),
        )
      }
      invoke.resolve(JSObject())
      return
    } catch (_: Exception) {
      // 下载管理器不可用时回退到系统浏览器打开
    }
    try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
      invoke.resolve(JSObject())
    } catch (_: Exception) { invoke.reject("Unable to open download") }
  }

  @Command
  fun set_system_bars(invoke: Invoke) {
    val light = invoke.parseArgs(SystemBarsArgs::class.java).light
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = light
      controller.isAppearanceLightNavigationBars = light
      invoke.resolve(JSObject())
    }
  }

  private fun appDetails() =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))

  private fun state(): JSObject {
    val power = activity.getSystemService(PowerManager::class.java)
    return JSObject()
      .put("running", KeepAliveService.running)
      .put("ignoringBatteryOptimizations", power.isIgnoringBatteryOptimizations(activity.packageName))
  }
}
