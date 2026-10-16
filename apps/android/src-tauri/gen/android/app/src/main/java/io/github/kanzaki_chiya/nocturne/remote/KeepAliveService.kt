package io.github.kanzaki_chiya.nocturne.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 前台服务：只负责让进程不被回收。连接、加密与订阅全在 WebView 里（ADR-0059 第 2 节）；
 * 服务本身不联网、不持有任何密钥。类型是 specialUse（理由见 docs/apps/android.md）。
 */
class KeepAliveService : Service() {
  companion object {
    const val EXTRA_TEXT = "text"
    private const val CHANNEL = "nocturne_background"
    private const val NOTIFICATION_ID = 1
    @Volatile var running = false
    @Volatile private var lastText = "Nocturne 远程：正在连接…"

    fun start(context: Context, text: String) {
      val intent = Intent(context, KeepAliveService::class.java).putExtra(EXTRA_TEXT, text)
      context.startForegroundService(intent)
    }

    fun update(context: Context, text: String) {
      lastText = text
      if (!running) return
      context.getSystemService(NotificationManager::class.java)
        .notify(NOTIFICATION_ID, build(context, text))
    }

    /** 通知权限刚授予时，之前被丢弃的常驻通知要重新发布 */
    fun refresh(context: Context) = update(context, lastText)

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }

    private fun ensureChannel(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL) != null) return
      val channel = NotificationChannel(CHANNEL, "后台保持连接", NotificationManager.IMPORTANCE_LOW)
      channel.description = "让 Nocturne 在后台保持与电脑的连接"
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    private fun build(context: Context, text: String): Notification {
      ensureChannel(context)
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      return Notification.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open)
        .build()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    NativeLog.init(this)
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: lastText
    lastText = text
    val notification = build(this, text)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (!running) NativeLog.add("service_start")
    running = true
    // 进程被回收后不自动拉起：WebView 不在，服务会谎称「已连接」
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    NativeLog.add("service_stop")
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    NativeLog.add("task_removed")
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }
}
