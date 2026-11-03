package com.photobooth4u.booth

import android.graphics.Bitmap

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
}

/**
 * Applies [PrintColorAdj] to every pixel and returns the adjusted bitmap.
 * Returns `this` unchanged when all adjustments are zero.
 */
fun Bitmap.applyColorAdj(adj: PrintColorAdj): Bitmap {
    if (adj.isNoop) return this

    // Scale -100…+100 → -255…+255 offset per channel (brightness is common to all).
    val bOff = (adj.brightness * 2.55).toInt()
    val rOff = bOff + (adj.red   * 2.55).toInt()
    val gOff = bOff + (adj.green * 2.55).toInt()
    val bOff2 = bOff + (adj.blue  * 2.55).toInt()

    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val px = IntArray(width)
    for (y in 0 until height) {
        getPixels(px, 0, width, 0, y, width, 1)
        for (x in 0 until width) {
            val c = px[x]
            val a =  (c ushr 24) and 0xFF
            val r = ((c shr 16) and 0xFF + rOff).coerceIn(0, 255)
            val g = ((c shr  8) and 0xFF + gOff).coerceIn(0, 255)
            val b = ( c         and 0xFF + bOff2).coerceIn(0, 255)
            px[x] = (a shl 24) or (r shl 16) or (g shl 8) or b
        }
        out.setPixels(px, 0, width, 0, y, width, 1)
    }
    return out
}

/** Convenience overload that accepts the legacy single-int brightness. */
fun Bitmap.applyBrightness(brightness: Int): Bitmap =
    applyColorAdj(PrintColorAdj(brightness = brightness))
