package io.github.kanzaki_chiya.nocturne.remote

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class TextArgs {
  var text: String = ""
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
    val args = invoke.parseArgs(TextArgs::class.java)
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      // 没有通知权限时前台服务照常运行，只是常驻通知不显示；这里请求一次
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
    KeepAliveService.start(activity, args.text)
    invoke.resolve(state())
  }

  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(TextArgs::class.java)
    KeepAliveService.update(activity, args.text)
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

  private fun appDetails() =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))

  private fun state(): JSObject {
    val power = activity.getSystemService(PowerManager::class.java)
    return JSObject()
      .put("running", KeepAliveService.running)
      .put("ignoringBatteryOptimizations", power.isIgnoringBatteryOptimizations(activity.packageName))
  }
}
