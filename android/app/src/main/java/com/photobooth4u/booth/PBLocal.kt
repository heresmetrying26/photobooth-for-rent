package com.photobooth4u.booth

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale

/**
 * Photos on this tablet, and the bridge the booth page uses to save them (window.__PBLocal).
 *
 * Mirrors desktop/lib/photos.mjs: the booth "uploads" each photo exactly like it uploads to Google Drive on
 * the web, but here the photo is saved in an event folder on the tablet. Guests on the same Wi-Fi open it
 * from the tablet through LocalShareServer. Nothing goes to the internet.
 *
 * Files live in the app's own storage (no permission needed):
 *   <app files>/Pictures/photobooth4u/<event folder>/<n>_<layout>.jpg
 * and, on Android 10+, a copy also goes to the shared Pictures/photobooth4u/<event folder> so the operator
 * can find every photo in the Gallery / Files app after the event.
 */
class PBLocal(private val ctx: Context) {

    class Folder(val slug: String, val id: String, val name: String, val sub: String, val at: Long)

    companion object {
        private const val TAG = "PBLocal"
        val IMG_RE = Regex("\\.(jpe?g|png|webp|gif|mp4|webm)$", RegexOption.IGNORE_CASE)
        private val SESSION_RE = Regex("^(?:BONUS_)?(\\d+)_")
        private val BAD_CHARS = Regex("[\\\\/:*?\"<>|\\x00-\\x1f]")
        private val SPACES = Regex("\\s+")
        private val EXT_RE = Regex("(\\.[a-z0-9]+)$", RegexOption.IGNORE_CASE)
        private val PRIVATE_172 = Regex("^172\\.(1[6-9]|2\\d|3[01])\\.")
        private val ROVE_RE = Regex("\\.(jpe?g|png|webp)$", RegexOption.IGNORE_CASE)
        private const val ROVE_MAX_REQUESTS = 200
        private const val ROVE_RATE_N = 8
        private const val ROVE_RATE_MS = 600000L

        /**
         * Picks the address guests' phones can reach out of (interface name, IPv4) pairs: a private address
         * on a Wi-Fi / hotspot / Ethernet interface; mobile data, VPN and virtual interfaces lose.
         */
        fun pickLanAddress(candidates: List<Pair<String, String>>): String? {
            var best: String? = null
            var bestScore = -100
            for ((rawName, ip) in candidates) {
                val name = rawName.lowercase(Locale.ROOT)
                var score = when {
                    ip.startsWith("192.168.") -> 3
                    ip.startsWith("10.") -> 2
                    PRIVATE_172.containsMatchIn(ip) -> 1
                    else -> continue            // not a private address: not a booth network
                }
                if (name.startsWith("wlan") || name.startsWith("swlan") || name.startsWith("ap") || name.startsWith("eth")) score += 2
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("tun") ||
                    name.startsWith("ppp") || name.startsWith("dummy") || name.startsWith("v4-") ||
                    name.startsWith("clat") || name.startsWith("tap")
                ) score -= 10
                if (score > bestScore) {
                    bestScore = score
                    best = ip
                }
            }
            return if (bestScore > -5) best else null
        }
    }

    private val lock = Any()
    private val folders = LinkedHashMap<String, Folder>()
    private val indexFile = File(ctx.filesDir, "folders.json")
    private val random = SecureRandom()

    /** Where the event folders are. */
    val root: File = File(
        ctx.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: File(ctx.filesDir, "Pictures"),
        "photobooth4u"
    )

    /** The port LocalShareServer listens on (0 = not running). */
    @Volatile
    var sharePort: Int = 0

    init {
        try { root.mkdirs() } catch (e: Exception) { Log.w(TAG, "Could not create $root", e) }
        loadIndex()
    }

    // ---------- the bridge the booth page calls ----------

    /**
     * The booth's "Drive script" call (same request and reply shape as the Apps Script relay).
     * body = the JSON the booth would POST; returns the JSON reply as text.
     */
    @JavascriptInterface
    fun drive(body: String?): String {
        return try {
            driveInner(body ?: "")
        } catch (e: Throwable) {
            Log.w(TAG, "drive failed", e)
            err("Could not save the photo: " + (e.message ?: e.javaClass.simpleName))
        }
    }

    /** "http://<tablet address>:<port>" for guests' phones, or "" when the tablet is not on a Wi-Fi network. */
    @JavascriptInterface
    fun lanBase(): String {
        val ip = lanAddress()
        val port = sharePort
        return if (ip != null && port > 0) "http://$ip:$port" else ""
    }

    // ---------- phone photos and guests' print requests (mirror desktop/lib/photos.mjs) ----------

    class PrintReq(val id: String, val slug: String, val file: String, val event: String, val t: Long)

    /** Set from the booth's Print settings: may guests ask for a print from their photo page? */
    @Volatile
    var guestPrintOn: Boolean = false

    private val printReqs = ArrayList<PrintReq>()
    private val askedBefore = HashSet<String>()
    private val reqHits = HashMap<String, MutableList<Long>>()
    private var sendToken: String? = null

    /** The random part of the phone upload address (kept between runs, so a printed QR keeps working). */
    fun roveToken(): String = synchronized(lock) {
        val cached = sendToken
        if (cached != null) return@synchronized cached
        val f = File(ctx.filesDir, "rove-token.txt")
        var t = try { if (f.exists()) f.readText().trim() else "" } catch (e: Exception) { "" }
        if (t.length < 8) {
            val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
            val sb = StringBuilder()
            for (i in 0 until 12) sb.append(chars[random.nextInt(chars.length)])
            t = sb.toString()
            try { f.writeText(t) } catch (e: Exception) { Log.w(TAG, "Could not keep the phone upload token", e) }
        }
        sendToken = t
        t
    }

    fun roveDir(): File {
        val d = File(root, "Roving inbox")
        d.mkdirs()
        return d
    }

    /** Saves a photo a phone sent (exactly [length] bytes from [input]); returns its file name, or null. */
    fun saveRovePhoto(rawName: String, input: InputStream, length: Long): String? {
        return try {
            var name = File(safeName(rawName).ifEmpty { "photo.jpg" }).name
            if (!ROVE_RE.containsMatchIn(name)) name = name.replace(Regex("\\.[A-Za-z0-9]{1,5}$"), "") + ".jpg"
            name = java.lang.Long.toString(System.currentTimeMillis(), 36) + "_" + name
            val dir = roveDir()
            var out = name
            var i = 2
            while (File(dir, out).exists()) {
                out = name.replace(EXT_RE, " ($i)$1")
                i++
            }
            val part = File(dir, ".$out.part")
            var ok = true
            part.outputStream().use { os ->
                val buf = ByteArray(65536)
                var left = length
                while (left > 0) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) { ok = false; break }
                    os.write(buf, 0, n)
                    left -= n.toLong()
                }
            }
            if (!ok || !part.renameTo(File(dir, out))) {
                part.delete()
                null
            } else out
        } catch (e: Exception) {
            Log.w(TAG, "Could not save a phone photo", e)
            null
        }
    }

    /** A guest asked for a print: the HTTP status and JSON reply (same answers as the laptop app). */
    fun addPrintRequest(slug: String, file: String, ip: String): Pair<Int, String> = synchronized(lock) {
        if (!guestPrintOn) return@synchronized Pair(403, "{\"ok\":false,\"error\":\"off\"}")
        val f = folders[slug] ?: return@synchronized Pair(404, "{\"ok\":false,\"error\":\"event\"}")
        val dir = dirOf(f)
        if (file.isEmpty() || file != File(file).name || file.startsWith(".") || !ROVE_RE.containsMatchIn(file) || !File(dir, file).isFile) {
            return@synchronized Pair(404, "{\"ok\":false,\"error\":\"photo\"}")
        }
        val key = "$slug/$file"
        if (printReqs.any { it.slug == slug && it.file == file }) return@synchronized Pair(200, "{\"ok\":true,\"waiting\":true}")
        if (askedBefore.contains(key)) return@synchronized Pair(200, "{\"ok\":true,\"done\":true}")
        if (printReqs.size >= ROVE_MAX_REQUESTS) return@synchronized Pair(429, "{\"ok\":false,\"error\":\"busy\"}")
        val now = System.currentTimeMillis()
        val recent = (reqHits[ip] ?: ArrayList<Long>()).filter { now - it < ROVE_RATE_MS }.toMutableList()
        if (recent.size >= ROVE_RATE_N) return@synchronized Pair(429, "{\"ok\":false,\"error\":\"rate\"}")
        recent.add(now)
        reqHits[ip] = recent
        val bytes = ByteArray(6)
        random.nextBytes(bytes)
        val id = bytes.joinToString("") { String.format(Locale.US, "%02x", it) }
        printReqs.add(PrintReq(id, slug, file, galleryTitle(f), now))
        askedBefore.add(key)
        Pair(200, "{\"ok\":true,\"waiting\":true}")
    }

    /** The address a phone opens to send photos here ("" when the tablet is not on a Wi-Fi network). */
    @JavascriptInterface
    fun roveInfo(): String {
        val ip = lanAddress() ?: return ""
        val port = sharePort
        return if (port > 0) "http://$ip:$port/send/${roveToken()}/photos" else ""
    }

    /** The photos phones sent that the booth has not taken yet, as JSON: [{name, size, mtime}]. */
    @JavascriptInterface
    fun roveScan(): String {
        val arr = JSONArray()
        try {
            val list = roveDir().listFiles() ?: return "[]"
            val sorted = list
                .filter { it.isFile && !it.name.startsWith(".") && ROVE_RE.containsMatchIn(it.name) }
                .sortedBy { it.lastModified() }
            for (f in sorted.take(200)) {
                arr.put(JSONObject().put("name", f.name).put("size", f.length()).put("mtime", f.lastModified()))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not list the phone photos", e)
        }
        return arr.toString()
    }

    /** One phone photo as base64 (and it moves to done/ so it is never taken twice); "" when it is not there. */
    @JavascriptInterface
    fun roveTake(name: String?): String {
        return try {
            val n = File(name ?: "").name
            if (n.isEmpty() || n.startsWith(".") || !ROVE_RE.containsMatchIn(n)) return ""
            val src = File(roveDir(), n)
            if (!src.isFile) return ""
            val b64 = Base64.encodeToString(src.readBytes(), Base64.NO_WRAP)
            val done = File(roveDir(), "done")
            done.mkdirs()
            var out = n
            var i = 2
            while (File(done, out).exists()) {
                out = n.replace(EXT_RE, " ($i)$1")
                i++
            }
            if (!src.renameTo(File(done, out))) src.delete()
            b64
        } catch (e: Exception) {
            Log.w(TAG, "Could not read a phone photo", e)
            ""
        }
    }

    @JavascriptInterface
    fun guestPrintSet(on: Boolean) {
        guestPrintOn = on
    }

    /** The guests' print requests that wait for the attendant, as JSON: [{id, slug, file, event, t}]. */
    @JavascriptInterface
    fun printReqList(): String {
        val arr = JSONArray()
        synchronized(lock) {
            for (r in printReqs) {
                arr.put(JSONObject().put("id", r.id).put("slug", r.slug).put("file", r.file).put("event", r.event).put("t", r.t))
            }
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun printReqDone(id: String?): Boolean = synchronized(lock) { printReqs.removeAll { it.id == id } }

    /** The photo of a print request as base64 ("" when it is gone). */
    @JavascriptInterface
    fun printReqRead(id: String?): String {
        val r = synchronized(lock) { printReqs.firstOrNull { it.id == id } } ?: return ""
        val f = folderBySlug(r.slug) ?: return ""
        return try {
            Base64.encodeToString(File(dirOf(f), r.file).readBytes(), Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    /** Where the photos are kept, for the Setup screen. */
    @JavascriptInterface
    fun photosPath(): String = root.absolutePath

    // ---------- folders and files (also used by the server) ----------

    fun folderBySlug(slug: String): Folder? = synchronized(lock) { folders[slug] }

    fun dirOf(f: Folder): File = if (f.sub.isNotEmpty()) File(File(root, f.name), f.sub) else File(root, f.name)

    /** The name shown for the event on the guests' pages. */
    fun galleryTitle(f: Folder): String = if (f.sub.isNotEmpty()) f.name + " · " + f.sub else f.name

    /** The photos, GIFs and videos in an event folder, newest first. */
    fun photosIn(dir: File): List<File> {
        val list = dir.listFiles() ?: return emptyList()
        return list
            .filter { it.isFile && !it.name.startsWith(".") && IMG_RE.containsMatchIn(it.name) }
            .sortedByDescending { it.lastModified() }
    }

    fun readAsset(name: String): ByteArray? {
        return try {
            ctx.assets.open(name).use { it.readBytes() }
        } catch (e: Exception) {
            Log.w(TAG, "Missing asset $name", e)
            null
        }
    }

    // ---------- inside ----------

    private fun err(message: String): String =
        JSONObject().put("ok", false).put("error", message).toString()

    private fun str(o: JSONObject, key: String): String =
        if (o.isNull(key)) "" else o.optString(key, "")

    private fun safeName(v: String?): String {
        var s = (v ?: "").replace(BAD_CHARS, " ").replace(SPACES, " ").trim()
        s = s.trim { it == '.' || it == ' ' }
        if (s.length > 80) s = s.substring(0, 80).trim()
        return s
    }

    private fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    private fun nextSession(dir: File): Int {
        var max = 0
        for (f in photosIn(dir)) {
            val m = SESSION_RE.find(f.name) ?: continue
            val n = m.groupValues[1].toIntOrNull() ?: continue
            if (n > max) max = n
        }
        return max + 1
    }

    // folderKey (+ subfolder) -> the event folder (made when it is new)
    private fun folderFor(folderKey: String?, subfolder: String?): Folder = synchronized(lock) {
        val name = safeName(folderKey).ifEmpty { "Photobooth " + today() }
        val sub = safeName(subfolder)
        val id = (name + (if (sub.isNotEmpty()) "/$sub" else "")).lowercase(Locale.ROOT)
        var f = folders.values.firstOrNull { it.id == id }
        if (f == null) {
            val bytes = ByteArray(8)
            random.nextBytes(bytes)
            val slug = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
                .replace('-', 'x').replace('_', 'x')
            f = Folder(slug, id, name, sub, System.currentTimeMillis())
            folders[slug] = f
            saveIndex()
        }
        dirOf(f).mkdirs()
        f
    }

    private fun driveInner(body: String): String {
        val o = try { JSONObject(body) } catch (e: Exception) { return err("Bad request") }
        val f = folderFor(str(o, "folderKey"), str(o, "subfolder"))
        val dir = dirOf(f)
        val folderUrl = "pb4u-local:" + f.slug
        val shownName = if (f.sub.isNotEmpty()) f.name + " / " + f.sub else f.name

        if (o.optBoolean("resolveOnly", false)) {
            return JSONObject()
                .put("ok", true)
                .put("folderUrl", folderUrl)
                .put("folderName", shownName)
                .put("nextSessionNumber", nextSession(dir))
                .put("folderPath", dir.absolutePath)
                .toString()
        }

        val b64 = str(o, "imageBase64")
        if (b64.isEmpty()) return err("No photo")
        val bytes = try { Base64.decode(b64, Base64.DEFAULT) } catch (e: IllegalArgumentException) { return err("No photo") }
        if (bytes.isEmpty()) return err("No photo")

        var name = File(safeName(str(o, "filename")).ifEmpty { "photo-" + System.currentTimeMillis() + ".jpg" }).name
        if (!IMG_RE.containsMatchIn(name)) name += ".jpg"

        val out: String
        synchronized(lock) {
            // Never overwrite an earlier photo with the same name.
            var candidate = name
            var i = 2
            while (File(dir, candidate).exists()) {
                candidate = name.replace(EXT_RE, " ($i)$1")
                i++
            }
            File(dir, candidate).writeBytes(bytes)
            out = candidate
        }
        copyToGallery(out, f.name, bytes)

        return JSONObject()
            .put("ok", true)
            .put("fileId", f.slug + "/" + out)
            .put("downloadUrl", "pb4u-local:" + f.slug + "/" + out)
            .put("folderUrl", folderUrl)
            .put("folderName", shownName)
            .put("folderPath", dir.absolutePath)
            .toString()
    }

    // Android 10+: also put a copy in the shared Pictures folder, so the operator finds every photo in the Gallery.
    private fun copyToGallery(fileName: String, eventDir: String, bytes: ByteArray) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val mime = when (fileName.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            else -> return
        }
        try {
            val values = ContentValues()
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime)
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/photobooth4u/$eventDir")
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
        } catch (e: Exception) {
            Log.w(TAG, "Could not copy $fileName to the Gallery", e)   // the photo itself is safe in the app folder
        }
    }

    private fun loadIndex() {
        try {
            if (!indexFile.exists()) return
            val fs = JSONObject(indexFile.readText()).optJSONObject("folders") ?: return
            val keys = fs.keys()
            while (keys.hasNext()) {
                val slug = keys.next()
                val x = fs.optJSONObject(slug) ?: continue
                folders[slug] = Folder(slug, x.optString("id", ""), x.optString("name", ""), x.optString("sub", ""), x.optLong("at", 0L))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the folder list", e)
        }
    }

    private fun saveIndex() {
        try {
            val fs = JSONObject()
            for (x in folders.values) {
                fs.put(x.slug, JSONObject().put("id", x.id).put("name", x.name).put("sub", x.sub).put("at", x.at))
            }
            val tmp = File(indexFile.path + ".tmp")
            tmp.writeText(JSONObject().put("folders", fs).toString())
            if (!tmp.renameTo(indexFile)) {
                indexFile.delete()
                tmp.renameTo(indexFile)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not save the folder list", e)
        }
    }

    // ---------- this tablet's address on the booth Wi-Fi ----------

    /**
     * The tablet's IPv4 address on the booth Wi-Fi (or its own hotspot), or null when it has none.
     * Mobile-data and VPN interfaces are skipped, so the QR never points guests at an address they can't reach.
     */
    fun lanAddress(): String? {
        val found = ArrayList<Pair<String, String>>()
        try {
            val nets = NetworkInterface.getNetworkInterfaces() ?: return null
            for (ni in Collections.list(nets)) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in Collections.list(ni.inetAddresses)) {
                    if (ia !is Inet4Address || ia.isLoopbackAddress || ia.isLinkLocalAddress) continue
                    val ip = ia.hostAddress ?: continue
                    found.add(Pair(ni.name, ip))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the network address", e)
        }
        return pickLanAddress(found)
    }
}
