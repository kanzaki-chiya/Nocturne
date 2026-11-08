package io.github.kanzaki_chiya.nocturne.remote

import android.app.Activity
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.view.View
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/** 无文字、音效或震动的竖屏 QR 预览。相机授权由调用方处理。 */
class ScanActivity : AppCompatActivity() {
  private lateinit var scanner: BarcodeView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    hideSystemBars()
    setResult(Activity.RESULT_CANCELED)
    scanner = BarcodeView(this).apply {
      decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
    }
    val root = FrameLayout(this)
    root.addView(scanner, FrameLayout.LayoutParams(-1, -1))
    root.addView(object : View(this) {
      private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      override fun onDraw(canvas: Canvas) {
        val side = minOf(width * 0.72f, height * 0.5f)
        val left = (width - side) / 2
        val top = (height - side) / 2
        paint.color = 0x88000000.toInt()
        canvas.drawRect(0f, 0f, width.toFloat(), top, paint)
        canvas.drawRect(0f, top + side, width.toFloat(), height.toFloat(), paint)
        canvas.drawRect(0f, top, left, top + side, paint)
        canvas.drawRect(left + side, top, width.toFloat(), top + side, paint)
        paint.color = Color.WHITE
        paint.strokeWidth = 3 * resources.displayMetrics.density
        val corner = 28 * resources.displayMetrics.density
        for (x in listOf(left, left + side)) for (y in listOf(top, top + side)) {
          canvas.drawLine(x, y, x + if (x == left) corner else -corner, y, paint)
          canvas.drawLine(x, y, x, y + if (y == top) corner else -corner, paint)
        }
      }
    }, FrameLayout.LayoutParams(-1, -1))
    val back = object : View(this) {
      private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; strokeWidth = 2 * resources.displayMetrics.density }
      override fun onDraw(canvas: Canvas) {
        val d = resources.displayMetrics.density
        canvas.drawLine(26*d, 13*d, 17*d, 22*d, paint)
        canvas.drawLine(17*d, 22*d, 26*d, 31*d, paint)
      }
    }
    val density = resources.displayMetrics.density
    root.addView(back, FrameLayout.LayoutParams((44*density).toInt(), (44*density).toInt()).apply { leftMargin = (8*density).toInt(); topMargin = (8*density).toInt() })
    back.setOnClickListener { finish() }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() { finish() }
    })
    setContentView(root)
    scanner.decodeSingle(object : BarcodeCallback {
      override fun barcodeResult(result: BarcodeResult) {
        setResult(Activity.RESULT_OK, Intent().putExtra("text", result.text))
        finish()
      }
    })
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  private fun hideSystemBars() {
    WindowInsetsControllerCompat(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  override fun onResume() { super.onResume(); scanner.resume() }
  override fun onPause() { scanner.pause(); super.onPause() }
}
