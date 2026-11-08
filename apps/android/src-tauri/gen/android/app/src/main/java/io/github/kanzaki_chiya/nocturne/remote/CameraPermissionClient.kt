package io.github.kanzaki_chiya.nocturne.remote

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.webkit.*

/** 先完成 capture 授权，再让 Wry 计算可用的相机 Intent；其余回调原样委托。 */
class CameraPermissionClient(
  private val activity: MainActivity,
  private val delegate: WebChromeClient,
) : WebChromeClient() {
  override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
    if (params.isCaptureEnabled && activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(arrayOf(Manifest.permission.CAMERA)) { granted ->
        if (granted == true) delegate.onShowFileChooser(view, callback, params)
        else callback.onReceiveValue(null)
      }
      return true
    }
    return delegate.onShowFileChooser(view, callback, params)
  }

  override fun onShowCustomView(view: View, callback: CustomViewCallback) = delegate.onShowCustomView(view, callback)
  override fun onHideCustomView() = delegate.onHideCustomView()
  override fun onPermissionRequest(request: PermissionRequest) = delegate.onPermissionRequest(request)
  override fun getDefaultVideoPoster(): Bitmap? = delegate.defaultVideoPoster
  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) = delegate.onJsAlert(view, url, message, result)
  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) = delegate.onJsConfirm(view, url, message, result)
  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult) = delegate.onJsPrompt(view, url, message, defaultValue, result)
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) = delegate.onGeolocationPermissionsShowPrompt(origin, callback)
  override fun onConsoleMessage(message: ConsoleMessage) = delegate.onConsoleMessage(message)
  override fun onReceivedTitle(view: WebView, title: String) = delegate.onReceivedTitle(view, title)
}
