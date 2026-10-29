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
        private val SEND_ROUTE = Regex("^/send/([A-Za-z0-9]+)/(photos|photo)/?$")
        private val PRINT_ROUTE = Regex("^/e/([A-Za-z0-9]{6,20})/print/([^/]+)/?$")
        private val OWN_ROUTE = Regex("^/o/([A-Za-z0-9_-]{16,40})(?:/(f|print)/([^/]+))?/?$")
        private const val OWN_CSS = "*{box-sizing:border-box}html,body{margin:0}" +
            "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#F5F1EA;color:#1C1A1E;min-height:100vh}" +
            "header{padding:22px 16px 6px;text-align:center}.brand{font-weight:800;font-size:15px;letter-spacing:-.01em}" +
            "h1{font-size:24px;line-height:1.2;margin:10px 0 2px;font-weight:800;letter-spacing:-.02em}.sub{color:#6B666C;font-size:13px;margin:0 0 14px}" +
            ".one{max-width:560px;margin:0 auto;padding:6px 16px 20px;text-align:center}" +
            ".one img,.one video{max-width:100%;max-height:72vh;border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(60,40,20,.15)}" +
            ".btn{display:inline-block;margin:16px 6px 0;padding:14px 22px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:15px;border:0;font-family:inherit;cursor:pointer}" +
            ".btn.alt{background:#fff;color:#1C1A1E;border:1.5px solid #E4DCCF}.tip{color:#6B666C;font-size:13px;line-height:1.5;margin:14px auto 0;max-width:420px;text-align:center}" +
            ".empty{text-align:center;color:#6B666C;padding:40px 16px}"
        private const val ROVE_MAX = 80L * 1024L * 1024L
        private const val THUMB_MAX = 640
    }

    @Volatile
    private var server: ServerSocket? = null
    private var pool: ExecutorService? = null
    private val thumbLock = Any()
    private var galleryHtml: ByteArray? = null
    private var roveHtml: ByteArray? = null

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
            route(head, input, out, s.inetAddress?.hostAddress ?: "")
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

    private fun route(head: String, input: InputStream, out: OutputStream, ip: String) {
        val eol = head.indexOf("\r\n")
        val line = if (eol >= 0) head.substring(0, eol) else head
        val parts = line.split(" ")
        if (parts.size < 2) return sendText(out, 400, "Bad Request", "Bad request", false)
        val method = parts[0]
        val headOnly = method == "HEAD"

        val target = parts[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = if (q >= 0) target.substring(q + 1) else ""

        // A guest's own page (/o/<code>): only the files the booth saved for their session.
        val ownM = OWN_ROUTE.find(path)
        if (ownM != null) return ownRoute(ownM, method, query, out, ip)
        // "Guests see only their own photos": the event pages answer only this tablet itself (the operator), not a guest's phone.
        if (store.guestView == "only" && path.startsWith("/e/") && !store.isOwnAddress(ip)) {
            return sendBytes(out, 403, "Forbidden", "text/html; charset=utf-8", privatePage().toByteArray(Charsets.UTF_8), method == "HEAD", "no-store")
        }

        // A phone sending photos to the booth, and a guest asking for a print: the only things that are not read-only.
        val sendM = SEND_ROUTE.find(path)
        if (sendM != null) return sendRoute(sendM, method, head, input, out, query)
        val printM = PRINT_ROUTE.find(path)
        if (printM != null) return printRoute(printM, method, out, ip)

        if (method != "GET" && !headOnly) return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)

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
            val o = JSONObject().put("name", store.galleryTitle(folder)).put("files", arr).put("print", store.guestPrintOn)
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

    // ---------- phone photos and print requests ----------

    private fun headerValue(head: String, name: String): String? {
        for (line in head.split("\r\n")) {
            val i = line.indexOf(':')
            if (i > 0 && line.substring(0, i).trim().equals(name, ignoreCase = true)) return line.substring(i + 1).trim()
        }
        return null
    }

    private fun queryParam(query: String, key: String): String? {
        for (kv in query.split("&")) {
            val i = kv.indexOf('=')
            if (i > 0 && kv.substring(0, i) == key) return kv.substring(i + 1)
        }
        return null
    }

    private fun sendJson(out: OutputStream, status: Int, body: String) {
        val reason = when (status) {
            200 -> "OK"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            413 -> "Payload Too Large"
            429 -> "Too Many Requests"
            else -> "Internal Server Error"
        }
        sendBytes(out, status, reason, "application/json; charset=utf-8", body.toByteArray(Charsets.UTF_8), false, "no-store")
    }

    // /send/<token>/photos = the page a phone opens; /send/<token>/photo?name=... = the photo it posts
    private fun sendRoute(m: MatchResult, method: String, head: String, input: InputStream, out: OutputStream, query: String) {
        if (m.groupValues[1] != store.roveToken()) return sendText(out, 404, "Not Found", "Not found", false)
        if (m.groupValues[2] == "photos") {
            if (method != "GET" && method != "HEAD") return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
            val html = roveHtml ?: store.readAsset("share/rove.html")?.also { roveHtml = it }
                ?: return sendText(out, 500, "Internal Server Error", "Page missing", false)
            return sendBytes(out, 200, "OK", "text/html; charset=utf-8", html, method == "HEAD", "no-store")
        }
        if (method != "POST") return sendJson(out, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}")
        val len = headerValue(head, "content-length")?.toLongOrNull() ?: -1L
        if (len <= 0L || len > ROVE_MAX) return sendJson(out, 413, "{\"ok\":false,\"error\":\"Too big\"}")
        val name = Uri.decode(queryParam(query, "name") ?: "")
        val saved = store.saveRovePhoto(name, input, len)
            ?: return sendJson(out, 500, "{\"ok\":false,\"error\":\"Could not save\"}")
        sendJson(out, 200, JSONObject().put("ok", true).put("name", saved).toString())
    }

    // /e/<event>/print/<photo>: a guest asks for a print
    private fun printRoute(m: MatchResult, method: String, out: OutputStream, ip: String) {
        if (method != "POST") return sendJson(out, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}")
        val r = store.addPrintRequest(m.groupValues[1], Uri.decode(m.groupValues[2]), ip)
        sendJson(out, r.first, r.second)
    }

    // ---------- a guest's own page ----------

    private fun esc(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")

    private fun shell(title: String, body: String): String =
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<title>" + esc(title) + "</title><style>" + OWN_CSS + "</style></head><body><header><span class=\"brand\">photobooth4u</span></header>" +
            body + "</body></html>"

    private fun privatePage(): String =
        shell("Private", "<p class=\"empty\">Guests of this event see only their own photos. Scan your own QR code at the booth to open yours.</p>")

    // Not saved yet (or not a code of ours): the page checks again by itself and says nothing about which codes exist.
    private fun pendingPage(): String =
        shell("Your photos", "<div class=\"one\"><h1>Your photos are on their way</h1><p class=\"sub\">They appear here in a few seconds. You can keep this page open.</p></div>" +
            "<script>setTimeout(function(){location.reload()},4000)</script>")

    // /o/<code> = the page, /o/<code>/f/<file> = a file of theirs, /o/<code>/print/<file> = ask for a print
    private fun ownRoute(m: MatchResult, method: String, query: String, out: OutputStream, ip: String) {
        val code = m.groupValues[1]
        val kind = m.groupValues[2]
        val name = Uri.decode(m.groupValues[3])
        val headOnly = method == "HEAD"
        val c = store.guestCode(code)
        if (c == null) {
            if (kind == "print") return sendJson(out, 404, "{\"ok\":false,\"error\":\"photo\"}")
            if (kind.isNotEmpty()) return sendText(out, 404, "Not Found", "Not found", headOnly)
            return sendBytes(out, 200, "OK", "text/html; charset=utf-8", pendingPage().toByteArray(Charsets.UTF_8), headOnly, "no-store")
        }
        if (kind == "print") {
            if (method != "POST") return sendJson(out, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}")
            if (!c.files.contains(name)) return sendJson(out, 404, "{\"ok\":false,\"error\":\"photo\"}")
            val r = store.addPrintRequest(c.slug, name, ip)      // the same rules as every other print request
            return sendJson(out, r.first, r.second)
        }
        if (method != "GET" && !headOnly) return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
        val folder = store.folderBySlug(c.slug)
        val dir = if (folder != null) store.dirOf(folder) else null
        if (folder == null || dir == null || !dir.isDirectory) return notFoundPage(out, "This event isn’t on this booth anymore.", headOnly)
        if (kind == "f") {
            if (!c.files.contains(name)) return sendText(out, 404, "Not Found", "Not found", headOnly)
            val file = File(dir, name)
            if (!file.isFile) return sendText(out, 404, "Not Found", "Not found", headOnly)
            val download = query.split("&").any { it == "dl=1" }
            val disposition = if (download) "attachment; filename=\"" + name.replace(FILENAME_UNSAFE, "_") + "\"" else null
            return sendFile(out, file, contentType(name), headOnly, "max-age=600", disposition)
        }
        val mine = c.files.filter { File(dir, it).isFile }
        val sb = StringBuilder()
        sb.append("<div style=\"text-align:center;padding:0 16px\"><h1>Your photos</h1><p class=\"sub\">").append(esc(store.galleryTitle(folder))).append("</p></div>")
        if (mine.isEmpty()) {
            sb.append("<p class=\"empty\">This photo isn’t here yet. Wait a moment and refresh.</p><script>setTimeout(function(){location.reload()},5000)</script>")
        }
        val askJs = "function ask(b,u,k){b.disabled=true;b.textContent='Sending…';fetch(u,{method:'POST'}).then(function(r){return r.json()}).then(function(j){" +
            "if(j.ok){try{sessionStorage.setItem(k,'1')}catch(e){}b.textContent=j.done?'Already printed ✓':'Requested ✓'}" +
            "else{b.disabled=false;b.textContent=j.error==='rate'?'Please wait a little, then try again':j.error==='off'?'Print requests are off':'Could not send. Try again'}" +
            "}).catch(function(){b.disabled=false;b.textContent='Could not send. Try again'})}"
        var anyPrint = false
        for ((i, f) in mine.withIndex()) {
            val src = "/o/" + code + "/f/" + Uri.encode(f)
            val type = contentType(f)
            val isVid = type.startsWith("video/")
            val isGif = type == "image/gif"
            sb.append("<div class=\"one\" style=\"padding-bottom:6px\">")
            if (isVid) sb.append("<video src=\"").append(src).append("\" controls playsinline autoplay muted loop></video>")
            else sb.append("<img src=\"").append(src).append("\" alt=\"").append(if (isGif) "Your GIF" else "Your photo").append("\">")
            sb.append("<div><a class=\"btn\" href=\"").append(src).append("?dl=1\" download=\"").append(esc(f)).append("\">")
                .append(if (isVid) "Save video" else if (isGif) "Save GIF" else "Save photo").append("</a>")
            if (store.guestPrintOn && !isVid && !isGif) {
                anyPrint = true
                val post = "/o/" + code + "/print/" + Uri.encode(f)
                sb.append("<button class=\"btn alt\" type=\"button\" onclick=\"ask(this,'").append(post).append("','pb_asked_").append(code).append('_').append(i)
                    .append("')\">Ask for a print at the booth</button>")
            }
            sb.append("</div></div>")
        }
        if (anyPrint) sb.append("<script>").append(askJs).append("</script>")
        if (mine.isNotEmpty()) sb.append("<p class=\"tip\">iPhone: tap <b>Save photo</b>, then <b>Save to Photos</b> (or press and hold the picture). Android: tap <b>Save photo</b>.</p>")
        if (store.guestView != "only") {
            sb.append("<div class=\"one\" style=\"padding-top:0\"><a class=\"btn alt\" href=\"/e/").append(c.slug).append("/\">Show photos with other guests</a></div>")
        }
        sendBytes(out, 200, "OK", "text/html; charset=utf-8", shell("Your photos", sb.toString()).toByteArray(Charsets.UTF_8), headOnly, "no-store")
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
