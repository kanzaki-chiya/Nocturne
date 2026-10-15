package io.github.kanzaki_chiya.nocturne.remote

import android.graphics.Bitmap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 包住 wry 的 `RustWebViewClient`（final，没有 onRenderProcessGone），其余回调原样转发。
 * 渲染进程被系统回收时，不处理会让整个 App 进程崩溃，这里改为交给 [onGone] 重建。
 */
class GuardedWebViewClient(
  private val inner: WebViewClient,
  private val onGone: (crashed: Boolean) -> Unit,
) : WebViewClient() {
  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    inner.shouldInterceptRequest(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
    inner.onPageStarted(view, url, favicon)

  override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
    inner.onReceivedError(view, request, error)

  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    onGone(detail.didCrash())
    return true
  }
}
