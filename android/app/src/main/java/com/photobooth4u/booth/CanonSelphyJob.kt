package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Matrix

/**
 * Direct dye-sublimation print driver for Canon SELPHY CP-series photo printers over USB:
 * CP820 / CP910 / CP1000 / CP1200 / CP1300 / CP1500.
 *
 * Implements the Canon SELPHY Neo USB protocol (32-byte header + 3-plane YUV444 raster).
 * Supports Postcard (4x6" / 100x148 mm), L size (3.5x5" / 89x119 mm), and Card size (54x86 mm).
 */
object CanonSelphyJob {

    const val VENDOR_ID = 0x04a9

    val PRODUCT_IDS = setOf(
        0x327a, // CP910
        0x327b, // CP820
        0x32ae, // CP1000
        0x32b1, // CP1200
        0x32db, // CP1300
        0x3302  // CP1500
    )

    class PaperSpec(val code: Byte, val cols: Int, val rows: Int, val name: String)

    val SPEC_P = PaperSpec(0x50.toByte(), 1248, 1872, "Postcard 4x6\"")
    val SPEC_L = PaperSpec(0x4C.toByte(), 1152, 1472, "L size 3.5x5\"")
    val SPEC_C = PaperSpec(0x43.toByte(), 1088, 668, "Card size")

    fun specFor(widthMm: Double, heightMm: Double): PaperSpec {
        val w = minOf(widthMm, heightMm)
        val h = maxOf(widthMm, heightMm)
        fun near(a: Double, b: Double, tol: Double = 10.0) = Math.abs(a - b) < tol
        return when {
            near(w, 54.0) && near(h, 86.0) -> SPEC_C
            near(w, 89.0) && near(h, 119.0) -> SPEC_L
            else -> SPEC_P // Default to 4x6 Postcard (Canon KP-108IN / RP-108)
        }
    }

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, brightness: Int = 0): ByteArray =
        build(src, widthMm, heightMm, PrintColorAdj(brightness = brightness))

    fun build(src: Bitmap, widthMm: Double, heightMm: Double, adj: PrintColorAdj): ByteArray {
        val spec = specFor(widthMm, heightMm)
        val cols = spec.cols
        val rows = spec.rows

        // Rotate if needed to match the portrait feed orientation (cols < rows)
        val needsRotate = src.width > src.height && cols < rows
        val rotatedSrc: Bitmap
        val shouldRecycleRotated: Boolean
        if (needsRotate) {
            rotatedSrc = Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(90f) }, true)
            shouldRecycleRotated = (rotatedSrc !== src)
        } else {
            rotatedSrc = src
            shouldRecycleRotated = false
        }

        // Scale and apply color adjustment at target dimensions (cols x rows) to minimize memory and CPU
        val bmp = if (rotatedSrc.width == cols && rotatedSrc.height == rows && adj.isNoop) {
            rotatedSrc
        } else {
            val target = Bitmap.createBitmap(cols, rows, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(target)
            val paint = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG or android.graphics.Paint.ANTI_ALIAS_FLAG)
            val filter = adj.toColorFilter()
            if (filter != null) paint.colorFilter = filter
            val scaleMatrix = Matrix()
            scaleMatrix.postScale(cols.toFloat() / rotatedSrc.width, rows.toFloat() / rotatedSrc.height)
            canvas.drawBitmap(rotatedSrc, scaleMatrix, paint)
            target
        }
        if (shouldRecycleRotated) {
            try { rotatedSrc.recycle() } catch (_: Exception) {}
        }

        val planeSize = cols * rows
        val totalSize = 32 + planeSize * 3
        val out = ByteArray(totalSize)

        // 32-byte Canon SELPHY Neo header
        out[0] = 0x0F.toByte()
        out[3] = 0x40.toByte()
        out[14] = 0x01.toByte()
        out[16] = 0x01.toByte()
        out[18] = spec.code // 0x50 ('P'), 0x4C ('L'), or 0x43 ('C')
        out[23] = 0x00.toByte() // 0x00 = YUV444 format

        // cols (32-bit Little Endian)
        out[24] = (cols and 0xFF).toByte()
        out[25] = ((cols shr 8) and 0xFF).toByte()
        out[26] = ((cols shr 16) and 0xFF).toByte()
        out[27] = ((cols shr 24) and 0xFF).toByte()

        // rows (32-bit Little Endian)
        out[28] = (rows and 0xFF).toByte()
        out[29] = ((rows shr 8) and 0xFF).toByte()
        out[30] = ((rows shr 16) and 0xFF).toByte()
        out[31] = ((rows shr 24) and 0xFF).toByte()

        // Three sequential planes: Y (Luma), U (Cb), V (Cr)
        val yOffset = 32
        val uOffset = 32 + planeSize
        val vOffset = 32 + planeSize * 2

        val pixels = IntArray(cols)
        for (y in 0 until rows) {
            bmp.getPixels(pixels, 0, cols, 0, y, cols, 1)
            val rowStart = y * cols
            for (x in 0 until cols) {
                val pix = pixels[x]
                val r = (pix ushr 16) and 0xFF
                val g = (pix ushr 8) and 0xFF
                val b = pix and 0xFF

                // Standard ITU-R BT.601 integer fixed-point conversion
                val luma = ((77 * r + 150 * g + 29 * b + 128) shr 8).coerceIn(0, 255)
                val cb = (((-43 * r - 85 * g + 128 * b + 128) shr 8) + 128).coerceIn(0, 255)
                val cr = (((128 * r - 107 * g - 21 * b + 128) shr 8) + 128).coerceIn(0, 255)

                val idx = rowStart + x
                out[yOffset + idx] = luma.toByte()
                out[uOffset + idx] = cb.toByte()
                out[vOffset + idx] = cr.toByte()
            }
        }

        if (bmp !== src) {
            try { bmp.recycle() } catch (_: Exception) {}
        }

        return out
    }

    fun statusDescription(statusByte: Int): String = when (statusByte) {
        0x01 -> "Idle"
        0x02 -> "Feeding paper"
        0x04 -> "Printing Yellow pass"
        0x08 -> "Printing Magenta pass"
        0x10 -> "Printing Cyan pass"
        0x20 -> "Laminating protective coat"
        else -> "Working (0x%02x)".format(statusByte)
    }

    fun errorDescription(errorCode: Int): String = when (errorCode) {
        0x00 -> ""
        0x01 -> "Low battery"
        0x02 -> "Paper feed error — check paper cassette"
        0x03 -> "No paper cassette inserted"
        0x04 -> "Incorrect paper cassette"
        0x05 -> "Incorrect paper loaded"
        0x06 -> "Ink cassette empty"
        0x07 -> "No ink cassette inserted"
        0x08 -> "Incorrect ink cassette"
        0x09 -> "No paper and no ink"
        0x0A -> "Media/job mismatch — check paper vs ink"
        0x0B -> "Paper jam"
        0x0C -> "Ink ribbon jam"
        0x0D -> "Ink ribbon invalid"
        0x0E -> "Unknown ink cassette"
        0x0F -> "Unknown paper"
        0x10 -> "Unknown command"
        else -> "Printer error (0x%02x)".format(errorCode)
    }
}

