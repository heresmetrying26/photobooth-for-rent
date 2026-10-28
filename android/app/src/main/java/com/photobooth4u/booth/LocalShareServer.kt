package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The guests' pages, served from this tablet over the booth Wi-Fi (mirrors the share server in
 * desktop/lib/photos.mjs, with the same addresses):
 *
 *   http://<tablet>:47777/e/<event>/                the event's photos
 *   http://<tablet>:47777/e/<event>/p/<file>        one photo / GIF, with a Save button
 *   http://<tablet>:47777/e/<event>/f/<file>        the file itself (add ?dl=1 to download)
 *   http://<tablet>:47777/e/<event>/t/<file>        a small preview of it
 *   http://<tablet>:47777/e/<event>/list.json       what the pages above show
 *
 * Read-only: guests can only look at and save photos. Nothing is sent to the internet.
 */
class LocalShareServer(private val store: PBLocal) {

    companion object {
        private const val TAG = "PBShare"
        val PORTS = intArrayOf(47777, 47778, 47779, 47787, 47797)
        private val ROUTE = Regex("^/e/([A-Za-z0-9]{6,20})(?:/(?:(p|f|t)/([^/]+)|(list\\.json)))?/?$")
        private val FILENAME_UNSAFE = Regex("[^\\w.() -]")
        private const val THUMB_MAX = 640
    }

    @Volatile
    private var server: ServerSocket? = null
    private var pool: ExecutorService? = null
    private val thumbLock = Any()
    private var galleryHtml: ByteArray? = null

