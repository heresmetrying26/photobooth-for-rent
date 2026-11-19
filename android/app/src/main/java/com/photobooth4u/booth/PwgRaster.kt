package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import java.io.ByteArrayOutputStream

/**
 * One page of PWG Raster (the standard "image/pwg-raster" document format of IPP Everywhere, PWG 5102.4) built from a
 * JPEG. Many driverless printers, including some Canon PIXMA G-series over IPP-over-USB, take this format even when
 * they do not take JPEG or PDF. Written from the published format description.
 *
 * File: the 4-byte sync word "RaS2", then per page a 1796-byte big-endian header and the compressed rows. A row is a
 * repeat count (extra copies of the row, 0 to 255), then runs of whole pixels: a count byte 0..127 repeats the next
 * pixel count+1 times, 129..255 means 257-count literal pixels follow.
 */
object PwgRaster {
    private const val HEADER = 1796
    private const val MAX_PIXELS = 26_000_000L            // keeps the bitmap in memory (about A4 at 300 dpi in colour)

    private fun ByteArray.put32(off: Int, v: Int) {
        this[off] = (v ushr 24).toByte(); this[off + 1] = (v shr 16).toByte(); this[off + 2] = (v shr 8).toByte(); this[off + 3] = v.toByte()
    }

    private fun ByteArray.putStr(off: Int, s: String) {
        val b = s.toByteArray(Charsets.US_ASCII)
        b.copyInto(this, off, 0, minOf(b.size, 63))                                    // 64-byte field, always ends in a zero
    }

