package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import java.io.ByteArrayOutputStream

/**
 * EXPERIMENTAL. One page for a Canon PIXMA G-series ink-tank printer (G1000 / G1010 / G2000 / G3000 family) over USB:
 * 300 x 300 dpi, one bit per ink, cyan / magenta / yellow / black, plain paper, 4x6 / A4 / Letter.
 *
 * Written from the byte layout published in the Gutenprint project's Canon driver (its "G1000" path: an XML job wrapper,
 * then ESC ( commands and PackBits raster bands), not copied from it. The G1010 itself is not in that driver, so this is
 * a best guess that needs a real G1010 to confirm.
 */
object CanonJob {
    private const val DPI = 300
    private const val LINES = 8                         // raster rows per band
    private const val MARGIN_SIDE = 42                  // 10 pt at 300 dpi
    private const val MARGIN_TOP = 38                   // 9 pt
    private const val MARGIN_BOTTOM = 63                // 15 pt

    // Job wrapper (Canon "IVEC" XML): start of job, then end of job.
    private const val PRE_XML = """<?xml version="1.0" encoding="utf-8" ?><cmd xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"><ivec:contents><ivec:operation>StartJob</ivec:operation><ivec:param_set servicetype="print"><ivec:jobID>00000001</ivec:jobID><ivec:bidi>0</ivec:bidi></ivec:param_set></ivec:contents></cmd><?xml version="1.0" encoding="utf-8" ?><cmd xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/" xmlns:vcn="http://www.canon.com/ns/cmd/2008/07/canon/"><ivec:contents><ivec:operation>VendorCmd</ivec:operation><ivec:param_set servicetype="print"><vcn:ijoperation>ModeShift</vcn:ijoperation><vcn:ijmode>1</vcn:ijmode><ivec:jobID>00000001</ivec:jobID></ivec:param_set></ivec:contents></cmd>"""
    private const val POST_XML = """<?xml version="1.0" encoding="utf-8" ?><cmd xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"><ivec:contents><ivec:operation>EndJob</ivec:operation><ivec:param_set servicetype="print"><ivec:jobID>00000001</ivec:jobID></ivec:param_set></ivec:contents></cmd>"""

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun be16(v: Int) = bytes(v shr 8, v)
    private fun be32(v: Int) = bytes(v ushr 24, v shr 16, v shr 8, v)
    private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)
    private fun ByteArrayOutputStream.put(vararg parts: ByteArray) { for (p in parts) write(p) }

    /** Paper size code the printer expects, or null when this size is not supported yet. */
    private fun sizeCode(wMm: Double, hMm: Double): Int? {
        val w = minOf(wMm, hMm)
        val h = maxOf(wMm, hMm)
        fun near(a: Double, b: Double) = Math.abs(a - b) < 3.0
        return when {
            near(w, 101.6) && near(h, 152.4) -> 0x34        // 4x6
            near(w, 210.0) && near(h, 297.0) -> 0x03        // A4
            near(w, 215.9) && near(h, 279.4) -> 0x0D        // Letter
            else -> null
        }
    }

    fun supports(wMm: Double, hMm: Double) = sizeCode(wMm, hMm) != null

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean): ByteArray {
        val size = sizeCode(widthMm, heightMm)
            ?: throw IllegalArgumentException("This paper size isn't supported on Canon USB printers yet. Use 4x6, A4 or Letter.")
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val areaW = paperW - 2 * MARGIN_SIDE
        val areaH = ((paperH - MARGIN_TOP - MARGIN_BOTTOM) / LINES) * LINES
        require(areaW > 0 && areaH > 0) { "Sheet too small" }

        var bmp = src
        if (bmp.width > bmp.height && widthMm <= heightMm) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
        }
        bmp = Bitmap.createScaledBitmap(bmp, areaW, areaH, true)
        val rowBytes = (areaW + 7) / 8
        // planes in the printer's order: cyan, magenta, yellow, black
        val planes: Array<ByteArray> = if (mono) {
            val grey = Bitmap.createBitmap(areaW, areaH, Bitmap.Config.ARGB_8888)
            val p = Paint().apply { colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) }) }
            Canvas(grey).apply { drawColor(Color.WHITE); drawBitmap(bmp, 0f, 0f, p) }
            arrayOf(ByteArray(rowBytes * areaH), ByteArray(rowBytes * areaH), ByteArray(rowBytes * areaH),
                EscP2Job.dither(grey, areaW, areaH, rowBytes))
        } else {
            val k = EscP2Job.cmykPlanes(bmp, areaW, areaH, rowBytes, 1.6)      // K, C, M, Y
            arrayOf(k[1], k[2], k[3], k[0])
        }

        val paperW600 = if (size == 0x03) 4961 else paperW * 2
        val paperH600 = if (size == 0x03) 7016 else paperH * 2
        val out = ByteArrayOutputStream()
        out.put(ascii(PRE_XML))
        out.put(bytes(0x1B, 0x5B, 0x4B, 0x02, 0x00, 0x00, 0x0F))                      // reset (first page)
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x01))                            // data compression on
        out.put(bytes(0x1B, 0x28, 0x71, 0x01, 0x00, 0x01))                            // page id
        out.put(bytes(0x1B, 0x28, 0x64, 0x04, 0x00), be16(DPI), be16(DPI))            // resolution 300 x 300
        out.put(bytes(0x1B, 0x28, 0x74, 0x18, 0x00, 0x80, 0x00, 0x01,                 // image format: 4 inks, 1 bit each
            0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02,
            0, 0, 0, 0, 0, 0, 0, 0, 0))
        out.put(bytes(0x1B, 0x28, 0x63, 0x03, 0x00, 0x30, 0x00, 0x01))                // plain paper, standard quality
        out.put(bytes(0x1B, 0x28, 0x70, 0x2E, 0x00), be16(areaH * 2), be16(0), be16(areaW * 2), be16(0), be32(0), be16(600),
            be32(83), be32(75), be32(areaW * 2), be32(areaH * 2), be32(0), be32(0), be32(paperW600), be32(paperH600))
        out.put(bytes(0x1B, 0x28, 0x50, 0x09, 0x00, 0x00, size, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xFF))   // paper size, portrait
        out.put(bytes(0x1B, 0x28, 0x6C, 0x03, 0x00, 0x34, 0x00, 0x00))                // rear tray, plain paper
        out.put(bytes(0x1B, 0x28, 0x76, 0x01, 0x00, 0x00))                            // portrait
        out.put(bytes(0x1B, 0x28, 0x49, 0x01, 0x00, 0x01))                            // multi-line raster on
        out.put(bytes(0x1B, 0x28, 0x4A, 0x01, 0x00, LINES))                           // 8 rows per band
        out.put(bytes(0x1B, 0x28, 0x4C, 0x04, 0x00, 0x43, 0x4D, 0x59, 0x4B))          // channels C M Y K

        val band = ByteArrayOutputStream()
        for (b in 0 until areaH / LINES) {
            for (ch in 0 until 4) {
                band.reset()
                for (r in 0 until LINES) {
                    val y = b * LINES + r
                    var end = rowBytes
                    while (end > 0 && planes[ch][y * rowBytes + end - 1].toInt() == 0) end--
                    if (end > 0) band.write(EscP2Job.packBits(planes[ch].copyOfRange(y * rowBytes, y * rowBytes + end), 1))
                    band.write(0x80)                                                  // end of row
                }
                val data = band.toByteArray()
                out.put(bytes(0x1B, 0x28, 0x46, data.size, data.size shr 8), data)
            }
        }
        out.put(bytes(0x0C))                                                           // eject
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x00))                            // compression off
        out.put(bytes(0x1B, 0x40))                                                    // reset
        out.put(ascii(POST_XML))                                                       // end of job
        return out.toByteArray()
    }
}
