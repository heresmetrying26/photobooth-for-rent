package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Color
import java.io.ByteArrayOutputStream

/**
 * Builds ESC/POS raster print data (GS v 0) for USB and network receipt printers.
 */
object ReceiptRaster {
    /**
     * Converts a bitmap into an ESC/POS raster image (GS v 0 mode).
     * rollWidthPx is typically 384 for 58mm paper or 576 for 80mm paper.
     */
    fun build(src: Bitmap, rollWidthPx: Int = 576): ByteArray {
        val targetW = rollWidthPx
        val targetH = ((src.height.toLong() * targetW) / src.width).toInt()
        val scaled = Bitmap.createScaledBitmap(src, targetW, targetH, true)
        val wBytes = (targetW + 7) / 8

        val out = ByteArrayOutputStream()
        // Initialize printer: ESC @
        out.write(byteArrayOf(0x1B, 0x40))

        // GS v 0 m xL xH yL yH d1...dk
        out.write(byteArrayOf(0x1D, 0x76, 0x30, 0x00))
        out.write(byteArrayOf((wBytes and 0xFF).toByte(), ((wBytes shr 8) and 0xFF).toByte()))
        out.write(byteArrayOf((targetH and 0xFF).toByte(), ((targetH shr 8) and 0xFF).toByte()))

        for (y in 0 until targetH) {
            for (xByte in 0 until wBytes) {
                var b = 0
                for (bit in 0 until 8) {
                    val px = xByte * 8 + bit
                    if (px < targetW) {
                        val pixel = scaled.getPixel(px, y)
                        val lum = (Color.red(pixel) * 299 + Color.green(pixel) * 587 + Color.blue(pixel) * 114) / 1000
                        if (lum < 160) {
                            b = b or (0x80 shr bit)
                        }
                    }
                }
                out.write(b)
            }
        }

        if (scaled !== src) {
            try { scaled.recycle() } catch (_: Exception) {}
        }

        // Feed 4 lines and cut: ESC d 4, GS V 66 0
        out.write(byteArrayOf(0x1B, 0x64, 0x04))
        out.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00))
        return out.toByteArray()
    }
}
