package com.photobooth4u.booth

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Guest gallery over the booth Wi-Fi / tablet hotspot.
 * Same URLs as the desktop app: http://<tablet-ip>:47777/e/<slug>/
 */
class ShareServer(private val store: PhotoStore) {
    private val port = AtomicInteger(0)
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        val ready = CountDownLatch(1)
        Thread({
            for (p in SHARE_PORTS) {
                try {
                    val ss = ServerSocket(p, 50)
                    serverSocket = ss
                    port.set(p)
                    ready.countDown()
                    while (running) {
                        val sock = try { ss.accept() } catch (_: Exception) { break }
                        Thread({ handleClient(sock) }, "pb-share-client").start()
                    }
                    break
                } catch (_: Exception) {
                    /* try next port */
                }
            }
            ready.countDown()
        }, "pb-share-server").apply { isDaemon = true; start() }
        try { ready.await(2, TimeUnit.SECONDS) } catch (_: Exception) { }
    }

    fun stop() {
        running = false
        try { serverSocket?.close() } catch (_: Exception) { }
        serverSocket = null
        port.set(0)
    }

    fun shareBase(): String? {
        val p = port.get()
        val ip = lanAddress()
        return if (p > 0 && ip != null) "http://$ip:$p" else null
    }

    private fun handleClient(sock: Socket) {
        sock.soTimeout = 15000
        try {
            val input = BufferedInputStream(sock.getInputStream())
            val req = readRequestLine(input) ?: return send(sock, 400, "text/plain", "Bad request")
            skipHeaders(input)
            if (req.method != "GET" && req.method != "HEAD") {
                return send(sock, 405, "text/plain", "Method not allowed")
            }
            val path = req.path
            val m = PATH_RE.find(path)
            if (m == null) {
                return send(sock, 404, "text/html; charset=utf-8", page("Not found", "<p class=\"empty\">This link isn’t on this booth.</p>"))
            }
            val slug = m.groupValues[1]
            val kind = m.groupValues[2]
            val folder = store.folder(slug)
            val dir = folder?.dir()
            if (folder == null || dir == null || !dir.exists()) {
                return send(sock, 404, "text/html; charset=utf-8", page("Not found", "<p class=\"empty\">This event isn’t on this booth anymore.</p>"))
            }
            val evName = folder.displayName().replace(" / ", " · ")
            if (kind.isEmpty()) {
                val list = store.photosIn(dir)
                val photoCount = list.count { !it.name.endsWith(".gif", true) }
                val gifCount = list.size - photoCount
                val tabs = if (photoCount > 0 && gifCount > 0) {
                    """<div style="text-align:center"><div class="tabs">
<button type="button" class="tab active" onclick="setTab('all',this)">All (${list.size})</button>
<button type="button" class="tab" onclick="setTab('photo',this)">Photos ($photoCount)</button>
<button type="button" class="tab" onclick="setTab('gif',this)">GIFs ($gifCount)</button>
</div></div>"""
                } else ""
                val countSub = if (photoCount > 0 && gifCount > 0)
                    "$photoCount photo${if (photoCount == 1) "" else "s"} · $gifCount GIF${if (gifCount == 1) "" else "s"}"
                else "${list.size} photo${if (list.size == 1) "" else "s"}"
                val grid = if (list.isEmpty()) {
                    "<p class=\"empty\">No photos yet. Pull down to refresh after your session.</p>"
                } else {
                    "<div class=\"grid\">" + list.joinToString("") { file ->
                        val k = if (file.name.endsWith(".gif", true)) "gif" else "photo"
                        val n = enc(file.name)
                        "<a href=\"/e/$slug/p/$n\" data-kind=\"$k\"><img loading=\"lazy\" alt=\"\" src=\"/e/$slug/t/$n\"></a>"
                    } + "</div>"
                }
                val body = "<div style=\"text-align:center;padding:0 16px\"><h1>${esc(evName)}</h1><p class=\"sub\">$countSub · tap one to save it</p></div>$tabs$grid$TAB_SCRIPT"
                return send(sock, 200, "text/html; charset=utf-8", page("$evName photos", body))
            }
            var fileName = try { URLDecoder.decode(m.groupValues[3], "UTF-8") } catch (_: Exception) { "" }
            fileName = File(fileName).name
            if (fileName.isEmpty() || fileName.startsWith(".") || !IMG_RE.matches(fileName)) {
                return send(sock, 404, "text/plain", "Not found")
            }
            val full = File(dir, fileName)
            if (!full.exists()) {
                if (kind == "p") {
                    return send(
                        sock, 404, "text/html; charset=utf-8",
                        page("Not ready", "<div class=\"one\"><p class=\"empty\">This photo isn’t here yet. Wait a moment and refresh.</p><a class=\"btn alt\" href=\"/e/$slug/\">All photos</a></div>")
                    )
                }
                return send(sock, 404, "text/plain", "Not found")
            }
            val type = mime(fileName)
            if (kind == "p") {
                val isGif = fileName.endsWith(".gif", true)
                val src = "/e/$slug/f/" + enc(fileName)
                val itemTitle = if (isGif) "Your GIF" else "Your photo"
                val dlText = if (isGif) "Save GIF" else "Save photo"
                val media = if (type.startsWith("video/"))
                    "<video src=\"$src\" controls playsinline autoplay muted loop></video>"
                else "<img src=\"$src\" alt=\"$itemTitle\">"
                val printBtn = if (!type.startsWith("video/") && !isGif)
                    "<button class=\"btn alt\" type=\"button\" onclick=\"window.print()\">Print photo</button>" else ""
                val body = "<div class=\"one\"><h1>$itemTitle</h1><p class=\"sub\">${esc(evName)}</p>$media" +
                    "<div><a class=\"btn\" href=\"$src?dl=1\" download=\"${esc(fileName)}\">$dlText</a>$printBtn" +
                    "<a class=\"btn alt\" href=\"/e/$slug/\">All photos</a></div>$SAVING_TIP</div>"
                return send(sock, 200, "text/html; charset=utf-8", page(itemTitle, body))
            }
            if (kind == "t") {
                val thumb = thumbnailJpeg(full)
                if (thumb != null) {
                    return sendBytes(sock, 200, "image/jpeg", thumb, cache = true, head = req.method == "HEAD")
                }
            }
            val extra = if (req.query.contains("dl=1"))
                mapOf("Content-Disposition" to "attachment; filename=\"${fileName.replace(Regex("[^\\w.() -]"), "_")}\"")
            else emptyMap()
            return sendFile(sock, full, type, extra, req.method == "HEAD")
        } catch (_: Exception) {
            try { send(sock, 500, "text/plain", "Error") } catch (_: Exception) { }
        } finally {
            try { sock.close() } catch (_: Exception) { }
        }
    }

    private data class Req(val method: String, val path: String, val query: String)

    companion object {
        val SHARE_PORTS = intArrayOf(47777, 47778, 47779, 47787, 47797)
        private val PATH_RE = Regex("^/e/([A-Za-z0-9]{6,20})(?:/(p|f|t)/([^/?]+))?/?$")
        private val IMG_RE = Regex(".*\\.(jpe?g|png|webp|gif|mp4|webm)$", RegexOption.IGNORE_CASE)
        private val TAB_SCRIPT = "<script>function setTab(k,b){document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});b.classList.add('active');var g=document.querySelector('.grid');if(g)g.className='grid'+(k==='all'?'':' filter-'+k);}</script>"
        private val SAVING_TIP = "<p class=\"tip\">iPhone: tap <b>Save photo</b>, then <b>Save to Photos</b> (or press and hold the picture). Android: tap <b>Save photo</b>.</p>"
        private val CSS = "*{box-sizing:border-box}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#F5F1EA;color:#1C1A1E;min-height:100vh}" +
            "header{padding:22px 16px 6px;text-align:center}.brand{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:15px;letter-spacing:-.01em;color:#1C1A1E;text-decoration:none}" +
            ".mk{display:grid;grid-template-columns:1fr 1fr;gap:2px;width:18px;height:18px}.mk i{background:#1C1A1E;border-radius:3px}.mk i:nth-child(2){background:#C93D27}" +
            "h1{font-size:24px;line-height:1.2;margin:10px 0 2px;font-weight:800;letter-spacing:-.02em}.sub{color:#6B666C;font-size:13px;margin:0 0 14px}" +
            ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:8px 12px 40px;max-width:1100px;margin:0 auto}" +
            ".grid a{display:block;background:#fff;border-radius:10px;overflow:hidden;aspect-ratio:3/4;box-shadow:0 2px 8px rgba(60,40,20,.08)}" +
            ".grid img{width:100%;height:100%;object-fit:cover;display:block}" +
            ".one{max-width:560px;margin:0 auto;padding:6px 16px 40px;text-align:center}.one img,.one video{max-width:100%;max-height:72vh;border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(60,40,20,.15)}" +
            ".btn{display:inline-block;margin:16px 6px 0;padding:14px 22px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:15px}" +
            ".btn.alt{background:#fff;color:#1C1A1E;border:1.5px solid #E4DCCF}.tip{color:#6B666C;font-size:13px;line-height:1.5;margin:14px auto 0;max-width:420px}.empty{text-align:center;color:#6B666C;padding:40px 16px}" +
            ".tabs{display:inline-flex;background:#EAE4D9;border-radius:24px;padding:3px;margin:0 auto 16px;gap:2px}" +
            ".tab{background:transparent;border:0;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:700;color:#6B666C;cursor:pointer}" +
            ".tab.active{background:#fff;color:#1C1A1E;box-shadow:0 1px 4px rgba(60,40,20,.1)}" +
            ".grid.filter-photo [data-kind=gif]{display:none!important}.grid.filter-gif [data-kind=photo]{display:none!important}" +
            ".grid [data-kind=gif]::after{content:'GIF';position:absolute;bottom:6px;right:6px;background:rgba(28,26,30,.8);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:4px}"

        private val VIRTUAL = Regex("(dummy|rmnet|ccmni|veth|tun|vpn|lo)", RegexOption.IGNORE_CASE)

        fun lanAddress(): String? {
            val cands = mutableListOf<Pair<String, Int>>()
            val ifaces = try { NetworkInterface.getNetworkInterfaces()?.toList() } catch (_: Exception) { null } ?: return null
            for (ni in ifaces) {
                try {
                    if (!ni.isUp || ni.isLoopback) continue
                    val name = ni.name ?: ""
                    for (addr in ni.inetAddresses) {
                        if (addr !is Inet4Address || addr.isLoopbackAddress) continue
                        val ip = addr.hostAddress ?: continue
                        if (ip.startsWith("169.254.")) continue
                        var score = 0
                        when {
                            ip.startsWith("192.168.") -> score += 3
                            ip.startsWith("10.") -> score += 2
                            ip.matches(Regex("^172\\.(1[6-9]|2\\d|3[01])\\..*")) -> score += 1
                        }
                        if (name.contains("wlan", true) || name.contains("ap", true) || name.contains("swlan", true)) score += 2
                        if (ip.startsWith("192.168.43.") || ip.startsWith("192.168.137.") || ip.startsWith("192.168.49.")) score += 3
                        if (VIRTUAL.containsMatchIn(name)) score -= 10
                        cands.add(ip to score)
                    }
                } catch (_: Exception) { }
            }
            val best = cands.maxByOrNull { it.second } ?: return null
            return if (best.second > -5) best.first else null
        }

        private fun mime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            else -> "application/octet-stream"
        }

        private fun enc(name: String): String = java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20")
        private fun esc(t: String): String = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

        private fun page(title: String, body: String): String {
            return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<title>${esc(title)}</title><style>$CSS</style></head><body><header><span class=\"brand\"><span class=\"mk\"><i></i><i></i><i></i><i></i></span>photobooth4u</span></header>$body</body></html>"
        }

        private fun thumbnailJpeg(full: File): ByteArray? {
            return try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(full.absolutePath, bounds)
                var sample = 1
                val max = maxOf(bounds.outWidth, bounds.outHeight)
                while (max / sample > 480) sample *= 2
                val opts = BitmapFactory.Options().apply { inSampleSize = maxOf(1, sample) }
                val bmp = BitmapFactory.decodeFile(full.absolutePath, opts) ?: return null
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 72, out)
                bmp.recycle()
                out.toByteArray()
            } catch (_: Exception) { null }
        }

        private fun readRequestLine(input: BufferedInputStream): Req? {
            val line = readLine(input) ?: return null
            val parts = line.split(" ")
            if (parts.size < 2) return null
            val raw = parts[1]
            val q = raw.indexOf('?')
            val path = if (q >= 0) raw.substring(0, q) else raw
            val query = if (q >= 0) raw.substring(q + 1) else ""
            return Req(parts[0].uppercase(), path, query)
        }

        private fun skipHeaders(input: BufferedInputStream) {
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
            }
        }

        private fun readLine(input: BufferedInputStream): String? {
            val buf = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
                if (b == '\n'.code) break
                if (b != '\r'.code) buf.write(b)
                if (buf.size() > 8192) break
            }
            return buf.toString("ISO-8859-1")
        }

        private fun send(sock: Socket, status: Int, type: String, body: String) {
            sendBytes(sock, status, type, body.toByteArray(Charsets.UTF_8), cache = false, head = false)
        }

        private fun sendBytes(
            sock: Socket,
            status: Int,
            type: String,
            body: ByteArray,
            cache: Boolean,
            head: Boolean,
            extra: Map<String, String> = emptyMap()
        ) {
            val reason = if (status == 200) "OK" else "Error"
            val cacheCtl = if (cache) "max-age=600" else "no-store"
            val headers = StringBuilder()
            headers.append("HTTP/1.1 $status $reason\r\n")
            headers.append("Content-Type: $type\r\n")
            headers.append("Content-Length: ${body.size}\r\n")
            headers.append("Cache-Control: $cacheCtl\r\n")
            headers.append("X-Content-Type-Options: nosniff\r\n")
            headers.append("Connection: close\r\n")
            for ((k, v) in extra) headers.append("$k: $v\r\n")
            headers.append("\r\n")
            val out = BufferedOutputStream(sock.getOutputStream())
            out.write(headers.toString().toByteArray(Charsets.ISO_8859_1))
            if (!head) out.write(body)
            out.flush()
        }

        private fun sendFile(sock: Socket, file: File, type: String, extra: Map<String, String>, head: Boolean) {
            sendBytes(sock, 200, type, file.readBytes(), cache = true, head = head, extra = extra)
        }
    }
}

class ShareBridge(private val store: PhotoStore, private val server: ShareServer) {
    @android.webkit.JavascriptInterface
    fun lanBase(): String = server.shareBase() ?: ""

    @android.webkit.JavascriptInterface
    fun savePhoto(json: String): String = store.driveRequest(json)
}
