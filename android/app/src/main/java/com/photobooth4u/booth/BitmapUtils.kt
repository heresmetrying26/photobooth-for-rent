package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint

/**
 * Colour-correction settings for print output.
 *
 * All values are in the range -100 … +100 (0 = no change).
 * Positive = brighter / more of that channel, negative = darker / less.
 *
 * @param brightness  Overall luminance offset applied to R, G, and B equally.
 * @param red         Per-channel red offset (applied after brightness).
 * @param green       Per-channel green offset (applied after brightness).
 * @param blue        Per-channel blue offset (applied after brightness).
 */
data class PrintColorAdj(
    val brightness: Int = 0,
    val red: Int = 0,
    val green: Int = 0,
    val blue: Int = 0
) {
    val isNoop get() = brightness == 0 && red == 0 && green == 0 && blue == 0

    companion object {
        /** Parse from an optionsJson JSONObject (all keys optional; missing = 0). */
        fun from(o: org.json.JSONObject) = PrintColorAdj(
            brightness = o.optInt("brightness", 0).coerceIn(-100, 100),
            red        = o.optInt("red",        0).coerceIn(-100, 100),
            green      = o.optInt("green",      0).coerceIn(-100, 100),
            blue       = o.optInt("blue",       0).coerceIn(-100, 100)
        )
    }

    /** Creates a native ColorMatrixColorFilter for hardware-accelerated drawing. */
    fun toColorFilter(): ColorMatrixColorFilter? {
        if (isNoop) return null
        val bOff = (brightness.coerceIn(-100, 100) * 2.55f)
        val rOff = bOff + (red.coerceIn(-100, 100) * 2.55f)
        val gOff = bOff + (green.coerceIn(-100, 100) * 2.55f)
        val bOff2 = bOff + (blue.coerceIn(-100, 100) * 2.55f)
        val matrix = ColorMatrix(floatArrayOf(
            1f, 0f, 0f, 0f, rOff,
            0f, 1f, 0f, 0f, gOff,
            0f, 0f, 1f, 0f, bOff2,
            0f, 0f, 0f, 1f, 0f
        ))
        return ColorMatrixColorFilter(matrix)
    }
}

/**
 * Applies [PrintColorAdj] to every pixel and returns the adjusted bitmap.
 * Returns `this` unchanged when all adjustments are zero.
 * Uses native Skia ColorMatrixColorFilter via Canvas for high performance.
 */
fun Bitmap.applyColorAdj(adj: PrintColorAdj): Bitmap {
    if (adj.isNoop) return this

    val filter = adj.toColorFilter() ?: return this
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply {
        colorFilter = filter
    }
    canvas.drawBitmap(this, 0f, 0f, paint)
    return out
}

/** Convenience overload that accepts the legacy single-int brightness. */
fun Bitmap.applyBrightness(brightness: Int): Bitmap =
    applyColorAdj(PrintColorAdj(brightness = brightness))
