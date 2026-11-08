package io.github.kanzaki_chiya.nocturne.remote

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import org.junit.Assert.assertEquals
import org.junit.Test

class QrCapacityTest {
  @Test fun desktopPairingUrlAtSixPixelsPerModule() {
    val lines = javaClass.classLoader!!.getResourceAsStream("pairing-qr.txt")!!.bufferedReader().readLines()
    val expected = lines.first()
    val modules = lines.drop(1)
    val width = modules.size * 6
    val pixels = IntArray(width * width) { index ->
      if (modules[index / width / 6][index % width / 6] == '1') 0xff000000.toInt() else 0xffffffff.toInt()
    }
    val decoded = MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(width, width, pixels))))
    assertEquals(BarcodeFormat.QR_CODE, decoded.barcodeFormat)
    assertEquals(expected, decoded.text)
    println("ZXing decoded ${expected.length} chars, ${modules.size} modules including quiet zone, ${width}px at 6px/module")
  }
}