    /** Starts listening on the first free port; returns it, or 0 when none is free. */
    @Synchronized
    fun start(): Int {
        if (server != null) return store.sharePort
        for (p in PORTS) {
            var ss: ServerSocket? = null
            try {
                ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(p))
                server = ss
                pool = Executors.newCachedThreadPool { r ->
                    val t = Thread(r, "pb-share-conn")
                    t.isDaemon = true
                    t
                }
                store.sharePort = p
                val accept = ss
                val t = Thread({ acceptLoop(accept) }, "pb-share")
                t.isDaemon = true
                t.start()
                Log.i(TAG, "Sharing photos on port $p")
                return p
            } catch (e: IOException) {
                Log.w(TAG, "Port $p is busy", e)
                try { ss?.close() } catch (_: IOException) { }
            }
        }
        store.sharePort = 0
        return 0
    }

    @Synchronized
    fun stop() {
        try { server?.close() } catch (_: IOException) { }
        server = null
        pool?.shutdownNow()
        pool = null
        store.sharePort = 0
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (!ss.isClosed) {
            try {
                val s = ss.accept()
                val p = pool
                if (p == null) { s.close(); break }
                p.execute { handle(s) }
            } catch (e: RejectedExecutionException) {
                break
            } catch (e: IOException) {
                if (ss.isClosed) break
                try { Thread.sleep(50) } catch (_: InterruptedException) { break }
            }
        }
    }

    private fun handle(s: Socket) {
        try {
            s.soTimeout = 15000
            s.tcpNoDelay = true
            val input = BufferedInputStream(s.getInputStream())
            val out = BufferedOutputStream(s.getOutputStream(), 65536)
            val head = readHead(input) ?: return
            route(head, out)
            out.flush()
        } catch (e: Exception) {
            // the phone went away or timed out: nothing to do
        } finally {
            try { s.close() } catch (_: Exception) { }
        }
    }

    // Reads the request line and headers (up to 16 KB); the body of a GET is ignored.
    private fun readHead(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        var last4 = 0
        while (buf.size() < 16384) {
            val b = input.read()
            if (b < 0) return null
            buf.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0D0A0D0A) return buf.toString("ISO-8859-1")
        }
        return null
    }

    private fun route(head: String, out: OutputStream) {
        val eol = head.indexOf("\r\n")
        val line = if (eol >= 0) head.substring(0, eol) else head
        val parts = line.split(" ")
        if (parts.size < 2) return sendText(out, 400, "Bad Request", "Bad request", false)
        val method = parts[0]
        val headOnly = method == "HEAD"
        if (method != "GET" && !headOnly) return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)

        val target = parts[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = if (q >= 0) target.substring(q + 1) else ""

        val m = ROUTE.find(path)
        if (m == null) {
            if (path == "/") return sendText(out, 200, "OK", "photobooth4u booth", headOnly)
            return notFoundPage(out, "This link isn’t on this booth.", headOnly)
        }
        val slug = m.groupValues[1]
        val kind = m.groupValues[2]
        val fileEnc = m.groupValues[3]
        val isList = m.groupValues[4].isNotEmpty()

        // The page itself is the same for every event; it reads the event's list.json.
        if (!isList && (kind.isEmpty() || kind == "p")) {
            val html = galleryHtml ?: store.readAsset("share/gallery.html")?.also { galleryHtml = it }
                ?: return sendText(out, 500, "Internal Server Error", "Gallery page missing", headOnly)
            return sendBytes(out, 200, "OK", "text/html; charset=utf-8", html, headOnly, "no-store")
        }

        val folder = store.folderBySlug(slug)
        val dir = if (folder != null) store.dirOf(folder) else null
        if (folder == null || dir == null || !dir.isDirectory) {
            if (isList) return sendBytes(out, 404, "Not Found", "application/json; charset=utf-8", "{\"error\":\"not found\"}".toByteArray(Charsets.UTF_8), headOnly, "no-store")
            return notFoundPage(out, "This event isn’t on this booth anymore.", headOnly)
        }

        if (isList) {
            val arr = JSONArray()
            for (f in store.photosIn(dir)) arr.put(JSONObject().put("n", f.name))
            val o = JSONObject().put("name", store.galleryTitle(folder)).put("files", arr)
            return sendBytes(out, 200, "OK", "application/json; charset=utf-8", o.toString().toByteArray(Charsets.UTF_8), headOnly, "no-store")
        }

        // f = the file, t = a small preview of it
        val name = Uri.decode(fileEnc)
        if (name.isEmpty() || name != File(name).name || name.startsWith(".") || !PBLocal.IMG_RE.containsMatchIn(name)) {
            return sendText(out, 404, "Not Found", "Not found", headOnly)
        }
        val file = File(dir, name)
        if (!file.isFile) return sendText(out, 404, "Not Found", "Not found", headOnly)

        if (kind == "t") {
            val thumb = thumbFor(dir, file)
            if (thumb != null) return sendFile(out, thumb, "image/jpeg", headOnly, "max-age=600", null)
        }
        val download = query.split("&").any { it == "dl=1" || it.startsWith("dl=") && it.length > 3 }
        val disposition = if (download) "attachment; filename=\"" + name.replace(FILENAME_UNSAFE, "_") + "\"" else null
        return sendFile(out, file, contentType(name), headOnly, "max-age=600", disposition)
    }

    private fun contentType(name: String): String = when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        else -> "application/octet-stream"
    }

    // ---------- previews ----------

    // A small JPEG of a photo for the grid, made once and kept in the event folder (.thumbs).
    private fun thumbFor(dir: File, file: File): File? {
        val ext = file.extension.lowercase(Locale.ROOT)
        if (ext != "jpg" && ext != "jpeg" && ext != "png" && ext != "webp") return null
        val tdir = File(dir, ".thumbs")
        val tf = File(tdir, file.nameWithoutExtension + ".jpg")
        if (tf.isFile && tf.lastModified() >= file.lastModified()) return tf
        synchronized(thumbLock) {
            if (tf.isFile && tf.lastModified() >= file.lastModified()) return tf
            try {
                val bounds = BitmapFactory.Options()
                bounds.inJustDecodeBounds = true
                BitmapFactory.decodeFile(file.path, bounds)
                val longest = maxOf(bounds.outWidth, bounds.outHeight)
                if (longest <= 0) return null
                var sample = 1
                while (longest / (sample * 2) >= THUMB_MAX) sample *= 2
                val opts = BitmapFactory.Options()
                opts.inSampleSize = sample
                val bmp = BitmapFactory.decodeFile(file.path, opts) ?: return null
                val scale = THUMB_MAX.toFloat() / maxOf(bmp.width, bmp.height)
                val small = if (scale < 1f) {
                    Bitmap.createScaledBitmap(bmp, maxOf(1, Math.round(bmp.width * scale)), maxOf(1, Math.round(bmp.height * scale)), true)
                } else bmp
                tdir.mkdirs()
                FileOutputStream(tf).use { small.compress(Bitmap.CompressFormat.JPEG, 72, it) }
                if (small !== bmp) small.recycle()
                bmp.recycle()
                return tf
            } catch (e: Throwable) {
                Log.w(TAG, "No preview for ${file.name}", e)
                return null            // the full photo is sent instead
            }
        }
    }

    // ---------- replies ----------

    private fun writeHead(out: OutputStream, status: Int, reason: String, type: String, length: Long, cache: String, disposition: String?) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
        sb.append("Content-Type: ").append(type).append("\r\n")
        sb.append("Content-Length: ").append(length).append("\r\n")
        sb.append("Cache-Control: ").append(cache).append("\r\n")
        if (disposition != null) sb.append("Content-Disposition: ").append(disposition).append("\r\n")
        sb.append("X-Content-Type-Options: nosniff\r\n")
        sb.append("Referrer-Policy: no-referrer\r\n")
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun sendBytes(out: OutputStream, status: Int, reason: String, type: String, body: ByteArray, headOnly: Boolean, cache: String) {
        writeHead(out, status, reason, type, body.size.toLong(), cache, null)
        if (!headOnly) out.write(body)
    }

    private fun sendText(out: OutputStream, status: Int, reason: String, body: String, headOnly: Boolean) {
        sendBytes(out, status, reason, "text/plain; charset=utf-8", body.toByteArray(Charsets.UTF_8), headOnly, "no-store")
    }

    private fun notFoundPage(out: OutputStream, message: String, headOnly: Boolean) {
        val html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<title>Not found</title></head><body style=\"font-family:system-ui,sans-serif;background:#F5F1EA;color:#6B666C;text-align:center;padding:48px 16px\">" +
            "<p>" + message + "</p></body></html>"
        sendBytes(out, 404, "Not Found", "text/html; charset=utf-8", html.toByteArray(Charsets.UTF_8), headOnly, "no-store")
    }

    private fun sendFile(out: OutputStream, f: File, type: String, headOnly: Boolean, cache: String, disposition: String?) {
        writeHead(out, 200, "OK", type, f.length(), cache, disposition)
        if (headOnly) return
        FileInputStream(f).use { it.copyTo(out, 65536) }
    }
}
