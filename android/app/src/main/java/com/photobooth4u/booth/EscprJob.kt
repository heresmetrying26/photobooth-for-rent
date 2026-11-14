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

    fun build(
        src: Bitmap,
        widthMm: Double,
        heightMm: Double,
        mono: Boolean,
        borderless: Boolean = false,
        photoMedia: Boolean = false,
        draft: Boolean = false,
        brightness: Int = 0
    ): ByteArray = build(src, widthMm, heightMm, mono, borderless, photoMedia, draft, PrintColorAdj(brightness = brightness))

    fun build(
        src: Bitmap,
        widthMm: Double,
        heightMm: Double,
        mono: Boolean,
        borderless: Boolean = false,
        photoMedia: Boolean = false,
        draft: Boolean = false,
        adj: PrintColorAdj = PrintColorAdj(),
        epsonBorderless: Boolean = false
    ): ByteArray {
        // Borderless the way Epson's own driver sends it (epson-inkjet-printer-escpr, lib/epson-escpr-media.h, 360 dpi): the sheet size
        // is the table's size, the page area starts 36 px left of and 42 px above the sheet (negative margins) and is 72 px wider and
        // 112 px taller than the sheet, so the printer prints a little past every edge. Only for the sheet sizes below, only when asked
        // for (printEscpr: Epson L-series over Wi-Fi). Any other job keeps the earlier layout (the USB L8050 / L3210 path is untouched).
        val ep = if (borderless && epsonBorderless) epsonBorderlessPaper(widthMm, heightMm) else null
        val (paperW, paperH) = ep ?: paperPixels(widthMm, heightMm)
        val border = if (borderless) 0 else BORDER
        val areaW = if (ep != null) paperW + BL_EXTRA_W else paperW - 2 * border
        val areaH = if (ep != null) paperH + BL_EXTRA_H else paperH - 2 * border
        val marginTop = if (ep != null) -BL_TOP else border
        val marginLeft = if (ep != null) -BL_LEFT else border
        require(areaW > 0 && areaH > 0) { "Sheet too small" }

        // Turn a landscape picture to match the portrait feed, then fit it to the printable area.
        val needsRotate = (src.width > src.height) != (areaW > areaH)
        val rotatedSrc: Bitmap
        val shouldRecycleRotated: Boolean
        if (needsRotate) {
            rotatedSrc = Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(90f) }, true)
            shouldRecycleRotated = (rotatedSrc !== src)
        } else {
            rotatedSrc = src
            shouldRecycleRotated = false
        }
        val bmp = if (ep != null) {
            epsonBleedPage(rotatedSrc, paperW, paperH, areaW, areaH)
        } else if (rotatedSrc.width == areaW && rotatedSrc.height == areaH) {
            rotatedSrc
        } else {
            Bitmap.createScaledBitmap(rotatedSrc, areaW, areaH, true)
        }
        if (shouldRecycleRotated) {
            try { rotatedSrc.recycle() } catch (_: Exception) {}
        }

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
        // print quality: media (0x01 photo paper when borderless/photo, else 0x00 plain), quality (0x00 draft, 0x01 normal), colour/mono
        val media = if (photoMedia || borderless) 0x01 else 0x00
        val quality = if (draft) 0x00 else 0x01
        out.put(bytes(0x1B, 0x71, 0x09, 0x00, 0x00, 0x00), ascii("setq"),
            bytes(media, quality, if (mono) 1 else 0, 0, 0, 0, 0x00, 0x00, 0x00))
        // job: page size and printable area, 360 dpi, bidirectional
        out.put(bytes(0x1B, 0x6A, 0x16, 0x00, 0x00, 0x00), ascii("setj"),
            be32(paperW), be32(paperH), be16(marginTop), be16(marginLeft), be32(areaW), be32(areaH), bytes(0x00, 0x00))
        // ── page ──
        out.put(bytes(0x1B, 0x70, 0x00, 0x00, 0x00, 0x00), ascii("sttp"))
        out.put(bytes(0x1B, 0x70, 0x01, 0x00, 0x00, 0x00), ascii("setn"), bytes(0x01))
        val bOff = (adj.brightness.coerceIn(-100, 100) * 2.55).toInt()
        val rOff = bOff + (adj.red.coerceIn(-100, 100) * 2.55).toInt()
        val gOff = bOff + (adj.green.coerceIn(-100, 100) * 2.55).toInt()
        val bOff2 = bOff + (adj.blue.coerceIn(-100, 100) * 2.55).toInt()
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
                if (!adj.isNoop) {
                    r = (r + rOff).coerceIn(0, 255)
                    g = (g + gOff).coerceIn(0, 255)
                    b = (b + bOff2).coerceIn(0, 255)
                }
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
        if (bmp !== src) {
            try { bmp.recycle() } catch (_: Exception) {}
        }
        return out.toByteArray()
    }

    private const val BL_LEFT = 36                    // borderless: the page area starts this far left of the sheet (360 dpi)
    private const val BL_TOP = 42                     // ... and this far above it
    private const val BL_EXTRA_W = 72                 // ... and is this much wider than the sheet (36 each side)
    private const val BL_EXTRA_H = 112                // ... and this much taller (42 above, 70 below)

    /** The sheet in 1/360 inch as Epson's media table lists it, for the sizes borderless is sent for; null for any other size. */
    fun epsonBorderlessPaper(widthMm: Double, heightMm: Double): Pair<Int, Int>? {
        val a = minOf(widthMm, heightMm)
        val b = maxOf(widthMm, heightMm)
        fun near(x: Double, y: Double) = Math.abs(a - x) <= 1.5 && Math.abs(b - y) <= 1.5
        return when {
            near(88.9, 127.0) -> 1261 to 1800        // L / 3R (3.5 x 5 in)
            near(101.6, 152.4) -> 1440 to 2160       // 4 x 6 in
            near(127.0, 177.8) -> 1800 to 2522       // 5 x 7 in (the L805's own list has it; 360.00 x 504.40 pt x 5)
            near(210.0, 297.0) -> 2976 to 4209       // A4
            else -> null
        }
    }

    /**
     * The page for a borderless job: the picture fills the sheet exactly (nothing is cut off), and the strip past each edge, which the
     * printer prints off the paper, repeats the picture's edge pixels so a hair of misalignment never shows white.
     */
    private fun epsonBleedPage(pic: Bitmap, paperW: Int, paperH: Int, areaW: Int, areaH: Int): Bitmap {
        val page = Bitmap.createBitmap(areaW, areaH, Bitmap.Config.ARGB_8888)
        val cv = android.graphics.Canvas(page)
        val l = BL_LEFT
        val t = BL_TOP
        val r = l + paperW
        val bt = t + paperH
        val w = pic.width
        val h = pic.height
        val paint = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG)
        cv.drawBitmap(pic, android.graphics.Rect(0, 0, w, 1), android.graphics.Rect(l, 0, r, t), null)
        cv.drawBitmap(pic, android.graphics.Rect(0, h - 1, w, h), android.graphics.Rect(l, bt, r, areaH), null)
        cv.drawBitmap(pic, android.graphics.Rect(0, 0, 1, h), android.graphics.Rect(0, t, l, bt), null)
        cv.drawBitmap(pic, android.graphics.Rect(w - 1, 0, w, h), android.graphics.Rect(r, t, areaW, bt), null)
        val fill = android.graphics.Paint()
        fun corner(px: Int, py: Int, x0: Int, y0: Int, x1: Int, y1: Int) { fill.color = pic.getPixel(px, py); cv.drawRect(x0.toFloat(), y0.toFloat(), x1.toFloat(), y1.toFloat(), fill) }
        corner(0, 0, 0, 0, l, t)
        corner(w - 1, 0, r, 0, areaW, t)
        corner(0, h - 1, 0, bt, l, areaH)
        corner(w - 1, h - 1, r, bt, areaW, areaH)
        cv.drawBitmap(pic, null, android.graphics.Rect(l, t, r, bt), paint)
        return page
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
