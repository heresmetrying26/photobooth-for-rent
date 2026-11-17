package com.photobooth4u.booth

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.media.MediaCodec
import android.media.MediaFormat
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketAddress
import java.net.SocketTimeoutException
import java.net.URL

/**
 * A GoPro (HERO9 Black and newer) used as the booth camera, through the Open GoPro HTTP API (https://github.com/gopro/OpenGoPro).
 * It answers the same few calls as the DSLR code in [UsbCameraHelper] (open, live, frame, capture, battery, close), which
 * serves them to the booth page at http://127.0.0.1:17321/camera/..., so the booth treats it like any other camera.
 *
 * How the tablet reaches the camera:
 *  - USB:   plugged in with a USB-C data cable the GoPro makes a network adapter. The camera is at 172.2X.1YZ.51 (X, Y, Z = the last
 *           three digits of its serial number); the tablet gets 172.2X.1YZ.5x. This needs a tablet whose Android brings up USB network
 *           adapters (many do not: then use Wi-Fi).
 *  - Wi-Fi: the tablet joined to the camera's own Wi-Fi (camera: Connections > Connect Device > GoPro App). The camera is 10.5.5.9.
 *
 * Live view and photos: the camera sends H.264 video in MPEG-TS to UDP port 8554 of the tablet. A small demuxer here splits the stream, the
 * tablet's own video decoder (MediaCodec) decodes it and each picture is turned into a JPEG. "frame" is the newest JPEG; "capture" is the
 * first JPEG after the call, so a photo is a 1080p still taken from the live picture (no slow switch between video and photo mode).
 */
class GoProCamera(private val ctx: Context) {

    class GoErr(val code: String, message: String) : Exception(message)

    class Found(val host: String, val mode: String, val network: Network?, val name: String, val serial: String, val firmware: String)

    companion object {
        private const val TAG = "PBGoPro"
        private const val HTTP_PORT = 8080
        private const val STREAM_PORT = 8554
        private const val RES_1080 = 12      // Open GoPro webcam resolution: 4 = 480p, 7 = 720p, 12 = 1080p
        private const val FOV_LINEAR = 4     // 0 wide, 2 narrow, 3 superview, 4 linear (no fish-eye)
        private const val WIFI_HOST = "10.5.5.9"
        private const val MIN_FRAME_GAP_MS = 80L
        private val USB_RE = Regex("^172\\.(2\\d)\\.(1\\d\\d)\\.\\d{1,3}$")

        private fun webcamError(code: Int): String = when (code) {
            1 -> "the camera could not switch preset"
            2 -> "the camera could not set the window size"
            3 -> "the camera could not start streaming"
            4 -> "the camera is busy with the shutter"
            5 -> "the camera did not answer in time"
            6 -> "a setting is not valid for this camera"
            7 -> "the camera is not available for webcam use right now (is it recording, or updating its firmware?)"
            8 -> "the camera could not leave webcam mode"
            else -> "error $code"
        }
    }

    private class Http(val code: Int, val body: ByteArray)
    private class Cand(val host: String, val mode: String, val network: Network?)

    private val lock = Any()
    @Volatile private var opened = false
    @Volatile private var host = ""
    @Volatile private var net: Network? = null
    @Volatile private var mode = ""
    @Volatile private var name = "GoPro"
    @Volatile private var serial = ""
    @Volatile private var battery = -1
    @Volatile private var jpeg: ByteArray? = null
    @Volatile private var jpegAt = 0L
    @Volatile private var rx: Rx? = null
    @Volatile private var keepGen = 0

    fun isOpen(): Boolean = opened
    fun name(): String = name

    // ================================================================ finding the camera

