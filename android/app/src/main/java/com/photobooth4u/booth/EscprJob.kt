package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Matrix
import java.io.ByteArrayOutputStream
import java.util.Calendar

/**
 * EXPERIMENTAL. Builds one print job in Epson's ESC/P-R raster language, the language older ink-tank
 * printers such as the Epson L120 / L210 understand, from the layout documented by Epson's open-source
 * Linux driver (epson-inkjet-printer-escpr). Written from that layout, not copied from the driver.
 *
 * One 24-bit RGB page at 360 dpi with 3 mm borders, plain paper, normal quality. No ink levels, no
 * borderless, no photo-paper settings: the printer's own driver does those and this does not.
 */
object EscprJob {
    private const val DPI = 360
    private const val BORDER = 42                       // 3 mm at 360 dpi

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun be16(v: Int) = bytes(v shr 8, v)
    private fun be32(v: Int) = bytes(v ushr 24, v shr 16, v shr 8, v)
    private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)

    private fun ByteArrayOutputStream.put(vararg parts: ByteArray) { for (p in parts) write(p) }

    /** Page size in 1/360 inch for a sheet widthMm x heightMm; the feed is always portrait (short side first). */
    fun paperPixels(widthMm: Double, heightMm: Double): Pair<Int, Int> {
        val w = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val h = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        return w to h
    }

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean, borderless: Boolean = false): ByteArray {
        val (paperW, paperH) = paperPixels(widthMm, heightMm)
        val border = if (borderless) 0 else BORDER
        val areaW = paperW - 2 * border
        val areaH = paperH - 2 * border
        require(areaW > 0 && areaH > 0) { "Sheet too small" }

        // Turn a landscape picture to match the portrait feed, then fit it to the printable area.
        var bmp = src
        if (bmp.width > bmp.height && widthMm <= heightMm) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
        }
        bmp = Bitmap.createScaledBitmap(bmp, areaW, areaH, true)

        val out = ByteArrayOutputStream()
        // ── job start ──
        out.put(bytes(0x00, 0x00, 0x00, 0x1B, 0x01), ascii("@EJL 1284.4\n@EJL     \n"))         // leave IEEE-1284.4 packet mode
        out.put(bytes(0x1B, 0x40))                                                              // initialise
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))                    // enter remote mode
        val now = Calendar.getInstance()
        out.put(bytes(0x54, 0x49, 0x08, 0x00, 0x00), be16(now.get(Calendar.YEAR)),
            bytes(now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH), now.get(Calendar.HOUR_OF_DAY),
                now.get(Calendar.MINUTE), now.get(Calendar.SECOND)))                           // TI: time
        out.put(bytes(0x4A, 0x53, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00))                          // JS: job start
        out.put(bytes(0x4A, 0x48, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), ascii("ESCPRLib")) // JH
        out.put(bytes(0x48, 0x44, 0x03, 0x00, 0x00, 0x03, 0x04))                                // HD: host (linux)
        out.put(bytes(0x50, 0x50, 0x03, 0x00, 0x00, 0x01, 0xFF))                                // PP: any paper source
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))                                                  // leave remote mode
        out.put(bytes(0x1B, 0x28, 0x52, 0x06, 0x00, 0x00), ascii("ESCPR"))                      // ESC/P-R mode
        // print quality: plain paper, normal, colour/mono, no brightness/contrast/saturation change, RGB, no palette
        out.put(bytes(0x1B, 0x71, 0x09, 0x00, 0x00, 0x00), ascii("setq"),
            bytes(0x00, 0x01, if (mono) 1 else 0, 0, 0, 0, 0x00, 0x00, 0x00))
        // job: page size and printable area, 360 dpi, bidirectional
        out.put(bytes(0x1B, 0x6A, 0x16, 0x00, 0x00, 0x00), ascii("setj"),
            be32(paperW), be32(paperH), be16(border), be16(border), be32(areaW), be32(areaH), bytes(0x00, 0x00))
        // ── page ──
        out.put(bytes(0x1B, 0x70, 0x00, 0x00, 0x00, 0x00), ascii("sttp"))
        out.put(bytes(0x1B, 0x70, 0x01, 0x00, 0x00, 0x00), ascii("setn"), bytes(0x01))
        val px = IntArray(areaW)
        val row = ByteArray(areaW * 3)
        for (y in 0 until areaH) {
            bmp.getPixels(px, 0, areaW, 0, y, areaW, 1)
            var white = true
            for (x in 0 until areaW) {
                val c = px[x]
                var r = (c shr 16) and 0xFF
                var g = (c shr 8) and 0xFF
                var b = c and 0xFF
                if (mono) { val l = (0.299 * r + 0.587 * g + 0.114 * b).toInt(); r = l; g = l; b = l }
                row[x * 3] = r.toByte(); row[x * 3 + 1] = g.toByte(); row[x * 3 + 2] = b.toByte()
                if (r != 0xFF || g != 0xFF || b != 0xFF) white = false
            }
            if (white) continue                                                                 // blank rows are skipped
            val rle = packBits(row, 3)
            val useRle = rle.size < row.size
            val data = if (useRle) rle else row
            val len = 7 + data.size
            out.put(bytes(0x1B, 0x64), bytes(len, len shr 8, len shr 16, len shr 24),
                ascii("dsnd"), be16(0), be16(y), bytes(if (useRle) 1 else 0), be16(data.size), data)
        }
        // ── page end, job end ──
        out.put(bytes(0x1B, 0x70, 0x01, 0x00, 0x00, 0x00), ascii("endp"), bytes(0x00))
        out.put(bytes(0x1B, 0x6A, 0x00, 0x00, 0x00, 0x00), ascii("endj"))
        out.put(bytes(0x1B, 0x40))
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))
        out.put(bytes(0x4A, 0x45, 0x01, 0x00, 0x00))                                            // JE: job end
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))
        return out.toByteArray()
    }

    /** PackBits over whole pixels (bpp bytes each): repeat runs up to 128, literal runs up to 127. */
    internal fun packBits(row: ByteArray, bpp: Int): ByteArray {
        val n = row.size / bpp
        val out = ByteArrayOutputStream()
        fun same(a: Int, b: Int): Boolean {
            for (k in 0 until bpp) if (row[a * bpp + k] != row[b * bpp + k]) return false
            return true
        }
        var i = 0
        while (i < n) {
            var run = 1
            while (i + run < n && run < 128 && same(i, i + run)) run++
            if (run >= 2) {
                out.write(0xFF - run + 2)
                out.write(row, i * bpp, bpp)
                i += run
            } else {
                var lit = 1
                while (i + lit < n && lit < 127 && !(i + lit + 1 < n && same(i + lit, i + lit + 1))) lit++
                out.write(lit - 1)
                out.write(row, i * bpp, lit * bpp)
                i += lit
            }
        }
        return out.toByteArray()
    }
}
