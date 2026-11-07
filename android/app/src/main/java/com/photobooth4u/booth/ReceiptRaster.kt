package com.photobooth4u.booth

import android.graphics.Bitmap
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Builds ESC/POS raster print data (GS v 0) for USB and network receipt printers.
 *
 * Called with no options it makes exactly the bytes it always did (hard black/white cut-off, one raster command for
 * the whole picture). A caller can ask for the same things the in-page Bluetooth encoder (booth.html) offers:
 * dithering, shorter bands that end on blank rows, a brightness shift and the printer's slow-print command.
 */
object ReceiptRaster {

    enum class Dither { THRESHOLD, FLOYD_STEINBERG, ATKINSON, ORDERED }

    class Options(
        val dither: Dither = Dither.THRESHOLD,
        /** Cut-off (0..255) for THRESHOLD. A pixel darker than this prints. */
        val threshold: Int = 160,
        /** Rows per GS v 0 command; 0 sends the whole picture in one command (the original behaviour). */
        val bandRows: Int = 0,
        /** -100 (darker) .. +100 (lighter), the same scale as the in-page encoder. */
        val brightness: Int = 0,
        /** Sharpen a little and lift the mid-tones first (thermal dots print bigger than they are). */
        val sharpen: Boolean = false,
        /** GS ( K: print at the printer's slowest speed so the paper never outruns the data. */
        val slowPrint: Boolean = false,
    ) {
        companion object {
            val LEGACY = Options()

            /**
             * Reads the optional "receipt" object of a print request:
             * { "quality": "best" | "normal" | "draft", "band": 256, "brightness": 0, "slow": false }.
             * Missing or unknown fields keep the original behaviour.
             */
            fun fromJson(o: JSONObject?): Options {
                if (o == null) return LEGACY
                val band = o.optInt("band", 0)
                val bright = o.optInt("brightness", 0).coerceIn(-100, 100)
                val slow = o.optBoolean("slow", false)
                return when (o.optString("quality", "")) {
                    "best" -> Options(Dither.ATKINSON, 160, band, bright, sharpen = true, slowPrint = slow)
                    "normal" -> Options(Dither.FLOYD_STEINBERG, 160, band, bright, slowPrint = slow)
                    "draft" -> Options(Dither.ORDERED, 160, band, bright, slowPrint = slow)
                    else -> Options(Dither.THRESHOLD, 160, band, bright, slowPrint = slow)
                }
            }
        }
    }

    // Epson caps one raster command at 2303 rows; the in-page encoder never goes above 2000.
    private const val MAX_BAND_ROWS = 2000

