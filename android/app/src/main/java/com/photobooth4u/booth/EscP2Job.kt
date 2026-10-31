package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Matrix
import java.io.ByteArrayOutputStream

/**
 * EXPERIMENTAL. One black-and-white page in Epson ESC/P2 raster, for ink-tank printers whose IEEE-1284 ID lists
 * CMD:ESCPL2 and not ESCPR (Epson L120 and its family). Written from the byte layout and head data documented in
 * the Gutenprint project's Epson driver data, not copied from it.
 *
 * Head: 180 black nozzles, 2 rows apart at 360 dpi. A band of 360 rows is printed in two interleaved passes
 * (even rows, then odd rows). Black ink only, 1 bit per dot, 360 x 360 dpi, 3 mm side borders.
 */
object EscP2Job {
    private const val DPI = 360
    private const val SIDE = 42                       // 3 mm
    private const val NOZZLES = 180
    private const val SEP = 2
    private const val BAND = NOZZLES * SEP            // 360 rows per band
    private const val EXTRA_BOTTOM = 120              // 24 pt, as the page length the printer is told

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun le16(v: Int) = bytes(v, v shr 8)
    private fun le32(v: Int) = bytes(v, v shr 8, v shr 16, v shr 24)
    private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)
    private fun ByteArrayOutputStream.put(vararg parts: ByteArray) { for (p in parts) write(p) }

    fun build(src: Bitmap, widthMm: Double, heightMm: Double): ByteArray {
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val areaW = paperW - 2 * SIDE
        val areaH = paperH - SIDE - EXTRA_BOTTOM
        require(areaW > 0 && areaH > 0) { "Sheet too small" }

        var bmp = src
        if (bmp.width > bmp.height && widthMm <= heightMm) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
        }
        bmp = Bitmap.createScaledBitmap(bmp, areaW, areaH, true)
        val rowBytes = (areaW + 7) / 8
        val bits = dither(bmp, areaW, areaH, rowBytes)

        val out = ByteArrayOutputStream()
        // ── job start ──
        out.put(bytes(0x00, 0x00, 0x00, 0x1B, 0x01), ascii("@EJL 1284.4\n@EJL     \n"), bytes(0x1B, 0x40))   // leave packet mode
        out.put(bytes(0x1B, 0x40))                                                                      // reset
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))                            // remote mode
        out.put(bytes(0x50, 0x4D, 0x02, 0x00, 0x00, 0x00))                                              // PM
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))                                                          // leave remote mode
        out.put(bytes(0x1B, 0x28, 0x47, 0x01, 0x00, 0x01))                                              // graphics mode
        out.put(bytes(0x1B, 0x28, 0x55, 0x05, 0x00, 10, 10, 10, 0x10, 0x0E))                            // units: 1/360 inch
        out.put(bytes(0x1B, 0x28, 0x4B, 0x02, 0x00, 0x00, 0x01))                                        // black only
        out.put(bytes(0x1B, 0x28, 0x69, 0x01, 0x00, 0x00))                                              // microweave off
        out.put(bytes(0x1B, 0x55, 0x01))                                                                // one direction
        out.put(bytes(0x1B, 0x28, 0x44, 0x04, 0x00, 0x40, 0x38, 0x50, 0x28))                            // head resolution
        out.put(bytes(0x1B, 0x28, 0x43, 0x04, 0x00), le32(paperH + EXTRA_BOTTOM))                       // page length
        out.put(bytes(0x1B, 0x28, 0x53, 0x08, 0x00), le32(paperW), le32(paperH + EXTRA_BOTTOM))         // paper size

        // ── page: each band of 360 rows as two passes (even rows, then odd rows) ──
        var last = 0
        val bands = (areaH + BAND - 1) / BAND
        val pass = ByteArray(NOZZLES * rowBytes)
        for (b in 0 until bands) {
            for (p in 0 until SEP) {
                var any = false
                java.util.Arrays.fill(pass, 0)
                for (k in 0 until NOZZLES) {
                    val row = b * BAND + p + SEP * k
                    if (row >= areaH) break
                    System.arraycopy(bits, row * rowBytes, pass, k * rowBytes, rowBytes)
                }
                for (v in pass) if (v.toInt() != 0) { any = true; break }
                if (!any) continue
                val start = b * BAND + p
                out.put(bytes(0x1B, 0x28, 0x76, 0x04, 0x00), le32(start - last))                       // paper advance
                last = start
                out.put(bytes(0x1B, 0x28, 0x24, 0x04, 0x00), le32(SIDE))                                // left position
                out.put(bytes(0x1B, 0x69, 0x00, 0x00, 0x01), le16(rowBytes), le16(NOZZLES), pass)       // black, raw, 1 bit
                out.put(bytes(0x0D))
            }
        }
        // ── page end, job end ──
        out.put(bytes(0x0C))
        out.put(bytes(0x1B, 0x40))
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))
        out.put(bytes(0x4C, 0x44, 0x00, 0x00))                                                          // LD
        out.put(bytes(0x4A, 0x45, 0x01, 0x00, 0x00))                                                    // JE
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))
        return out.toByteArray()
    }

    /** Floyd-Steinberg to 1 bit, packed MSB first, 1 = ink. */
    internal fun dither(bmp: Bitmap, w: Int, h: Int, rowBytes: Int): ByteArray {
        val out = ByteArray(rowBytes * h)
        val px = IntArray(w)
        var cur = FloatArray(w + 2)
        var next = FloatArray(w + 2)
        for (y in 0 until h) {
            bmp.getPixels(px, 0, w, 0, y, w, 1)
            java.util.Arrays.fill(next, 0f)
            for (x in 0 until w) {
                val c = px[x]
                val lum = 0.299f * ((c shr 16) and 0xFF) + 0.587f * ((c shr 8) and 0xFF) + 0.114f * (c and 0xFF) + cur[x + 1]
                val on = lum < 128f
                val err = lum - (if (on) 0f else 255f)
                if (on) out[y * rowBytes + (x shr 3)] = (out[y * rowBytes + (x shr 3)].toInt() or (0x80 shr (x and 7))).toByte()
                cur[x + 2] += err * 7f / 16f
                next[x] += err * 3f / 16f
                next[x + 1] += err * 5f / 16f
                next[x + 2] += err * 1f / 16f
            }
            val t = cur; cur = next; next = t
        }
        return out
    }
}