    /**
     * gray = 8-bit sGray, otherwise 24-bit sRGB. dpi: one of the resolutions the printer lists (300 is the usual choice).
     * pageName / mediaType: the IPP names of the paper and its type ("na_index-4x6_4x6in", "photographic-glossy"), written into the header.
     * cupsExact: write the header the way CUPS does (image box left zero), which is what a printer that takes ONLY raster is tested with
     * (a Brother DCP-T420W); false keeps the whole page as the image box.
     */
    fun fromJpeg(jpeg: ByteArray, wMm: Double, hMm: Double, dpi: Int, gray: Boolean,
                 pageName: String = "", mediaType: String = "", cupsExact: Boolean = false,
                 forcePxW: Int = 0, forcePxH: Int = 0, pagePtW: Int = 0, pagePtH: Int = 0,
                 imageBox: IntArray? = null): ByteArray {
        val shortMm = minOf(wMm, hMm)
        val longMm = maxOf(wMm, hMm)
        // forcePxW / forcePxH: the exact raster size the printer wants (Canon lists a printable area that is not the paper size).
        // pagePtW / pagePtH: the paper in points for the header. imageBox: left, top, right, bottom written as-is (else see cupsExact).
        val wPx = if (forcePxW > 0) forcePxW else Math.round(shortMm / 25.4 * dpi).toInt()
        val hPx = if (forcePxH > 0) forcePxH else Math.round(longMm / 25.4 * dpi).toInt()
        if (wPx <= 0 || hPx <= 0 || wPx.toLong() * hPx > MAX_PIXELS) {
            throw IllegalStateException("This page is too large for the printer's raster mode.")
        }
        var bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: throw IllegalStateException("Couldn't read the picture to print.")
        try {
            if (bmp.width > bmp.height) {
                val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
                if (rotated !== bmp) try { bmp.recycle() } catch (_: Exception) {}
                bmp = rotated
            }
            if (bmp.width != wPx || bmp.height != hPx) {
                val scaled = Bitmap.createScaledBitmap(bmp, wPx, hPx, true)
                if (scaled !== bmp) try { bmp.recycle() } catch (_: Exception) {}
                bmp = scaled
            }

            val bpp = if (gray) 1 else 3
            val out = ByteArrayOutputStream(wPx * hPx / 4 + HEADER)
            out.write("RaS2".toByteArray(Charsets.US_ASCII))

            val h = ByteArray(HEADER)
            "PwgRaster".toByteArray(Charsets.US_ASCII).copyInto(h, 0)
            if (mediaType.isNotEmpty()) h.putStr(128, mediaType)                            // MediaType
            if (pageName.isNotEmpty()) h.putStr(1732, pageName)                             // PageSizeName
            h.put32(276, dpi); h.put32(280, dpi)                                            // HWResolution
            h.put32(340, 1)                                                                 // NumCopies
            h.put32(352, if (pagePtW > 0) pagePtW else Math.round(shortMm / 25.4 * 72).toInt())   // PageSize (points)
            h.put32(356, if (pagePtH > 0) pagePtH else Math.round(longMm / 25.4 * 72).toInt())
            h.put32(372, wPx); h.put32(376, hPx)                                            // Width, Height
            h.put32(384, 8)                                                                 // BitsPerColor
            h.put32(388, 8 * bpp)                                                           // BitsPerPixel
            h.put32(392, wPx * bpp)                                                         // BytesPerLine
            h.put32(396, 0)                                                                 // ColorOrder: chunky
            h.put32(400, if (gray) 18 else 19)                                              // ColorSpace: sGray / sRGB
            h.put32(420, bpp)                                                               // NumColors
            h.put32(452, 1)                                                                 // TotalPageCount
            h.put32(456, 1); h.put32(460, 1)                                                // Cross-feed / feed transform
            if (imageBox != null && imageBox.size >= 4) { for (k in 0 until 4) h.put32(464 + 4 * k, imageBox[k]) }   // ImageBox as given
            else if (!cupsExact) { h.put32(464, 0); h.put32(468, 0); h.put32(472, wPx); h.put32(476, hPx) }   // ImageBox (CUPS leaves it zero)
            h.put32(480, 0x00FFFFFF)                                                        // AlternatePrimary
            out.write(h)

            val px = IntArray(wPx)
            var prev: ByteArray? = null
            var repeats = 0
            for (y in 0 until hPx) {
                bmp.getPixels(px, 0, wPx, 0, y, wPx, 1)
                val row = ByteArray(wPx * bpp)
                for (x in 0 until wPx) {
                    val c = px[x]
                    var r = (c shr 16) and 0xFF
                    var g = (c shr 8) and 0xFF
                    var b = c and 0xFF
                    val a = (c ushr 24) and 0xFF
                    if (a < 255) { r = (r * a + 255 * (255 - a)) / 255; g = (g * a + 255 * (255 - a)) / 255; b = (b * a + 255 * (255 - a)) / 255 }
                    if (gray) row[x] = ((299 * r + 587 * g + 114 * b) / 1000).toByte()
                    else { row[x * 3] = r.toByte(); row[x * 3 + 1] = g.toByte(); row[x * 3 + 2] = b.toByte() }
                }
                val p = prev
                if (p != null && repeats < 255 && row.contentEquals(p)) {
                    repeats++
                } else {
                    if (p != null) writeRow(out, p, repeats, bpp)
                    prev = row
                    repeats = 0
                }
            }
            prev?.let { writeRow(out, it, repeats, bpp) }
            return out.toByteArray()
        } finally {
            try { bmp.recycle() } catch (_: Exception) {}
        }
    }

    private fun writeRow(out: ByteArrayOutputStream, row: ByteArray, repeats: Int, bpp: Int) {
        out.write(repeats)
        val n = row.size / bpp
        fun same(a: Int, b: Int): Boolean {
            for (k in 0 until bpp) if (row[a * bpp + k] != row[b * bpp + k]) return false
            return true
        }
        var i = 0
        while (i < n) {
            var run = 1
            while (i + run < n && run < 128 && same(i, i + run)) run++
            if (run >= 2) {
                out.write(run - 1)
                out.write(row, i * bpp, bpp)
                i += run
            } else {
                var lit = 1
                while (i + lit < n && lit < 128 && !(i + lit + 1 < n && same(i + lit, i + lit + 1))) lit++
                if (lit == 1) {                                   // a single pixel is a repeat of one
                    out.write(0)
                    out.write(row, i * bpp, bpp)
                } else {
                    out.write(257 - lit)
                    out.write(row, i * bpp, lit * bpp)
                }
                i += lit
            }
        }
    }
}
