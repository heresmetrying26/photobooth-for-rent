package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.util.Log

/**
 * Direct USB print driver for DNP dye-sublimation photo printers: DS-RX1 / RX1HS, DS620 / DS620A and DS40
 * (also sold as Citizen CX / CY). Same command set the DNP Windows driver and Gutenprint's dnpds40 backend use:
 *
 *   every command is 32 bytes: ESC 'P', a 6-char group, a 16-char name, an 8-digit payload length (or spaces),
 *   all space-padded, then the payload. A print is CNTRL QTY / OVERCOAT / CUTTER, IMAGE MULTICUT (paper size),
 *   three IMAGE xPLANE blocks (Y, M, C, each an 8-bit bottom-up BMP at 300 dpi), then CNTRL START.
 *   STATUS and INFO FREE_PBUFFER answer with an 8-digit length and an ASCII payload.
 *
 * Plane data is RGB-style (255 = no ink): the Y plane carries the blue channel, M green, C red.
 */
object DnpJob {
    private const val TAG = "DnpJob"

    /** DS40 / DS80 / DS-RX1 enumerate with Citizen's vendor id (they are built by Citizen); DS620 / DS820 with DNP's. */
    const val VID_CITIZEN = 0x1343
    const val VID_DNP = 0x1452

    private val CITIZEN_PIDS = mapOf(
        0x0003 to "DS40",
        0x0004 to "DS80",
        0x0005 to "DS-RX1",
        0x0008 to "DS80D"
    )
    private val DNP_PIDS = mapOf(
        0x8b01 to "DS620",
        0x9001 to "DS820"
    )
    private val NAME_RX = Regex("(?i)DS-?RX1(HS)?|DS-?620A?|DS-?40|DS-?80D?|DS-?820A?|QW-?410")

    /** Model name ("DS-RX1", "DS620" ...) or null when this is not a DNP photo printer. Works without USB access. */
    fun match(d: UsbDevice, productName: String? = null): String? {
        val descName: String? = try { d.productName } catch (_: Exception) { null }
        val name = productName ?: descName ?: ""
        val fromName = NAME_RX.find(name)?.value?.uppercase()?.replace("DSRX", "DS-RX")?.replace(Regex("^DS-(\\d)"), "DS\$1")
        if (d.vendorId == VID_CITIZEN) return CITIZEN_PIDS[d.productId] ?: fromName
        if (d.vendorId == VID_DNP) return DNP_PIDS[d.productId] ?: fromName ?: "photo printer"
        return null
    }

    fun isKnown(d: UsbDevice): Boolean = match(d) != null

    /** 8-inch (DS80 / DS820) and 4.5-inch (QW410) models use other sheet sizes that are not built in yet. */
    fun unsupportedReason(model: String): String? = when {
        model.contains("80") || model.contains("820") -> "The DNP $model (8-inch paper) is not supported by the app yet. Use a laptop with the DNP driver."
        model.contains("QW") -> "The DNP $model is not supported by the app yet. Use a laptop with the DNP driver."
        else -> null
    }

    /**
     * One DNP sheet. cols × rows is what is sent (the printer's fixed 1920-dot head width); printCols is the part that lands
     * on the paper (6-inch media 1844, 5-inch media 1548). code is the IMAGE MULTICUT value.
     */
    class Sheet(val code: String, val cols: Int, val rows: Int, val printCols: Int, val name: String)

    private val SHEET_3X5 = Sheet("01", 1920, 1088, 1548, "3.5×5")
    private val SHEET_4X6 = Sheet("02", 1920, 1240, 1844, "4×6")
    private val SHEET_5X7 = Sheet("03", 1920, 2138, 1548, "5×7")
    private val SHEET_6X8 = Sheet("04", 1920, 2436, 1844, "6×8")
    private val SHEET_6X9 = Sheet("05", 1920, 2740, 1844, "6×9")

    private fun near(a: Double, b: Double, tol: Double) = Math.abs(a - b) <= tol

