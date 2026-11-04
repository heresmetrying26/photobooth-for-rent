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
import java.io.RandomAccessFile
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
        private val SEND_ROUTE = Regex("^/send/([A-Za-z0-9]+)(?:/(photos|photo|upload|hello|file|edited)(?:/([^/]+))?)?/?$")
        private val RANGE_RE = Regex("^bytes=(\\d*)-(\\d*)$")
        private val PRINT_ROUTE = Regex("^/e/([A-Za-z0-9]{6,20})/print/([^/]+)/?$")
        private val OWN_ROUTE = Regex("^/o/([A-Za-z0-9_-]{16,40})(?:/(f|print)/([^/]+))?/?$")
        private val STATION_ROUTE = Regex("^/station(?:/([A-Za-z0-9_-]{6,30}))?(?:/(list|stats))?/?$")
        private val WALL_ROUTE = Regex("^/wall(?:/([A-Za-z0-9_-]{6,30}))?(?:/(feed))?/?$")
        private val STATS_ROUTE = Regex("^/e/([A-Za-z0-9]{6,20})/stats/?$")
        private val TRACK_ROUTE = Regex("^/e/([A-Za-z0-9]{6,20})/track/?$")
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
        private const val SPIN_MAX = 1024L * 1024L * 1024L
        private const val THUMB_MAX = 640
        private const val SEND_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Send a video</title>" +
            "<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1EA;color:#1C1A1E;padding:24px 18px;text-align:center}h1{font-size:22px;margin:6px 0}p{color:#6B666C}" +
            "label.pick{display:inline-block;margin:18px 0 8px;padding:16px 26px;border-radius:14px;background:#C93D27;color:#fff;font-weight:800;font-size:17px}input{display:none}" +
            ".bar{height:10px;border-radius:6px;background:#E4DCCF;overflow:hidden;margin:14px auto;max-width:420px}.bar i{display:block;height:100%;width:0;background:#2EA66B}.row{margin:6px auto;max-width:420px;text-align:left;font-size:14px}</style></head><body>" +
            "<h1>Send a 360 video</h1><p>Pick the clip you just recorded. It goes straight to the booth tablet.</p>" +
            "<label class=\"pick\" for=\"f\">Choose a video</label><input id=\"f\" type=\"file\" accept=\"video/*\" multiple><div id=\"list\"></div>" +
            "<script>var T=location.pathname.replace(/[/]+$/,\"\");document.getElementById(\"f\").addEventListener(\"change\",function(e){Array.prototype.forEach.call(e.target.files,send);e.target.value=\"\"});" +
            "function send(file){var row=document.createElement(\"div\");row.className=\"row\";row.innerHTML=\"<b></b><div class=bar><i></i></div><span></span>\";row.querySelector(\"b\").textContent=file.name;document.getElementById(\"list\").appendChild(row);" +
            "var x=new XMLHttpRequest();x.open(\"POST\",T+\"/upload?name=\"+encodeURIComponent(file.name));x.setRequestHeader(\"content-type\",\"application/octet-stream\");" +
            "x.upload.onprogress=function(p){if(p.lengthComputable)row.querySelector(\"i\").style.width=Math.round(p.loaded/p.total*100)+\"%\"};" +
            "x.onload=function(){var ok=x.status===200;row.querySelector(\"span\").textContent=ok?\"Sent. It is on the tablet now.\":\"Could not send (\"+x.status+\"). Try again.\";if(ok)row.querySelector(\"i\").style.width=\"100%\"};" +
            "x.onerror=function(){row.querySelector(\"span\").textContent=\"No connection to the tablet. Are you on the booth Wi-Fi?\"};x.send(file)}</script></body></html>"
    }

    @Volatile
    private var server: ServerSocket? = null
    private var pool: ExecutorService? = null
    private val statsTotals = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>()
    private val statsEvents = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>>()

    fun recordStat(slug: String?, action: String?) {
        if (action.isNullOrEmpty()) return
        var a = action.lowercase()
        if (a == "share") a = "shares"
        if (a == "view") a = "views"
        if (a == "download") a = "downloads"
        statsTotals.computeIfAbsent(a) { java.util.concurrent.atomic.AtomicInteger(0) }.incrementAndGet()
        if (!slug.isNullOrEmpty()) {
            val ev = statsEvents.computeIfAbsent(slug) { java.util.concurrent.ConcurrentHashMap() }
            ev.computeIfAbsent(a) { java.util.concurrent.atomic.AtomicInteger(0) }.incrementAndGet()
        }
    }

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
            if (last4 == 0x0D0A0D0A || (last4 and 0xFFFF) == 0x0A0A) return buf.toString("ISO-8859-1")
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
        if (ownM != null) return ownRoute(ownM, method, query, out, ip, head)
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

        if (path == "/stats" || path == "/api/stats") {
            val tot = JSONObject()
            for ((k, v) in statsTotals) tot.put(k, v.get())
            val evs = JSONObject()
            for ((slugKey, actMap) in statsEvents) {
                val o = JSONObject()
                for ((a, c) in actMap) o.put(a, c.get())
                evs.put(slugKey, o)
            }
            return sendJson(out, 200, JSONObject().put("ok", true).put("stats", JSONObject().put("totals", tot).put("events", evs)).toString())
        }

        val trackM = TRACK_ROUTE.find(path)
        if (trackM != null) {
            val slug = trackM.groupValues[1]
            if (method == "OPTIONS") return sendOptions(out)
            if (method == "POST") {
                val len = headerValue(head, "content-length")?.toIntOrNull() ?: 0
                val bodyBytes = if (len in 1..8192) {
                    val b = ByteArray(len); var off = 0
                    while (off < len) { val r = input.read(b, off, len - off); if (r < 0) break; off += r }
                    b
                } else ByteArray(0)
                try {
                    val j = JSONObject(bodyBytes.toString(Charsets.UTF_8))
                    recordStat(slug, j.optString("action", ""))
                } catch (_: Exception) {}
                return sendJson(out, 200, "{\"ok\":true}")
            }
            return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
        }

        val statsM = STATS_ROUTE.find(path)
        if (statsM != null) {
            val slug = statsM.groupValues[1]
            val ev = statsEvents[slug]
            val o = JSONObject()
            if (ev != null) for ((a, c) in ev) o.put(a, c.get())
            return sendJson(out, 200, JSONObject().put("ok", true).put("slug", slug).put("stats", o).toString())
        }

        val stationM = STATION_ROUTE.find(path)
        if (stationM != null) return stationRoute(stationM, method, headOnly, out)

        val wallM = WALL_ROUTE.find(path)
        if (wallM != null) return wallRoute(wallM, method, headOnly, out)

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
        if (!file.isFile) {
            if (kind == "p") {
                val isVid = PBLocal.VIDEO_RE.containsMatchIn(name)
                val title = if (isVid) "Your 360 video is on its way" else "Your photo is on its way"
                val msg = if (isVid) "We’re preparing your video. It appears here in a few seconds. You can keep this page open." else "This photo isn’t here yet. Wait a moment and refresh."
                val body = "<div class=\"one\"><h1>$title</h1><p class=\"sub\">${esc(store.galleryTitle(folder))}</p>" +
                    "<div style=\"margin:28px auto;width:44px;height:44px;border:4px solid #E4DCCF;border-top-color:#C93D27;border-radius:50%;animation:pbSpin 1s linear infinite\"></div>" +
                    "<style>@keyframes pbSpin{to{transform:rotate(360deg)}}</style>" +
                    "<p class=\"empty\" style=\"padding:10px 0 20px\">$msg</p>" +
                    "<a class=\"btn alt\" href=\"/e/$slug/\">All photos</a></div>" +
                    "<script>setTimeout(function(){location.reload()},3000)</script>"
                return sendBytes(out, 200, "OK", "text/html; charset=utf-8", shell(title, body).toByteArray(Charsets.UTF_8), headOnly, "no-store")
            }
            return sendText(out, 404, "Not Found", "Not found", headOnly)
        }

        if (kind == "t") {
            val thumb = thumbFor(dir, file)
            if (thumb != null) return sendFile(out, thumb, "image/jpeg", headOnly, "max-age=600", null, null)
        }
        if (kind == "p") recordStat(slug, "views")
        val download = query.split("&").any { it == "dl=1" || it.startsWith("dl=") && it.length > 3 }
        if (download) recordStat(slug, "downloads")
        val disposition = if (download) "attachment; filename=\"" + name.replace(FILENAME_UNSAFE, "_") + "\"" else null
        val range = headerValue(head, "range")
        return sendFile(out, file, contentType(name), headOnly, "max-age=600", disposition, range)
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

    // /send/<token> = 360 upload page; /send/<token>/upload?name=... = 360 video uploaded
    // /send/<token>/photos = roving photos page; /send/<token>/photo?name=... = photo posted
    // /send/<token>/hello = booth connection check; /send/<token>/file|edited/<name> = video preview
    private fun sendRoute(m: MatchResult, method: String, head: String, input: InputStream, out: OutputStream, query: String) {
        if (m.groupValues[1] != store.roveToken()) return sendText(out, 404, "Not Found", "Not found", false)
        val action = m.groupValues[2]
        if (method == "OPTIONS") {
            return sendOptions(out)
        }
        if (action == "photos") {
            if (method != "GET" && method != "HEAD") return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
            val html = roveHtml ?: store.readAsset("share/rove.html")?.also { roveHtml = it }
                ?: return sendText(out, 500, "Internal Server Error", "Page missing", false)
            return sendBytes(out, 200, "OK", "text/html; charset=utf-8", html, method == "HEAD", "no-store")
        }
        if (action == "hello") {
            return sendJson(out, 200, JSONObject().put("ok", true).put("app", "photobooth4u").put("kind", "tablet").toString())
        }
        if (action.isEmpty()) {
            if (method != "GET" && method != "HEAD") return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
            return sendBytes(out, 200, "OK", "text/html; charset=utf-8", SEND_PAGE.toByteArray(Charsets.UTF_8), method == "HEAD", "no-store")
        }
        if (action == "file" || action == "edited") {
            if (method != "GET" && method != "HEAD") return sendText(out, 405, "Method Not Allowed", "Method not allowed", false)
            val baseDir = if (action == "edited") File(store.spinDir(), "edited") else store.spinDir()
            val name = Uri.decode(m.groupValues[3])
            if (name.isEmpty() || name != File(name).name || name.startsWith(".") || !PBLocal.VIDEO_RE.containsMatchIn(name)) {
                return sendText(out, 404, "Not Found", "Not found", method == "HEAD")
            }
            val file = File(baseDir, name)
            if (!file.isFile) return sendText(out, 404, "Not Found", "Not found", method == "HEAD")
            val range = headerValue(head, "range")
            return sendFile(out, file, contentType(name), method == "HEAD", "max-age=600", null, range)
        }
        if (action == "photo") {
            if (method != "POST") return sendJson(out, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}")
            val len = headerValue(head, "content-length")?.toLongOrNull() ?: -1L
            if (len <= 0L || len > ROVE_MAX) return sendJson(out, 413, "{\"ok\":false,\"error\":\"Too big\"}")
            val name = Uri.decode(queryParam(query, "name") ?: "")
            val saved = store.saveRovePhoto(name, input, len)
                ?: return sendJson(out, 500, "{\"ok\":false,\"error\":\"Could not save\"}")
            return sendJson(out, 200, JSONObject().put("ok", true).put("name", saved).toString())
        }
        if (action == "upload") {
            if (method != "POST") return sendJson(out, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}")
            val len = headerValue(head, "content-length")?.toLongOrNull() ?: -1L
            if (len <= 0L || len > SPIN_MAX) return sendJson(out, 413, "{\"ok\":false,\"error\":\"Too big\"}")
            val name = Uri.decode(queryParam(query, "name") ?: "")
            val saved = store.saveSpinVideo(name, input, len)
                ?: return sendJson(out, 500, "{\"ok\":false,\"error\":\"Could not save\"}")
            return sendJson(out, 200, JSONObject().put("ok", true).put("name", saved).toString())
        }
        return sendText(out, 404, "Not Found", "Not found", false)
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
    private fun ownRoute(m: MatchResult, method: String, query: String, out: OutputStream, ip: String, head: String) {
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
            val range = headerValue(head, "range")
            return sendFile(out, file, contentType(name), headOnly, "max-age=600", disposition, range)
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

    private fun sendOptions(out: OutputStream) {
        val s = "HTTP/1.1 204 No Content\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Connection: close\r\n\r\n"
        out.write(s.toByteArray(Charsets.ISO_8859_1))
    }

    private fun stationRoute(m: MatchResult, method: String, headOnly: Boolean, out: OutputStream) {
        val rawSlug = m.groupValues[1]
        val sub = m.groupValues[2]
        val folder = (if (rawSlug.isNotEmpty()) store.folderBySlug(rawSlug) else null) ?: store.latestFolder()
        if (sub == "list") {
            if (folder == null) return sendJson(out, 200, "{\"ok\":true,\"slug\":null,\"files\":[]}")
            val dir = store.dirOf(folder)
            val arr = JSONArray()
            for (f in store.photosIn(dir)) {
                val isVid = PBLocal.VIDEO_RE.containsMatchIn(f.name)
                val isGif = f.name.endsWith(".gif", ignoreCase = true)
                val kind = if (isVid) "video" else if (isGif) "gif" else "photo"
                arr.put(JSONObject()
                    .put("name", f.name)
                    .put("kind", kind)
                    .put("url", "/e/${folder.slug}/f/" + Uri.encode(f.name))
                    .put("thumbUrl", "/e/${folder.slug}/t/" + Uri.encode(f.name))
                    .put("pageUrl", "/e/${folder.slug}/p/" + Uri.encode(f.name))
                    .put("mtime", f.lastModified())
                )
            }
            return sendJson(out, 200, JSONObject().put("ok", true).put("slug", folder.slug).put("name", store.galleryTitle(folder)).put("count", arr.length()).put("files", arr).toString())
        }
        val slug = folder?.slug ?: ""
        val title = if (folder != null) store.galleryTitle(folder) else "Sharing Station"
        val html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>${esc(title)} - Sharing Station</title>" +
            "<style>body{margin:0;font-family:system-ui,sans-serif;background:#0F0E13;color:#F0EEF5;padding:24px;text-align:center}h1{font-size:22px;margin:8px 0}.sub{color:#A49FA9;font-size:14px;margin-bottom:24px}" +
            ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;max-width:1100px;margin:0 auto}.card{background:#18161D;border-radius:12px;overflow:hidden;padding:12px;border:1px solid rgba(255,255,255,0.1)}" +
            ".card video,.card img{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:8px}.btn{display:inline-block;margin-top:10px;padding:10px 16px;background:#C93D27;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}</style></head><body>" +
            "<h1>${esc(title)}</h1><p class=\"sub\">📱 Sharing Station</p><div class=\"grid\" id=\"g\"></div>" +
            "<script>var slug='${esc(slug)}';function load(){fetch('/station/'+slug+'/list').then(function(r){return r.json()}).then(function(j){" +
            "var g=document.getElementById('g');if(!j||!j.files||!j.files.length){g.innerHTML='<p style=\"color:#888;grid-column:1/-1\">No clips yet.</p>';return;}" +
            "g.innerHTML=j.files.map(function(f){return '<div class=\"card\">'+(f.kind==='video'?'<video src=\"'+f.url+'\" controls playsinline></video>':'<img src=\"'+f.thumbUrl+'\">')+'<br><a class=\"btn\" href=\"'+f.pageUrl+'\">Open / Save</a></div>';}).join('');" +
            "})}load();setInterval(load,4000);</script></body></html>"
        return sendBytes(out, 200, "OK", "text/html; charset=utf-8", html.toByteArray(Charsets.UTF_8), headOnly, "no-store")
    }

    private fun wallRoute(m: MatchResult, method: String, headOnly: Boolean, out: OutputStream) {
        val rawSlug = m.groupValues[1]
        val sub = m.groupValues[2]
        val folder = (if (rawSlug.isNotEmpty()) store.folderBySlug(rawSlug) else null) ?: store.latestFolder()
        if (sub == "feed") {
            if (folder == null) return sendJson(out, 200, "{\"ok\":true,\"slug\":null,\"videos\":[]}")
            val dir = store.dirOf(folder)
            val arr = JSONArray()
            for (f in store.photosIn(dir)) {
                if (!PBLocal.VIDEO_RE.containsMatchIn(f.name)) continue
                arr.put(JSONObject()
                    .put("name", f.name)
                    .put("url", "/e/${folder.slug}/f/" + Uri.encode(f.name))
                    .put("pageUrl", "/e/${folder.slug}/p/" + Uri.encode(f.name))
                    .put("mtime", f.lastModified())
                )
            }
            return sendJson(out, 200, JSONObject().put("ok", true).put("slug", folder.slug).put("name", store.galleryTitle(folder)).put("count", arr.length()).put("videos", arr).toString())
        }
        val slug = folder?.slug ?: ""
        val title = if (folder != null) store.galleryTitle(folder) else "360 Live Wall"
        val html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>${esc(title)} - 360 Live Wall</title>" +
            "<style>body{margin:0;background:#080709;color:#fff;font-family:sans-serif;height:100vh;overflow:hidden;display:flex;align-items:center;justify-content:center}video{max-width:96vw;max-height:94vh;object-fit:contain;border-radius:12px}</style></head><body>" +
            "<video id=\"v\" autoplay playsinline muted></video>" +
            "<script>var slug='${esc(slug)}',list=[],idx=0,v=document.getElementById('v');v.onended=function(){if(list.length){idx=(idx+1)%list.length;v.src=list[idx].url;v.play()}};" +
            "function poll(){fetch('/wall/'+slug+'/feed').then(function(r){return r.json()}).then(function(j){if(j&&j.videos&&j.videos.length){var first=!list.length;list=j.videos;if(first){v.src=list[0].url;v.play()}}})}poll();setInterval(poll,4000);</script></body></html>"
        return sendBytes(out, 200, "OK", "text/html; charset=utf-8", html.toByteArray(Charsets.UTF_8), headOnly, "no-store")
    }

    private fun writeHead(out: OutputStream, status: Int, reason: String, type: String, length: Long, cache: String, disposition: String?, contentRange: String? = null, acceptRanges: Boolean = true) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
        sb.append("Content-Type: ").append(type).append("\r\n")
        sb.append("Content-Length: ").append(length).append("\r\n")
        sb.append("Cache-Control: ").append(cache).append("\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        if (disposition != null) sb.append("Content-Disposition: ").append(disposition).append("\r\n")
        if (contentRange != null) sb.append("Content-Range: ").append(contentRange).append("\r\n")
        if (acceptRanges) sb.append("Accept-Ranges: bytes\r\n")
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

    private fun sendFile(out: OutputStream, f: File, type: String, headOnly: Boolean, cache: String, disposition: String?, range: String? = null) {
        val total = f.length()
        var start = 0L
        var end = total - 1L
        var isPartial = false

        if (range != null && range.startsWith("bytes=")) {
            val m = RANGE_RE.find(range.trim())
            if (m != null) {
                val sStr = m.groupValues[1]
                val eStr = m.groupValues[2]
                if (sStr.isNotEmpty() && eStr.isNotEmpty()) {
                    start = sStr.toLongOrNull() ?: 0L
                    end = eStr.toLongOrNull() ?: (total - 1L)
                } else if (sStr.isNotEmpty()) {
                    start = sStr.toLongOrNull() ?: 0L
                    end = total - 1L
                } else if (eStr.isNotEmpty()) {
                    val suffix = eStr.toLongOrNull() ?: 0L
                    start = maxOf(0L, total - suffix)
                    end = total - 1L
                }
                if (start <= end && start < total) {
                    end = minOf(end, total - 1L)
                    isPartial = true
                } else {
                    writeHead(out, 416, "Range Not Satisfiable", type, 0L, "no-store", null, contentRange = "bytes */$total")
                    return
                }
            }
        }

        val len = if (isPartial) (end - start + 1L) else total
        val contentRange = if (isPartial) "bytes $start-$end/$total" else null
        val status = if (isPartial) 206 else 200
        val reason = if (isPartial) "Partial Content" else "OK"

        writeHead(out, status, reason, type, len, cache, disposition, contentRange = contentRange, acceptRanges = true)
        if (headOnly || len <= 0L) return

        if (!isPartial) {
            FileInputStream(f).use { it.copyTo(out, 65536) }
        } else {
            RandomAccessFile(f, "r").use { raf ->
                raf.seek(start)
                val buf = ByteArray(65536)
                var remaining = len
                while (remaining > 0L) {
                    val toRead = minOf(buf.size.toLong(), remaining).toInt()
                    val r = raf.read(buf, 0, toRead)
                    if (r <= 0) break
                    out.write(buf, 0, r)
                    remaining -= r
                }
            }
        }
    }
}