    /**
     * Converts a bitmap into an ESC/POS raster image (GS v 0 mode).
     * rollWidthPx is typically 384 for 58mm paper or 576 for 80mm paper.
     */
    fun build(src: Bitmap, rollWidthPx: Int = 576, opt: Options = Options.LEGACY): ByteArray {
        val targetW = rollWidthPx
        val targetH = ((src.height.toLong() * targetW) / src.width).toInt()
        val scaled = Bitmap.createScaledBitmap(src, targetW, targetH, true)
        val wBytes = (targetW + 7) / 8

        val black = mono(scaled, targetW, targetH, opt)

        val out = ByteArrayOutputStream()
        // Initialize printer: ESC @
        out.write(byteArrayOf(0x1B, 0x40))
        // Slowest print speed: GS ( K 2 0 50 1
        if (opt.slowPrint) out.write(byteArrayOf(0x1D, 0x28, 0x4B, 0x02, 0x00, 0x32, 0x01))

        // One band for the whole picture (original behaviour), or shorter bands that end on blank rows: the printer
        // stops for a moment between bands, and that stop then falls on white paper instead of across a photo.
        val maxBand = if (opt.bandRows > 0) opt.bandRows.coerceIn(1, MAX_BAND_ROWS) else targetH
        val blank = if (opt.bandRows > 0) blankRows(black, targetW, targetH) else null

        var startY = 0
        while (startY < targetH) {
            var bandH = min(maxBand, targetH - startY)
            if (blank != null && startY + bandH < targetH) {
                var e = startY + bandH
                while (e > startY + max(8, bandH shr 2)) {
                    if (blank[e - 1] && blank[e]) { bandH = e - startY; break }
                    e--
                }
            }

            // GS v 0 m xL xH yL yH d1...dk
            out.write(byteArrayOf(0x1D, 0x76, 0x30, 0x00))
            out.write(byteArrayOf((wBytes and 0xFF).toByte(), ((wBytes shr 8) and 0xFF).toByte()))
            out.write(byteArrayOf((bandH and 0xFF).toByte(), ((bandH shr 8) and 0xFF).toByte()))

            val rows = ByteArray(bandH * wBytes)
            var o = 0
            for (y in startY until startY + bandH) {
                val rowBase = y * targetW
                for (xByte in 0 until wBytes) {
                    var b = 0
                    for (bit in 0 until 8) {
                        val px = xByte * 8 + bit
                        if (px < targetW && black[rowBase + px]) b = b or (0x80 shr bit)
                    }
                    rows[o++] = b.toByte()
                }
            }
            out.write(rows)
            startY += bandH
        }

        if (scaled !== src) {
            try { scaled.recycle() } catch (_: Exception) {}
        }

        // Feed 4 lines and cut: ESC d 4, GS V 66 0
        out.write(byteArrayOf(0x1B, 0x64, 0x04))
        out.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00))
        return out.toByteArray()
    }

    /** True for every dot that should print. */
    private fun mono(bmp: Bitmap, w: Int, h: Int, opt: Options): BooleanArray {
        val px = IntArray(w * h)
        bmp.getPixels(px, 0, w, 0, 0, w, h)
        val n = w * h
        val lum = FloatArray(n)
        for (i in 0 until n) {
            val p = px[i]
            lum[i] = (((p shr 16) and 0xFF) * 299 + ((p shr 8) and 0xFF) * 587 + (p and 0xFF) * 114) / 1000f
        }

        if (opt.sharpen) sharpenAndLift(lum, w, h)
        val offset = opt.brightness * 1.28f
        val black = BooleanArray(n)

        when (opt.dither) {
            Dither.THRESHOLD -> {
                for (i in 0 until n) black[i] = lum[i] + offset < opt.threshold
            }
            Dither.ORDERED -> {
                // 2x2 blocks with a 4x4 ordered pattern: half the detail, but quick and gentle on the print head.
                val bayer = intArrayOf(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5)
                for (y in 0 until h) for (x in 0 until w) {
                    val t = (bayer[((y shr 1) and 3) * 4 + ((x shr 1) and 3)] + 0.5f) / 16f * 255f
                    black[y * w + x] = lum[y * w + x] + offset < t
                }
            }
            Dither.FLOYD_STEINBERG, Dither.ATKINSON -> {
                val atk = opt.dither == Dither.ATKINSON
                for (y in 0 until h) for (x in 0 until w) {
                    val i = y * w + x
                    val l = lum[i] + offset
                    val v = if (l < 128f) 0f else 255f
                    black[i] = v == 0f
                    val e = l - v
                    if (atk) {
                        // Atkinson passes on 6/8 of the error to six neighbours: highlights and shadows stay clean.
                        val e8 = e / 8f
                        if (x + 1 < w) lum[i + 1] += e8
                        if (x + 2 < w) lum[i + 2] += e8
                        if (y + 1 < h) {
                            if (x > 0) lum[i + w - 1] += e8
                            lum[i + w] += e8
                            if (x + 1 < w) lum[i + w + 1] += e8
                        }
                        if (y + 2 < h) lum[i + 2 * w] += e8
                    } else {
                        if (x + 1 < w) lum[i + 1] += e * 7f / 16f
                        if (y + 1 < h) {
                            if (x > 0) lum[i + w - 1] += e * 3f / 16f
                            lum[i + w] += e * 5f / 16f
                            if (x + 1 < w) lum[i + w + 1] += e * 1f / 16f
                        }
                    }
                }
            }
        }
        return black
    }

    /** A light sharpen so faces and text stay crisp, then a gentle lift of the mid-tones. */
    private fun sharpenAndLift(lum: FloatArray, w: Int, h: Int) {
        val blur = FloatArray(lum.size)
        for (y in 0 until h) for (x in 0 until w) {
            var sum = 0f
            var cnt = 0
            for (yy in max(0, y - 1)..min(h - 1, y + 1)) for (xx in max(0, x - 1)..min(w - 1, x + 1)) {
                sum += lum[yy * w + xx]
                cnt++
            }
            blur[y * w + x] = sum / cnt
        }
        for (i in lum.indices) {
            val sh = (lum[i] + 0.7f * (lum[i] - blur[i])).coerceIn(0f, 255f)
            lum[i] = 255f * (sh / 255f).pow(0.8f)
        }
    }

    /** Rows with no dot to print. */
    private fun blankRows(black: BooleanArray, w: Int, h: Int): BooleanArray {
        val blank = BooleanArray(h)
        for (y in 0 until h) {
            var white = true
            val base = y * w
            for (x in 0 until w) if (black[base + x]) { white = false; break }
            blank[y] = white
        }
        return blank
    }
}