    private fun candidates(): List<Cand> {
        val out = ArrayList<Cand>()
        val seen = HashSet<String>()
        fun add(local: String, network: Network?) {
            val m = USB_RE.matchEntire(local)
            if (m != null) {
                val h = "172." + m.groupValues[1] + "." + m.groupValues[2] + ".51"
                if (seen.add(h)) out.add(Cand(h, "usb", network))
            } else if (local.startsWith("10.5.5.") && seen.add(WIFI_HOST)) {
                out.add(Cand(WIFI_HOST, "wifi", network))
            }
        }
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            @Suppress("DEPRECATION")
            val all = cm.allNetworks
            for (n in all) {
                val lp = cm.getLinkProperties(n) ?: continue
                for (la in lp.linkAddresses) {
                    val a = la.address
                    if (a is Inet4Address) {
                        val s = a.hostAddress
                        if (s != null) add(s, n)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "network scan failed", e)
        }
        try {
            val en = NetworkInterface.getNetworkInterfaces()
            while (en != null && en.hasMoreElements()) {
                val ni = en.nextElement()
                val ias = ni.inetAddresses
                while (ias.hasMoreElements()) {
                    val a = ias.nextElement()
                    if (a is Inet4Address) {
                        val s = a.hostAddress
                        if (s != null) add(s, null)
                    }
                }
            }
        } catch (_: Exception) { }
        return out
    }

    private fun http(h: String, n: Network?, path: String, timeoutMs: Int): Http {
        val url = URL("http://" + h + ":" + HTTP_PORT + path)
        val c = (if (n != null) n.openConnection(url) else url.openConnection()) as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.useCaches = false
        c.setRequestProperty("Connection", "close")
        try {
            val code = c.responseCode
            val s = if (code >= 400) c.errorStream else c.inputStream
            val bytes = if (s != null) s.use { it.readBytes() } else ByteArray(0)
            return Http(code, bytes)
        } finally {
            c.disconnect()
        }
    }

    private fun get(path: String, timeoutMs: Int = 4000): Http = http(host, net, path, timeoutMs)

    private fun getJson(path: String, timeoutMs: Int = 4000): JSONObject {
        val r = get(path, timeoutMs)
        if (r.code >= 400) throw GoErr("ERROR", "The GoPro refused " + path.substringBefore('?') + " (HTTP " + r.code + ").")
        val text = String(r.body, Charsets.UTF_8).trim()
        return try { JSONObject(if (text.isEmpty()) "{}" else text) } catch (_: Exception) { JSONObject() }
    }

    /** The GoPro the tablet can reach right now, or null. Quick when there is no camera network at all. */
    fun detect(): Found? {
        for (c in candidates()) {
            try {
                val r = http(c.host, c.network, "/gopro/camera/info", 2500)
                if (r.code != 200) continue
                val root = JSONObject(String(r.body, Charsets.UTF_8))
                val info = root.optJSONObject("info") ?: root
                val model = info.optString("model_name", "").replace(Regex("^GoPro\\s*", RegexOption.IGNORE_CASE), "").trim()
                return Found(c.host, c.mode, c.network, "GoPro " + (if (model.isEmpty()) "camera" else model), info.optString("serial_number", ""), info.optString("firmware_version", ""))
            } catch (_: Exception) { }
        }
        return null
    }

    // ================================================================ the booth's calls

    fun open(): JSONObject = synchronized(lock) {
        if (opened) {
            try { get("/gopro/camera/keep_alive", 2500); return@synchronized infoJson() } catch (_: Exception) { markGone() }
        }
        val f = detect() ?: throw GoErr("NOCAMERA",
            "No GoPro found. Switch the GoPro on and plug it into the tablet with a USB-C data cable (not charge-only). " +
                "If the tablet does not show the GoPro as a network adapter, use Wi-Fi instead: on the GoPro choose Connections > Connect Device > GoPro App, " +
                "then join the tablet to the GoPro's Wi-Fi (name and password are on the camera's screen).")
        host = f.host; net = f.network; mode = f.mode; name = f.name; serial = f.serial
        if (mode == "usb") { try { getJson("/gopro/camera/control/wired_usb?p=1") } catch (_: Exception) { } }
        try { getJson("/gopro/camera/analytics/set_client_info", 3000) } catch (_: Exception) { }
        opened = true
        startKeep()
        battery = readBattery()
        Log.i(TAG, "Connected: " + name + " (" + mode + " " + host + ", firmware " + f.firmware + ")")
        try {
            startStream()
        } catch (e: Exception) {
            opened = false
            keepGen++
            throw e
        }
        infoJson()
    }

    private fun infoJson(): JSONObject = JSONObject().put("name", name).put("battery", battery).put("gopro", true).put("mode", mode).put("serial", serial)

    fun live(on: Boolean) {
        needOpen()
        synchronized(lock) { if (on) startStream() else stopStream() }
    }

    /** The newest picture (JPEG), or null when none has arrived yet. */
    fun frame(): ByteArray? {
        needOpen()
        val r = rx
        if (r == null || !r.alive) synchronized(lock) { startStream() }
        val f = jpeg
        val age = System.currentTimeMillis() - jpegAt
        if (f != null && age < 4000) return f
        if (f != null && age > 6000) { markGone(); throw GoErr("GONE", "The GoPro picture stopped. Check the USB cable and that the camera is on.") }
        return null
    }

    /** A photo: the first picture that arrives after the call. */
    fun capture(): ByteArray {
        needOpen()
        val r0 = rx
        if (r0 == null || !r0.alive) synchronized(lock) { startStream() }
        val after = System.currentTimeMillis() - 20
        val t0 = System.currentTimeMillis()
        while (true) {
            val f = jpeg
            if (f != null && jpegAt >= after) return f
            if (rx?.alive != true) { markGone(); throw GoErr("GONE", "The GoPro picture stopped. Check the USB cable and that the camera is on.") }
            if (System.currentTimeMillis() - t0 > 3500) {
                if (f != null && System.currentTimeMillis() - jpegAt < 2500) return f
                throw GoErr("CAPTURE", "The GoPro picture did not arrive. Try again.")
            }
            Thread.sleep(40)
        }
    }

    fun batteryNow(): Int {
        if (!opened) return -1
        battery = readBattery()
        return battery
    }

    fun close() {
        keepGen++
        val was = opened
        opened = false
        stopRx()
        if (was) {
            try {
                if (mode == "usb") { getJson("/gopro/webcam/stop", 3000); getJson("/gopro/webcam/exit", 3000) }
                else getJson("/gopro/camera/stream/stop", 3000)
            } catch (_: Exception) { }
        }
    }

    fun release() { close() }

    private fun needOpen() {
        if (!opened) throw GoErr("GONE", "The GoPro isn't connected.")
    }

    private fun markGone() {
        opened = false
        keepGen++
        stopRx()
    }

    private fun readBattery(): Int {
        try {
            val st = getJson("/gopro/camera/state", 4000).optJSONObject("status") ?: return -1
            val pct = st.optInt("70", -1)                    // status 70 = internal battery percentage
            if (pct in 0..100) return pct
            val bars = st.optInt("2", -1)                    // status 2 = battery bars (0..4)
            if (bars in 0..4) return bars * 25
        } catch (_: Exception) { }
        return -1
    }

    /** Keeps the camera awake and notices when it was unplugged. */
    private fun startKeep() {
        val gen = ++keepGen
        Thread({
            var fails = 0
            while (keepGen == gen && opened) {
                try { Thread.sleep(3000) } catch (_: InterruptedException) { }
                if (keepGen != gen || !opened) break
                try {
                    get("/gopro/camera/keep_alive", 2500)
                    fails = 0
                } catch (_: Exception) {
                    fails++
                    if (fails >= 3) { Log.i(TAG, "Camera stopped answering"); markGone(); break }
                }
            }
        }, "pb-gopro-keep").also { it.isDaemon = true; it.start() }
    }

    // ================================================================ live view

    private fun startStream() {
        val r0 = rx
        if (r0 != null && r0.alive && jpeg != null) return
        stopRx()
        jpeg = null
        jpegAt = 0L
        val r = Rx(STREAM_PORT, net)
        r.begin()
        rx = r
        try {
            if (mode == "usb") {
                // The camera's webcam mode: leave any earlier stream, enter preview, then start at 1080p with the Linear lens.
                var st = 0
                try { st = getJson("/gopro/webcam/status", 4000).optInt("status", 0) } catch (_: Exception) { }
                if (st >= 2) { try { getJson("/gopro/webcam/stop", 6000); Thread.sleep(400) } catch (_: Exception) { } }
                try { getJson("/gopro/webcam/preview", 8000); Thread.sleep(300) } catch (_: Exception) { }
                val j = getJson("/gopro/webcam/start?res=" + RES_1080 + "&fov=" + FOV_LINEAR + "&port=" + STREAM_PORT + "&protocol=TS", 10000)
                val code = j.optInt("error", 0)
                if (code > 0) throw GoErr("ERROR", "The GoPro would not start its webcam picture: " + webcamError(code) + ".")
            } else {
                getJson("/gopro/camera/stream/start?port=" + STREAM_PORT, 8000)
            }
            val t0 = System.currentTimeMillis()
            while (jpeg == null && System.currentTimeMillis() - t0 < 14000) {
                if (!r.alive) throw GoErr("ERROR", "The tablet could not decode the GoPro picture" + (if (r.err.isNotEmpty()) " (" + r.err + ")" else "") + ".")
                Thread.sleep(120)
            }
            if (jpeg == null) throw GoErr("ERROR", "The GoPro started, but no picture reached the tablet. Unplug and replug the GoPro, then try again.")
        } catch (e: Exception) {
            stopRx()
            throw e
        }
    }

    private fun stopStream() {
        stopRx()
        try {
            if (mode == "usb") { getJson("/gopro/webcam/stop", 5000); getJson("/gopro/webcam/exit", 5000) }
            else getJson("/gopro/camera/stream/stop", 5000)
        } catch (_: Exception) { }
    }

    private fun stopRx() {
        val r = rx
        rx = null
        r?.stop()
    }

    /** Receives the camera's UDP video, splits it and decodes it. */
    private inner class Rx(val port: Int, val network: Network?) {
        @Volatile var alive = true
        @Volatile var err = ""
        private var sock: DatagramSocket? = null

        fun begin() {
            val s = DatagramSocket(null as SocketAddress?)
            try {
                s.reuseAddress = true
                try { network?.bindSocket(s) } catch (_: Exception) { }
                s.bind(InetSocketAddress(port))
                s.soTimeout = 1000
                try { s.receiveBufferSize = 1 shl 20 } catch (_: Exception) { }
            } catch (e: Exception) {
                try { s.close() } catch (_: Exception) { }
                throw GoErr("ERROR", "The tablet could not listen for the GoPro picture on port " + port + ": " + (e.message ?: e.javaClass.simpleName))
            }
            sock = s
            Thread({ loop(s) }, "pb-gopro-rx").also { it.isDaemon = true; it.start() }
        }

        fun stop() {
            alive = false
            try { sock?.close() } catch (_: Exception) { }
        }

        private fun loop(s: DatagramSocket) {
            val demux = TsDemux()
            val dec = Decoder()
            val buf = ByteArray(2048)
            val pkt = DatagramPacket(buf, buf.size)
            try {
                while (alive) {
                    pkt.length = buf.size
                    try { s.receive(pkt) } catch (_: SocketTimeoutException) { continue }
                    demux.feed(buf, pkt.length) { pes -> dec.onPes(pes, demux.h264) }
                }
            } catch (e: Exception) {
                if (alive) { err = e.message ?: e.javaClass.simpleName; Log.w(TAG, "stream stopped", e) }
            } finally {
                alive = false
                dec.release()
                try { s.close() } catch (_: Exception) { }
            }
        }
    }

    /** MPEG-TS: finds the video stream in the PAT / PMT and hands over each picture's data (a PES payload). */
    private class TsDemux {
        var pmtPid = -1
        var videoPid = -1
        var h264 = true
        private val pes = ByteArrayOutputStream(256 * 1024)
        private var hasPes = false

        fun feed(b: ByteArray, len: Int, onPes: (ByteArray) -> Unit) {
            var o = 0
            while (o + 188 <= len) {
                if (b[o] != 0x47.toByte()) { o++; continue }
                packet(b, o, onPes)
                o += 188
            }
        }

        private fun packet(b: ByteArray, o: Int, onPes: (ByteArray) -> Unit) {
            val pusi = (b[o + 1].toInt() and 0x40) != 0
            val pid = ((b[o + 1].toInt() and 0x1F) shl 8) or (b[o + 2].toInt() and 0xFF)
            val afc = (b[o + 3].toInt() shr 4) and 3
            if ((afc and 1) == 0) return                      // no payload
            var p = o + 4
            if ((afc and 2) != 0) p += 1 + (b[o + 4].toInt() and 0xFF)
            val end = o + 188
            if (p >= end) return
            if (pid == 0) { section(b, p, end, pusi, true); return }
            if (pid == pmtPid) { section(b, p, end, pusi, false); return }
            if (pid == videoPid) {
                if (pusi) { flush(onPes); hasPes = true }
                if (hasPes) {
                    if (pes.size() > 6 * 1024 * 1024) { pes.reset(); hasPes = false; return }
                    pes.write(b, p, end - p)
                }
            }
        }

        private fun flush(onPes: (ByteArray) -> Unit) {
            if (hasPes && pes.size() > 0) {
                val d = pes.toByteArray()
                pes.reset()
                val payload = payloadOf(d)
                if (payload != null) onPes(payload)
            } else {
                pes.reset()
            }
            hasPes = false
        }

        private fun payloadOf(d: ByteArray): ByteArray? {
            if (d.size < 9 || d[0].toInt() != 0 || d[1].toInt() != 0 || d[2].toInt() != 1) return null
            val start = 9 + (d[8].toInt() and 0xFF)
            if (start >= d.size) return null
            return d.copyOfRange(start, d.size)
        }

        private fun section(b: ByteArray, p0: Int, end: Int, pusi: Boolean, pat: Boolean) {
            if (!pusi) return
            val p = p0 + 1 + (b[p0].toInt() and 0xFF)         // after the pointer field
            if (p + 12 > end) return
            val secLen = ((b[p + 1].toInt() and 0x0F) shl 8) or (b[p + 2].toInt() and 0xFF)
            val secEnd = minOf(p + 3 + secLen - 4, end)       // without the CRC
            if (pat) {
                var q = p + 8
                while (q + 4 <= secEnd) {
                    val prog = ((b[q].toInt() and 0xFF) shl 8) or (b[q + 1].toInt() and 0xFF)
                    val pid = ((b[q + 2].toInt() and 0x1F) shl 8) or (b[q + 3].toInt() and 0xFF)
                    if (prog != 0) { pmtPid = pid; return }
                    q += 4
                }
            } else {
                val progInfo = ((b[p + 10].toInt() and 0x0F) shl 8) or (b[p + 11].toInt() and 0xFF)
                var q = p + 12 + progInfo
                while (q + 5 <= secEnd) {
                    val type = b[q].toInt() and 0xFF
                    val pid = ((b[q + 1].toInt() and 0x1F) shl 8) or (b[q + 2].toInt() and 0xFF)
                    val esLen = ((b[q + 3].toInt() and 0x0F) shl 8) or (b[q + 4].toInt() and 0xFF)
                    if (type == 0x1B || type == 0x24) { videoPid = pid; h264 = (type == 0x1B); return }
                    q += 5 + esLen
                }
            }
        }
    }

    /** The tablet's video decoder; writes each decoded picture to [jpeg]. */
    private inner class Decoder {
        private var codec: MediaCodec? = null
        private var ptsUs = 0L
        private var lastJpegAt = 0L
        private val info = MediaCodec.BufferInfo()

        /** The decoder can only begin at a picture that carries the stream settings (SPS for H.264, VPS for HEVC). */
        private fun hasParams(d: ByteArray, h264: Boolean): Boolean {
            var i = 0
            val n = minOf(d.size - 4, 200000)
            while (i < n) {
                if (d[i].toInt() == 0 && d[i + 1].toInt() == 0 && d[i + 2].toInt() == 1) {
                    val t = d[i + 3].toInt() and 0xFF
                    if (h264 && (t and 0x1F) == 7) return true
                    if (!h264 && ((t shr 1) and 0x3F) == 32) return true
                    i += 3
                } else {
                    i++
                }
            }
            return false
        }

        fun onPes(d: ByteArray, h264: Boolean) {
            if (codec == null) {
                if (!hasParams(d, h264)) return
                val mime = if (h264) "video/avc" else "video/hevc"
                val fmt = MediaFormat.createVideoFormat(mime, 1920, 1080)
                fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 2 * 1024 * 1024)
                try { fmt.setInteger("low-latency", 1) } catch (_: Exception) { }
                val c = MediaCodec.createDecoderByType(mime)
                c.configure(fmt, null, null, 0)
                c.start()
                codec = c
            }
            val c = codec ?: return
            val i = c.dequeueInputBuffer(20000)
            if (i >= 0) {
                val ib = c.getInputBuffer(i)
                if (ib != null) {
                    ib.clear()
                    val n = minOf(d.size, ib.capacity())
                    ib.put(d, 0, n)
                    c.queueInputBuffer(i, 0, n, ptsUs, 0)
                    ptsUs += 33333L
                } else {
                    c.queueInputBuffer(i, 0, 0, ptsUs, 0)
                }
            }
            drain(c)
        }

        private fun drain(c: MediaCodec) {
            while (true) {
                val o = c.dequeueOutputBuffer(info, 0)
                if (o >= 0) {
                    val now = System.currentTimeMillis()
                    if (info.size > 0 && now - lastJpegAt >= MIN_FRAME_GAP_MS) {
                        try {
                            val img = c.getOutputImage(o)
                            if (img != null) {
                                try {
                                    val j = toJpeg(img)
                                    if (j != null) { jpeg = j; jpegAt = now; lastJpegAt = now }
                                } finally {
                                    img.close()
                                }
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "could not convert a picture", e)
                        }
                    }
                    c.releaseOutputBuffer(o, false)
                } else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    break
                }
            }
        }

