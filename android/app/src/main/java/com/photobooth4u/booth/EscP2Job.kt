package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
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

    /**
     * Colour head calibration (the debug screen can change it). Offsets are in rows, measured from the yellow nozzles:
     * measured on a real L120 colour-bar print, yellow is the highest group, magenta ~120 rows lower, cyan and black ~240.
     * n = nozzles used per colour pass (59, or 60 to line the passes of every colour up on the same rows);
     * gamma lightens the picture before it is dotted (1.0 = none), because 1-bit dots at 360 dpi spread and print dark.
     */
    class Cal(m: Int = 120, c: Int = 240, k: Int = 240, n: Int = 59, gamma: Double = 1.6) {
        val m = m.coerceIn(0, 400)
        val c = c.coerceIn(0, 400)
        val k = k.coerceIn(0, 400)
        val n = n.coerceIn(30, 60)
        val gamma = gamma.coerceIn(0.8, 3.0)
    }

    private const val MIN_LINES = 60                    // colour channels always send blocks of 60 lines
    // channel id (black 0, magenta 1, cyan 2, yellow 4), offset in rows, lines per block. Order: K, C, M, Y.
    private fun channels(cal: Cal) = arrayOf(
        intArrayOf(0, cal.k, MIN_LINES), intArrayOf(2, cal.c, MIN_LINES), intArrayOf(1, cal.m, MIN_LINES), intArrayOf(4, 0, MIN_LINES))

    /** quality: 0 draft (half the passes), 1 normal (360 dpi), 2 best (720 dpi with smaller dots, when the page is small enough). */
    /** feed: paper feed sequence for the paper type (0 = plain, left unsent; 8 = photo paper; 7 = matte / inkjet paper). */
    fun build(src: Bitmap, widthMm: Double, heightMm: Double, color: Boolean = false, cal: Cal = Cal(), quality: Int = 1, feed: Int = 0, brightness: Int = 0): ByteArray =
        build(src, widthMm, heightMm, color, cal, quality, feed, PrintColorAdj(brightness = brightness))

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, color: Boolean = false, cal: Cal = Cal(), quality: Int = 1, feed: Int = 0, adj: PrintColorAdj): ByteArray =
        if (color) buildColor(src, widthMm, heightMm, cal, quality = quality, feed = feed, adj = adj) else buildMono(src, widthMm, heightMm, cal, quality, feed, adj)
    private const val BEST_MAX_PIXELS = 16_000_000L       // above this the page stays at 360 dpi (memory on the tablet)

    /** kMode: value for the ESC ( K colour-mode command (1 black only, 2 colour), or -1 to leave the command out. */
    private fun header(out: ByteArrayOutputStream, paperW: Int, paperH: Int, kMode: Int, s: Int = 1, feed: Int = 0) {
        out.put(bytes(0x00, 0x00, 0x00, 0x1B, 0x01), ascii("@EJL 1284.4\n@EJL     \n"), bytes(0x1B, 0x40))
        out.put(bytes(0x1B, 0x40))
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))
        out.put(bytes(0x50, 0x4D, 0x02, 0x00, 0x00, 0x00))
        if (feed > 0) out.put(bytes(0x53, 0x4E, 0x03, 0x00, 0x00, 0x00, feed))                         // paper feed sequence (photo 8, matte 7)
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))
        out.put(bytes(0x1B, 0x28, 0x47, 0x01, 0x00, 0x01))
        out.put(bytes(0x1B, 0x28, 0x55, 0x05, 0x00, 10, 10 / s, 10 / s, 0x10, 0x0E))                 // units: 1/360 or 1/720 inch
        if (kMode >= 0) out.put(bytes(0x1B, 0x28, 0x4B, 0x02, 0x00, 0x00, kMode))                      // colour / black only
        out.put(bytes(0x1B, 0x28, 0x69, 0x01, 0x00, 0x00))
        out.put(bytes(0x1B, 0x55, 0x01))
        if (s > 1) out.put(bytes(0x1B, 0x28, 0x65, 0x02, 0x00, 0x00, 0x11))                           // smaller dots at 720 dpi
        out.put(bytes(0x1B, 0x28, 0x44, 0x04, 0x00, 0x40, 0x38, 0x50, 40 / s))
        out.put(bytes(0x1B, 0x28, 0x43, 0x04, 0x00), le32(paperH + EXTRA_BOTTOM))
        out.put(bytes(0x1B, 0x28, 0x53, 0x08, 0x00), le32(paperW), le32(paperH + EXTRA_BOTTOM))
    }

    private fun footer(out: ByteArrayOutputStream) {
        out.put(bytes(0x0C))
        out.put(bytes(0x1B, 0x40))
        out.put(bytes(0x1B, 0x28, 0x52, 0x08, 0x00, 0x00), ascii("REMOTE1"))
        out.put(bytes(0x4C, 0x44, 0x00, 0x00))
        out.put(bytes(0x4A, 0x45, 0x01, 0x00, 0x00))
        out.put(bytes(0x1B, 0x00, 0x00, 0x00))
    }

    /**
     * DIAGNOSTIC for the colour mode. Prints one small solid strip (2 in wide, about 0.3 in tall per pass pair) per channel
     * so a failure points at one cause. step: 1 black, 2 cyan, 3 magenta, 4 yellow, 5 cyan+magenta+yellow,
     * 6 black in 180-line blocks (expected to fail in colour mode).
     * kMode as in header().
     */
    fun diagnostic(step: Int, kMode: Int, widthMm: Double, heightMm: Double, cal: Cal = Cal()): ByteArray {
        val CHANNELS = channels(cal)
        // 7 and 8 run the real full-page colour path on a synthetic bar chart: 7 = about 35 mm tall, 8 = the whole page.
        if (step >= 7) return buildColor(bars(), widthMm, heightMm, cal, if (step == 7) 500 else Int.MAX_VALUE)
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val chans = when (step) { 1, 6 -> intArrayOf(0); 2 -> intArrayOf(1); 3 -> intArrayOf(2); 4 -> intArrayOf(3); else -> intArrayOf(1, 2, 3) }
        val rowBytes = 90                                              // 720 dots = 2 inches
        val out = ByteArrayOutputStream()
        header(out, paperW, paperH, kMode)
        var last = 0
        for (p in 0 until SEP) {                                       // two interleaved passes: 59 nozzles x 2 rows = 118 rows
            out.put(bytes(0x1B, 0x28, 0x76, 0x04, 0x00), le32(p - last))
            last = p
            for (c in chans) {
                val lines = if (step == 6) 180 else CHANNELS[c][2]            // step 6: black in 180-line blocks, the form that failed
                val buf = ByteArray(lines * rowBytes)
                java.util.Arrays.fill(buf, 0, cal.n * rowBytes, 0xFF.toByte())
                out.put(bytes(0x1B, 0x28, 0x24, 0x04, 0x00), le32(SIDE))
                out.put(bytes(0x1B, 0x69, CHANNELS[c][0], 0x00, 0x01), le16(rowBytes), le16(lines), buf)
                out.put(bytes(0x0D))
            }
        }
        footer(out)
        return out.toByteArray()
    }

    /** EXPERIMENTAL colour: four planes (black, cyan, magenta, yellow), each dithered to 1 bit and printed by its own nozzles. */
    private fun buildColor(src: Bitmap, widthMm: Double, heightMm: Double, cal: Cal, limitRows: Int = Int.MAX_VALUE, quality: Int = 1, feed: Int = 0, adj: PrintColorAdj = PrintColorAdj()): ByteArray {
        val CHANNELS = channels(cal)
        val top360 = maxOf(cal.m, cal.c, cal.k)            // blank rows at the top so the lower colours can reach the first rows
        val nz = cal.n
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val area360W = paperW - 2 * SIDE
        val area360H = minOf(paperH - top360 - EXTRA_BOTTOM, limitRows)
        require(area360W > 0 && area360H > 0) { "Sheet too small" }
        val s = if (quality == 2 && area360W.toLong() * area360H * 4 <= BEST_MAX_PIXELS) 2 else 1   // 1 = 360 dpi, 2 = 720 dpi
        val areaW = area360W * s
        val areaH = area360H * s
        val top = top360 * s
        val phases = SEP * s                               // interleaved passes per band
        val cband = nz * phases                            // rows covered by one colour band
        var bmp = src.applyColorAdj(adj)
        if (bmp.width > bmp.height && widthMm <= heightMm) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
        }
        bmp = Bitmap.createScaledBitmap(bmp, areaW, areaH, true)
        val rowBytes = (areaW + 7) / 8
        val planes = cmykPlanes(bmp, areaW, areaH, rowBytes, cal.gamma)    // same order as CHANNELS: K, C, M, Y

        val out = ByteArrayOutputStream()
        header(out, paperW, paperH, 2, s, feed)
        var last = 0
        val use = if (quality == 0) 1 else phases           // draft prints only the first pass of each band
        val jMax = (top + areaH + cband - 1) / cband
        for (j in 0..jMax) {
            for (p in 0 until use) {
                val head = j * cband + p
                val lines = arrayOfNulls<ByteArray>(CHANNELS.size)
                var any = false
                for (c in CHANNELS.indices) {
                    val off = CHANNELS[c][1] * s
                    val n = CHANNELS[c][2]
                    val buf = ByteArray(n * rowBytes)
                    var used = false
                    for (k in 0 until nz) {
                        val row = head + off + phases * k - top
                        if (row < 0 || row >= areaH) continue
                        System.arraycopy(planes[c], row * rowBytes, buf, k * rowBytes, rowBytes)
                    }
                    for (v in buf) if (v.toInt() != 0) { used = true; break }
                    if (used) { lines[c] = buf; any = true }
                }
                if (!any) continue
                out.put(bytes(0x1B, 0x28, 0x76, 0x04, 0x00), le32(head - last))
                last = head
                for (c in CHANNELS.indices) {
                    val buf = lines[c] ?: continue
                    out.put(bytes(0x1B, 0x28, 0x24, 0x04, 0x00), le32(SIDE * s))
                    out.put(bytes(0x1B, 0x69, CHANNELS[c][0], 0x00, 0x01), le16(rowBytes), le16(CHANNELS[c][2]), buf)
                    out.put(bytes(0x0D))
                }
            }
        }
        footer(out)
        return out.toByteArray()
    }

    /** A bar chart for the diagnostics: black, cyan, magenta, yellow, red, green, blue and a grey ramp, left to right. */
    private fun bars(): Bitmap {
        val w = 840
        val h = 1200
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(Color.WHITE)
        val colours = intArrayOf(Color.BLACK, Color.rgb(0, 255, 255), Color.rgb(255, 0, 255), Color.rgb(255, 255, 0),
            Color.RED, Color.GREEN, Color.BLUE)
        val p = Paint()
        val barW = w / 8
        for (i in colours.indices) {
            p.color = colours[i]
            c.drawRect((i * barW).toFloat(), 0f, ((i + 1) * barW).toFloat(), h.toFloat(), p)
        }
        for (y in 0 until h) {                                         // last bar: grey ramp top (white) to bottom (black)
            val g = 255 - 255 * y / (h - 1)
            p.color = Color.rgb(g, g, g)
            c.drawRect((7 * barW).toFloat(), y.toFloat(), w.toFloat(), (y + 1).toFloat(), p)
        }
        return bmp
    }

    /** RGB to black / cyan / magenta / yellow, with the grey part moved to black, each plane dithered to 1 bit. */
    internal fun cmykPlanes(bmp: Bitmap, w: Int, h: Int, rowBytes: Int, gamma: Double): Array<ByteArray> {
        val lut = IntArray(256) { Math.round(255.0 * Math.pow(it / 255.0, gamma)).toInt() }
        val planes = Array(4) { ByteArray(rowBytes * h) }
        val px = IntArray(w)
        val cur = Array(4) { FloatArray(w + 2) }
        val next = Array(4) { FloatArray(w + 2) }
        val ink = FloatArray(4)
        var c0 = cur; var n0 = next
        for (y in 0 until h) {
            bmp.getPixels(px, 0, w, 0, y, w, 1)
            for (pl in 0 until 4) java.util.Arrays.fill(n0[pl], 0f)
            for (x in 0 until w) {
                val c = px[x]
                val cy = 255 - ((c shr 16) and 0xFF)
                val ma = 255 - ((c shr 8) and 0xFF)
                val ye = 255 - (c and 0xFF)
                // Black only where the colour is dark (grey component squared): keeps skin and sky in colour instead of
                // turning every grey part into black ink.
                val grey = minOf(cy, minOf(ma, ye))
                val k = grey * grey / 255
                ink[0] = lut[k].toFloat(); ink[1] = lut[cy - k].toFloat(); ink[2] = lut[ma - k].toFloat(); ink[3] = lut[ye - k].toFloat()
                for (pl in 0 until 4) {
                    val v = ink[pl] + c0[pl][x + 1]
                    val on = v >= 128f
                    val err = v - (if (on) 255f else 0f)
                    if (on) planes[pl][y * rowBytes + (x shr 3)] = (planes[pl][y * rowBytes + (x shr 3)].toInt() or (0x80 shr (x and 7))).toByte()
                    c0[pl][x + 2] += err * 7f / 16f
                    n0[pl][x] += err * 3f / 16f
                    n0[pl][x + 1] += err * 5f / 16f
                    n0[pl][x + 2] += err * 1f / 16f
                }
            }
            val t = c0; c0 = n0; n0 = t
        }
        return planes
    }

    private fun buildMono(src: Bitmap, widthMm: Double, heightMm: Double, cal: Cal, quality: Int, feed: Int = 0, adj: PrintColorAdj = PrintColorAdj()): ByteArray {
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * DPI).toInt()
        val area360W = paperW - 2 * SIDE
        val area360H = paperH - SIDE - EXTRA_BOTTOM
        require(area360W > 0 && area360H > 0) { "Sheet too small" }
        val s = if (quality == 2 && area360W.toLong() * area360H * 4 <= BEST_MAX_PIXELS) 2 else 1   // 1 = 360 dpi, 2 = 720 dpi
        val areaW = area360W * s
        val areaH = area360H * s

        var bmp = src.applyColorAdj(adj)
        if (bmp.width > bmp.height && widthMm <= heightMm) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(90f) }, true)
        }
        bmp = Bitmap.createScaledBitmap(bmp, areaW, areaH, true)
        val rowBytes = (areaW + 7) / 8
        val bits = dither(bmp, areaW, areaH, rowBytes, if (s == 2) cal.gamma else 1.0)

        val out = ByteArrayOutputStream()
        header(out, paperW, paperH, 1, s, feed)

        // each band is printed as interleaved passes (2 at 360 dpi, 4 at 720 dpi); draft prints only the first pass
        val phases = SEP * s
        val band = NOZZLES * phases
        val use = if (quality == 0) 1 else phases
        var last = 0
        val bands = (areaH + band - 1) / band
        val pass = ByteArray(NOZZLES * rowBytes)
        for (b in 0 until bands) {
            for (p in 0 until use) {
                var any = false
                java.util.Arrays.fill(pass, 0)
                for (k in 0 until NOZZLES) {
                    val row = b * band + p + phases * k
                    if (row >= areaH) break
                    System.arraycopy(bits, row * rowBytes, pass, k * rowBytes, rowBytes)
                }
                for (v in pass) if (v.toInt() != 0) { any = true; break }
                if (!any) continue
                val start = b * band + p
                out.put(bytes(0x1B, 0x28, 0x76, 0x04, 0x00), le32(start - last))                       // paper advance
                last = start
                out.put(bytes(0x1B, 0x28, 0x24, 0x04, 0x00), le32(SIDE * s))                            // left position
                out.put(bytes(0x1B, 0x69, 0x00, 0x00, 0x01), le16(rowBytes), le16(NOZZLES), pass)       // black, raw, 1 bit
                out.put(bytes(0x0D))
            }
        }
        footer(out)
        return out.toByteArray()
    }

    /** Floyd-Steinberg to 1 bit, packed MSB first, 1 = ink. */
    internal fun dither(bmp: Bitmap, w: Int, h: Int, rowBytes: Int, gamma: Double = 1.0): ByteArray {
        val lut = IntArray(256) { Math.round(255.0 * Math.pow(it / 255.0, gamma)).toInt() }
        val out = ByteArray(rowBytes * h)
        val px = IntArray(w)
        var cur = FloatArray(w + 2)
        var next = FloatArray(w + 2)
        for (y in 0 until h) {
            bmp.getPixels(px, 0, w, 0, y, w, 1)
            java.util.Arrays.fill(next, 0f)
            for (x in 0 until w) {
                val c = px[x]
                val l0 = 0.299f * ((c shr 16) and 0xFF) + 0.587f * ((c shr 8) and 0xFF) + 0.114f * (c and 0xFF)
                val lum = (if (gamma == 1.0) l0 else 255f - lut[(255f - l0).toInt().coerceIn(0, 255)]) + cur[x + 1]
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
