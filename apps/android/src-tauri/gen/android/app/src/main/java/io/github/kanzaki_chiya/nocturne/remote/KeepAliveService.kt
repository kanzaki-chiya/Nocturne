package io.github.kanzaki_chiya.nocturne.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder

data class ServiceNotice(
  val title: String,
  val body: String = "",
  val shortCriticalText: String = "",
  val promoted: Boolean = false,
  val hostId: String = "",
  val sessionId: String = "",
)

/**
 * 前台服务：只负责让进程不被回收。连接、加密与订阅全在 WebView 里（ADR-0059 第 2 节）；
 * 服务本身不联网、不持有任何密钥。类型是 specialUse（理由见 docs/apps/android.md）。
 */
class KeepAliveService : Service() {
  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_SHORT_CRITICAL_TEXT = "shortCriticalText"
    const val EXTRA_PROMOTED = "promoted"
    const val EXTRA_HOST_ID = "hostId"
    const val EXTRA_SESSION_ID = "sessionId"
    private const val CHANNEL = "nocturne_background"
    private const val NOTIFICATION_ID = 1
    @Volatile var running = false
    @Volatile private var lastNotice = ServiceNotice(title = "Nocturne 远程：正在连接…")

    fun start(context: Context, notice: ServiceNotice) {
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(EXTRA_TITLE, notice.title)
        .putExtra(EXTRA_BODY, notice.body)
        .putExtra(EXTRA_SHORT_CRITICAL_TEXT, notice.shortCriticalText)
        .putExtra(EXTRA_PROMOTED, notice.promoted)
        .putExtra(EXTRA_HOST_ID, notice.hostId)
        .putExtra(EXTRA_SESSION_ID, notice.sessionId)
      context.startForegroundService(intent)
    }

    fun update(context: Context, notice: ServiceNotice) {
      lastNotice = notice
      if (!running) return
      context.getSystemService(NotificationManager::class.java)
        .notify(NOTIFICATION_ID, build(context, notice))
    }

    /** 通知权限刚授予时，之前被丢弃的常驻通知要重新发布 */
    fun refresh(context: Context) = update(context, lastNotice)

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

    private fun contentIntent(context: Context, notice: ServiceNotice): PendingIntent {
      val intent = if (notice.hostId.isNotEmpty() && notice.sessionId.isNotEmpty()) {
        Intent(context, MainActivity::class.java)
          .setAction("io.github.kanzaki_chiya.nocturne.remote.OPEN_SESSION")
          .setData(
            Uri.Builder().scheme("nocturne").authority("session")
              .appendPath(notice.hostId).appendPath(notice.sessionId).build()
          )
          .putExtra(SessionNotifications.HOST, notice.hostId)
          .putExtra(SessionNotifications.SESSION, notice.sessionId)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      } else {
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }

    private fun build(context: Context, notice: ServiceNotice): Notification {
      ensureChannel(context)
      val builder = Notification.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle(notice.title)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentIntent(context, notice))
      if (notice.body.isNotEmpty()) {
        builder.setContentText(notice.body)
        builder.setStyle(Notification.BigTextStyle().bigText(notice.body))
      }
      if (Build.VERSION.SDK_INT >= 36) {
        builder.setRequestPromotedOngoing(notice.promoted)
        if (notice.promoted && notice.shortCriticalText.isNotEmpty()) {
          builder.setShortCriticalText(notice.shortCriticalText)
        }
      }
      return builder.build()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    NativeLog.init(this)
    val notice = if (intent?.hasExtra(EXTRA_TITLE) == true) {
      ServiceNotice(
        title = intent.getStringExtra(EXTRA_TITLE) ?: lastNotice.title,
        body = intent.getStringExtra(EXTRA_BODY) ?: "",
        shortCriticalText = intent.getStringExtra(EXTRA_SHORT_CRITICAL_TEXT) ?: "",
        promoted = intent.getBooleanExtra(EXTRA_PROMOTED, false),
        hostId = intent.getStringExtra(EXTRA_HOST_ID) ?: "",
        sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "",
      )
    } else {
      lastNotice
    }
    lastNotice = notice
    val notification = build(this, notice)
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
