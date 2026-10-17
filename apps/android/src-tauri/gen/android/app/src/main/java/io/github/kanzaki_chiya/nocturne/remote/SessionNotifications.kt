package io.github.kanzaki_chiya.nocturne.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** 与保活通知分开；同一 host/session 的 tag 固定，下一条替换上一条。 */
object SessionNotifications {
  // 渠道级别创建后不能调高：旧渠道是 DEFAULT，换新 id 用 HIGH 以悬浮通知弹出，并删掉旧渠道
  private const val CHANNEL = "nocturne_sessions_v2"
  private const val LEGACY_CHANNEL = "nocturne_sessions"
  const val HOST = "notification_host_id"
  const val SESSION = "notification_session_id"

  private fun tag(hostId: String, sessionId: String) = "$hostId:$sessionId"
  private fun id(sessionId: String) = sessionId.hashCode()

  fun enabled(context: Context): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)
    return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
  }

  fun show(context: Context, hostId: String, sessionId: String, title: String, body: String, kind: String): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (!enabled(context)) return false
    val system = context.getSystemService(NotificationManager::class.java)
    if (system.getNotificationChannel(CHANNEL) == null) {
      system.createNotificationChannel(NotificationChannel(CHANNEL, "会话提醒", NotificationManager.IMPORTANCE_HIGH))
      system.deleteNotificationChannel(LEGACY_CHANNEL)
    }
    if (system.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) return false
    val intent = Intent(context, MainActivity::class.java)
      .setAction("io.github.kanzaki_chiya.nocturne.remote.OPEN_SESSION")
      .setData(Uri.Builder().scheme("nocturne").authority("session")
        .appendPath(hostId).appendPath(sessionId).build())
      .putExtra(HOST, hostId).putExtra(SESSION, sessionId)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val open = PendingIntent.getActivity(context, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val publicBody = when (kind) {
      "attention" -> "需要确认"
      "error" -> "出错停止"
      else -> "已完成"
    }
    val publicVersion = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("Nocturne")
      .setContentText(publicBody)
      .build()
    val notice: Notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(title).setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(open).setAutoCancel(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
      .build()
    return try {
      manager.notify(tag(hostId, sessionId), id(sessionId), notice)
      true
    } catch (_: SecurityException) {
      false
    }
  }

  fun dismiss(context: Context, hostId: String, sessionId: String) {
    NotificationManagerCompat.from(context).cancel(tag(hostId, sessionId), id(sessionId))
  }
}
