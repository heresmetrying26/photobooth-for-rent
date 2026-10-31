package com.photobooth4u.booth

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.content.Intent
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.print.pdf.PrintedPdfDocument
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileOutputStream

/**
 * PrintBridge — injected into the WebView as window.__PBPrint.
 *
 * WebView ignores window.print(), so this hands the booth's print pages to Android's own print system.
 * The system print dialog lists every printer the tablet can reach: Wi-Fi / network printers found by the
 * built-in Mopria service, and any maker's print service that is installed (Epson, Canon, HP, Brother, …).
 * That covers Epson inkjet and photo printers, which the Bluetooth receipt-printer bridge (BTBridge) cannot.
 */
class PrintBridge(private val activity: Activity) {

    companion object {
        private const val TAG = "PBPrint"
    }

    @JavascriptInterface
    fun isAvailable(): Boolean = activity.getSystemService(PrintManager::class.java) != null

    /** Opens Android's own Printing settings, where print services (Mopria, Epson, Canon, HP, Brother...) are switched on. */
    @JavascriptInterface
    fun openPrintSettings(): Boolean = try {
        activity.runOnUiThread {
            try { activity.startActivity(Intent(Settings.ACTION_PRINT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            catch (e: Exception) { Log.w(TAG, "print settings", e) }
        }
        true
    } catch (e: Exception) { false }

    /**
     * pagesJson: JSON array of base64 JPEG/PNG images, one per sheet. widthMm/heightMm: the sheet size.
     * Returns {"ok":true} once the system print dialog has been asked to open, or {"ok":false,"error":"…"}.
     */
    @JavascriptInterface
    fun print(jobName: String, widthMm: Double, heightMm: Double, pagesJson: String): String {
        val res = JSONObject()
        try {
            val pm = activity.getSystemService(PrintManager::class.java)
                ?: return res.put("ok", false).put("error", "This tablet has no print service.").toString()
            val arr = JSONArray(pagesJson)
            if (arr.length() == 0) return res.put("ok", false).put("error", "Nothing to print.").toString()
            val pages = ArrayList<ByteArray>(arr.length())
            for (i in 0 until arr.length()) {
                var s = arr.getString(i)
                val comma = s.indexOf(',')
                if (s.startsWith("data:") && comma >= 0) s = s.substring(comma + 1)
                pages.add(Base64.decode(s, Base64.DEFAULT))
            }
            val wMils = Math.round(widthMm / 25.4 * 1000).toInt().coerceAtLeast(1000)
            val hMils = Math.round(heightMm / 25.4 * 1000).toInt().coerceAtLeast(1000)
            val size = PrintAttributes.MediaSize("pb_${wMils}x$hMils", "Booth ${widthMm.toInt()}x${heightMm.toInt()} mm", wMils, hMils)
            val attrs = PrintAttributes.Builder()
                .setMediaSize(if (hMils >= wMils) size.asPortrait() else size.asLandscape())
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                .build()
            val name = if (jobName.isBlank()) "Photobooth" else jobName
            activity.runOnUiThread {
                try {
                    pm.print(name, PagesAdapter(name, pages), attrs)
                } catch (e: Exception) {
                    Log.w(TAG, "print dialog failed", e)
                }
            }
            res.put("ok", true)
        } catch (e: Exception) {
            Log.w(TAG, "print failed", e)
            res.put("ok", false).put("error", e.message ?: "Couldn't start printing.")
        }
        return res.toString()
    }

    /** Draws each image full-bleed on its own PDF page, sized to whatever paper the user picks in the dialog. */
    private inner class PagesAdapter(private val name: String, private val pages: List<ByteArray>) : PrintDocumentAdapter() {
        private var attrs: PrintAttributes? = null

        override fun onLayout(
            old: PrintAttributes?, new: PrintAttributes, signal: CancellationSignal?,
            callback: LayoutResultCallback, extras: Bundle?
        ) {
            if (signal?.isCanceled == true) { callback.onLayoutCancelled(); return }
            attrs = new
            val info = PrintDocumentInfo.Builder("$name.pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_PHOTO)
                .setPageCount(pages.size)
                .build()
            callback.onLayoutFinished(info, old != new)
        }

        override fun onWrite(
            ranges: Array<out PageRange>, dest: ParcelFileDescriptor, signal: CancellationSignal?,
            callback: WriteResultCallback
        ) {
            val a = attrs ?: run { callback.onWriteFailed("No layout"); return }
            Thread {
                val pdf = PrintedPdfDocument(activity, a)
                try {
                    for (i in pages.indices) {
                        if (signal?.isCanceled == true) { callback.onWriteCancelled(); return@Thread }
                        val bmp: Bitmap? = BitmapFactory.decodeByteArray(pages[i], 0, pages[i].size)
                        val page = pdf.startPage(i)
                        if (bmp != null) {
                            val c = page.canvas
                            c.drawBitmap(bmp, null, Rect(0, 0, c.width, c.height), null)
                            bmp.recycle()
                        }
                        pdf.finishPage(page)
                    }
                    FileOutputStream(dest.fileDescriptor).use { pdf.writeTo(it) }
                    callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                } catch (e: Exception) {
                    Log.w(TAG, "write failed", e)
                    callback.onWriteFailed(e.message)
                } finally {
                    pdf.close()
                    try { dest.close() } catch (_: Exception) {}
                }
            }.start()
        }
    }
}
