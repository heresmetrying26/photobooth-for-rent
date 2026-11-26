package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import java.util.Calendar
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Streaming ESC/P-Raster (ESC ( U + ESC i) job generator hardcoded for the Epson L3210
 * (USB VID 0x04B8, PID 0xE671) from the official Windows "EPSON L3210 Series" driver
 * (e_wf1yxe.inf v3.80.05.00).
 *
 * Key design choices to eliminate lag, OOMs, and rainbow bands:
 * - Renders source photos in 64-row Skia strips (~0.8-1.5 MB) with hardware bilinear scaling,
 *   auto 90-deg landscape rotation, and PrintColorAdj filtering.
 * - Uses calibrated 9x9x9 (729-entry, 2,916-byte) 3D RGB->CMYK LUTs extracted directly from
 *   the installed EPSON L3210 Windows driver for both 720x720 and 1440x720 photo printing.
 * - Error-diffuses 2-bit variable drops {0,1,2,3} into a 1024-row packed ring buffer
 *   (4 channels x 2 bits = 1 byte/px, ~3-6 MB RAM) and streams PackBits bands directly into a
 *   16 KB USB write buffer — zero full-page raster arrays and zero multi-chunk USB restarts.
 * - Enforces exact physical L3210 head alignments (C=0, M=-60 nozzles, Y=-120 nozzles, and
 *   K=+2 dots sub-nozzle stagger at 720 dpi) plus verified hybrid borderless/bordered interlace
 *   schedules with 0 missing nozzle slots across all supported paper sizes.
 */
object EpsonL3210RasterJob {

    const val MEDIA_PLAIN = 0x00
    const val MEDIA_MATTE = 0x05
    const val MEDIA_ULTRA_GLOSSY = 0x0b
    const val MEDIA_SEMI_GLOSS = 0x0c
    const val MEDIA_GLOSSY = 0x34

    data class PaperSpec(
        val sw: Int,
        val sh: Int,
        val code: Int,
        val borderlessSupported: Boolean
    )

    data class Config(
        val dpiH: Int = 720,              // 720 (720x720 photo) or 1440 (1440x720 best)
        val mediaCode: Int = MEDIA_GLOSSY,
        val borderless: Boolean = true,
        val mono: Boolean = false,
        val adj: PrintColorAdj = PrintColorAdj()
    )

    private const val NOZZLES = 59
    private const val PITCH = 4           // 720 / 180 = 4 vertical grid rows per nozzle
    private const val RING_ROWS = 1024    // > max span (712 rows from C top to Y bottom)
    private const val STRIP_H = 64
    private const val CHUNK_CAP = 16384

    // Nominal 2-bit variable-drop weights matching tot / (3 * cnt) * 255 extraction
    private val DROP_LEVELS = intArrayOf(0, 85, 170, 255)

    // Mild zero-mean 4x4 Bayer threshold jitter [-14..+14] to eliminate halftone worming/contouring
    private val BAYER = arrayOf(
        intArrayOf(-14, 8, -8, 12),
        intArrayOf(10, -4, 14, -2),
        intArrayOf(-6, 12, -12, 6),
        intArrayOf(4, -10, 2, -14)
    )

    // Calibrated 9x9x9x4 (2,916-byte) 3D CMYK LUTs captured from "EPSON L3210 Series" (e_wf1yxe.inf v3.80.05.00)
    private const val LUT720_B64 =
        "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ICGGACEjfAAhJWUAIiVKACMmMQAkKB0AJiUNACkfAQAqHwAAIAibACALjAAgD3AAIBFUACAROQAgEiUAIRISACMRBgAjEQAAIAB/ACAAfAAfAHIAHwFdAB8BQQAeAioAHgMZAB4ECgAfAwAAIgBkACIAYgAhAF4AIQBNACAAPAAdACsAGwAcABkAEQAZAAkAF4qMABaVggARuU0AEL4XABG3AAAYlQAAH38AACdrAAAsXgAAF4SSABaLhAAWlkwAFZcpABWTEQAahQgAHnsAACZoAAArWwAAFnh7ABd4agAXeE4AGXU0ABp1IAAadA8AGnEBACNgAAAoUQAAE2J8ABVjawAXYU8AGGA4ABlgJAAaYBIAGmAEACBRAAAlQwAAFEV9ABVGbwAWRVcAFkU+ABdEKgAYRBYAGUUHAB09AAAhNAAAFSmCABUreAAVLWEAFixFABYsMAAXLRwAGCwMABooAAAdIwAAFBWDABQVegAUGGcAFBdPABUXNwAWFyMAFhcSABgVBAAaEwAAFAKOABQEhQAUBHcAEwZfABQGQQATBisAEwYXABQHCQAUBwAAFwBrABcAaQAXAGEAFwBTABUAPgAUACoAEgAaABAADQAQAAUADZiAAAuidwAJvEIACL4WAAe6AQANlwAAEoIAABp0AAAgZQAADJGHAAubeQALnEQACqAjAAqWEQANhwgAEH4AABhxAAAgYwAACoB+AAqBZgAMfEgADHsyAA14IAAOdxAADnUBABZqAAAdXAAACWh5AAppaAALZk0ADGU3AAxjJQANZBUADmMHABFeAAAaTAAACU57AAlPbAALTVEAC0w7AAtKKQANShgADUsKAA9HAAAWOwAACTJ/AAozdQAKNVsACzJAAAsyLwAMMR0ADDEMAA0wAQATKQAAChyBAAodeAAKH2MACh5JAAocNQALGyMACxwRAAwcAwAQGQAACQuAAAkNegAJDmkACQ1TAAkMPAAKCikACgoWAAoKCAAMCgAACwBvAAsAbQAKAGYACQBVAAoAPwAKACsACgAYAAkACwAIAAMABqF4AASrawACvTwAAb0YAAG6AwAEnQAACYYAAA92AAAVbQAABZx9AAOibgADrEAAA6ghAAOlDQAFiwcACIMAAA5zAAAVbAAABIWRAAOKcwAEhUYABIAxAAR+HgAFeBAABnkBAAxsAAARZQAAAm57AAJuagADbk0AA2g3AARoJAAEZhUABWYIAAhhAAAOWAAAAVV4AAFVawACVVIAA1E6AANRKAADTxkAA08LAAVNAQALQwAAATp1AAE8awACO1gAAjk9AAI3LAACNhwAAjYOAAM2AQAILgAAASN+AAEkdgABJWEAAiREAAIiMQACIiAAAiARAAIhBAAHHAAAAg+HAAIQeAACE2IAAhJKAAIRNQADDyUAAw4VAAMOCAAECwAAAACBAAABegAABV4AAAVNAAAEOgAAAioAAQAZAAEACwAAAAAA"

    private const val LUT1440_B64 =
        "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"

    private val lut720: ByteArray by lazy { decodeB64(LUT720_B64) }
    private val lut1440: ByteArray by lazy { decodeB64(LUT1440_B64) }

    fun matchPaper(widthMm: Double, heightMm: Double): PaperSpec {
        val s = minOf(widthMm, heightMm)
        val l = maxOf(widthMm, heightMm)
        return when {
            abs(s - 101.6) <= 3.5 && abs(l - 152.4) <= 4.0 -> PaperSpec(2880, 4320, 0x0a, true)   // 4x6 / 10x15
            abs(s - 88.9) <= 2.5 && abs(l - 127.0) <= 3.0 -> PaperSpec(2522, 3600, 0x0f, true)    // 3.5x5 / 9x13
            abs(s - 100.0) <= 2.0 && abs(l - 148.0) <= 2.0 -> PaperSpec(2834, 4196, 0x10, true)   // 100x148mm
            abs(s - 101.6) <= 3.0 && abs(l - 180.6) <= 3.5 -> PaperSpec(2880, 5120, 0x2b, true)   // 16:9 wide 4x7.11
            abs(s - 127.0) <= 3.0 && abs(l - 177.8) <= 3.0 -> PaperSpec(3600, 5044, 0x1c, false)  // 5x7
            abs(s - 210.0) <= 4.0 && abs(l - 297.0) <= 4.0 -> PaperSpec(5952, 8418, 0x00, false)  // A4
            else -> PaperSpec(
                (s / 25.4 * 720.0).roundToInt().coerceAtLeast(360),
                (l / 25.4 * 720.0).roundToInt().coerceAtLeast(360),
                0x00,
                false
            )
        }
    }

    fun isBorderlessSize(widthMm: Double, heightMm: Double): Boolean =
        matchPaper(widthMm, heightMm).borderlessSupported

    fun mediaCodeFor(media: String, photoDefault: Boolean = true): Int =
        when (media.lowercase()) {
            "photopg", "ultraglossy" -> MEDIA_ULTRA_GLOSSY
            "photosg", "semigloss" -> MEDIA_SEMI_GLOSS
            "matte" -> MEDIA_MATTE
            "plain" -> MEDIA_PLAIN
            "photo" -> MEDIA_GLOSSY
            else -> if (photoDefault) MEDIA_GLOSSY else MEDIA_PLAIN
        }

    /**
     * Streams an Android [Bitmap] to [writeChunk] as a complete Epson L3210 ESC/P-Raster job
     * using bounded strip RAM (~0.8-1.5 MB strip + ~3-6 MB ring buffer).
     */
    fun stream(
        src: Bitmap,
        widthMm: Double,
        heightMm: Double,
        cfg: Config,
        writeChunk: (ByteArray, Int) -> Unit
    ): Long {
        val paper = matchPaper(widthMm, heightMm)
        val isBl = cfg.borderless && paper.borderlessSupported
        val use1440 = cfg.dpiH >= 1440
        val hx = if (use1440) 2 else 1
        val aw = ((if (isBl) paper.sw + 144 else paper.sw - 168)) * hx
        val ah = if (isBl) paper.sh + 170 else paper.sh - 168

        val needRotate = (src.width > src.height) != (aw > ah)
        if (!needRotate && src.width == aw && src.height == ah && cfg.adj.isNoop) {
            return streamRaster(aw, ah, { y, dstRow ->
                src.getPixels(dstRow, 0, aw, 0, y, aw, 1)
            }, paper, isBl, cfg, writeChunk)
        }

        val rotW = if (needRotate) src.height.toFloat() else src.width.toFloat()
        val rotH = if (needRotate) src.width.toFloat() else src.height.toFloat()

        // Cover-fill for borderless bleed; contain inside 3 mm margins for bordered frames so edges aren't cropped
        val scale = if (isBl) max(aw.toFloat() / rotW, ah.toFloat() / rotH) else min(aw.toFloat() / rotW, ah.toFloat() / rotH)
        val drawW = rotW * scale
        val drawH = rotH * scale
        val dx = (aw - drawW) * 0.5f
        val dy = (ah - drawH) * 0.5f

        val stripBmp = Bitmap.createBitmap(aw, STRIP_H, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(stripBmp)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = if (cfg.adj.isNoop) null else cfg.adj.toColorFilter()
        }
        val m = Matrix()
        var cachedStripStart = -1
        val stripRow = IntArray(aw)

        try {
            return streamRaster(aw, ah, { y, dstRow ->
                val sStart = (y / STRIP_H) * STRIP_H
                if (sStart != cachedStripStart) {
                    cachedStripStart = sStart
                    stripBmp.eraseColor(-1) // crisp white background
                    m.reset()
                    if (needRotate) {
                        m.postRotate(90f)
                        m.postTranslate(src.height.toFloat(), 0f)
                    }
                    m.postScale(scale, scale)
                    m.postTranslate(dx, dy - sStart.toFloat())
                    canvas.drawBitmap(src, m, paint)
                }
                stripBmp.getPixels(stripRow, 0, aw, 0, y - sStart, aw, 1)
                System.arraycopy(stripRow, 0, dstRow, 0, aw)
            }, paper, isBl, cfg, writeChunk)
        } finally {
            try { stripBmp.recycle() } catch (_: Exception) {}
        }
    }

    /**
     * Pure-JVM testable core encoder taking an arbitrary ARGB row provider [getRowArgb].
     * Emits the exact EPSON L3210 ESC/P-Raster protocol verified against e_wf1yxe.inf v3.80.05.00.
     */
    internal fun streamRaster(
        aw: Int,
        ah: Int,
        getRowArgb: (y: Int, dst: IntArray) -> Unit,
        paper: PaperSpec,
        isBl: Boolean,
        cfg: Config,
        writeChunk: (ByteArray, Int) -> Unit
    ): Long {
        val use1440 = cfg.dpiH >= 1440
        val hx = if (use1440) 2 else 1
        val xstep = 2 * hx
        val align = 4 * xstep
        val cols = ((aw + align - 1) / align) * align
        val wb = cols / align
        val top = if (isBl) 166 else 320
        val lut = if (use1440) lut1440 else lut720

        val w = ChunkWriter(writeChunk)
        writeHeader(w, paper.sw, paper.sh, paper.code, cfg.mediaCode, isBl, use1440, cfg.mono)

        // Packed 4-channel 2-bit dot ring buffer: (C<<6) | (M<<4) | (Y<<2) | K
        val ring = Array(RING_ROWS) { ByteArray(cols) }
        val printed = Array(RING_ROWS) { ByteArray(4) } // per ch: bitmask of covered x-offsets
        var generatedUpTo = -1

        var errCurC = IntArray(cols + 2)
        var errCurM = IntArray(cols + 2)
        var errCurY = IntArray(cols + 2)
        var errCurK = IntArray(cols + 2)
        var errNxtC = IntArray(cols + 2)
        var errNxtM = IntArray(cols + 2)
        var errNxtY = IntArray(cols + 2)
        var errNxtK = IntArray(cols + 2)
        val argbRow = IntArray(aw)

        fun ensureRow(targetY: Int) {
            val clamped = min(ah - 1, targetY)
            while (generatedUpTo < clamped) {
                val y = generatedUpTo + 1
                val ridx = y % RING_ROWS
                val dst = ring[ridx]
                java.util.Arrays.fill(dst, 0.toByte())
                java.util.Arrays.fill(printed[ridx], 0.toByte())

                java.util.Arrays.fill(errNxtC, 0)
                java.util.Arrays.fill(errNxtM, 0)
                java.util.Arrays.fill(errNxtY, 0)
                java.util.Arrays.fill(errNxtK, 0)

                getRowArgb(y, argbRow)
                val by = BAYER[y and 3]
                val ltr = (y and 1) == 0
                var x = if (ltr) 0 else aw - 1
                val endX = if (ltr) aw else -1
                val step = if (ltr) 1 else -1

                while (x != endX) {
                    val px = argbRow[x]
                    var r = (px ushr 16) and 0xFF
                    var g = (px ushr 8) and 0xFF
                    var b = px and 0xFF
                    if (cfg.mono) {
                        val lum = (77 * r + 150 * g + 29 * b) ushr 8
                        r = lum; g = lum; b = lum
                    }

                    // Trilinear 9x9x9 lookup (step=32 except top cell 224..255 width=31)
                    val ri = if (r >= 224) 7 else r ushr 5
                    val gi = if (g >= 224) 7 else g ushr 5
                    val bi = if (b >= 224) 7 else b ushr 5
                    val rf = if (ri == 7) ((r - 224) shl 8) / 31 else (r and 31) shl 3
                    val gf = if (gi == 7) ((g - 224) shl 8) / 31 else (g and 31) shl 3
                    val bf = if (bi == 7) ((b - 224) shl 8) / 31 else (b and 31) shl 3
                    val irf = 256 - rf
                    val igf = 256 - gf
                    val ibf = 256 - bf

                    val w000 = ((irf * igf) ushr 8) * ibf ushr 8
                    val w001 = ((irf * igf) ushr 8) * bf ushr 8
                    val w010 = ((irf * gf) ushr 8) * ibf ushr 8
                    val w011 = ((irf * gf) ushr 8) * bf ushr 8
                    val w100 = ((rf * igf) ushr 8) * ibf ushr 8
                    val w101 = ((rf * igf) ushr 8) * bf ushr 8
                    val w110 = ((rf * gf) ushr 8) * ibf ushr 8
                    val w111 = ((rf * gf) ushr 8) * bf ushr 8

                    val i000 = (ri * 81 + gi * 9 + bi) shl 2
                    val i001 = i000 + 4
                    val i010 = i000 + 36
                    val i011 = i000 + 40
                    val i100 = i000 + 324
                    val i101 = i100 + 4
                    val i110 = i100 + 36
                    val i111 = i100 + 40

                    val tC = ((lut[i000].toInt() and 0xFF) * w000 + (lut[i001].toInt() and 0xFF) * w001 +
                              (lut[i010].toInt() and 0xFF) * w010 + (lut[i011].toInt() and 0xFF) * w011 +
                              (lut[i100].toInt() and 0xFF) * w100 + (lut[i101].toInt() and 0xFF) * w101 +
                              (lut[i110].toInt() and 0xFF) * w110 + (lut[i111].toInt() and 0xFF) * w111) ushr 8
                    val tM = ((lut[i000 + 1].toInt() and 0xFF) * w000 + (lut[i001 + 1].toInt() and 0xFF) * w001 +
                              (lut[i010 + 1].toInt() and 0xFF) * w010 + (lut[i011 + 1].toInt() and 0xFF) * w011 +
                              (lut[i100 + 1].toInt() and 0xFF) * w100 + (lut[i101 + 1].toInt() and 0xFF) * w101 +
                              (lut[i110 + 1].toInt() and 0xFF) * w110 + (lut[i111 + 1].toInt() and 0xFF) * w111) ushr 8
                    val tY = ((lut[i000 + 2].toInt() and 0xFF) * w000 + (lut[i001 + 2].toInt() and 0xFF) * w001 +
                              (lut[i010 + 2].toInt() and 0xFF) * w010 + (lut[i011 + 2].toInt() and 0xFF) * w011 +
                              (lut[i100 + 2].toInt() and 0xFF) * w100 + (lut[i101 + 2].toInt() and 0xFF) * w101 +
                              (lut[i110 + 2].toInt() and 0xFF) * w110 + (lut[i111 + 2].toInt() and 0xFF) * w111) ushr 8
                    val tK = ((lut[i000 + 3].toInt() and 0xFF) * w000 + (lut[i001 + 3].toInt() and 0xFF) * w001 +
                              (lut[i010 + 3].toInt() and 0xFF) * w010 + (lut[i011 + 3].toInt() and 0xFF) * w011 +
                              (lut[i100 + 3].toInt() and 0xFF) * w100 + (lut[i101 + 3].toInt() and 0xFF) * w101 +
                              (lut[i110 + 3].toInt() and 0xFF) * w110 + (lut[i111 + 3].toInt() and 0xFF) * w111) ushr 8

                    val bx = by[x and 3]
                    val xi = x + 1

                    val qC = quantizeAndDiffuse(tC, bx, errCurC, errNxtC, xi, ltr)
                    val qM = quantizeAndDiffuse(tM, bx, errCurM, errNxtM, xi, ltr)
                    val qY = quantizeAndDiffuse(tY, bx, errCurY, errNxtY, xi, ltr)
                    val qK = quantizeAndDiffuse(tK, bx, errCurK, errNxtK, xi, ltr)

                    dst[x] = ((qC shl 6) or (qM shl 4) or (qY shl 2) or qK).toByte()
                    x += step
                }

                var tmp = errCurC; errCurC = errNxtC; errNxtC = tmp
                tmp = errCurM; errCurM = errNxtM; errNxtM = tmp
                tmp = errCurY; errCurY = errNxtY; errNxtY = tmp
                tmp = errCurK; errCurK = errNxtK; errNxtK = tmp
                generatedUpTo = y
            }
        }

        // Physical nozzle layout verified on EPSON L3210: (escColor, packShift, dyNozzles, kSubDot)
        val chEsc = intArrayOf(2, 1, 4, 0)
        val chShift = intArrayOf(6, 4, 2, 0)
        val chDy = intArrayOf(0, -60, -120, 0)
        val chKSub = intArrayOf(0, 0, 0, 2)

        val bandRaw = ByteArray(wb * NOZZLES)
        val packBuf = ByteArray(wb + (wb + 127) / 128 + 4)
        val classCount = IntArray(4)

        var yPos = if (isBl) {
            if (use1440) 51 else 55
        } else {
            if (use1440) 100 else 112
        }
        val yEnd = top + ah + 480 + 240
        var pendingAdv = yPos
        var pIdx = 0

        while (yPos <= yEnd) {
            val cls = yPos and 3
            val xo = classCount[cls] % xstep
            classCount[cls]++

            val maxTouch = yPos + PITCH * (NOZZLES - 1) - top
            if (maxTouch >= 0 && generatedUpTo < ah - 1) {
                ensureRow(maxTouch)
            }

            for (ch in 0 until 4) {
                val shift = chShift[ch]
                val dyNoz = chDy[ch]
                val kSub = chKSub[ch]
                var anyNz = false

                for (n in 0 until NOZZLES) {
                    val yrow = yPos + PITCH * (n + dyNoz) - kSub - top
                    val outOff = n * wb
                    if (yrow in 0 until ah) {
                        val ridx = yrow % RING_ROWS
                        val mask = printed[ridx][ch].toInt() and 0xFF
                        if (((mask ushr xo) and 1) == 0) {
                            printed[ridx][ch] = (mask or (1 shl xo)).toByte()
                            val r = ring[ridx]
                            var xPix = xo
                            for (bi in 0 until wb) {
                                val d0 = (r[xPix].toInt() ushr shift) and 3; xPix += xstep
                                val d1 = (r[xPix].toInt() ushr shift) and 3; xPix += xstep
                                val d2 = (r[xPix].toInt() ushr shift) and 3; xPix += xstep
                                val d3 = (r[xPix].toInt() ushr shift) and 3; xPix += xstep
                                val bv = ((d0 shl 6) or (d1 shl 4) or (d2 shl 2) or d3).toByte()
                                bandRaw[outOff + bi] = bv
                                if (bv.toInt() != 0) anyNz = true
                            }
                            continue
                        }
                    }
                    java.util.Arrays.fill(bandRaw, outOff, outOff + wb, 0.toByte())
                }

                if (anyNz) {
                    while (pendingAdv > 0) {
                        val stepAdv = min(pendingAdv, 4096)
                        writeVertFeed(w, stepAdv)
                        pendingAdv -= stepAdv
                    }
                    if (xo != 0) writeHorizPos(w, xo)
                    // Emit ESC i color comp=1 bpp=2 wb N + PackBits rows + CR
                    w.byte(0x1b); w.byte(0x69)
                    w.byte(chEsc[ch]); w.byte(1); w.byte(2)
                    w.le16(wb); w.le16(NOZZLES)
                    for (n in 0 until NOZZLES) {
                        val packedLen = packBitsRow(bandRaw, n * wb, wb, packBuf)
                        w.bytes(packBuf, 0, packedLen)
                    }
                    w.byte(0x0d)
                }
            }

            // Hybrid borderless advance transitions verified for 0 missing slots across all borderless papers
            val adv = if (isBl) {
                val slowEdge = (yPos < if (use1440) 741 else 737) ||
                               (yPos >= paper.sh - if (use1440) 83 else 90)
                if (use1440) {
                    if (slowEdge) (if ((pIdx and 1) == 0) 9 else 6)
                    else (if ((pIdx and 1) == 0) 13 else 14)
                } else {
                    if (slowEdge) (if ((pIdx and 1) == 0) 17 else 14)
                    else (if ((pIdx and 1) == 0) 26 else 25)
                }
            } else {
                if (use1440) (if ((pIdx and 1) == 0) 14 else 13)
                else (if ((pIdx and 1) == 0) 26 else 25)
            }
            pIdx++
            yPos += adv
            pendingAdv += adv
        }

        writeTrailer(w)
        w.flush()
        return w.totalBytes
    }

    private fun quantizeAndDiffuse(
        target: Int,
        jitter: Int,
        errCur: IntArray,
        errNxt: IntArray,
        xi: Int,
        ltr: Boolean
    ): Int {
        var v = target + (errCur[xi] shr 4)
        if (v < 0) v = 0 else if (v > 255) v = 255
        val vt = v + jitter
        val q = when {
            vt < 43 -> 0
            vt < 128 -> 1
            vt < 213 -> 2
            else -> 3
        }
        val err = v - DROP_LEVELS[q]
        if (err != 0) {
            if (ltr) {
                errCur[xi + 1] += err * 7
                errNxt[xi - 1] += err * 3
                errNxt[xi]     += err * 5
                errNxt[xi + 1] += err
            } else {
                errCur[xi - 1] += err * 7
                errNxt[xi + 1] += err * 3
                errNxt[xi]     += err * 5
                errNxt[xi - 1] += err
            }
        }
        return q
    }

    private fun packBitsRow(src: ByteArray, offset: Int, len: Int, dst: ByteArray): Int {
        var i = 0
        var out = 0
        while (i < len) {
            val b = src[offset + i]
            if (i + 2 < len && b == src[offset + i + 1] && b == src[offset + i + 2]) {
                var run = 3
                while (i + run < len && src[offset + i + run] == b && run < 128) run++
                dst[out++] = (257 - run).toByte()
                dst[out++] = b
                i += run
            } else {
                val start = i
                i++
                while (i < len && i - start < 128) {
                    if (i + 2 < len && src[offset + i] == src[offset + i + 1] && src[offset + i] == src[offset + i + 2]) {
                        break
                    }
                    i++
                }
                val count = i - start
                dst[out++] = (count - 1).toByte()
                System.arraycopy(src, offset + start, dst, out, count)
                out += count
            }
        }
        return out
    }

    private fun writeHeader(
        w: ChunkWriter,
        sw: Int,
        sh: Int,
        paperCode: Int,
        mediaCode: Int,
        borderless: Boolean,
        use1440: Boolean,
        mono: Boolean
    ) {
        val now = try { Calendar.getInstance() } catch (_: Exception) { null }
        val yr = now?.get(Calendar.YEAR) ?: 2026
        val mo = (now?.get(Calendar.MONTH) ?: 0) + 1
        val da = now?.get(Calendar.DAY_OF_MONTH) ?: 1
        val hr = now?.get(Calendar.HOUR_OF_DAY) ?: 12
        val mn = now?.get(Calendar.MINUTE) ?: 0
        val sc = now?.get(Calendar.SECOND) ?: 0
        val ti = byteArrayOf(0, (yr ushr 8).toByte(), (yr and 0xFF).toByte(), mo.toByte(), da.toByte(), hr.toByte(), mn.toByte(), sc.toByte())

        // Pre-sync REMOTE1 block + two 32767-byte ESC ( d sync padding blocks
        w.bytes(byteArrayOf(0, 0, 0, 0x1b, 0x01))
        w.ascii("@EJL 1284.4\n@EJL     \n")
        w.bytes(byteArrayOf(0x1b, 0x40, 0x1b, 0x40, 0x1b, 0x28, 0x52, 0x08, 0x00, 0x00))
        w.ascii("REMOTE1")
        rem(w, "TI", ti)
        rem(w, "US", byteArrayOf(0x00, 0x08, 0x01))
        rem(w, "JS", byteArrayOf(0x00, 0x00, 0x00, 0x00))
        rem(w, "JH", byteArrayOf(0x00, 0x01, 0x23, 0x45, 0x67, 0x89.toByte(), 0x3c, 0x21, 0x9c.toByte(), 0x55, 0x84.toByte(), 0x6c))
        rem(w, "HD", byteArrayOf(0x00, 0x03, 0x02))
        w.bytes(byteArrayOf(0x1b, 0x00, 0x00, 0x00))

        for (i in 0 until 2) {
            w.bytes(byteArrayOf(0x1b, 0x28, 0x64, 0xff.toByte(), 0x7f))
            w.zeros(32767)
        }

        // Main job header REMOTE1 block
        w.bytes(byteArrayOf(0, 0, 0, 0x1b, 0x01))
        w.ascii("@EJL 1284.4\n@EJL     \n")
        w.bytes(byteArrayOf(0x1b, 0x40, 0x1b, 0x40, 0x1b, 0x28, 0x52, 0x08, 0x00, 0x00))
        w.ascii("REMOTE1")
        rem(w, "TI", ti)
        rem(w, "PM", byteArrayOf(0x00, 0x00))
        rem(w, "DP", byteArrayOf(0x00, 0x00))
        rem(w, "SN", byteArrayOf(0x00))
        rem(w, "MI", byteArrayOf(0x00, 0x01, mediaCode.toByte(), paperCode.toByte()))
        rem(w, "US", byteArrayOf(0x00, 0x00, if (borderless) 0x02 else 0x01))
        rem(w, "US", byteArrayOf(0x00, 0x01, 0x00))
        rem(w, "US", byteArrayOf(0x00, 0x02, 0x00))
        rem(w, "US", byteArrayOf(0x00, 0x07, 0x00))
        rem(w, "US", byteArrayOf(0x00, 0x08, 0x01))
        rem(w, "FP", if (borderless) byteArrayOf(0x00, 0xb0.toByte(), 0xff.toByte()) else byteArrayOf(0x00, 0x00, 0x00))
        rem(w, "PP", byteArrayOf(0x00, 0x01, 0x00))
        w.bytes(byteArrayOf(0x1b, 0x00, 0x00, 0x00))

        // ESC/P-Raster page setup
        w.bytes(byteArrayOf(0x1b, 0x28, 0x41, 0x09, 0x00)); w.zeros(9)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x47, 0x01, 0x00, 0x01))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x55, 0x05, 0x00, 0x02, 0x02, if (use1440) 0x01 else 0x02))
        w.le16(1440)
        w.bytes(byteArrayOf(0x1b, 0x55, 0x00))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x69, 0x01, 0x00, 0x00))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x43, 0x04, 0x00)); w.le32(sh)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x63, 0x08, 0x00))
        w.le32(-716)
        w.le32(if (borderless) sh + 790 else sh + 396)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x53, 0x08, 0x00))
        w.le32(sw); w.le32(sh)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x4b, 0x02, 0x00, 0x00, 0x02))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x4b, 0x02, 0x00, 0x02, if (mono) 0x01 else 0x02))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x44, 0x04, 0x00, 0x40, 0x38, 0x50, 0x28))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x6d, 0x01, 0x00, if (use1440) 0x70 else 0x52))
        w.bytes(byteArrayOf(0x1b, 0x28, 0x65, 0x02, 0x00, 0x00, if (use1440) 0x13 else 0x12))
    }

    private fun writeTrailer(w: ChunkWriter) {
        w.byte(0x0c); w.byte(0x1b); w.byte(0x40)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x52, 0x08, 0x00, 0x00)); w.ascii("REMOTE1")
        rem(w, "LD", ByteArray(0))
        w.bytes(byteArrayOf(0x1b, 0x00, 0x00, 0x00))
        w.byte(0x1b); w.byte(0x40)
        w.bytes(byteArrayOf(0x1b, 0x28, 0x52, 0x08, 0x00, 0x00)); w.ascii("REMOTE1")
        rem(w, "LD", ByteArray(0))
        rem(w, "JE", byteArrayOf(0x00))
        w.bytes(byteArrayOf(0x1b, 0x00, 0x00, 0x00))
    }

    private fun rem(w: ChunkWriter, name: String, data: ByteArray) {
        w.ascii(name)
        w.le16(data.size)
        if (data.isNotEmpty()) w.bytes(data, 0, data.size)
    }

    private fun writeVertFeed(w: ChunkWriter, dy: Int) {
        w.bytes(byteArrayOf(0x1b, 0x28, 0x76, 0x04, 0x00))
        w.le32(dy)
    }

    private fun writeHorizPos(w: ChunkWriter, dx: Int) {
        w.bytes(byteArrayOf(0x1b, 0x28, 0x24, 0x04, 0x00))
        w.le32(dx)
    }

    private fun decodeB64(s: String): ByteArray {
        val tbl = IntArray(128) { -1 }
        val alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        for (i in alpha.indices) tbl[alpha[i].code] = i
        val out = ByteArray((s.length * 3) / 4)
        var pos = 0
        var i = 0
        while (i + 3 < s.length) {
            val c0 = tbl[s[i].code]; val c1 = tbl[s[i + 1].code]
            val p2 = s[i + 2]; val p3 = s[i + 3]
            val c2 = if (p2 == '=') 0 else tbl[p2.code]
            val c3 = if (p3 == '=') 0 else tbl[p3.code]
            val v = (c0 shl 18) or (c1 shl 12) or (c2 shl 6) or c3
            out[pos++] = ((v ushr 16) and 0xFF).toByte()
            if (p2 != '=') out[pos++] = ((v ushr 8) and 0xFF).toByte()
            if (p3 != '=') out[pos++] = (v and 0xFF).toByte()
            i += 4
        }
        return if (pos == out.size) out else out.copyOf(pos)
    }

    private class ChunkWriter(private val writeChunk: (ByteArray, Int) -> Unit) {
        private val buf = ByteArray(CHUNK_CAP)
        private var pos = 0
        var totalBytes = 0L
            private set

        fun byte(v: Int) {
            if (pos >= CHUNK_CAP) flush()
            buf[pos++] = v.toByte()
        }

        fun bytes(b: ByteArray, off: Int = 0, len: Int = b.size) {
            var o = off
            var rem = len
            while (rem > 0) {
                if (pos >= CHUNK_CAP) flush()
                val take = min(rem, CHUNK_CAP - pos)
                System.arraycopy(b, o, buf, pos, take)
                pos += take; o += take; rem -= take
            }
        }

        fun zeros(count: Int) {
            var rem = count
            while (rem > 0) {
                if (pos >= CHUNK_CAP) flush()
                val take = min(rem, CHUNK_CAP - pos)
                java.util.Arrays.fill(buf, pos, pos + take, 0.toByte())
                pos += take; rem -= take
            }
        }

        fun ascii(s: String) {
            for (i in 0 until s.length) byte(s[i].code and 0xFF)
        }

        fun le16(v: Int) {
            byte(v and 0xFF); byte((v ushr 8) and 0xFF)
        }

        fun le32(v: Int) {
            byte(v and 0xFF); byte((v ushr 8) and 0xFF); byte((v ushr 16) and 0xFF); byte((v ushr 24) and 0xFF)
        }

        fun flush() {
            if (pos > 0) {
                writeChunk(buf, pos)
                totalBytes += pos
                pos = 0
            }
        }
    }
}