    /** The sheet for a paper size in mm (any orientation), or null when DNP has no such paper. */
    fun sheetFor(widthMm: Double, heightMm: Double): Sheet? {
        val s = minOf(widthMm, heightMm); val l = maxOf(widthMm, heightMm)
        return when {
            near(s, 101.6, 6.0) && near(l, 152.4, 6.0) -> SHEET_4X6        // 4x6, SELPHY postcard, A6
            near(s, 88.9, 5.0) && near(l, 127.0, 5.0) -> SHEET_3X5
            near(s, 127.0, 5.0) && near(l, 177.8, 6.0) -> SHEET_5X7
            near(s, 152.4, 5.0) && near(l, 203.2, 6.0) -> SHEET_6X8
            near(s, 152.4, 5.0) && near(l, 228.6, 6.0) -> SHEET_6X9
            else -> null
        }
    }

    /** A single 2×6 strip: printed twice, side by side, on a 4×6 sheet that the printer cuts in half. */
    fun isSingleStrip(widthMm: Double, heightMm: Double): Boolean {
        val s = minOf(widthMm, heightMm); val l = maxOf(widthMm, heightMm)
        return s <= 60.0 && near(l, 152.4, 8.0)
    }

    private fun header(group: String, name: String, len: Int?): ByteArray {
        val h = ByteArray(32) { 0x20 }
        h[0] = 0x1b; h[1] = 'P'.code.toByte()
        val g = group.toByteArray(Charsets.US_ASCII); g.copyInto(h, 2, 0, minOf(6, g.size))
        val n = name.toByteArray(Charsets.US_ASCII); n.copyInto(h, 8, 0, minOf(16, n.size))
        if (len != null) "%08d".format(len).toByteArray(Charsets.US_ASCII).copyInto(h, 24)
        return h
    }

    private fun cmd(group: String, name: String, payload: String? = null): ByteArray {
        if (payload == null) return header(group, name, null)
        val p = payload.toByteArray(Charsets.US_ASCII)
        return header(group, name, p.size) + p
    }

