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
     * quality: 0 draft (300 dpi, less ink), 1 normal (300 dpi), 2 best (600 dpi).
     * media: 0 plain paper, 1 glossy photo paper (printed at 600 dpi), 2 matte photo paper.
     * The 600 dpi mode and the photo / matte paper codes follow Gutenprint's G1000 data but are untested on a real printer.
     */
    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean, quality: Int = 1, media: Int = 0, brightness: Int = 0): ByteArray =
        build(src, widthMm, heightMm, mono, quality, media, PrintColorAdj(brightness = brightness))

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, mono: Boolean, quality: Int = 1, media: Int = 0, adj: PrintColorAdj): ByteArray {
        val size = sizeCode(widthMm, heightMm)
            ?: throw IllegalArgumentException("This paper size isn't supported on Canon USB printers yet. Use 4x6, A4 or Letter.")
        fun areaWOf(d: Int) = Math.round(minOf(widthMm, heightMm) / 25.4 * d).toInt() - 2 * MARGIN_SIDE * (d / DPI)
        fun areaHOf(d: Int) = ((Math.round(maxOf(widthMm, heightMm) / 25.4 * d).toInt() - (MARGIN_TOP + MARGIN_BOTTOM) * (d / DPI)) / LINES) * LINES
        var dpi = if (quality == 2 || media == 1) 600 else 300
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
}
