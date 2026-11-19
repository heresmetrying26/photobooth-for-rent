package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
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

    // ── IVEC + PWG Raster (the way Canon's current G-series ink-tank printers are driven) ──────────────────────────
    // The G3010 / G1020 / G2020 family takes the same IVEC XML wrapper as above, but the page itself goes in as ONE PWG Raster
    // document inside a SendData command (not as ESC ( bands). Layout confirmed on a G3010 by the open-source noble6/canon-universal-driver;
    // the byte layout here is written from the protocol description, not copied. A G1010 has not been confirmed on this app yet.
    private const val NS = "xmlns:ivec=\"http://www.canon.com/ns/cmd/2008/07/common/\""
    private const val NS_V = "xmlns:vcn=\"http://www.canon.com/ns/cmd/2008/07/canon/\""
    private const val DECL = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>"
    private const val JOB = "00000002"

    private fun cmd(op: String, params: String, vendor: Boolean = false, decl: String = DECL) =
        "$decl<cmd $NS${if (vendor) " $NS_V" else ""}><ivec:contents><ivec:operation>$op</ivec:operation>" +
            "<ivec:param_set servicetype=\"print\"><ivec:jobID>$JOB</ivec:jobID>$params</ivec:param_set></ivec:contents></cmd>"

    /** The status question the printer answers on its bulk-in endpoint (no job id). */
    val GET_STATUS: ByteArray = ascii("$DECL<cmd $NS><ivec:contents><ivec:operation>GetStatus</ivec:operation><ivec:param_set servicetype=\"print\"></ivec:param_set></ivec:contents></cmd>")

    /** The capability question Canon's Windows driver opens a job with; the reply lists the data formats the printer takes. */
    val GET_CAPABILITY: ByteArray = ascii("$DECL<cmd $NS><ivec:contents><ivec:operation>GetCapability</ivec:operation><ivec:param_set servicetype=\"print\"></ivec:param_set></ivec:contents></cmd>")

    /** What a status reply says: status ("idle", "stopped", "notready", else printing) and an optional detail ("MediaEmpty", "MediaJam", "DoorOpen"...). */
    data class Status(val status: String, val detail: String, val code: String)

    fun parseStatus(reply: String): Status? {
        val end = reply.lastIndexOf("</cmd>")
        if (end < 0) return null
        fun last(tag: String): String {
            val open = "<ivec:$tag>"
            val i = reply.lastIndexOf(open)
            if (i < 0) return ""
            val j = reply.indexOf("</ivec:$tag>", i)
            return if (j < 0) "" else reply.substring(i + open.length, j).trim()
        }
        val st = last("status")
        if (st.isEmpty()) return null
        return Status(st.lowercase(), last("status_detail"), last("current_support_code").ifEmpty { last("error_code") })
    }

    /** Plain-words message for a blocking printer status, or null when the printer is fine. */
    fun statusProblem(s: Status): String? = when {
        s.detail.equals("MediaEmpty", true) -> "The printer is out of paper. Load paper, press the Black button on the printer, then try again."
        s.detail.equals("MediaJam", true) -> "The printer has a paper jam. Clear it, then try again."
        s.detail.equals("DoorOpen", true) -> "The printer's cover is open. Close it, then try again."
        s.detail.equals("AttentionRequired", true) || s.status == "stopped" || s.status == "notready" ->
            "The printer needs attention (check the paper, ink and the lights on the printer)" + (if (s.code.isNotEmpty()) " - code ${s.code}." else ".")
        else -> null
    }

    /** One paper: the PWG name, the points on the page, and the printable raster at 600 dpi without / with borderless overspray. */
    private class IvecPaper(val pwg: String, val wPt: Int, val hPt: Int, val w600: Int, val h600: Int, val bw600: Int, val bh600: Int)

    private fun ivecPaper(wMm: Double, hMm: Double): IvecPaper? {
        val w = minOf(wMm, hMm)
        val h = maxOf(wMm, hMm)
        fun near(a: Double, b: Double) = Math.abs(a - b) < 3.0
        return when {
            near(w, 101.6) && near(h, 152.4) -> IvecPaper("na_index-4x6_4x6in", 288, 432, 2239, 3411, 2532, 3765)
            near(w, 210.0) && near(h, 297.0) -> IvecPaper("iso_a4_210x297mm", 595, 842, 4800, 6826, 5092, 7181)
            near(w, 215.9) && near(h, 279.4) -> IvecPaper("na_letter_8.5x11in", 612, 792, 4800, 6411, 5232, 6765)
            else -> null
        }
    }

    fun supportsIvec(wMm: Double, hMm: Double) = ivecPaper(wMm, hMm) != null

    /**
     * A whole IVEC print job for one page: StartJob, SetJobConfiguration (clock), SetConfiguration, SetPageConfiguration,
     * SendData (PWG Raster), EndJob.
     * quality: 0 draft, 1 normal, 2 best. media: 0 plain, 1 glossy photo, 2 matte photo. borderless: fill the page (the printer overshoots a little).
     */
    fun buildIvec(jpeg: ByteArray, widthMm: Double, heightMm: Double, mono: Boolean, quality: Int, media: Int,
                  borderless: Boolean, adj: PrintColorAdj = PrintColorAdj()): ByteArray {
        val p = ivecPaper(widthMm, heightMm)
            ?: throw IllegalArgumentException("This paper size isn't supported on Canon USB printers yet. Use 4x6, A4 or Letter.")
        // 600 dpi for a 4x6 photo; the big sheets stay at 300 dpi so the tablet's memory is enough.
        val draftPlain = quality == 0 && media == 0
        val dpi = if (p.wPt <= 300 && !draftPlain) 600 else 300
        val f = dpi / 600.0
        val bl = borderless
        val pxW = Math.round((if (bl) p.bw600 else p.w600) * f).toInt()
        val pxH = Math.round((if (bl) p.bh600 else p.h600) * f).toInt()

        val src = if (adj.isNoop) jpeg else {
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: throw IllegalStateException("Couldn't read the picture to print.")
            val tmp = Bitmap.createBitmap(bmp.width, bmp.height, Bitmap.Config.ARGB_8888)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            adj.toColorFilter()?.let { paint.colorFilter = it }
            Canvas(tmp).drawBitmap(bmp, 0f, 0f, paint)
            try { bmp.recycle() } catch (_: Exception) {}
            val bo = ByteArrayOutputStream()
            tmp.compress(Bitmap.CompressFormat.JPEG, 95, bo)
            try { tmp.recycle() } catch (_: Exception) {}
            bo.toByteArray()
        }

        // The ImageBox words are the page's usable box in points x dpi (Canon's own driver leaves out the /72).
        val box = if (bl) intArrayOf(0, 0, p.wPt * dpi, p.hPt * dpi) else {
            val left = (p.wPt - p.w600 * 72.0 / 600) / 2
            val bottom = 14.18
            intArrayOf((left * dpi).toInt(), (bottom * dpi).toInt(), ((left + p.w600 * 72.0 / 600) * dpi).toInt(), ((bottom + p.h600 * 72.0 / 600) * dpi).toInt())
        }
        val pwgType = when (media) { 1 -> "custom-media-type-canon-14"; 2 -> "custom-media-type-canon-15"; else -> "stationery" }
        val pwg = PwgRaster.fromJpeg(src, widthMm, heightMm, dpi, mono, pageName = p.pwg, mediaType = pwgType, cupsExact = true,
            forcePxW = pxW, forcePxH = pxH, pagePtW = p.wPt, pagePtH = p.hPt, imageBox = box)

        val q = when { quality == 2 -> "<ivec:printquality>best</ivec:printquality>"; draftPlain -> "<ivec:printquality>fast_draft</ivec:printquality>"; else -> "" }
        val stamp = java.text.SimpleDateFormat("yyyyMMddHHmmss", java.util.Locale.US).format(java.util.Date())
        val uuid = java.util.UUID.randomUUID().toString()
        val out = ByteArrayOutputStream(pwg.size + 4096)
        out.write(ascii(cmd("StartJob",
            "<ivec:bidi>0</ivec:bidi><vcn:forcepmdetection>OFF</vcn:forcepmdetection><ivec:jobname/><ivec:username/><ivec:computername/>" +
                "<ivec:job_description><![CDATA[$uuid]]></ivec:job_description><vcn:host_environment>android</vcn:host_environment>", vendor = true)))
        out.write(ascii(cmd("SetJobConfiguration", "<ivec:mismatch_mode>none</ivec:mismatch_mode><ivec:datetime>$stamp</ivec:datetime>",
            decl = "<?xml version=\"1.0\" encoding=\"utf-8\"?>")))
        out.write(ascii(cmd("SetConfiguration",
            "<ivec:papersize>${p.pwg}</ivec:papersize><ivec:papertype>$pwgType</ivec:papertype>" +
                "<ivec:borderlessprint>${if (bl) "ON" else "OFF"}</ivec:borderlessprint>" +
                "<ivec:printcolormode>${if (mono) "monochrome" else "color"}</ivec:printcolormode><ivec:duplexprint>OFF</ivec:duplexprint>$q")))
        out.write(ascii(cmd("VendorCmd", "<vcn:ijoperation>SetPageConfiguration</vcn:ijoperation><vcn:nextpage>OFF</vcn:nextpage>", vendor = true)))
        out.write(ascii(cmd("SendData", "<ivec:format>PWGRaster</ivec:format><ivec:datasize>${pwg.size}</ivec:datasize>")))
        out.write(pwg)
        out.write(ascii(cmd("EndJob", "")))
        return out.toByteArray()
    }

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

    private const val BEST_MAX_PIXELS = 16_000_000L     // above this a page stays at 300 dpi (tablet memory)

    /**
     * quality: 0 draft (300 dpi, less ink), 1 normal (300 dpi), 2 high (600 dpi, Canon's Standard), 3 best (600 dpi, Canon's High: slower).
     * media: 0 plain paper, 1 glossy photo paper, 2 matte photo paper. 4x6 on photo paper, and 4x6 at quality 2 or 3, use [build600]
     * (the stream copied from Canon's own driver, with borderless as an option); everything else is the 300 dpi stream.
     */
    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean, quality: Int = 1, media: Int = 0, brightness: Int = 0): ByteArray =
        build(src, widthMm, heightMm, mono, quality, media, PrintColorAdj(brightness = brightness))

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean, quality: Int = 1, media: Int = 0, adj: PrintColorAdj,
              borderless: Boolean = false): ByteArray {
        val size = sizeCode(widthMm, heightMm)
            ?: throw IllegalArgumentException("This paper size isn't supported on Canon USB printers yet. Use 4x6, A4 or Letter.")
        // 4x6 in High quality (600 dpi) or on photo / matte paper: the stream Canon's own Windows G1010 driver sends for that job.
        if (size == 0x34 && (media != 0 || quality >= 2 || borderless)) return build600(src, widthMm, heightMm, media, adj, mono, quality >= 3, borderless)
        fun areaWOf(d: Int) = Math.round(minOf(widthMm, heightMm) / 25.4 * d).toInt() - 2 * MARGIN_SIDE * (d / DPI)
        fun areaHOf(d: Int) = ((Math.round(maxOf(widthMm, heightMm) / 25.4 * d).toInt() - (MARGIN_TOP + MARGIN_BOTTOM) * (d / DPI)) / LINES) * LINES
        // 300 dpi only. A client's real G1010 printed the test page and photos at 300 dpi (Normal) but did NOT print at all with
        // "Best (600 dpi)" (client report, 2026-11-19), so the 600 dpi mode stays off until it has been checked on a G1010.
        var dpi = 300
        if (dpi == 600 && areaWOf(600).toLong() * areaHOf(600) > BEST_MAX_PIXELS) dpi = 300
        val u = 600 / dpi                                   // the printer counts page areas in 1/600 inch
        val paperW = Math.round(minOf(widthMm, heightMm) / 25.4 * dpi).toInt()
        val paperH = Math.round(maxOf(widthMm, heightMm) / 25.4 * dpi).toInt()
        val areaW = areaWOf(dpi)
        val areaH = areaHOf(dpi)
        require(areaW > 0 && areaH > 0) { "Sheet too small" }

        val needsRotate = src.width > src.height && widthMm <= heightMm
        val rotatedSrc: Bitmap
        val shouldRecycleRotated: Boolean
        if (needsRotate) {
            rotatedSrc = Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(90f) }, true)
            shouldRecycleRotated = (rotatedSrc !== src)
        } else {
            rotatedSrc = src
            shouldRecycleRotated = false
        }

        // Scale and apply color adjustment at target dimensions (areaW x areaH)
        val bmp = if (rotatedSrc.width == areaW && rotatedSrc.height == areaH && adj.isNoop) {
            rotatedSrc
        } else {
            val target = Bitmap.createBitmap(areaW, areaH, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(target)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
            val filter = adj.toColorFilter()
            if (filter != null) paint.colorFilter = filter
            val scaleMatrix = Matrix()
            scaleMatrix.postScale(areaW.toFloat() / rotatedSrc.width, areaH.toFloat() / rotatedSrc.height)
            canvas.drawBitmap(rotatedSrc, scaleMatrix, paint)
            target
        }
        if (shouldRecycleRotated) {
            try { rotatedSrc.recycle() } catch (_: Exception) {}
        }
        val rowBytes = (areaW + 7) / 8
        // planes in the printer's order: cyan, magenta, yellow, black
        val planes: Array<ByteArray> = if (mono) {
            val grey = Bitmap.createBitmap(areaW, areaH, Bitmap.Config.ARGB_8888)
            val p = Paint().apply { colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) }) }
            Canvas(grey).apply { drawColor(Color.WHITE); drawBitmap(bmp, 0f, 0f, p) }
            val dithered = EscP2Job.dither(grey, areaW, areaH, rowBytes, if (quality == 0) 2.2 else 1.0)
            try { grey.recycle() } catch (_: Exception) {}
            arrayOf(ByteArray(rowBytes * areaH), ByteArray(rowBytes * areaH), ByteArray(rowBytes * areaH), dithered)
        } else {
            val k = EscP2Job.cmykPlanes(bmp, areaW, areaH, rowBytes, if (quality == 0) 2.2 else 1.6)   // K, C, M, Y
            arrayOf(k[1], k[2], k[3], k[0])
        }
        if (bmp !== src) {
            try { bmp.recycle() } catch (_: Exception) {}
        }

        // paper codes for the page-setup commands: ESC ( c, ESC ( l and ESC ( P (plain 0; glossy photo; matte photo)
        val mediaC = when (media) { 1 -> 0x1D; 2 -> 0x0A; else -> 0x00 }
        val mediaL = when (media) { 1 -> 0x23; 2 -> 0x10; else -> 0x00 }
        val mediaP = when (media) { 1 -> 0x32; 2 -> 0x1C; else -> 0x00 }
        val paperW600 = if (size == 0x03) 4961 else paperW * u
        val paperH600 = if (size == 0x03) 7016 else paperH * u
        val out = ByteArrayOutputStream()
        out.put(ascii(PRE_XML))
        out.put(bytes(0x1B, 0x5B, 0x4B, 0x02, 0x00, 0x00, 0x0F))                      // reset (first page)
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x01))                            // data compression on
        out.put(bytes(0x1B, 0x28, 0x71, 0x01, 0x00, 0x01))                            // page id
        out.put(bytes(0x1B, 0x28, 0x64, 0x04, 0x00), be16(dpi), be16(dpi))            // resolution 300 or 600
        out.put(bytes(0x1B, 0x28, 0x74, 0x18, 0x00, 0x80, if (dpi == 600) 0x80 else 0x00, 0x01,   // image format: 4 inks, 1 bit each
            0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02,
            0, 0, 0, 0, 0, 0, 0, 0, 0))
        out.put(bytes(0x1B, 0x28, 0x63, 0x03, 0x00, 0x30, mediaC, if (dpi == 600) 0x02 else 0x01))   // paper type, quality
        out.put(bytes(0x1B, 0x28, 0x70, 0x2E, 0x00), be16(areaH * u), be16(0), be16(areaW * u), be16(0), be32(0), be16(600),
            be32(83), be32(75), be32(areaW * u), be32(areaH * u), be32(0), be32(0), be32(paperW600), be32(paperH600))
        out.put(bytes(0x1B, 0x28, 0x50, 0x09, 0x00, 0x00, size, 0x00, mediaP, 0x01, 0x00, 0x01, 0x00, 0xFF))   // paper size, portrait
        out.put(bytes(0x1B, 0x28, 0x6C, 0x03, 0x00, 0x34, mediaL, 0x00))              // rear tray, paper type
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
                    if (end > 0) band.write(EscprJob.packBits(planes[ch].copyOfRange(y * rowBytes, y * rowBytes + end), 1))
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

    // ── 600 dpi, 4x6 ────────────────────────────────────────────────────────────────────────────────────────────────
    // Written to match what Canon's own Windows G1010 driver sends. That driver was made to print to a file (no printer) at
    // its Standard and High quality, bordered and borderless, on plain paper, Photo Paper Plus Glossy II and Matte Photo, and
    // its bytes were compared command by command: the job wrapper (StartJob, SetJobConfiguration with the date, ModeShift,
    // EndJob), the page setup commands, the per-ink bit depths, the skipping of blank bands, and the raster bands.
    // Standard: plain paper black / yellow 1 bit, cyan / magenta 2 bits; photo paper cyan, magenta, yellow only, 2 bits.
    // High: finer drops (quality byte 3): plain paper all four inks 2 bits, photo paper the same format with more levels.
    private const val W600 = 2240                       // bordered print area of a 4x6 sheet, in 1/600 inch (offset 80, 70)
    private const val H600 = 3412
    private const val WBL = 2533                        // borderless print area: the sheet plus the printer's overspray (offset -66, -47)
    private const val HBL = 3766
    private const val OFF_L = 66                        // where the sheet starts inside the borderless area
    private const val OFF_T = 47
    private const val SHEET_W = 2400
    private const val SHEET_H = 3600
    private const val JITTER = 0.5f                     // threshold noise of the dither, see lutPlanes

    /**
     * Turns a picture into ink planes the way Canon's driver does at this quality: each pixel's colour gives an ink amount per
     * ink (trilinear in the 9 x 9 x 9 table, in "average pixel value"), and an error-diffusion dither places pixel values 0..maxLv
     * so that their average is that amount (below 1: small dots at that rate; 1 to 2: a mix of small and bigger dots; ...).
     * The dither scans left to right and back (serpentine) and adds a little threshold noise: plain Floyd-Steinberg leaves
     * regular stripes in flat tones (a dot two pixels to its right 8 times out of 10 at mid-grey), which Canon's own output does
     * not have; this version matches Canon's dot-to-dot statistics (measured on its chart) far more closely.
     * table: node = r * 81 + g * 9 + b, then one float per ink. bits: bits per pixel of each plane (1 or 2), packed MSB first.
     */
    private fun lutPlanes(bmp: Bitmap, w: Int, h: Int, table: FloatArray, bits: IntArray, maxLv: IntArray): Array<ByteArray> {
        val n = bits.size
        val rb = IntArray(n) { (w * bits[it] + 7) / 8 }
        val planes = Array(n) { ByteArray(rb[it] * h) }
        val idx = IntArray(256)
        val frac = FloatArray(256)
        for (v in 0..255) { val f = v / 32f; val i = minOf(7, f.toInt()); idx[v] = i; frac[v] = f - i }
        val px = IntArray(w)
        var cur = Array(n) { FloatArray(w + 2) }
        var nxt = Array(n) { FloatArray(w + 2) }
        val a = FloatArray(n)
        var rng = 0x2545F491
        for (y in 0 until h) {
            bmp.getPixels(px, 0, w, 0, y, w, 1)
            for (c in 0 until n) java.util.Arrays.fill(nxt[c], 0f)
            val rev = (y and 1) == 1
            for (k in 0 until w) {
                val x = if (rev) w - 1 - k else k
                val p = px[x]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val rf = frac[r]; val gf = frac[g]; val bf = frac[b]
                val o0 = (idx[r] * 81 + idx[g] * 9 + idx[b]) * n
                val o1 = o0 + n                     // blue + 1
                val o2 = o0 + 9 * n                 // green + 1
                val o3 = o2 + n
                val o4 = o0 + 81 * n                // red + 1
                val o5 = o4 + n
                val o6 = o4 + 9 * n
                val o7 = o6 + n
                val w0 = (1 - rf) * (1 - gf) * (1 - bf); val w1 = (1 - rf) * (1 - gf) * bf
                val w2 = (1 - rf) * gf * (1 - bf); val w3 = (1 - rf) * gf * bf
                val w4 = rf * (1 - gf) * (1 - bf); val w5 = rf * (1 - gf) * bf
                val w6 = rf * gf * (1 - bf); val w7 = rf * gf * bf
                for (c in 0 until n) {
                    a[c] = w0 * table[o0 + c] + w1 * table[o1 + c] + w2 * table[o2 + c] + w3 * table[o3 + c] +
                        w4 * table[o4 + c] + w5 * table[o5 + c] + w6 * table[o6 + c] + w7 * table[o7 + c]
                }
                for (c in 0 until n) {
                    rng = rng * 1664525 + 1013904223
                    if (a[c] < 0.004f) continue      // no ink wanted here: stays blank, no stray dots spill in from the row above
                    val noise = ((rng ushr 8) * (1f / 16777216f) - 0.5f) * JITTER
                    val v = a[c] + cur[c][x + 1]
                    var q = Math.round(v + noise)
                    if (q < 0) q = 0 else if (q > maxLv[c]) q = maxLv[c]
                    val err = v - q
                    if (q > 0) {
                        if (bits[c] == 2) {
                            val bi = y * rb[c] + ((x * 2) ushr 3)
                            planes[c][bi] = (planes[c][bi].toInt() or (q shl (6 - ((x * 2) and 7)))).toByte()
                        } else {
                            val bi = y * rb[c] + (x shr 3)
                            planes[c][bi] = (planes[c][bi].toInt() or (0x80 shr (x and 7))).toByte()
                        }
                    }
                    if (rev) {                       // right to left: the error goes to the left pixel and the row below
                        cur[c][x] += err * 7f / 16f
                        nxt[c][x + 2] += err * 3f / 16f
                        nxt[c][x + 1] += err * 5f / 16f
                        nxt[c][x] += err * 1f / 16f
                    } else {
                        cur[c][x + 2] += err * 7f / 16f
                        nxt[c][x] += err * 3f / 16f
                        nxt[c][x + 1] += err * 5f / 16f
                        nxt[c][x + 2] += err * 1f / 16f
                    }
                }
            }
            val t = cur; cur = nxt; nxt = t
        }
        return planes
    }

    private fun build600(src: Bitmap, widthMm: Double, heightMm: Double, media: Int, adj: PrintColorAdj, mono: Boolean,
                         high: Boolean, borderless: Boolean): ByteArray {
        val photo = media != 0
        val areaW = if (borderless) WBL else W600
        val areaH = if (borderless) HBL else H600
        val needsRotate = src.width > src.height && widthMm <= heightMm
        val rotatedSrc = if (needsRotate) Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(90f) }, true) else src
        val bmp = Bitmap.createBitmap(areaW, areaH, Bitmap.Config.ARGB_8888)
        run {
            val canvas = Canvas(bmp)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
            val edge = Paint()                                                      // nearest pixel, for the repeated rim
            val filter = if (mono) ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) }) else adj.toColorFilter()
            if (filter != null) { paint.colorFilter = filter; edge.colorFilter = filter }
            val sw = rotatedSrc.width
            val sh = rotatedSrc.height
            if (!borderless) {
                val scale = Matrix()
                scale.postScale(W600.toFloat() / sw, H600.toFloat() / sh)
                canvas.drawBitmap(rotatedSrc, scale, paint)
            } else {
                // the picture fills the 4x6 sheet exactly (nothing of the design is cut off); the rim the printer sprays past the
                // sheet repeats the picture's own edge pixels, so a sheet that sits a little off still has no white edge
                val l = OFF_L; val t = OFF_T; val r = OFF_L + SHEET_W; val bt = OFF_T + SHEET_H
                val scale = Matrix()
                scale.postScale(SHEET_W.toFloat() / sw, SHEET_H.toFloat() / sh)
                scale.postTranslate(l.toFloat(), t.toFloat())
                canvas.drawBitmap(rotatedSrc, scale, paint)
                canvas.drawBitmap(rotatedSrc, Rect(0, 0, 1, sh), Rect(0, t, l, bt), edge)                    // left
                canvas.drawBitmap(rotatedSrc, Rect(sw - 1, 0, sw, sh), Rect(r, t, areaW, bt), edge)          // right
                canvas.drawBitmap(rotatedSrc, Rect(0, 0, sw, 1), Rect(l, 0, r, t), edge)                     // top
                canvas.drawBitmap(rotatedSrc, Rect(0, sh - 1, sw, sh), Rect(l, bt, r, areaH), edge)          // bottom
                canvas.drawBitmap(rotatedSrc, Rect(0, 0, 1, 1), Rect(0, 0, l, t), edge)                      // corners
                canvas.drawBitmap(rotatedSrc, Rect(sw - 1, 0, sw, 1), Rect(r, 0, areaW, t), edge)
                canvas.drawBitmap(rotatedSrc, Rect(0, sh - 1, 1, sh), Rect(0, bt, l, areaH), edge)
                canvas.drawBitmap(rotatedSrc, Rect(sw - 1, sh - 1, sw, sh), Rect(r, bt, areaW, areaH), edge)
            }
        }
        if (rotatedSrc !== src) { try { rotatedSrc.recycle() } catch (_: Exception) {} }
        // Ink amounts per colour from Canon's own driver (CanonLut), then a multi-level dither. Planes in band order:
        // photo paper C, M, Y (2 bits, 0..3); plain Standard C, M (2 bits, 0..2), Y, K (1 bit); plain High all 2 bits (C, M 0..3; Y, K 0..2).
        val bits = if (photo) intArrayOf(2, 2, 2) else if (high) intArrayOf(2, 2, 2, 2) else intArrayOf(2, 2, 1, 1)
        val maxLv = if (photo) intArrayOf(3, 3, 3) else if (high) intArrayOf(3, 3, 2, 2) else intArrayOf(2, 2, 1, 1)
        val planes = lutPlanes(bmp, areaW, areaH, CanonLut.table(media, high), bits, maxLv)
        try { bmp.recycle() } catch (_: Exception) {}

        // Bands (8 rows) with no ink in any plane are not sent: the driver skips them with ESC ( e <count>
        val nBands = (areaH + LINES - 1) / LINES
        val active = BooleanArray(nBands)
        for (ch in planes.indices) {
            val rbc = (areaW * bits[ch] + 7) / 8
            for (y in 0 until areaH) {
                if (active[y / LINES]) continue
                val base = y * rbc
                for (i in 0 until rbc) if (planes[ch][base + i].toInt() != 0) { active[y / LINES] = true; break }
            }
        }
        var lead = 0
        while (lead < nBands && !active[lead]) lead++

        // paper codes in the page-setup commands, as sent by the driver for these papers (plain; Photo Paper Plus Glossy II; Matte Photo)
        val mediaC = if (media == 1) 0x1D else if (media == 2) 0x0A else 0x00
        val mediaP = if (media == 1) 0x32 else if (media == 2) 0x1C else 0x00
        val mediaL = if (media == 1) 0x23 else if (media == 2) 0x10 else 0x00
        val mediaW = if (media == 1) 0x03 else if (media == 2) 0x0F else 0x00           // ESC ( w: another per-paper code in the driver's job
        val qual = if (high) 0x03 else 0x02
        val pH = if (borderless) 0 else (H600 + 9) / 10
        val pW = if (borderless) 0 else W600 / 10
        val pLeft = if (borderless) -OFF_L else 80
        val pTop = if (borderless) -OFF_T else 70
        val pAreaW = if (borderless) WBL else W600
        val pAreaH = if (borderless) HBL else H600
        val inkFormat = if (photo) bytes(0x00, 0x00, 0x00, 0x02, 0x00, 0x04, 0x02, 0x00, 0x04, 0x02, 0x00, 0x04) else if (high) bytes(0x02, 0x00, 0x03, 0x02, 0x00, 0x04, 0x02, 0x00, 0x04, 0x02, 0x00, 0x03) else bytes(0x01, 0x00, 0x02, 0x02, 0x00, 0x03, 0x02, 0x00, 0x03, 0x01, 0x00, 0x02)
        val stamp = java.text.SimpleDateFormat("yyyyMMddHHmmss", java.util.Locale.US).format(java.util.Date())
        val uuid = java.util.UUID.randomUUID().toString().uppercase()
        val ns = "xmlns:ivec=\"http://www.canon.com/ns/cmd/2008/07/common/\""
        val nsV = "xmlns:vcn=\"http://www.canon.com/ns/cmd/2008/07/canon/\""
        val decl = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>"
        val out = ByteArrayOutputStream(1 shl 20)
        out.put(ascii(decl + "<cmd $ns $nsV><ivec:contents><ivec:operation>StartJob</ivec:operation><ivec:param_set servicetype=\"print\">" +
            "<ivec:jobID>00000001</ivec:jobID><ivec:bidi>0</ivec:bidi><ivec:jobname><![CDATA[photobooth4u]]></ivec:jobname>" +
            "<ivec:username><![CDATA[photobooth4u]]></ivec:username><ivec:computername><![CDATA[Android]]></ivec:computername>" +
            "<ivec:job_description><![CDATA[$uuid]]></ivec:job_description><vcn:host_environment>windows</vcn:host_environment>" +
            "</ivec:param_set></ivec:contents></cmd>"))
        out.put(ascii(decl + "<cmd $ns><ivec:contents><ivec:operation>SetJobConfiguration</ivec:operation><ivec:param_set servicetype=\"print\">" +
            "<ivec:jobID>00000001</ivec:jobID><ivec:datetime>$stamp</ivec:datetime></ivec:param_set></ivec:contents></cmd>"))
        out.put(ascii(decl + "<cmd $ns $nsV><ivec:contents><ivec:operation>VendorCmd</ivec:operation><ivec:param_set servicetype=\"print\">" +
            "<vcn:ijoperation>ModeShift</vcn:ijoperation><vcn:ijmode>1</vcn:ijmode><ivec:jobID>00000001</ivec:jobID>" +
            "</ivec:param_set></ivec:contents></cmd>"))

        out.put(bytes(0x1B, 0x5B, 0x4B, 0x02, 0x00, 0x00, 0x0F))                      // reset
        out.put(bytes(0x1B, 0x28, 0x54, 0x03, 0x00, 0x03, 0x04, 0x04))                // (T) as sent by the Windows driver
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x01))                            // data compression on
        out.put(bytes(0x1B, 0x28, 0x63, 0x03, 0x00, 0x30, mediaC, qual))              // paper type, quality (2 Standard, 3 High)
        out.put(bytes(0x1B, 0x28, 0x64, 0x04, 0x00), be16(600), be16(600))            // resolution 600 x 600
        // ink formats in the order K, C, M, Y: (bits, 0, levels)
        out.put(bytes(0x1B, 0x28, 0x74, 0x18, 0x00, 0x80, 0x80, 0x01), inkFormat, bytes(0, 0, 0, 0, 0, 0, 0, 0, 0))
        out.put(bytes(0x1B, 0x28, 0x70, 0x2E, 0x00), be16(pH), be16(0), be16(pW), be16(0), be32(0), be16(600),
            be32(pLeft), be32(pTop), be32(pAreaW), be32(pAreaH), be32(0), be32(0), be32(SHEET_W), be32(SHEET_H))   // print area and 4x6 sheet, in 1/600 inch
        out.put(bytes(0x1B, 0x28, 0x50, 0x09, 0x00, 0x00, 0x34, 0x00, mediaP, 0x01, 0x00, 0x01, 0x00, 0xFF))   // paper size 4x6, paper type
        out.put(bytes(0x1B, 0x28, 0x6C, 0x03, 0x00, 0x34, mediaL, 0x00))              // rear tray, paper type
        out.put(bytes(0x1B, 0x28, 0x76, 0x01, 0x00, 0x00))
        out.put(bytes(0x1B, 0x28, 0x77, 0x01, 0x00, mediaW))                          // (w)
        out.put(bytes(0x1B, 0x28, 0x43, 0x01, 0x00, 0x00))                            // (C)
        out.put(bytes(0x1B, 0x28, 0x71, 0x01, 0x00, 0x01))                            // page id
        out.put(bytes(0x1B, 0x28, 0x79, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01))          // (y) one copy
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x01))
        out.put(bytes(0x1B, 0x28, 0x49, 0x01, 0x00, 0x01))                            // multi-line raster on
        out.put(bytes(0x1B, 0x28, 0x4A, 0x01, 0x00, LINES))                           // 8 rows per band
        if (lead > 0) out.put(bytes(0x1B, 0x28, 0x65, 0x02, 0x00), be16(lead))        // skip the blank bands at the top
        if (photo) out.put(bytes(0x1B, 0x28, 0x4C, 0x03, 0x00, 0x43, 0x4D, 0x59))     // channels C M Y
        else out.put(bytes(0x1B, 0x28, 0x4C, 0x04, 0x00, 0x43, 0x4D, 0x59, 0x4B))     // channels C M Y K

        val band = ByteArrayOutputStream()
        var gap = 0
        for (b in lead until nBands) {
            if (!active[b]) { gap++; continue }
            if (gap > 0) { out.put(bytes(0x1B, 0x28, 0x65, 0x02, 0x00), be16(gap)); gap = 0 }       // skip blank bands in the page
            for (ch in planes.indices) {
                band.reset()
                var any = false
                val rowBytes = (areaW * bits[ch] + 7) / 8
                for (r in 0 until LINES) {
                    val y = b * LINES + r
                    if (y < areaH) {
                        val pl = planes[ch]
                        var end = rowBytes
                        while (end > 0 && pl[y * rowBytes + end - 1].toInt() == 0) end--
                        if (end > 0) {
                            any = true
                            band.write(EscprJob.packBits(pl.copyOfRange(y * rowBytes, y * rowBytes + end), 1))
                        }
                    }
                    band.write(0x80)                                                  // end of row
                }
                // an ink with nothing in this band is sent as an empty command, as the driver does
                val data = if (any) band.toByteArray() else ByteArray(0)
                out.put(bytes(0x1B, 0x28, 0x46, data.size, data.size shr 8), data)
            }
        }
        out.put(bytes(0x1B, 0x28, 0x65, 0x02, 0x00, 0x00, 0x01))                      // end of page data
        out.put(bytes(0x0C))                                                           // eject
        out.put(bytes(0x1B, 0x28, 0x62, 0x01, 0x00, 0x00))                            // compression off
        out.put(bytes(0x1B, 0x40))                                                    // reset
        out.put(ascii(POST_XML))                                                       // end of job (job id 1)
        return out.toByteArray()
    }
}
