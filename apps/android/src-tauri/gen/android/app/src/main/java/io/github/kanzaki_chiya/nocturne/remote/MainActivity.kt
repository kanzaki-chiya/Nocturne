package io.github.kanzaki_chiya.nocturne.remote

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
  private var pendingTarget: Pair<String, String>? = null
  private var foreground = false
  fun isActivityForeground(): Boolean = foreground
  private var rendererLost = false
  private var webViewRef: WebView? = null
  private val handler = Handler(Looper.getMainLooper())
  private val keepVisible = object : Runnable {
    override fun run() {
      if (foreground || !KeepAliveService.running) return
      webViewRef?.dispatchWindowVisibilityChanged(View.VISIBLE)
      handler.postDelayed(this, 5_000)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    NativeLog.init(this)
    NativeLog.add("activity_create")
    captureTarget(intent)
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // 页面掌握 SPA 导航栈：首页后台化，内页交给 history.back()。
        if (webViewRef == null) moveTaskToBack(true)
        else webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('nocturne-android-back'))", null)
      }
    })
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureTarget(intent)
    webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('nocturne-android-notification-target'))", null)
  }

  private fun captureTarget(intent: Intent?) {
    val host = intent?.getStringExtra(SessionNotifications.HOST)
    val session = intent?.getStringExtra(SessionNotifications.SESSION)
    if (!host.isNullOrEmpty() && !session.isNullOrEmpty()) {
      pendingTarget = host to session
      SessionNotifications.dismiss(this, host, session)
    }
  }

  fun consumeNotificationTarget(): Pair<String, String>? {
    val target = pendingTarget
    pendingTarget = null
    intent?.removeExtra(SessionNotifications.HOST)
    intent?.removeExtra(SessionNotifications.SESSION)
    return target
  }

  override fun onWebViewCreate(webView: WebView) {
    // 页面不可见时不要把渲染进程降到可回收/可冻结的优先级：后台要继续跑 JS 与 WebSocket
    webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    webViewRef = webView
    // wry 在 setWebView 之后才 setWebViewClient；排到主线程队列后面再包装，才能包住它的 client
    webView.post {
      webView.webViewClient = GuardedWebViewClient(webView.webViewClient, ::rendererGone)
    }
  }

  override fun onResume() {
    super.onResume()
    foreground = true
    handler.removeCallbacks(keepVisible)
    NativeLog.add("activity_resume")
    if (rendererLost) restart()
    else notifyPageResumed()
  }

  /**
   * 页面靠「窗口保持可见」在后台继续运行，visibilitychange 不可靠；回前台时用原生信号让页面补刷
   * 一次会话列表（别的进程新建的会话没有通知）。事件名与 src/host.ts 的 RESUME_EVENT 一致。
   */
  private fun notifyPageResumed() {
    webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('nocturne-android-resume'))", null)
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    NativeLog.add("permission_result code=$requestCode granted=${grantResults.all { it == 0 }}")
    KeepAliveService.refresh(this)
  }

  override fun onPause() {
    super.onPause()
    foreground = false
    NativeLog.add("activity_pause")
    webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('nocturne-android-pause'))", null)
    keepWebViewRunning()
  }

  override fun onStop() {
    super.onStop()
    keepWebViewRunning()
  }

  /**
   * 实测（模拟器）：Activity 进入后台约 5 分钟后 Chromium 把不可见页面整体冻结，WebSocket 的收发都停了；
   * 只做 WebView.onResume()/resumeTimers() 挡不住。让渲染端一直认为窗口可见（Cordova 后台插件的做法）：
   * 后台期间反复补发一次「窗口可见」。wry 在 onPause 里调 WebView.onPause()，这里一并恢复。
   */
  private fun keepWebViewRunning() {
    if (!KeepAliveService.running) return
    webViewRef?.let {
      it.onResume()
      it.resumeTimers()
      it.dispatchWindowVisibilityChanged(View.VISIBLE)
    }
    NativeLog.add("webview_kept_running")
    handler.removeCallbacks(keepVisible)
    handler.postDelayed(keepVisible, 1_000)
  }

  override fun onDestroy() {
    NativeLog.add("activity_destroy finishing=$isFinishing")
    // 用户划掉 App：WebView 随 Activity 消失，连接也没了，常驻通知不能继续说「已连接」
    if (isFinishing && !rendererLost) KeepAliveService.stop(this)
    super.onDestroy()
  }

  /**
   * WebView 属于 Activity，渲染进程没了就没有可用的页面。前台时立刻重启 App（身份密钥在 IndexedDB 里，
   * 重启后按现有逻辑重连并重新订阅）；后台时 Android 不允许无界面拉起 Activity，先更新常驻通知
   * 提示，回到前台时再重启。
   */
  private fun rendererGone(crashed: Boolean) {
    NativeLog.add("renderer_gone crashed=$crashed foreground=$foreground")
    rendererLost = true
    if (foreground) restart()
    else KeepAliveService.update(this, "Nocturne 远程：连接已中断，点按重新打开")
  }

  private fun restart() {
    NativeLog.add("app_restart")
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
    startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    Process.killProcess(Process.myPid())
  }
}