        private fun toJpeg(img: Image): ByteArray? {
            val crop = img.cropRect
            val w = crop.width() and 1.inv()
            val h = crop.height() and 1.inv()
            val planes = img.planes
            if (w <= 0 || h <= 0 || planes.size < 3) return null
            val nv21 = ByteArray(w * h * 3 / 2)
            val yp = planes[0]
            val yb = yp.buffer
            var o = 0
            for (r in 0 until h) {
                val base = (crop.top + r) * yp.rowStride + crop.left * yp.pixelStride
                if (yp.pixelStride == 1) {
                    yb.position(base)
                    yb.get(nv21, o, w)
                } else {
                    for (x in 0 until w) nv21[o + x] = yb.get(base + x * yp.pixelStride)
                }
                o += w
            }
            val up = planes[1]
            val vp = planes[2]
            val ub = up.buffer
            val vb = vp.buffer
            for (r in 0 until h / 2) {
                val uBase = (crop.top / 2 + r) * up.rowStride + (crop.left / 2) * up.pixelStride
                val vBase = (crop.top / 2 + r) * vp.rowStride + (crop.left / 2) * vp.pixelStride
                for (x in 0 until w / 2) {
                    nv21[o++] = vb.get(vBase + x * vp.pixelStride)
                    nv21[o++] = ub.get(uBase + x * up.pixelStride)
                }
            }
            val out = ByteArrayOutputStream(w * h / 4)
            YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 90, out)
            return out.toByteArray()
        }

        fun release() {
            val c = codec
            codec = null
            if (c != null) {
                try { c.stop() } catch (_: Exception) { }
                try { c.release() } catch (_: Exception) { }
            }
        }
    }
}