    /**
     * Builds one complete DNP print job.
     * @param stripCut the page holds two 2×6 strips side by side: cut the 4×6 sheet in half (2-inch cut).
     */
    fun build(src: Bitmap, widthMm: Double, heightMm: Double, copies: Int, matte: Boolean, stripCut: Boolean, adj: PrintColorAdj): ByteArray {
        var page = src
        var ownPage = false
        var cut = stripCut
        val sheet: Sheet
        if (isSingleStrip(widthMm, heightMm)) {
            // Portrait strip, twice, side by side = a portrait 4x6 page with the cut down the middle.
            val strip = if (src.width > src.height) Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(90f) }, true) else src
            val two = Bitmap.createBitmap(strip.width * 2, strip.height, Bitmap.Config.ARGB_8888)
            Canvas(two).apply {
                drawColor(android.graphics.Color.WHITE)
                drawBitmap(strip, 0f, 0f, null)
                drawBitmap(strip, strip.width.toFloat(), 0f, null)
            }
            if (strip !== src) try { strip.recycle() } catch (_: Exception) {}
            page = two; ownPage = true; cut = true
            sheet = SHEET_4X6
        } else {
            sheet = sheetFor(widthMm, heightMm)
                ?: throw IllegalStateException("A DNP printer can't print %.0f×%.0f mm. Choose 4×6, 2×6, 3.5×5, 5×7, 6×8 or 6×9 paper.".format(minOf(widthMm, heightMm), maxOf(widthMm, heightMm)))
        }
        if (cut && sheet !== SHEET_4X6) cut = false     // the 2-inch cut only exists on 4x6 sheets

        val cols = sheet.cols
        val rows = sheet.rows
        // Turn the page so its long side runs the same way as the printed area's long side.
        val boxLandscape = sheet.printCols > rows
        val pageLandscape = page.width > page.height
        val turned = if (boxLandscape != pageLandscape)
            Bitmap.createBitmap(page, 0, 0, page.width, page.height, Matrix().apply { postRotate(90f) }, true) else page
        if (turned !== page && ownPage) try { page.recycle() } catch (_: Exception) {}

        val img = Bitmap.createBitmap(cols, rows, Bitmap.Config.ARGB_8888)
        val cv = Canvas(img)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        adj.toColorFilter()?.let { paint.colorFilter = it }
        cv.drawColor(android.graphics.Color.WHITE)
        // The dots outside the paper (head is wider than the media): the page stretched, so a slightly off-centre cut never
        // shows white. Then the page itself, filling the paper area, centre-cropped where the shapes differ a little.
        cv.drawBitmap(turned, null, Rect(0, 0, cols, rows), paint)
        val boxL = (cols - sheet.printCols) / 2f
        val box = RectF(boxL, 0f, boxL + sheet.printCols, rows.toFloat())
        val scale = maxOf(box.width() / turned.width, box.height() / turned.height)
        val dw = turned.width * scale; val dh = turned.height * scale
        cv.save()
        cv.clipRect(box)
        cv.drawBitmap(turned, null, RectF(box.centerX() - dw / 2, box.centerY() - dh / 2, box.centerX() + dw / 2, box.centerY() + dh / 2), paint)
        cv.restore()
        if (turned !== src) try { turned.recycle() } catch (_: Exception) {}

        // ---- job bytes ----
        val pre = cmd("CNTRL", "QTY", "%07d\r".format(copies.coerceIn(1, 99))) +
            cmd("CNTRL", "OVERCOAT", "000000" + (if (matte) "01" else "00")) +
            cmd("CNTRL", "CUTTER", "%08d".format(if (cut) 120 else 0)) +
            cmd("IMAGE", "MULTICUT", "000000" + sheet.code)
        val end = cmd("CNTRL", "START")
        val pad = 10
        val pixOff = 54 + 1024 + pad
        val plane = cols * rows
        val fsize = pixOff + plane
        val blockLen = 32 + fsize
        val out = ByteArray(pre.size + blockLen * 3 + end.size)
        pre.copyInto(out, 0)
        val starts = IntArray(3)
        for ((k, letter) in listOf("Y", "M", "C").withIndex()) {
            val at = pre.size + blockLen * k
            header("IMAGE", letter + "PLANE", fsize).copyInto(out, at)
            bmpHeader(out, at + 32, cols, rows, fsize, pixOff)
            starts[k] = at + 32 + pixOff
        }
        end.copyInto(out, pre.size + blockLen * 3)

        // BMP rows run bottom to top.
        val px = IntArray(cols)
        for (y in 0 until rows) {
            img.getPixels(px, 0, cols, 0, y, cols, 1)
            val row = (rows - 1 - y) * cols
            val yo = starts[0] + row; val mo = starts[1] + row; val co = starts[2] + row
            for (x in 0 until cols) {
                val p = px[x]
                out[yo + x] = (p and 0xFF).toByte()             // blue  -> yellow plane
                out[mo + x] = ((p ushr 8) and 0xFF).toByte()    // green -> magenta plane
                out[co + x] = ((p ushr 16) and 0xFF).toByte()   // red   -> cyan plane
            }
        }
        img.recycle()
        Log.i(TAG, "job sheet=${sheet.name} ${cols}x$rows cut=$cut matte=$matte copies=$copies bytes=${out.size}")
        return out
    }

    private fun le32(b: ByteArray, at: Int, v: Int) { b[at] = v.toByte(); b[at + 1] = (v ushr 8).toByte(); b[at + 2] = (v ushr 16).toByte(); b[at + 3] = (v ushr 24).toByte() }
    private fun le16(b: ByteArray, at: Int, v: Int) { b[at] = v.toByte(); b[at + 1] = (v ushr 8).toByte() }

    /** 54-byte 8-bit BMP header; the 1024-byte palette and the 10-byte pad after it stay zero. */
    private fun bmpHeader(b: ByteArray, at: Int, w: Int, h: Int, fsize: Int, pixOff: Int) {
        b[at] = 'B'.code.toByte(); b[at + 1] = 'M'.code.toByte()
        le32(b, at + 2, fsize)
        le32(b, at + 10, pixOff)
        le32(b, at + 14, 40)
        le32(b, at + 18, w)
        le32(b, at + 22, h)
        le16(b, at + 26, 1)
        le16(b, at + 28, 8)
        le32(b, at + 34, w * h)
        le32(b, at + 38, 11811)     // 300 dpi in pixels per metre
        le32(b, at + 42, 11811)
    }

    // ---- talking to the printer ----

    private fun drain(conn: UsbDeviceConnection, inn: UsbEndpoint) {
        val b = ByteArray(4096)
        for (i in 0 until 8) if (conn.bulkTransfer(inn, b, b.size, 60) <= 0) break
    }

    /** Sends a query and returns its ASCII answer, or null when the printer does not answer. */
    fun query(conn: UsbDeviceConnection, out: UsbEndpoint, inn: UsbEndpoint, group: String, name: String): String? {
        drain(conn, inn)
        val c = cmd(group, name)
        if (conn.bulkTransfer(out, c, c.size, 5000) != c.size) return null
        val got = java.io.ByteArrayOutputStream()
        val b = ByteArray(4096)
        val t0 = System.currentTimeMillis()
        while (System.currentTimeMillis() - t0 < 4000) {
            val n = conn.bulkTransfer(inn, b, b.size, 1500)
            if (n > 0) got.write(b, 0, n)
            val all = got.toByteArray()
            if (all.size >= 8) {
                val len = String(all, 0, 8, Charsets.US_ASCII).trim().toIntOrNull() ?: return String(all, Charsets.US_ASCII).trim()
                if (all.size >= 8 + len) return String(all, 8, len, Charsets.US_ASCII).trim()
            }
        }
        val all = got.toByteArray()
        return if (all.size > 8) String(all, 8, all.size - 8, Charsets.US_ASCII).trim() else null
    }

    /** Printer state number (0 idle, 1 printing, 1000+ an error), or null when it does not answer. */
    fun status(conn: UsbDeviceConnection, out: UsbEndpoint, inn: UsbEndpoint): Int? =
        query(conn, out, inn, "STATUS", "")?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() }

    /** Free page buffers ("FBP02" = 2), or null when unknown. */
    fun freeBuffers(conn: UsbDeviceConnection, out: UsbEndpoint, inn: UsbEndpoint): Int? =
        query(conn, out, inn, "INFO", "FREE_PBUFFER")?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() }

    fun isError(st: Int) = st >= 1000

    fun statusText(st: Int): String = when (st) {
        0 -> "Idle"
        1 -> "Printing"
        500 -> "Cooling the print head"
        510 -> "Cooling the paper motor"
        900 -> "Standby"
        1000 -> "Cover open — close the printer door"
        1010 -> "No scrap box — put the scrap box back"
        1100 -> "Paper end — load a new paper roll"
        1200 -> "Ribbon end — load a new ribbon"
        1300 -> "Paper jam — open the printer and clear the paper"
        1400 -> "Ribbon error — check the ribbon is loaded properly"
        1500 -> "Paper definition error — the loaded paper doesn't match the print size chosen"
        1600 -> "Data error — power the printer off and on, then retry"
        2000 -> "Head voltage error"
        2100 -> "Head position error"
        2200 -> "Power supply fan error"
        2300 -> "Cutter error"
        2400 -> "Pinch roller error"
        2500 -> "Head temperature error"
        2600 -> "Media temperature error"
        2610 -> "Paper motor temperature error"
        2700 -> "Ribbon tension error"
        2800 -> "RFID module error"
        3000 -> "System error — power the printer off and on"
        else -> if (st >= 1000) "Printer error $st" else "Busy ($st)"
    }

    /**
     * Sends print jobs: waits for a free page buffer before each, stops on a printer error, then waits (up to 2 min)
     * for the last sheet to finish so paper / ribbon errors are reported. A printer that never answers status
     * queries is printed to anyway.
     */
    fun send(conn: UsbDeviceConnection, out: UsbEndpoint, inn: UsbEndpoint?, jobs: List<ByteArray>, write: (ByteArray) -> Unit) {
        fun fail(st: Int): Nothing = throw IllegalStateException("DNP printer: " + statusText(st))
        var answers = inn != null
        for (job in jobs) {
            if (answers && inn != null) {
                val t0 = System.currentTimeMillis()
                while (true) {
                    val st = status(conn, out, inn)
                    if (st == null) { answers = false; Log.w(TAG, "no status reply; printing anyway"); break }
                    if (isError(st)) fail(st)
                    val fb = freeBuffers(conn, out, inn)
                    if (fb == null || fb > 0) break
                    if (System.currentTimeMillis() - t0 > 90_000) throw IllegalStateException("The DNP printer stayed busy for 90 seconds. Check it and retry.")
                    try { Thread.sleep(1000) } catch (_: Exception) {}
                }
            }
            write(job)
        }
        if (!answers || inn == null) return
        val t0 = System.currentTimeMillis()
        var started = false
        while (System.currentTimeMillis() - t0 < 120_000) {
            try { Thread.sleep(1000) } catch (_: Exception) {}
            val st = status(conn, out, inn) ?: return
            if (isError(st)) fail(st)
            if (st == 1) started = true
            if ((st == 0 || st == 900) && (started || System.currentTimeMillis() - t0 > 6000)) return
        }
    }
}
