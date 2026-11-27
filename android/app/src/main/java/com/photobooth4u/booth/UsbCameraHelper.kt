package com.photobooth4u.booth

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * A Nikon, Canon EOS or Sony Alpha camera plugged into the tablet's USB port.
 *
 * Chrome on a laptop talks to such a camera with WebUSB, but Android's WebView has no WebUSB, so the booth
 * page never saw the camera in this app. Here the app does what the photobooth4u Helper does on Windows: it
 * talks PTP (the camera's own USB protocol) through Android's USB host API and answers the booth page on
 * http://127.0.0.1:17321 with the same few calls (/camera, /camera/open, /camera/live, /camera/frame,
 * /camera/capture, /camera/battery).
 *
 * The camera logic is a line-by-line port of tools/print-helper/camera-worker.ps1 (the Windows Helper's camera
 * part, proven with real cameras); only the transport differs: there Windows' driver carries each PTP
 * operation, here this file does (see [transact]). Keep the two in step when one changes.
 */
class UsbCameraHelper(private val ctx: Context) {

    companion object {
        private const val TAG = "PBCam"
        const val PORT = 17321
        private const val ACTION_PERMISSION = "com.photobooth4u.booth.USB_CAMERA_PERMISSION"
        private const val VENDOR_NIKON = 0x04b0
        private const val VENDOR_CANON = 0x04a9
        private const val VENDOR_SONY = 0x054c
        private const val VENDOR_INSTA360 = 0x2e1a
        private const val VENDOR_DJI = 0x2ca3
        private const val VENDOR_GOPRO = 0x2672   // a GoPro is driven over its network (see GoProCamera), never as a PTP camera
        private const val INSTA360_HINT = "Insta360: on the camera set the USB mode to Webcam (camera screen > Settings > USB mode), then unplug and replug it. The Camera menu will then list it as \"USB webcam\"."
        private const val DJI_HINT = "DJI Osmo: unplug and replug the USB-C cable, then tap Webcam on the camera screen. The Camera menu will then list it as \"USB webcam\"."
        private val CAMERA_VENDORS = intArrayOf(VENDOR_NIKON, VENDOR_CANON, VENDOR_SONY, 0x04cb, 0x07b4, 0x04da, 0x0a17, 0x05ca)   // + Fujifilm, Olympus, Panasonic, Pentax, Ricoh

        private const val OK = 0x2001
        private const val SESSION_OPEN = 0x201E
        private const val BUSY = 0x2019
        private const val NOTREADY = 0xA102   // Canon: "not ready yet, ask again"
        private const val EOS_MULTI_ASPECT = 0xD194   // Canon Aspect ratio (0=3:2, 1=1:1, 2=4:3, 3/7=16:9)

        // Nikons in MTP mode (D3400, D5600...) may not list their own commands, but they still answer them.
        private val NIKON_OPS = intArrayOf(0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207)

        private val SONY_LV = 0xFFFFC002L.toInt()
        private val SONY_PHOTO = 0xFFFFC001L.toInt()
        private val ALL_ONES = 0xFFFFFFFFL.toInt()
        private val SDRAM_HANDLE = 0xFFFF0001L.toInt()
        private const val SONY_HINT = "On the camera set PC Remote: On (MENU > Network > PC Remote Function) and USB Connection to PC Remote (MENU > Setup > USB), close Imaging Edge and other camera apps, switch the camera off and on, unplug and replug the USB cable, then try again."

        @Volatile
        var activeInstance: UsbCameraHelper? = null
            private set
    }

    /** code: NOCAMERA / GONE / UNSUPPORTED / MODE / LIVEVIEW / FOCUS / CAPTURE / ERROR (what the booth page switches on). */
    private class CamErr(val code: String, message: String, val transient: Boolean = false) : Exception(message) {
        val status: Int get() = when (code) { "GONE" -> 410; "NOCAMERA" -> 404; else -> 409 }
    }

    private class Resp(val code: Int, val params: IntArray, val data: ByteArray?) {
        val bytes: ByteArray get() = data ?: ByteArray(0)
    }

    private class Desc(val type: Int, val current: String, val choices: List<String>, val getSet: Int = 0)   // getSet: 1 = the camera lets us change it right now

    private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private val lock = Any()
    private val uvc = UvcWebcam(ctx)
    private val gopro = GoProCamera(ctx)
    var printBridge: NetPrintBridge? = null

    // ---- the open camera (all guarded by lock) ----
    private var dev: UsbDevice? = null
    private var conn: UsbDeviceConnection? = null
    private var iface: UsbInterface? = null
    private var epIn: UsbEndpoint? = null
    private var epOut: UsbEndpoint? = null
    private var tid = 0
    private var pend = ByteArray(131072)
    private var pendLen = 0
    private val rbuf = ByteArray(16384)

    private var vendor = 0
    private var nikon = false
    private var canon = false
    private var sony = false
    private var camName = ""
    private var camModel = ""
    private var camMaker = ""
    private var ops: Set<Int> = emptySet()
    private var props: Set<Int> = emptySet()
    private var live = false
    private var setupNote = ""
    private var diag = ""
    @Volatile private var rovingMode = false
    @Volatile private var rovingSaveToCard = true
    private var keepOnCard = false

    // Canon
    private val eosVals = HashMap<Int, Long>()
    private val canonNew = ArrayList<LongArray>()      // new files: { handle, event, format, size }
    private var liveAt = 0L
    private var keepAt = 0L
    private var recoverNext = false      // the booth asked for a clean start: the Canon leaves remote mode before it is switched on again
    private var pollAt = -1L
    private var gotFrame = false
    private var canonAspectChanged = false
    private var canonAspectCrop = false
    private var canonAspectOrig = 0

    // Sony
    private var sonyAt = -1L                           // when the connection finished; -1 = not a Sony
    private var sonyVer = 2
    private var sonyDestBlocked = false
    @Volatile private var lastShutterMs = 0L

    @Volatile private var server: ServerSocket? = null

    private fun now() = System.nanoTime() / 1_000_000L
    private fun hex(v: Int) = "0x" + Integer.toHexString(v).uppercase()
    private fun log(s: String) { Log.i(TAG, s) }

    // ================================================================ HTTP server

    @Synchronized
    fun start() {
        activeInstance = this
        if (server != null) return
        try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT))
            server = ss
            val pool = Executors.newCachedThreadPool { r -> Thread(r, "pb-cam-conn").also { it.isDaemon = true } }
            Thread({
                while (!ss.isClosed) {
                    try { val s = ss.accept(); pool.execute { handle(s) } }
                    catch (e: IOException) { if (ss.isClosed) break }
                }
                pool.shutdownNow()
            }, "pb-cam").also { it.isDaemon = true }.start()
            log("Camera helper listening on 127.0.0.1:$PORT")
        } catch (e: Exception) {
            Log.w(TAG, "Camera helper could not start", e)
        }
    }

    @Synchronized
    fun stop() {
        if (activeInstance == this) activeInstance = null
        try { server?.close() } catch (_: IOException) { }
        server = null
        synchronized(lock) { closeCamera() }
        uvc.release()
        gopro.release()
    }

    private fun handle(s: Socket) {
        s.use { sock ->
            try {
                sock.soTimeout = 60000
                val inp = sock.getInputStream().buffered()
                val line = readLine(inp) ?: return
                val parts = line.split(' ')
                if (parts.size < 2) return
                var contentLength = 0
                while (true) {
                    val h = readLine(inp) ?: break
                    if (h.isEmpty()) break
                    val colon = h.indexOf(':')
                    if (colon > 0 && h.substring(0, colon).trim().equals("content-length", ignoreCase = true)) {
                        contentLength = h.substring(colon + 1).trim().toIntOrNull() ?: 0
                    }
                }
                val method = parts[0]
                val full = parts[1]
                val path = full.substringBefore('?').trimEnd('/')
                val query = if (full.contains('?')) full.substringAfter('?') else ""
                val out = sock.getOutputStream()
                if (method == "OPTIONS") { reply(out, 204, "text/plain", ByteArray(0)); return }

                val body = if (contentLength in 1..(50 * 1024 * 1024)) {
                    val b = ByteArray(contentLength)
                    var readTotal = 0
                    while (readTotal < contentLength) {
                        val n = inp.read(b, readTotal, contentLength - readTotal)
                        if (n < 0) break
                        readTotal += n
                    }
                    if (readTotal == contentLength) b else null
                } else null

                try {
                    route(out, method, path, query, body)
                } catch (e: CamErr) {
                    log("Camera call $path failed: ${e.code} ${e.message}")
                    reply(out, e.status, "application/json", err(e.code, e.message ?: "Camera problem").toByteArray())
                } catch (e: Exception) {
                    Log.w(TAG, "helper call failed", e)
                    reply(out, 409, "application/json", err("ERROR", e.message ?: e.javaClass.simpleName).toByteArray())
                }
            } catch (_: IOException) { }
        }
    }

    private fun readLine(i: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = i.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            if (sb.length > 4096) return null
            sb.append(c.toChar())
        }
    }

    private fun err(code: String, msg: String) = JSONObject().put("ok", false).put("code", code).put("error", msg).toString()

    private fun reply(out: OutputStream, status: Int, type: String, body: ByteArray) {
        val reason = when (status) { 200 -> "OK"; 204 -> "No Content"; 404 -> "Not Found"; 410 -> "Gone"; else -> "Error" }
        val h = "HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\n" +
            "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n" +
            "Access-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun json(out: OutputStream, o: JSONObject) = reply(out, 200, "application/json", o.put("ok", true).toString().toByteArray())

    private fun route(out: OutputStream, method: String, path: String, query: String, body: ByteArray?) {
        if (path == "/uvc" || path.startsWith("/uvc/")) {   // plain USB webcams (see UvcWebcam)
            val r = uvc.route(method, path, query)
            reply(out, r.status, r.type, r.body)
            return
        }
        when {
            method == "GET" && path == "/status" -> json(out, statusJson(query.contains("refresh=1")))
            method == "GET" && path == "/printers" -> json(out, printersJson())
            method == "GET" && path == "/paper" -> json(out, paperJson(query))
            method == "POST" && path == "/printer/configure" -> json(out, printerConfigureJson())
            method == "POST" && path == "/printer/bluetooth" -> json(out, printerBluetoothJson())
            method == "GET" && path == "/printer/discover" -> json(out, printerDiscoverJson(query))
            method == "GET" && path == "/printer/diag/info" -> printerDiagInfo(out)
            method == "POST" && path == "/printer/diag/probe" -> printerDiagProbe(out, body)
            method == "POST" && path == "/printer/diag/print" -> printerDiagPrint(out, body)
            method == "POST" && path == "/print" -> printJson(out, body)
            method == "GET" && path == "/camera" -> json(out, listAny())
            method == "POST" && path == "/camera/open" -> json(out, openAny(query.contains("fresh=1"), query.contains("saveToCard=1")))
            method == "POST" && path == "/camera/live" -> {
                val on = !query.contains("on=0")
                if (gopro.isOpen()) goTry { gopro.live(on) } else setLive(on)
                json(out, JSONObject())
            }
            method == "GET" && path == "/camera/frame" -> {
                val f = if (gopro.isOpen()) goTry { gopro.frame() } else frame()
                if (f == null) reply(out, 204, "image/jpeg", ByteArray(0)) else reply(out, 200, "image/jpeg", f)
            }
            method == "POST" && path == "/camera/capture" -> reply(out, 200, "image/jpeg", if (gopro.isOpen()) goTry { gopro.capture() } else capture())
            method == "POST" && path == "/camera/af" -> json(out, if (gopro.isOpen()) JSONObject() else autoFocus())   // a GoPro focuses by itself
            method == "GET" && path == "/camera/battery" -> json(out, JSONObject().put("battery", if (gopro.isOpen()) gopro.batteryNow() else battery()))
            // The booth's Camera check: read the camera's shutter / aperture / ISO and set them (Nikon; any other camera, and a GoPro, answer supported:false)
            method == "GET" && path == "/camera/props" -> json(out, if (gopro.isOpen()) JSONObject().put("supported", false) else synchronized(lock) { needCamera(); exposureJson() })
            method == "POST" && path == "/camera/setprops" -> json(out, if (gopro.isOpen()) JSONObject().put("supported", false) else setExposure(query))
            method == "POST" && path == "/camera/close" -> { gopro.close(); synchronized(lock) { closeCamera() }; json(out, JSONObject()) }
            method == "POST" && path == "/camera/free" -> json(out, JSONObject())
            else -> reply(out, 404, "application/json", err("NOTFOUND", "Not found").toByteArray())
        }
    }

    private fun statusJson(refresh: Boolean): JSONObject {
        val o = JSONObject()
        o.put("ok", true)
        o.put("app", "photobooth4u-print-helper")
        o.put("version", "1.1.12-android")
        o.put("printerDiag", true)
        val pb = printBridge
        val printersArr = JSONArray()
        if (pb != null) {
            for (p in pb.getPrinterNames()) printersArr.put(p)
        }
        o.put("printers", printersArr)
        val camObj = JSONObject()
        camObj.put("supported", true)
        camObj.put("open", conn != null || gopro.isOpen())
        camObj.put("name", if (gopro.isOpen()) gopro.name() else dev?.let { it.productName ?: "Camera" } ?: "")
        camObj.put("free", false)
        o.put("camera", camObj)
        return o
    }

    private fun printersJson(): JSONObject {
        val o = JSONObject().put("ok", true)
        val arr = JSONArray()
        printBridge?.let { pb ->
            for (p in pb.getPrinterNames()) arr.put(p)
        }
        o.put("printers", arr)
        return o
    }

    private fun paperJson(query: String): JSONObject {
        val o = JSONObject().put("ok", true).put("known", true)
        val match = JSONObject().put("name", "4x6 in").put("borderless", true).put("isDefault", true)
        o.put("match", match)
        o.put("def", "4x6 in")
        val sizes = JSONArray().put("4x6 in").put("2x6 in").put("A4").put("80mm Receipt").put("58mm Receipt")
        o.put("sizes", sizes)
        return o
    }

    private fun printerConfigureJson(): JSONObject =
        JSONObject().put("ok", true).put("message", "Printer preferences are managed automatically by the Photobooth Helper.")

    private fun printerBluetoothJson(): JSONObject {
        try {
            val i = Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            ctx.startActivity(i)
        } catch (_: Exception) {}
        return JSONObject().put("ok", true).put("message", "Bluetooth settings opened.")
    }

    private fun queryParam(query: String, key: String): String {
        if (query.isBlank()) return ""
        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            val k = if (eq >= 0) part.substring(0, eq) else part
            if (k == key) {
                val raw = if (eq >= 0) part.substring(eq + 1) else ""
                return try { java.net.URLDecoder.decode(raw, "UTF-8") } catch (_: Exception) { raw }
            }
        }
        return ""
    }

    private fun printerDiscoverJson(query: String): JSONObject {
        val pb = printBridge ?: return JSONObject().put("ok", true).put("printers", JSONArray())
        val extra = queryParam(query, "ip").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return pb.discoverForHelper(extra)
    }

    private fun printerDiagInfo(out: OutputStream) {
        val pb = printBridge
        if (pb == null) {
            reply(out, 503, "application/json", err("UNAVAILABLE", "Print bridge not available").toByteArray())
            return
        }
        val res = pb.diagNetworkJson().put("ok", true)
        reply(out, 200, "application/json", res.toString().toByteArray(Charsets.UTF_8))
    }

    private fun printerDiagProbe(out: OutputStream, body: ByteArray?) {
        val pb = printBridge
        if (pb == null) {
            reply(out, 503, "application/json", err("UNAVAILABLE", "Print bridge not available").toByteArray())
            return
        }
        val req = try {
            if (body != null && body.isNotEmpty()) JSONObject(String(body, Charsets.UTF_8)) else JSONObject()
        } catch (_: Exception) {
            reply(out, 400, "application/json", err("BAD_REQUEST", "Invalid JSON body").toByteArray())
            return
        }
        val ip = req.optString("ip", "").trim()
        val cases = req.optJSONArray("cases")
        val res = pb.diagProbeSync(ip, cases)
        reply(out, 200, "application/json", res.toString().toByteArray(Charsets.UTF_8))
    }

    private fun printerDiagPrint(out: OutputStream, body: ByteArray?) {
        val pb = printBridge
        if (pb == null) {
            reply(out, 503, "application/json", err("UNAVAILABLE", "Print bridge not available").toByteArray())
            return
        }
        if (body == null || body.isEmpty()) {
            reply(out, 400, "application/json", err("BAD_REQUEST", "Missing request body").toByteArray())
            return
        }
        val req = try {
            JSONObject(String(body, Charsets.UTF_8))
        } catch (_: Exception) {
            reply(out, 400, "application/json", err("BAD_REQUEST", "Invalid JSON body").toByteArray())
            return
        }
        val res = pb.diagPrintSync(req)
        reply(out, 200, "application/json", res.toString().toByteArray(Charsets.UTF_8))
    }

    private fun printJson(out: OutputStream, body: ByteArray?) {
        if (body == null || body.isEmpty()) {
            reply(out, 400, "application/json", err("BAD_REQUEST", "Missing request body").toByteArray())
            return
        }
        val pb = printBridge
        if (pb == null) {
            reply(out, 503, "application/json", err("UNAVAILABLE", "Print bridge not available").toByteArray())
            return
        }
        try {
            val req = JSONObject(String(body, Charsets.UTF_8))
            val printer = req.optString("printer", "").trim()
            val widthMm = req.optDouble("widthMm", 101.6)
            val heightMm = req.optDouble("heightMm", 152.4)
            val fit = req.optString("fit", "").ifEmpty { null }
            val pages = req.optJSONArray("pages")
            if (pages == null || pages.length() == 0) {
                reply(out, 400, "application/json", err("NOPAGES", "No pages to print").toByteArray())
                return
            }
            val receiptObj = req.optJSONObject("receipt") ?: if (fit == "width") {
                JSONObject()
                    .put("quality", req.optString("quality", "best").ifBlank { "best" })
                    .put("band", if (widthMm <= 55.0) 32 else 256)
            } else null
            val err = pb.printFromHelper(printer, widthMm, heightMm, pages, fit, receiptObj, req.optJSONObject("options"))
            if (err == null) {
                json(out, JSONObject())
            } else {
                reply(out, 500, "application/json", err("PRINT_FAILED", err).toByteArray())
            }
        } catch (e: Exception) {
            Log.e(TAG, "printJson failed", e)
            reply(out, 500, "application/json", err("ERROR", e.message ?: "Print failed").toByteArray())
        }
    }

    // ================================================================ devices

    private fun hasInterfaceClass(d: UsbDevice, cls: Int): Boolean {
        for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == cls) return true
        return false
    }

    /** A still-image (PTP) device; or a camera maker's device showing as a USB drive (Sony without PC Remote).
     *  Excludes USB printers (class 7) so multifunction printers with scanner/PictBridge class 6 are never mistaken for a DSLR. */
    private fun isCamera(d: UsbDevice): Boolean =
        d.vendorId != VENDOR_GOPRO &&
            !hasInterfaceClass(d, UsbConstants.USB_CLASS_PRINTER) &&
            (hasInterfaceClass(d, 6) || (CAMERA_VENDORS.contains(d.vendorId) && hasInterfaceClass(d, 8)))

    // ---- GoPro: used when no DSLR / mirrorless camera is plugged in (see GoProCamera) ----

    private fun goErr(e: GoProCamera.GoErr): CamErr = CamErr(e.code, e.message ?: "GoPro problem")

    private fun <T> goTry(f: () -> T): T = try { f() } catch (e: GoProCamera.GoErr) { throw goErr(e) }

    private fun dslrPlugged(): Boolean {
        if (synchronized(lock) { conn != null }) return true
        for (d in usb.deviceList.values) if (isCamera(d)) return true
        return false
    }

    /** The camera list: the USB cameras, plus the GoPro when it is the camera found. */
    private fun listAny(): JSONObject {
        val o = listJson()
        if (gopro.isOpen()) {
            val g = JSONObject().put("name", gopro.name()).put("maker", "GoPro").put("camera", true).put("gopro", true)
            return JSONObject().put("devices", JSONArray().put(g)).put("open", true).put("name", gopro.name())
        }
        if (!dslrPlugged()) {
            val f = try { gopro.detect() } catch (_: Exception) { null }
            if (f != null) {
                val arr = o.optJSONArray("devices") ?: JSONArray()
                arr.put(JSONObject().put("name", f.name).put("maker", "GoPro").put("camera", true).put("gopro", true))
                o.put("devices", arr)
            }
        }
        return o
    }

    private fun openAny(fresh: Boolean, saveToCard: Boolean = false): JSONObject {
        if (gopro.isOpen()) {
            if (fresh) gopro.close() else return goTry { gopro.open() }
        }
        if (!dslrPlugged()) {
            val f = try { gopro.detect() } catch (_: Exception) { null }
            if (f != null) return goTry { gopro.open() }
        }
        return openCamera(fresh, roving = false, saveToCard = saveToCard)
    }

    private fun listJson(): JSONObject {
        synchronized(lock) {
            // An open camera that was unplugged meanwhile: notice it now.
            if (conn != null) {
                val d = dev
                var ok = d != null && usb.deviceList.containsKey(d.deviceName)
                if (ok) try { alive() } catch (_: Exception) { ok = false }
                if (!ok) { log("Camera lost"); closeCamera() }
            }
        }
        val arr = JSONArray()
        for (d in usb.deviceList.values) {
            if (!isCamera(d)) continue
            arr.put(JSONObject().put("name", d.productName ?: "USB camera").put("maker", d.manufacturerName ?: "").put("camera", true))
        }
        val o = JSONObject().put("devices", arr)
        synchronized(lock) { o.put("open", conn != null).put("name", if (conn != null) camName else "").put("shutterMs", lastShutterMs).put("aspectCrop", canon && canonAspectCrop) }
        return o
    }

    private fun requestPermission(d: UsbDevice) {
        if (usb.hasPermission(d)) return
        val latch = CountDownLatch(1)
        val rcv = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) { latch.countDown() }
        }
        ContextCompat.registerReceiver(ctx, rcv, IntentFilter(ACTION_PERMISSION), ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(ctx, 0, Intent(ACTION_PERMISSION).setPackage(ctx.packageName), flags)
            usb.requestPermission(d, pi)
            latch.await(60, TimeUnit.SECONDS)
        } finally {
            try { ctx.unregisterReceiver(rcv) } catch (_: Exception) { }
        }
        if (!usb.hasPermission(d)) throw CamErr("NOCAMERA", "The tablet needs your OK to use the camera. Tap Try Again and choose OK when Android asks.")
    }

    // ================================================================ PTP transport (replaces Windows' driver)

    private fun gone(why: String): CamErr {
        closeUsb()
        return CamErr("GONE", why)
    }

    /**
     * A USB transfer failed. Only when the camera has really left the USB bus is it gone; otherwise (a slow answer,
     * a stalled endpoint) clear the stall, drain what is left of the exchange and let the caller try again.
     */
    private fun usbFail(why: String, what: String): CamErr {
        val d = dev
        val present = d != null && usb.deviceList.containsKey(d.deviceName)
        log("USB $what failed; the camera is " + (if (present) "still listed" else "no longer listed"))
        if (!present) return gone(why)
        resync()
        return CamErr("ERROR", "The camera paused for a moment ($what). Trying again.", true)
    }

    private fun resync() {
        val c = conn ?: return
        for (ep in listOfNotNull(epIn, epOut)) { try { c.controlTransfer(0x02, 0x01, 0, ep.address, null, 0, 1000) } catch (_: Exception) { } }   // CLEAR_FEATURE(ENDPOINT_HALT)
        val ep = epIn
        if (ep != null) { var n = 0; while (n < 20 && c.bulkTransfer(ep, rbuf, rbuf.size, 100) > 0) n++ }
        pendLen = 0
    }

    private fun send(b: ByteArray) {
        val c = conn ?: throw gone("The camera was unplugged.")
        val ep = epOut ?: throw gone("The camera was unplugged.")
        var off = 0
        while (off < b.size) {
            val n = minOf(16384, b.size - off)
            val chunk = if (off == 0 && n == b.size) b else b.copyOfRange(off, off + n)
            val r = c.bulkTransfer(ep, chunk, n, 5000)
            if (r < 0) throw usbFail("The camera stopped answering. Check it is on and the USB cable is plugged in.", "write")
            off += n
        }
    }

    private fun fill(n: Int, timeoutMs: Int) {
        val c = conn ?: throw gone("The camera was unplugged.")
        val ep = epIn ?: throw gone("The camera was unplugged.")
        var empty = 0
        while (pendLen < n) {
            val r = c.bulkTransfer(ep, rbuf, rbuf.size, timeoutMs)
            if (r < 0) throw usbFail("The camera stopped answering. Check it is on and the USB cable is plugged in.", "read")
            if (r == 0) { if (++empty > 50) throw usbFail("The camera stopped answering.", "read"); continue }   // zero-length packet that ends a transfer
            empty = 0
            if (pendLen + r > pend.size) pend = pend.copyOf(maxOf(pend.size * 2, pendLen + r))
            System.arraycopy(rbuf, 0, pend, pendLen, r)
            pendLen += r
        }
    }

    private fun le(b: ByteArray, o: Int): Int = ByteBuffer.wrap(b, o, 4).order(ByteOrder.LITTLE_ENDIAN).int
    private fun le16(b: ByteArray, o: Int): Int = ByteBuffer.wrap(b, o, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
    private fun u32(b: ByteArray, o: Int): Long = le(b, o).toLong() and 0xFFFFFFFFL

    private fun container(type: Int, code: Int, t: Int, params: IntArray, payload: ByteArray? = null): ByteArray {
        val len = 12 + params.size * 4 + (payload?.size ?: 0)
        val bb = ByteBuffer.allocate(len).order(ByteOrder.LITTLE_ENDIAN)
        bb.putInt(len).putShort(type.toShort()).putShort(code.toShort()).putInt(t)
        params.forEach { bb.putInt(it) }
        if (payload != null) bb.put(payload)
        return bb.array()
    }

    /** One PTP operation: command, optional data out, then the camera's data (if any) and its response. */
    private fun transact(op: Int, params: IntArray = IntArray(0), out: ByteArray? = null, timeoutMs: Int = 15000): Resp {
        val t = ++tid
        send(container(1, op, t, params))
        if (out != null) send(container(2, op, t, IntArray(0), out))
        var dataOut: java.io.ByteArrayOutputStream? = null
        while (true) {
            fill(12, timeoutMs)
            val len = le(pend, 0)
            if (len < 12 || len > 300_000_000) throw usbFail("The camera sent something unexpected. Unplug it and plug it in again.", "answer")
            fill(len, timeoutMs)
            val type = le16(pend, 4)
            val code = le16(pend, 6)
            val cTid = le(pend, 8)
            val payloadLen = len - 12
            val skip = (type == 4) || (cTid != t && cTid != 0)
            if (!skip) {
                if (type == 2) {
                    if (dataOut == null) dataOut = java.io.ByteArrayOutputStream(payloadLen)
                    if (payloadLen > 0) dataOut.write(pend, 12, payloadLen)
                } else if (type == 3) {
                    val params = IntArray(payloadLen / 4) { le(pend, 12 + it * 4) }
                    val rem = pendLen - len
                    if (rem > 0) System.arraycopy(pend, len, pend, 0, rem)
                    pendLen = rem
                    val outBytes = dataOut?.toByteArray()
                    if (pendLen == 0 && pend.size > 4_194_304) pend = ByteArray(262144)
                    return Resp(code, params, outBytes)
                }
            }
            val rem = pendLen - len
            if (rem > 0) System.arraycopy(pend, len, pend, 0, rem)
            pendLen = rem
        }
    }

    // The same five calls the Windows worker has: Op, OpP, OpRead, OpWrite.
    private fun op(code: Int, vararg ps: Int): Int = transact(code, ps).code
    private fun opP(code: Int, vararg ps: Int): Resp = transact(code, ps)
    private fun opRead(code: Int, vararg ps: Int): Resp = transact(code, ps, null, 30000)
    private fun opWrite(code: Int, data: ByteArray, vararg ps: Int): Int = transact(code, ps, data).code

    // ================================================================ reading PTP data

    private class Rd(val b: ByteArray) {
        var p = 0
        val more: Boolean get() = p < b.size
        fun u8() = if (p < b.size) b[p++].toInt() and 0xFF else { p++; 0 }
        fun u16(): Int { val v = if (p + 2 <= b.size) ByteBuffer.wrap(b, p, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF else 0; p += 2; return v }
        fun u32(): Int { val v = if (p + 4 <= b.size) ByteBuffer.wrap(b, p, 4).order(ByteOrder.LITTLE_ENDIAN).int else 0; p += 4; return v }
        fun str(): String { val n = u8(); val sb = StringBuilder(); repeat(n) { val c = u16(); if (c != 0) sb.append(c.toChar()) }; return sb.toString() }
        fun arr(): Set<Int> { val n = u32(); if (n < 0 || n > 8192) return emptySet(); val s = HashSet<Int>(); repeat(n) { s.add(u16()) }; return s }
        /** One value of a PTP data type, as text (numbers) or the string itself. */
        fun value(type: Int): String = when (type) {
            1 -> u8().toByte().toString()
            2 -> u8().toString()
            3 -> u16().toShort().toString()
            4 -> u16().toString()
            5 -> u32().toString()
            6 -> (u32().toLong() and 0xFFFFFFFFL).toString()
            0xFFFF -> str()
            else -> throw Exception("type $type")
        }
    }

    private fun has(op: Int): Boolean = ops.contains(op) || (nikon && NIKON_OPS.contains(op))

    private fun readInfo(): Boolean {
        val r = opRead(0x1001)
        if (r.code != OK && r.code != 0) return false
        val rd = Rd(r.bytes)
        rd.u16(); vendor = rd.u32(); rd.u16(); rd.str(); rd.u16()
        ops = rd.arr(); rd.arr(); props = rd.arr(); rd.arr(); rd.arr()
        camMaker = rd.str(); camModel = rd.str()
        nikon = vendor == 0x0A || camMaker.contains("nikon", ignoreCase = true)
        canon = !nikon && (vendor == 0x0B || camMaker.contains("canon", ignoreCase = true))
        sony = !nikon && !canon && (vendor == 0x11 || camMaker.contains("sony", ignoreCase = true))
        val mine = if (canon) intArrayOf(0x9114, 0x9115, 0x9116, 0x9153, 0x9110, 0x910F, 0x9128)
            else if (sony) intArrayOf(0x9201, 0x9202, 0x9205, 0x9207, 0x9209)
            else intArrayOf(0x9201, 0x9203, 0x90C0, 0x90C7, 0x90C8)
        val listed = mine.filter { ops.contains(it) }.joinToString(" ") { Integer.toHexString(it).uppercase() }
        diag = "vendor $vendor, ${ops.size} ops, lists: ${if (listed.isEmpty()) "none of ours" else listed}"
        log("DeviceInfo $camMaker $camModel: $diag")
        return true
    }

    // ================================================================ open / close

    private fun releaseUsb() {
        try { iface?.let { conn?.releaseInterface(it) } } catch (_: Exception) { }
        try { conn?.close() } catch (_: Exception) { }
        conn = null; dev = null; iface = null; epIn = null; epOut = null
        pendLen = 0
    }

    /** The camera is gone (or about to be handed back): forget it without talking to it. */
    private fun closeUsb() {
        releaseUsb()
        live = false; nikon = false; canon = false; sony = false; sonyAt = -1L; sonyVer = 2; sonyDestBlocked = false; lastShutterMs = 0L
        canonAspectChanged = false; canonAspectCrop = false; canonAspectOrig = 0
    }

    /** Hands the camera back politely, then lets go of the USB connection. */
    private fun closeCamera() {
        if (conn != null) {
            try {
                if (nikon && live) { try { op(0x9202) } catch (e: CamErr) { throw e } catch (_: Exception) { } }
                if (canon) {
                    // Hand the camera back: restore aspect ratio, live view off, out of remote mode.
                    try { canonRestoreAspect() } catch (e: CamErr) { throw e } catch (_: Exception) { }
                    try { if (live) setEos(0xD1B0, 0); op(0x9115, 0); op(0x9114, 0) } catch (e: CamErr) { throw e } catch (_: Exception) { }
                }
                if (sony) sonyReleaseButtons(false)
                try { op(0x1003) } catch (e: CamErr) { throw e } catch (_: Exception) { }     // CloseSession
            } catch (_: CamErr) { }
        }
        closeUsb()
    }

    // fresh: the booth lost the picture. A camera that went to sleep can still be listed and answer "alive" with a dead
    // session, so close it and connect again (leaving remote mode first) instead of trusting it.
    private fun openCamera(fresh: Boolean = false, roving: Boolean = false, saveToCard: Boolean = false): JSONObject = synchronized(lock) {
        if (fresh) recoverNext = true
        val wantCard = if (roving) rovingSaveToCard else saveToCard
        if (conn != null) {
            val d = dev
            if (!fresh && d != null && usb.deviceList.containsKey(d.deviceName) && rovingMode == roving && keepOnCard == wantCard) {
                try { alive(); return@synchronized infoJson() } catch (_: Exception) { }
            }
            closeCamera()
        }
        rovingMode = roving
        keepOnCard = wantCard
        val all = usb.deviceList.values.filter { isCamera(it) }
        if (all.isEmpty()) {
            if (usb.deviceList.values.any { it.vendorId == VENDOR_DJI }) throw CamErr("NOCAMERA", "The DJI Osmo is plugged in, but the tablet app cannot remote-control it as a DSLR. $DJI_HINT")
            throw CamErr("NOCAMERA", "No camera found. Plug the camera into the tablet with a data USB cable (not charge-only) and switch it on.")
        }
        var seen = ""
        var brandErr: CamErr? = null
        for (d in all) {
            try {
                val r = openOne(d, roving, wantCard)
                if (r != null) return@synchronized r
                seen += (if (seen.isEmpty()) "" else ", ") + "$camMaker $camModel".trim()
                closeCamera()
            } catch (e: CamErr) {
                log("Skipped ${d.productName}: ${e.message}")
                val first = brandErr
                if (first == null || (first.code == "NOCAMERA" && e.code != "NOCAMERA")) brandErr = e
                if (conn != null) closeCamera()
            }
        }
        brandErr?.let { throw it }
        if (all.any { it.vendorId == VENDOR_INSTA360 }) throw CamErr("NOCAMERA", "The Insta360 is plugged in, but the tablet app cannot remote-control it as a camera. $INSTA360_HINT")
        if (all.any { it.vendorId == VENDOR_DJI }) throw CamErr("NOCAMERA", "The DJI Osmo is plugged in, but the tablet app cannot remote-control it as a DSLR. $DJI_HINT")
        if (seen.isNotEmpty()) throw CamErr("NOCAMERA", "Found $seen, but the tablet app can only control Nikon, Canon EOS and Sony Alpha cameras. For another make, switch the camera to its USB webcam mode (or use an HDMI capture card): it then shows up in the Camera list by itself.")
        throw CamErr("NOCAMERA", "No camera found. Plug the camera into the tablet with a data USB cable (not charge-only) and switch it on.")
    }

    /** Opens one USB device. Returns the camera's info, or null when it is not a Nikon / Canon / Sony camera. */
    private fun openOne(d: UsbDevice, roving: Boolean = false, wantCard: Boolean = false): JSONObject? {
        rovingMode = roving
        keepOnCard = wantCard
        var itf: UsbInterface? = null
        for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == 6) { itf = d.getInterface(i); break }
        if (itf == null) {
            if (d.vendorId == VENDOR_SONY) throw CamErr("MODE", "The Sony camera is connected as a file-transfer drive, not for remote control. $SONY_HINT")
            if (d.vendorId == VENDOR_INSTA360) throw CamErr("MODE", "The Insta360 is not in webcam mode, so the tablet cannot use it. $INSTA360_HINT")
            if (d.vendorId == VENDOR_DJI) throw CamErr("MODE", "The DJI Osmo is not in webcam mode, so the tablet cannot use it. $DJI_HINT")
            throw CamErr("UNSUPPORTED", "This camera is not in a USB mode the booth can control. Set its USB mode to PTP / MTP (Nikon: Setup menu > USB; Canon: Photo Import / Remote Control), then plug it in again.")
        }
        requestPermission(d)
        val c = usb.openDevice(d) ?: throw CamErr("ERROR", "Android would not let the app open the camera. Unplug and replug it, then tap Try Again.")
        if (!c.claimInterface(itf, true)) { c.close(); throw CamErr("ERROR", "Another app is using the camera. Close it, unplug and replug the camera, then tap Try Again.") }
        var bi: UsbEndpoint? = null
        var bo: UsbEndpoint? = null
        for (i in 0 until itf.endpointCount) {
            val e = itf.getEndpoint(i)
            if (e.type == UsbConstants.USB_ENDPOINT_XFER_BULK) { if (e.direction == UsbConstants.USB_DIR_IN) bi = e else bo = e }
        }
        if (bi == null || bo == null) { c.releaseInterface(itf); c.close(); throw CamErr("ERROR", "The camera did not offer a USB data channel. Unplug and replug it.") }
        dev = d; conn = c; iface = itf; epIn = bi; epOut = bo; tid = 0; pendLen = 0
        live = false; nikon = false; canon = false; sony = false; sonyAt = -1L; sonyVer = 2; sonyDestBlocked = false; lastShutterMs = 0L; setupNote = ""

        val s = transact(0x1002, intArrayOf(1))                                   // OpenSession
        if (s.code != OK && s.code != SESSION_OPEN) throw CamErr("ERROR", "The camera would not start a session (${hex(s.code)}). Switch it off and on, then try again.")
        if (!readInfo()) return null
        if (nikon) {
            camName = (if (camMaker.startsWith("Nikon", ignoreCase = true)) "Nikon " else "$camMaker ") + camModel.replace("NIKON", "").replace("Nikon", "").trim()
            log("Opened $camName")
            prepareNikon()
        } else if (canon) {
            camName = "Canon " + camModel.replace("Canon", "").trim()
            log("Opened $camName")
            prepareCanon()
        } else if (sony) {
            camName = sonyName(camModel)
            log("Opened $camName")
            prepareSony()
        } else return null
        return infoJson()
    }

    private fun infoJson(): JSONObject = JSONObject()
        .put("name", camName).put("model", camModel).put("maker", camMaker)
        .put("brand", if (nikon) "nikon" else if (canon) "canon" else if (sony) "sony" else "")
        .put("vendor", vendor).put("liveview", live).put("battery", batteryNow()).put("note", setupNote).put("diag", diag)
        .put("aspectCrop", canon && canonAspectCrop)

    private fun batteryNow(): Int {
        if (canon) {
            // EOS battery arrives as property 0xD111 in the event stream: quarter steps (1=Low 6=25% 2=50% 5=75% 3=100%) on most bodies, a percent on some.
            try { if (pollAt < 0 || now() - pollAt > 2000) canonPoll() } catch (e: CamErr) { throw e } catch (_: Exception) { }
            return when (val v = (eosVals[0xD111] ?: -1L).toInt()) {
                1 -> 10; 6 -> 25; 2 -> 50; 5 -> 75; 3 -> 100
                in 7..100 -> v
                else -> -1
            }
        }
        if (sony || !props.contains(0x5001)) return -1    // Sony reports battery in steps, not percent
        return try {
            val r = opRead(0x1015, 0x5001)
            val d = r.data
            if (r.code == OK && d != null && d.isNotEmpty()) d[0].toInt() and 0xFF else -1
        } catch (e: CamErr) { throw e } catch (_: Exception) { -1 }
    }

    // Is the open camera still answering? (Throws when it's gone.)
    private fun alive() {
        if (nikon) { op(0x90C8); return }
        if (canon && has(0x911D)) { op(0x911D); return }     // KeepDeviceOn: also stops it sleeping
        opRead(0x1001)
    }

    private fun needCamera() { if (conn == null) throw CamErr("GONE", "The camera isn't connected.") }

    // ================================================================ calls the booth makes

    private fun setLive(on: Boolean) = synchronized(lock) {
        needCamera()
        if (!on) {
            if (canon) canonLiveOff() else if (sony) live = false else stopLive()
        } else if (!live) {
            if (canon) canonLiveOn() else if (sony) live = true else startLive()
        }
        Unit
    }

    private var frameFails = 0

    // A hiccup while fetching a live view picture just skips that picture; only a run of them is reported.
    private fun frame(): ByteArray? = synchronized(lock) {
        needCamera()
        try {
            val f = if (canon) canonFrame() else if (sony) sonyFrame() else nikonFrame()
            frameFails = 0
            f
        } catch (e: CamErr) {
            if (e.transient && ++frameFails <= 5) null else throw e
        }
    }

    private fun capture(): ByteArray = synchronized(lock) {
        needCamera()
        if (canon) canonCapture() else if (sony) sonyCapture() else nikonCapture()
    }

    private fun battery(): Int = synchronized(lock) { needCamera(); batteryNow() }

    private fun autoFocus(): JSONObject = synchronized(lock) {
        needCamera()
        var afOk = true
        if (nikon) {
            if (!live) setLive(true)
            val afR = op(0x90C1)
            val t0 = now()
            while (now() - t0 < 1400) {
                Thread.sleep(80)
                try { nikonEvents() } catch (_: Exception) { }
            }
            afOk = (afR == OK)
        } else if (canon) {
            val afR = opRetry(0x9128, 1, 0)
            Thread.sleep(800)
            try { opRetry(0x9129, 1) } catch (_: Exception) { }
            afOk = (afR == OK)
        }
        JSONObject().put("ok", afOk)
    }

    // ================================================================ Nikon

    private fun waitReady(ms: Int): Boolean {
        val t0 = now()
        while (now() - t0 < ms) {
            val r = op(0x90C8)                           // Nikon DeviceReady
            if (r == OK) return true
            if (r != BUSY) return false
            Thread.sleep(50)
        }
        return false
    }

    private fun propDesc(code: Int): Desc? {
        val r = opRead(0x1014, code)
        val d = r.bytes
        if (r.code != OK || d.size < 6) return null
        val rd = Rd(d)
        rd.u16(); val type = rd.u16(); val getSet = rd.u8()
        rd.value(type); val cur = rd.value(type)
        val form = rd.u8()
        val choices = ArrayList<String>()
        if (form == 2) { val n = rd.u16(); for (k in 0 until n) choices.add(rd.value(type)) }
        return Desc(type, cur, choices, getSet)
    }

    private fun setProp(code: Int, type: Int, value: String): Boolean {
        val data: ByteArray
        if (type == 0xFFFF) {
            val bb = ByteBuffer.allocate(1 + (value.length + 1) * 2).order(ByteOrder.LITTLE_ENDIAN)
            bb.put((value.length + 1).toByte())
            (value + "\u0000").forEach { bb.putShort(it.code.toShort()) }
            data = bb.array()
        } else {
            val v = value.toLong()
            val size = if (type == 1 || type == 2) 1 else if (type == 3 || type == 4) 2 else 4
            data = ByteArray(size) { ((v shr (8 * it)) and 0xFF).toByte() }
        }
        val r = opWrite(0x1016, data, code)
        waitReady(2000)
        return r == OK
    }

    // ---- Exposure settings for the booth's Camera check (Nikon; standard PTP properties) ----
    // A port of props / setprops in tools/print-helper/camera-worker.ps1: keep the two in step.
    // 0x500E exposure mode (1 manual, 2 program, 3 aperture priority, 4 shutter priority), 0x500D exposure time in 0.0001 s,
    // 0x5007 f-number x 100, 0x500F ISO. The camera says per property whether it can be changed right now; a setting it will not
    // take is reported, never forced. The mode itself is the dial: never set. Any other brand answers supported:false.
    private fun descNum(d: Desc?): Double = d?.current?.toDoubleOrNull() ?: 0.0
    private fun canSet(d: Desc?): Boolean = d != null && d.getSet == 1 && d.choices.isNotEmpty()

    private fun exposureJson(): JSONObject {
        if (!nikon) return JSONObject().put("supported", false)
        var m: Desc? = null; var t: Desc? = null; var f: Desc? = null; var i: Desc? = null
        try { m = propDesc(0x500E); t = propDesc(0x500D); f = propDesc(0x5007); i = propDesc(0x500F) }
        catch (e: CamErr) { throw e } catch (e: Exception) { log("Exposure settings not read: ${e.message}") }
        if (t == null && f == null && i == null) return JSONObject().put("supported", false)
        return JSONObject().put("supported", true)
            .put("program", descNum(m).toInt())
            .put("shutter", descNum(t) / 10000.0)
            .put("f", descNum(f) / 100.0)
            .put("iso", descNum(i).toInt())
            .put("set", JSONObject().put("shutter", canSet(t)).put("f", canSet(f)).put("iso", canSet(i)))
    }

    // The camera's own list, the entry nearest (on a log scale) to what was asked for. Entries that are not real values
    // (Auto / Hi / bulb markers sit at the ends of some lists) are skipped.
    private fun nearChoice(d: Desc, want: Double, scale: Double): String? {
        var best: String? = null
        var bestD = Double.MAX_VALUE
        for (c in d.choices) {
            val v = c.toDoubleOrNull() ?: continue
            val x = v * scale
            if (x <= 0 || x > 60000) continue
            val dd = Math.abs(Math.log(x) - Math.log(want))
            if (dd < bestD) { bestD = dd; best = c }
        }
        return best
    }

    // query: "shutter=0.00625&f=5.6&iso=400" (seconds, f-number, ISO; any subset). Answers the settings now plus, per asked setting,
    // "set" | "same" | "locked" (the camera won't change it in this mode) | "refused" | "unsupported".
    private fun setExposure(query: String): JSONObject = synchronized(lock) {
        needCamera()
        if (!nikon) return@synchronized JSONObject().put("supported", false)
        val want = HashMap<String, Double>()
        for (kv in query.split('&', ' ')) {
            val eq = kv.indexOf('=')
            val v = if (eq > 0) kv.substring(eq + 1).toDoubleOrNull() else null
            if (v != null && v > 0) want[kv.substring(0, eq)] = v
        }
        val res = JSONObject()
        for ((key, code, scale) in listOf(Triple("shutter", 0x500D, 0.0001), Triple("f", 0x5007, 0.01), Triple("iso", 0x500F, 1.0))) {
            val w = want[key] ?: continue
            val state = try {
                val d = propDesc(code)
                if (d == null) "unsupported"
                else if (d.getSet != 1 || d.choices.isEmpty()) "locked"
                else {
                    val pick = nearChoice(d, w, scale)
                    if (pick == null) "unsupported" else if (pick == d.current) "same" else if (setProp(code, d.type, pick)) "set" else "refused"
                }
            } catch (e: CamErr) { throw e } catch (e: Exception) { log("Exposure setting $key not changed: ${e.message}"); "refused" }
            log("Exposure $key -> $w: $state")
            res.put(key, state)
        }
        exposureJson().put("results", res)
    }

    private fun widthOf(s: String): Int { val x = s.indexOf('x'); return if (x > 0) s.substring(0, x).toIntOrNull() ?: 0 else 0 }

    private fun isRawObjectFormat(fmt: Int): Boolean =
        fmt == 0x3000 || fmt == 0xB101 || fmt == 0xB103 || fmt == 0xB108 || (fmt != 0 && fmt != 0x3801 && fmt != 0x3808)

    private fun peekObjectFormat(handle: Int): Int {
        for (attempt in 0 until 2) {
            try {
                val oi = opRead(0x1008, handle)
                if (oi.code == BUSY && attempt == 0) { Thread.sleep(60); continue }
                val b = oi.bytes
                return if (oi.code == OK && b.size > 6) le16(b, 4) else 0
            } catch (e: CamErr) { throw e } catch (_: Exception) { return 0 }
        }
        return 0
    }

    private fun peekIsJpegHeader(handle: Int): Boolean? {
        if (!has(0x101B)) return null
        return try {
            val r = opRead(0x101B, handle, 0, 4)
            val b = r.bytes
            if (r.code == OK && b.size >= 2) (b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte()) else null
        } catch (e: CamErr) { throw e } catch (_: Exception) { null }
    }

    private fun hasStorageCard(): Boolean {
        return try {
            val r = opRead(0x1004)
            val d = r.bytes
            if (r.code != OK || d.size < 8) return false
            val count = u32(d, 0).toInt()
            var i = 0
            while (i < count && 4 + (i + 1) * 4 <= d.size) {
                val sid = u32(d, 4 + i * 4)
                if (sid != 0L && sid != 0x00010000L) return true
                i++
            }
            false
        } catch (e: CamErr) { throw e } catch (_: Exception) { false }
    }

    /** Record to SDRAM when keepOnCard is off (fast booth mode), or SD Card preserving RAW + JPEG when keepOnCard is on. */
    private fun prepareNikon() {
        setupNote = ""
        try {
            val rm = propDesc(0xD10B)                    // Nikon RecordingMedia (0 = SD Card, 1 = SDRAM)
            if (keepOnCard) {
                if (hasStorageCard()) {
                    if (rm != null && rm.current != "0" && setProp(0xD10B, rm.type, "0")) {
                        log("Recording media -> SD card (backup + RAW preserved)")
                    }
                    setupNote += "Backup + RAW saved to camera SD card. "
                } else {
                    if (rm != null && rm.current != "1" && setProp(0xD10B, rm.type, "1")) {
                        log("No SD card found; recording media -> SDRAM")
                    }
                    setupNote += "No SD card in camera — photos saved on tablet only. "
                }
            } else {
                if (rm != null && rm.current != "1" && setProp(0xD10B, rm.type, "1")) { setupNote += "Records to camera memory. "; log("Recording media -> camera memory (SDRAM)") }
            }
        } catch (e: CamErr) { throw e } catch (e: Exception) { log("Recording media not changed: ${e.message}") }
        try {
            if (props.contains(0x5004)) {
                val q = propDesc(0x5004)
                if (q != null) {
                    val cur = q.current.toIntOrNull() ?: 0
                    // Nikon: 0 Basic, 1 Normal, 2 Fine (JPEG); higher values include RAW.
                    if (keepOnCard) {
                        if (cur in 0..1 && q.choices.contains("2") && setProp(0x5004, q.type, "2")) { setupNote += "Set to JPEG Fine. "; log("Image quality upgraded -> JPEG Fine (RAW+JPEG preserved if set)") }
                    } else {
                        if (cur > 2 && q.choices.contains("2") && setProp(0x5004, q.type, "2")) { setupNote += "Set to JPEG Fine. "; log("Image quality was RAW; set to JPEG Fine") }
                    }
                }
            }
            if (!(rovingMode && keepOnCard) && props.contains(0x5003)) {
                val s = propDesc(0x5003)
                if (s != null && s.type == 0xFFFF && s.choices.size > 1) {
                    var best: String? = null
                    var bestW = Int.MAX_VALUE
                    for (c in s.choices) { val w = widthOf(c); if (w >= 2900 && w < bestW) { best = c; bestW = w } }
                    if (best != null && best != s.current && setProp(0x5003, s.type, best)) { setupNote += "Photo size $best. "; log("Image size ${s.current} -> $best") }
                }
            }
        } catch (e: CamErr) { throw e } catch (e: Exception) { log("Photo size not changed: ${e.message}") }
        if (rovingMode && has(0x90C2)) {
            // Ensure Nikon body controls / physical shutter remain unlocked for roving shooting (D5300/D5600/Z-series)
            try { op(0x90C2, 0) } catch (e: CamErr) { throw e } catch (_: Exception) { }
        }
        if (rovingMode) { try { nikonEvents() } catch (e: CamErr) { throw e } catch (_: Exception) { } }
    }

    private fun startLive() {
        val r = op(0x9201)
        log("StartLiveView: ${hex(r)}")
        if (r != OK && r != 0xA00B && r != BUSY)
            throw CamErr("LIVEVIEW", "The camera refused live view (${hex(r)}). Put an SD card in the camera, close its menu, turn the mode dial to P and extend the kit lens, then try again.")
        waitReady(6000)
        live = true
    }

    private fun stopLive() {
        if (!live) return
        // EndLiveView is refused (busy) while the camera is still saving the last photo; ask again until it accepts, or live view stays on.
        var r = 0
        for (k in 0 until 14) {
            r = try { op(0x9202) } catch (e: CamErr) { throw e } catch (_: Exception) { 0xFFFF }
            if (r == OK || r == 0xA00B) { live = false; break }
            Thread.sleep(300)
        }
        if (live) log("EndLiveView not accepted (${hex(r)}): live view may still be on, will ask again") else waitReady(3000)
    }

    private fun jpegStart(d: ByteArray): Int {
        var k = 0
        while (k + 1 < d.size && k < 4096) { if (d[k] == 0xFF.toByte() && d[k + 1] == 0xD8.toByte()) return k; k++ }
        return -1
    }

    private fun jpegFrom(d: ByteArray, s: Int): ByteArray {
        var e = d.size
        for (k in d.size - 2 downTo s + 1) if (d[k] == 0xFF.toByte() && d[k + 1] == 0xD9.toByte()) { e = k + 2; break }
        return d.copyOfRange(s, e)
    }

    private fun nikonFrame(): ByteArray? {
        if (!live) startLive()
        val t0 = now()
        var restarts = 0
        var last = 0
        while (now() - t0 < 2500) {
            val r = opRead(0x9203)
            last = r.code
            if (r.code == OK) {
                val lv = r.bytes
                val s = jpegStart(lv)
                if (s >= 0) return jpegFrom(lv, s)
            } else if (r.code == 0xA00B && restarts < 2) {       // not in live view (it stops after a photo on some models)
                restarts++; live = false; startLive(); continue
            }
            Thread.sleep(40)
        }
        if (last != OK && last != BUSY && last != 0)
            throw CamErr("LIVEVIEW", "The camera sends no live view (${hex(last)}). Put an SD card in the camera, close its menu and turn the mode dial to P.")
        return null
    }

    private fun nikonEvents(): List<Int> {
        val l = ArrayList<Int>()
        if (!has(0x90C7)) return l
        val r = opRead(0x90C7)
        val d = r.bytes
        if (r.code == OK && d.size >= 2) {
            val cnt = le16(d, 0)
            var o = 2
            for (k in 0 until cnt) {
                if (o + 6 > d.size) break
                val code = le16(d, o); val p = le(d, o + 2)
                if (code == 0x4002) l.add(p)
                else if (code == 0xC101) l.add(if (p != 0) p else SDRAM_HANDLE)
                o += 6
            }
        }
        return l
    }

    private fun nikonCollectJpegs(handles: List<Int>, maxPhotos: Int = Int.MAX_VALUE, cachedFmt: Map<Int, Int>? = null): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        if (handles.isEmpty()) return out
        val jpegHandles = ArrayList<Int>()
        val otherHandles = ArrayList<Int>()
        for (h in handles) {
            if (h == SDRAM_HANDLE) { jpegHandles.add(h); continue }
            val fmt = cachedFmt?.get(h) ?: peekObjectFormat(h)
            if (fmt == 0x3801 || fmt == 0x3808) jpegHandles.add(h)
            else if (!isRawObjectFormat(fmt)) {
                val magicOk = if (fmt == 0) peekIsJpegHeader(h) else null
                if (magicOk == false) log("Skipping non-JPEG Nikon handle 0x${Integer.toHexString(h).uppercase()} (kept on card)")
                else otherHandles.add(h)
            } else log("Skipping RAW Nikon handle 0x${Integer.toHexString(h).uppercase()} (fmt ${hex(fmt)}, kept on card)")
        }
        val order = if (jpegHandles.isNotEmpty()) jpegHandles else otherHandles
        if (order.isEmpty()) return out
        val cd = StringBuilder("handles " + handles.joinToString(",") { Integer.toHexString(it).uppercase() })
        for (pick in order) {
            val img = downloadObject(pick, 0, cd)
            log("Photo download: $cd")
            if (img.size > 4 && img[0] == 0xFF.toByte() && img[1] == 0xD8.toByte()) {
                out.add(img)
                if (out.size >= maxPhotos) break
            }
        }
        return out
    }

    private fun nikonDownloadHandles(handles: List<Int>, cachedFmt: Map<Int, Int>? = null): ByteArray? =
        nikonCollectJpegs(handles, maxPhotos = 1, cachedFmt = cachedFmt).firstOrNull()

    private fun nikonPollNewList(): List<ByteArray> {
        val handles = nikonEvents()
        if (handles.isEmpty()) return emptyList()
        return nikonCollectJpegs(handles)
    }

    private fun nikonPollNew(): ByteArray? = nikonPollNewList().firstOrNull()

    private fun nikonCapture(): ByteArray {
        val t0 = now()
        var r: Int
        // Focus first while in live view (contrast AF); a miss is fine, the shot decides.
        if (live && has(0x90C1)) {
            try {
                r = op(0x90C1)
                if (r == OK) {
                    Thread.sleep(1200)
                    waitReady(2000)
                }
            } catch (e: CamErr) { throw e } catch (_: Exception) { }
        }
        try { nikonEvents() } catch (e: CamErr) { throw e } catch (_: Exception) { }      // drain old events
        val lagSw = now()
        val captureToCard = keepOnCard && has(0x9207) && hasStorageCard()
        var useCardOp = captureToCard
        var shotToCard = false
        if (captureToCard) {
            r = op(0x9207, ALL_ONES, 0)                                               // InitiateCaptureRecInMedia -> SD card (RAW+JPEG)
            // Nikon D5300/D5xxx can return 0xA00B or BUSY if 0x9207 runs while Live View is active: stop LV and retry once.
            if ((r == 0xA00B || r == BUSY) && live) {
                stopLive()
                waitReady(2500)
                r = op(0x9207, ALL_ONES, 0)
            }
            if (r == OK) shotToCard = true
            else if (r == 0x2005 && has(0x90C0)) { useCardOp = false; r = op(0x90C0, ALL_ONES) }
        } else {
            r = if (has(0x90C0)) op(0x90C0, ALL_ONES) else op(0x100E, 0, 0)           // InitiateCaptureRecInSdram / InitiateCapture
        }
        if (r == 0xA002 && has(0x9207)) {
            log("Out of focus; shooting without autofocus")
            r = op(0x9207, ALL_ONES, if (useCardOp) 0 else 1)
            if (r != OK && !useCardOp) r = op(0x9207, ALL_ONES, 0)
            else if (r == OK && useCardOp) shotToCard = true
        }
        if (r == BUSY) {
            waitReady(3000)
            if (useCardOp) { r = op(0x9207, ALL_ONES, 0); if (r == OK) shotToCard = true }
            else r = op(0x90C0, ALL_ONES)
        }
        if (r != OK) {
            if (r == 0xA002) throw CamErr("FOCUS", "The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).")
            if (r == 0xA00A || r == 0xA009) throw CamErr("CAPTURE", "The camera can't take a photo right now (${hex(r)}). Check the memory card isn't full or locked.")
            throw CamErr("CAPTURE", "The camera refused the photo (${hex(r)}). Check the mode dial isn't on video and the camera's menu is closed.")
        }
        waitReady(10000)
        lastShutterMs = minOf(now() - lagSw, 10000L)
        val handles = ArrayList<Int>()
        val checkedFmt = HashMap<Int, Int>()
        val e0 = now()
        var foundJpeg = false
        while (now() - e0 < 8000) {
            for (h in nikonEvents()) if (!handles.contains(h)) handles.add(h)
            if (handles.isNotEmpty()) {
                if (!shotToCard) {
                    Thread.sleep(150); for (h in nikonEvents()) if (!handles.contains(h)) handles.add(h)
                    break
                }
                for (h in handles) {
                    if (checkedFmt.containsKey(h)) continue
                    val f = peekObjectFormat(h)
                    checkedFmt[h] = f
                    if (f == 0x3801 || f == 0x3808) foundJpeg = true
                }
                if (foundJpeg || now() - e0 > 3500) {
                    Thread.sleep(120); for (h in nikonEvents()) if (!handles.contains(h)) handles.add(h)
                    break
                }
            }
            Thread.sleep(100)
        }
        if (handles.isEmpty() && !shotToCard) handles.add(SDRAM_HANDLE)               // the photo in the camera's memory
        val cd = StringBuilder("handles " + handles.joinToString(",") { Integer.toHexString(it).uppercase() })
        val img = nikonDownloadHandles(handles, cachedFmt = checkedFmt)
        if (img == null || img.size < 4) throw CamErr("CAPTURE", "The photo didn't come through from the camera ($cd). Make sure Image quality is JPEG or RAW+JPEG.")
        if (!(img[0] == 0xFF.toByte() && img[1] == 0xD8.toByte())) throw CamErr("CAPTURE", "The camera saved a RAW photo. Set Image quality to JPEG or RAW + JPEG on the camera.")
        log("Photo ${img.size / 1024} KB in ${now() - t0} ms")
        // Live view resumes by itself on most models; nikonFrame() restarts it if not.
        return img
    }

    // ================================================================ shared: fetch a photo object

    /** The whole object, or (when that fails or comes up short) in 1 MB pieces. Empty array when it did not come. */
    private fun downloadObject(h: Int, sizeIn: Int, cd: StringBuilder): ByteArray {
        var size = sizeIn
        if (size == 0) {
            try {
                val oi = opRead(0x1008, h)
                val b = oi.bytes
                if (oi.code == OK && b.size >= 12) size = le(b, 8)
                cd.append("; info ${hex(oi.code)} $size B")
            } catch (e: CamErr) { throw e } catch (e: Exception) { cd.append("; info failed ${e.message}") }
        }
        var img = ByteArray(0)
        var r: Int
        try { val g = opRead(0x1009, h); r = g.code; img = g.bytes; cd.append("; get ${hex(r)} ${img.size} B") }
        catch (e: CamErr) { throw e } catch (e: Exception) { r = 0; cd.append("; get failed ${e.message}") }
        if ((r != OK || img.size < 4 || (size > 0 && img.size < size)) && size > 0) {
            // Canon's own piece command, then the standard one.
            val piece = if (has(0x9107)) 0x9107 else 0x101B
            val ms = java.io.ByteArrayOutputStream(size)
            var off = 0
            var pr = 0
            while (off < size) {
                val p = opRead(piece, h, off, minOf(1048576, size - off))
                pr = p.code
                val part = p.bytes
                if (pr != OK || part.isEmpty()) break
                ms.write(part); off += part.size
            }
            cd.append("; pieces ${hex(piece)} ${hex(pr)} $off B")
            if (off >= size) { img = ms.toByteArray(); r = OK }
        }
        return if (r == OK) img else ByteArray(0)
    }

    // ================================================================ Canon EOS
    // Canon's own PTP commands (the same ones EOS Utility and gphoto2 use):
    // 0x9114 remote mode, 0x9115 event mode, 0x9116 events, 0x9110 set a setting,
    // 0x9153 live view picture, 0x910F / 0x9128-0x9129 shutter, 0x9107 photo in pieces, 0x9117 transfer done.

    private fun opRetry(code: Int, vararg ps: Int): Int {
        val t0 = now()
        while (true) {
            val r = transact(code, ps).code
            if ((r != BUSY && r != NOTREADY) || now() - t0 > 3000) return r
            Thread.sleep(60)
        }
    }

    // SetDevicePropValueEx: { size 12, setting, value }
    private fun setEos(prop: Int, value: Int): Int {
        val b = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN).putInt(12).putInt(prop).putInt(value).array()
        val t0 = now()
        var r: Int
        while (true) {
            r = opWrite(0x9110, b)
            if ((r != BUSY && r != NOTREADY) || now() - t0 > 3000) break
            Thread.sleep(60)
        }
        log("Set ${hex(prop)} = $value: ${hex(r)}")
        if (r == OK) eosVals[prop] = value.toLong() and 0xFFFFFFFFL
        return r
    }

    /** Reads the camera's news: changed settings, and new photos. */
    private fun canonPoll() {
        pollAt = now()
        val r = opRead(0x9116)
        val d = r.data
        if (r.code != OK || d == null) return
        var off = 0
        while (off + 8 <= d.size) {
            val size = u32(d, off)
            val type = u32(d, off + 4)
            if (size < 8 || off + size > d.size || type == 0L) break
            val end = off + size.toInt()
            if (type == 0xC189L && size >= 16) eosVals[(u32(d, off + 8) and 0xFFFF).toInt()] = u32(d, off + 12)       // a setting changed
            else if ((type == 0xC181L || type == 0xC1A7L) && size >= 12)                                              // a photo was saved on the card
                canonNew.add(longArrayOf(u32(d, off + 8), type, if (off + 0x12 <= end) le16(d, off + 0x10).toLong() else 0L, if (off + 0x20 <= end) u32(d, off + 0x1C) else 0L))
            else if (type == 0xC186L && size >= 12)                                                                   // a photo waits in the camera's memory for us
                canonNew.add(longArrayOf(u32(d, off + 8), type, if (off + 0x0E <= end) le16(d, off + 0x0C).toLong() else 0L, if (off + 0x18 <= end) u32(d, off + 0x14) else 0L))
            off = end
        }
    }

    // Canon EOS USB Live View (0x9153) always sends the full uncropped 3:2 frame, while Aspect ratio (0xD194) crops still JPEGs.
    // Switch to 3:2 (0) automatically for the booth session and restore on closeCamera().
    private fun canonAspect32() {
        val ar = eosVals[EOS_MULTI_ASPECT] ?: return
        if (ar == 0L) { canonAspectCrop = false; return }
        try {
            val r = setEos(EOS_MULTI_ASPECT, 0)
            if (r == OK) canonPoll()
            val nowVal = eosVals[EOS_MULTI_ASPECT]
            val ok = r == OK && (nowVal == null || nowVal == 0L)
            log("Aspect ratio was $ar: set to 3:2 (0): ${hex(r)}${if (ok) "" else " (kept ${nowVal ?: ar})"}")
            if (ok) {
                if (!canonAspectChanged) { canonAspectOrig = ar.toInt(); canonAspectChanged = true }
                canonAspectCrop = false
                setupNote += "Camera aspect ratio was cropped; set to 3:2. "
            } else {
                canonAspectCrop = true
                setupNote += "Camera aspect ratio is not 3:2: set Aspect ratio to 3:2 on the camera. "
            }
        } catch (e: CamErr) { throw e } catch (e: Exception) {
            canonAspectCrop = true
            log("Aspect ratio not changed: ${e.message}")
        }
    }

    private fun canonRestoreAspect() {
        if (!canonAspectChanged) return
        canonAspectChanged = false
        try {
            val r = setEos(EOS_MULTI_ASPECT, canonAspectOrig)
            log("Aspect ratio: restored to $canonAspectOrig: ${hex(r)}")
        } catch (e: CamErr) { throw e } catch (_: Exception) { }
    }

    private fun prepareCanon() {
        setupNote = ""
        eosVals.clear(); canonNew.clear(); gotFrame = false; pollAt = -1L
        canonAspectChanged = false; canonAspectCrop = false; canonAspectOrig = 0
        if (recoverNext) {
            // The last session ended without a goodbye: leave remote mode before going in again.
            recoverNext = false
            try { op(0x9115, 0) } catch (e: CamErr) { throw e } catch (_: Exception) { }
            try { op(0x9114, 0) } catch (e: CamErr) { throw e } catch (_: Exception) { }
            log("Reset the camera's remote mode before connecting")
            Thread.sleep(600)
        }
        val r = opRetry(0x9114, 1)         // remote mode on
        log("SetRemoteMode: ${hex(r)}")
        val r2 = opRetry(0x9115, 1)        // send events when asked
        log("SetEventMode: ${hex(r2)}")
        if (r != OK && r2 != OK)
            throw CamErr("UNSUPPORTED", "The $camName didn't accept remote control (${hex(r)}). Canon EOS cameras work; most PowerShot / compact cameras don't. On an EOS: close other camera apps, switch the camera off and on, and try again.")
        canonPoll()                        // the first batch lists all settings
        readInfo()                         // in remote mode the camera lists more commands
        canonPoll()
        for (t in 0 until 5) {
            if (eosVals.containsKey(0xD11C) || eosVals.containsKey(0xD1B0)) break
            Thread.sleep(50); canonPoll()
        }
        if (!has(0x9153)) throw CamErr("UNSUPPORTED", "The $camName doesn't send live view over USB.")
        if (!has(0x910F) && !has(0x9128)) throw CamErr("UNSUPPORTED", "The $camName doesn't take photos over USB.")
        canonAspect32()
        if (keepOnCard) {
            // Keep Canon EOS saving RAW + JPEG to the camera's SD card instead of Host RAM-only (0xD11C = 4).
            val curDest = eosVals[0xD11C]
            if (curDest == 4L) {
                var rDest = setEos(0xD11C, 2)
                if (rDest != OK) rDest = setEos(0xD11C, 1)
                log("Canon SaveTo restored from Host (4) -> Card (${hex(rDest)})")
            }
            setupNote += "Backup + RAW saved to camera SD card. "
        }
        keepAt = now()
    }

    /** Every few seconds: read news (keeps the camera's list short) and keep it awake. */
    // [pollEveryMs]: the live view loop passes a longer gap, because each news read is an extra USB round
    // trip made while the frame lock is held (a visible hitch). Photo calls keep the quick 2 s default.
    private fun canonKeep(pollEveryMs: Long = 2000L) {
        if (pollAt < 0 || now() - pollAt > pollEveryMs) canonPoll()
        // Not only when the camera lists KeepDeviceOn: some older EOS (60D) don't list it but still stay awake when it is sent.
        if (now() - keepAt > 10000) { try { op(0x911D) } catch (e: CamErr) { throw e } catch (_: Exception) { }; keepAt = now() }
    }

    private fun canonLiveOn() {
        var started = false
        if (has(0x9151)) { val ri = opRetry(0x9151); log("InitiateViewfinder: ${hex(ri)}"); started = ri == OK }
        val mode = eosVals[0xD1B1]
        if (mode != null && mode != 1L) setEos(0xD1B1, 1)            // live view mode
        val r = setEos(0xD1B0, 2)                                    // live view to the computer (mirror up)
        // Still saving the last photo: not an error, the next frame asks again.
        if (r != OK && !started && (r == BUSY || r == NOTREADY)) { live = false; log("Live view: camera still busy (${hex(r)}), will ask again"); return }
        if (r != OK && !started)
            throw CamErr("LIVEVIEW", "The camera refused live view (${hex(r)}). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M. Then try again.")
        live = true; gotFrame = false; liveAt = now()
    }

    private fun canonLiveOff() {
        if (!live) return
        try { setEos(0xD1B0, 0); if (has(0x9152)) op(0x9152) } catch (e: CamErr) { throw e } catch (_: Exception) { }
        live = false
    }

    /** The live view data is a list of blocks { length, type, data }; one of them is the JPEG. */
    private fun eosJpeg(d: ByteArray?): ByteArray? {
        if (d == null || d.size < 12) return null
        var off = 0
        while (off + 8 <= d.size) {
            val len = u32(d, off)
            if (len < 8 || off + len > d.size) break
            if (len > 12 && d[off + 8] == 0xFF.toByte() && d[off + 9] == 0xD8.toByte()) return d.copyOfRange(off + 8, off + len.toInt())
            off += len.toInt()
        }
        val s = jpegStart(d)
        return if (s < 0) null else jpegFrom(d, s)
    }

    // Live view speed, written to the log about every 5 s so lag can be measured instead of guessed.
    private var fpsFrames = 0
    private var fpsBytes = 0L
    private var fpsSince = 0L
    private fun canonFpsTick(bytes: Int) {
        val t = now()
        if (fpsSince == 0L || t - fpsSince > 60000L) { fpsSince = t; fpsFrames = 0; fpsBytes = 0L }
        fpsFrames++; fpsBytes += bytes
        val ms = t - fpsSince
        if (ms >= 5000L) {
            log("Canon live view: %.1f fps, %d KB/frame".format(fpsFrames * 1000.0 / ms, fpsBytes / fpsFrames / 1024))
            fpsSince = t; fpsFrames = 0; fpsBytes = 0L
        }
    }

    private fun canonFrame(): ByteArray? {
        if (!live) { canonLiveOn(); if (!live) { Thread.sleep(400); return null } }     // camera still busy: no picture yet, ask again
        val t0 = now()
        var last = 0
        var kicked = false
        var rearmed = false
        while (now() - t0 < 3000) {
            canonKeep(6000L)
            val r = opRead(0x9153, 0x00100000)
            last = r.code
            if (r.code == OK) {
                val j = eosJpeg(r.data)
                if (j != null) { gotFrame = true; canonFpsTick(j.size); return j }
            } else if (r.code != BUSY && r.code != NOTREADY) {
                // The camera ended live view by itself (heat, its time limit, sleep): switch it back on once.
                if (gotFrame && !rearmed) {
                    rearmed = true
                    log("Live view was stopped by the camera (${hex(r.code)}): switching it back on")
                    try { canonLiveOn() } catch (e: CamErr) { if (e.code == "GONE") throw e } catch (_: Exception) { }
                    Thread.sleep(150)
                    continue
                }
                break
            }
            // Some models leave live view after a photo: switch it back on once.
            if (!kicked && now() - t0 > 1200 && now() - liveAt > 4000) { kicked = true; setEos(0xD1B0, 2) }
            Thread.sleep(15)       // camera not ready with the next picture: look again soon, don't idle (was 50 ms)
        }
        if (last != OK && last != BUSY && last != NOTREADY && last != 0)
            throw CamErr("LIVEVIEW", "The camera sends no live view (${hex(last)}). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M.")
        if (!gotFrame && now() - liveAt > 9000)
            throw CamErr("LIVEVIEW", "The camera isn't sending live view. On the camera: Menu, Live View shoot: Enable (on the 60D / 70D it's in the red camera menu); close the menu; mode dial on P, Tv, Av or M. Then try again.")
        return null
    }

    private fun canonShotError(r: Int, res: Long): CamErr {
        if (res == 1L) return CamErr("FOCUS", "The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).")
        if (res == 7L || res == 3L) return CamErr("CAPTURE", "The camera can't save the photo (result $res). Check there's an SD card in the camera and it isn't full or locked.")
        if (r == BUSY || r == NOTREADY) return CamErr("CAPTURE", "The camera is busy (still saving the last photo?). Try again in a moment.")
        return CamErr("CAPTURE", "The camera refused the photo (${hex(r)}${if (res != 0L) ", result $res" else ""}). Close the camera's menu, set the mode dial to P, Tv, Av or M (not video), and check the SD card.")
    }

    private fun canonCollectJpegs(files: List<LongArray>, maxPhotos: Int = Int.MAX_VALUE): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        val resolved = ArrayList<Pair<LongArray, Int>>(files.size)
        for (o in files) {
            var fmt = o[2].toInt()
            if (fmt == 0) fmt = peekObjectFormat(o[0].toInt())
            resolved.add(Pair(o, fmt))
        }
        val cd = StringBuilder("files " + resolved.joinToString(",") { java.lang.Long.toHexString(it.first[0]).uppercase() + "/" + Integer.toHexString(it.second).uppercase() })
        // JPEG first, then anything else that isn't RAW (CRW / CR2 / CR3).
        val order = ArrayList<LongArray>()
        for ((o, fmt) in resolved) if (fmt == 0x3801 || fmt == 0x3808) order.add(o)
        for ((o, fmt) in resolved) if (fmt != 0x3801 && fmt != 0x3808 && !isRawObjectFormat(fmt)) {
            val magicOk = if (fmt == 0) peekIsJpegHeader(o[0].toInt()) else null
            if (magicOk != false) order.add(o)
        }
        try {
            for (o in order) {
                val b = downloadObject(o[0].toInt(), o[3].toInt(), cd)
                if (b.size > 4 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte()) {
                    out.add(b)
                    if (out.size >= maxPhotos) break
                }
            }
        } finally {
            // Photos waiting in the camera's memory: tell it we're done so it frees them.
            for (o in files) if (o[1] == 0xC186L) { try { op(0x9117, o[0].toInt()) } catch (_: Exception) { } }
        }
        log("Photo download: $cd")
        return out
    }

    private fun canonDownloadFiles(files: List<LongArray>): ByteArray? =
        canonCollectJpegs(files, maxPhotos = 1).firstOrNull()

    private fun canonPollNewList(): List<ByteArray> {
        canonKeep()
        canonPoll()
        if (canonNew.isEmpty()) return emptyList()
        val files = ArrayList<LongArray>()
        for (o in canonNew) if (o[2] != 0x3001L) files.add(o)
        canonNew.clear()
        if (files.isEmpty()) return emptyList()
        return canonCollectJpegs(files)
    }

    private fun canonPollNew(): ByteArray? = canonPollNewList().firstOrNull()

    private fun canonCapture(): ByteArray {
        val t0 = now()
        canonPoll()
        if (!canonAspectCrop) canonAspect32()
        canonNew.clear()
        val lagSw = now()
        var r: Int
        if (ops.contains(0x9128)) {
            // Newer EOS: press the shutter all the way (it focuses, then shoots), then let go.
            r = opRetry(0x9128, 3, 0)
            log("RemoteReleaseOn: ${hex(r)}")
            if (r == OK) { try { opRetry(0x9129, 3) } catch (e: CamErr) { throw e } catch (_: Exception) { } }
            else {
                val h = opRetry(0x9128, 1, 0)                          // half press (focus)
                val f = if (h == OK) opRetry(0x9128, 2, 0) else h      // full press
                try { opRetry(0x9129, 2); opRetry(0x9129, 1) } catch (e: CamErr) { throw e } catch (_: Exception) { }
                log("Half / full press: ${hex(h)} / ${hex(f)}")
                r = f
            }
            if (r != OK) throw canonShotError(r, 0)
        } else {
            // Older EOS (60D, 7D, 550D...): one command; its answer says if it fired.
            var a = opP(0x910F)
            r = a.code
            if (r == BUSY || r == NOTREADY) { Thread.sleep(400); a = opP(0x910F); r = a.code }
            val res = if (a.params.isNotEmpty()) a.params[0].toLong() and 0xFFFFFFFFL else 0L
            log("RemoteRelease: ${hex(r)}, result $res")
            if (r != OK || res != 0L) throw canonShotError(r, res)
        }
        // Wait for the camera to say where the photo is (RAW + JPEG: two files).
        val files = ArrayList<LongArray>()
        val e0 = now()
        var firstAt = -1L
        while (now() - e0 < 15000) {
            canonPoll()
            for (o in canonNew) if (o[2] != 0x3001L) files.add(o)     // not folders
            canonNew.clear()
            if (files.isNotEmpty() && firstAt < 0) {
                firstAt = now() - e0
                lastShutterMs = minOf(now() - lagSw, 10000L)
            }
            if (firstAt >= 0 && now() - e0 - firstAt > 350) break
            Thread.sleep(80)
        }
        if (files.isEmpty())
            throw CamErr("FOCUS", "The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.")
        val cd = StringBuilder("files " + files.joinToString(",") { java.lang.Long.toHexString(it[0]).uppercase() + "/" + java.lang.Long.toHexString(it[2]).uppercase() })
        val img = canonDownloadFiles(files)
        if (img == null) {
            val nonRaw = files.filter { it[2] != 0xB101L && it[2] != 0xB103L && it[2] != 0xB108L }
            if (nonRaw.isEmpty()) throw CamErr("CAPTURE", "The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).")
            throw CamErr("CAPTURE", "The photo didn't come through from the camera ($cd).")
        }
        log("Photo ${img.size / 1024} KB in ${now() - t0} ms")
        return img
    }

    // ================================================================ Sony Alpha (PC Remote mode)
    // Sony's own PTP commands (the same ones gphoto2 and Sony's remote tools use):
    // connect 0x9201 (phases 1, 2, 3), extended device info 0x9202, all properties 0x9209,
    // set property 0x9205, buttons 0x9207 (shutter half press 0xD2C1, full press 0xD2C2),
    // live view = object 0xFFFFC002, a new photo = property 0xD215 >= 0x8000, then object 0xFFFFC001.

    private fun sonyName(model: String): String {
        val key = model.uppercase().replace("SONY", "").trim()
        val map = arrayOf(
            "ILCE-7M2", "A7 II", "ILCE-7M3", "A7 III", "ILCE-7M4", "A7 IV", "ILCE-7M5", "A7 V",
            "ILCE-7RM2", "A7R II", "ILCE-7RM3", "A7R III", "ILCE-7RM3A", "A7R IIIA", "ILCE-7RM4", "A7R IV", "ILCE-7RM4A", "A7R IVA", "ILCE-7RM5", "A7R V",
            "ILCE-7SM2", "A7S II", "ILCE-7SM3", "A7S III", "ILCE-7C", "A7C", "ILCE-7CM2", "A7C II", "ILCE-7CR", "A7CR",
            "ILCE-9", "A9", "ILCE-9M2", "A9 II", "ILCE-9M3", "A9 III", "ILCE-1", "A1",
            "ILCE-6100", "A6100", "ILCE-6400", "A6400", "ILCE-6600", "A6600", "ILCE-6700", "A6700")
        var k = 0
        while (k + 1 < map.size) { if (key == map[k]) return "Sony " + map[k + 1]; k += 2 }
        return "Sony " + (if (key.isEmpty()) "camera" else key)
    }

    private fun sonyFail(what: String, r: Int) = CamErr("MODE", "The $camName didn't accept remote control ($what, ${hex(r)}). $SONY_HINT [$diag]")

    private fun sonyProps(): ByteArray {
        val r = opRead(0x9209)
        return if (r.code == OK) r.bytes else ByteArray(0)
    }

    private fun sonyScalarSize(dtype: Int): Int = when (dtype) {
        1, 2 -> 1
        3, 4 -> 2
        5, 6 -> 4
        7, 8 -> 8
        else -> 0
    }

    private fun sonyReadInt(d: ByteArray, off: IntArray, dtype: Int): Long? {
        val o = off[0]
        val sz = sonyScalarSize(dtype)
        if (sz == 0 || o + sz > d.size) return null
        val v: Long = when (dtype) {
            1 -> d[o].toLong()
            2 -> d[o].toLong() and 0xFFL
            3 -> le16(d, o).toShort().toLong()
            4 -> le16(d, o).toLong()
            5 -> le(d, o).toLong()
            6 -> u32(d, o)
            else -> {
                var u = 0L
                for (k in 0 until 8) u = u or ((d[o + k].toLong() and 0xFFL) shl (8 * k))
                u
            }
        }
        off[0] = o + sz
        return v
    }

    private fun sonySkipValue(d: ByteArray, off: IntArray, dtype: Int): Boolean {
        var o = off[0]
        if (dtype == 0xFFFF) {
            if (o >= d.size) return false
            val n = d[o++].toInt() and 0xFF
            if (o + n * 2 > d.size) return false
            off[0] = o + n * 2
            return true
        }
        if (dtype in 0x4001..0x4008) {
            if (o + 4 > d.size) return false
            val n = u32(d, o)
            o += 4
            val esz = sonyScalarSize(dtype and 0x0FFF)
            if (esz == 0 || n > 4096L || o + n * esz > d.size) return false
            off[0] = o + (n * esz).toInt()
            return true
        }
        val sz = sonyScalarSize(dtype)
        if (sz == 0 || o + sz > d.size) return false
        off[0] = o + sz
        return true
    }

    /** Current value and scalar type of one property in the 0x9209 blob, or null when absent: header count(4)+reserved(4), entries code(2) type(2) getset(1) enabled(1) def cur form. */
    private fun sonyPropInfo(d: ByteArray, code: Int): LongArray? {
        if (d.size < 8) return null
        val count = u32(d, 0)
        val reserved = u32(d, 4)
        if (reserved != 0L || count > 8192L) return null
        val off = intArrayOf(8)
        for (idx in 0 until count.toInt()) {
            if (off[0] + 6 > d.size) break
            val pcode = le16(d, off[0])
            val dtype = le16(d, off[0] + 2)
            val getSet = d[off[0] + 4].toInt() and 0xFF
            val enabled = d[off[0] + 5].toInt() and 0xFF
            off[0] += 6
            if (getSet > 0x84 || enabled > 2) break
            if (!sonySkipValue(d, off, dtype)) break
            var curVal: Long? = null
            if (dtype in 1..8) curVal = sonyReadInt(d, off, dtype)
            else if (!sonySkipValue(d, off, dtype)) break
            if (pcode == code) return if (curVal != null) longArrayOf(curVal, dtype.toLong()) else null
            if (off[0] >= d.size) break
            val form = d[off[0]++].toInt() and 0xFF
            if (form == 1) {
                if (!sonySkipValue(d, off, dtype) || !sonySkipValue(d, off, dtype) || !sonySkipValue(d, off, dtype)) break
            } else if (form == 2) {
                if (off[0] + 2 > d.size) break
                val n1 = le16(d, off[0]); off[0] += 2
                for (k in 0 until n1) if (!sonySkipValue(d, off, dtype)) return null
                if (sonyVer >= 3 && off[0] + 2 <= d.size) {
                    val n2 = le16(d, off[0]); off[0] += 2
                    for (k in 0 until n2) if (!sonySkipValue(d, off, dtype)) return null
                }
            } else if (form != 0) break
        }
        return null
    }

    private fun sonyVal(d: ByteArray, code: Int): Long = sonyPropInfo(d, code)?.get(0) ?: -1L

    private fun sonyScalarBytes(value: Int, dtype: Int): ByteArray {
        val raw = sonyScalarSize(dtype)
        val sz = if (raw in 1..8) raw else 2
        return ByteArray(sz) { k -> ((value ushr (8 * k)) and 0xFF).toByte() }
    }

    /** Sony "buttons": 1 = released, 2 = pressed. */
    private fun sonyButton(prop: Int, value: Int): Int =
        opWrite(0x9207, byteArrayOf((value and 0xFF).toByte(), (value shr 8).toByte()), prop)

    private fun sonyReleaseButtons(throwGone: Boolean) {
        try {
            sonyButton(0xD2C2, 1)
            sonyButton(0xD2C1, 1)
        } catch (e: CamErr) {
            if (throwGone) throw e
        } catch (_: Exception) { }
    }

    private fun sonyConnectPhase(phase: Int): Int {
        var r = OK
        for (t in 0 until 12) {
            r = opRead(0x9201, phase, 0, 0).code
            if (r != BUSY) break
            Thread.sleep(150)
        }
        return r
    }

    private fun sonyWait3s() {
        while (sonyAt >= 0 && now() - sonyAt < 3000) { sonyProps(); Thread.sleep(150) }
    }

    private fun ensureSonySaveDest(p: ByteArray) {
        // 1 = PC Only (no card needed), 0x11 = PC + Camera (saves RAW + JPEG backup on camera SD card), 0x10 = Camera Only.
        val info = sonyPropInfo(p, 0xD222) ?: return
        val dest = info[0]
        val dtype = info[1].toInt()
        val wantTarget = if (keepOnCard) 0x11L else 0x01L
        if (dest >= 0 && dest != wantTarget && !sonyDestBlocked) {
            var ok = false
            val prefs = if (keepOnCard) intArrayOf(0x11, 0x01) else intArrayOf(0x01, 0x11)
            for (want in prefs) {
                try {
                    if (opWrite(0x9205, sonyScalarBytes(want, dtype), 0xD222) != OK) continue
                    if (sonyVal(sonyProps(), 0xD222) != want.toLong()) continue      // the camera must really have taken it
                    ok = true
                    setupNote += if (want == 0x01) "Photos go to the tablet only (no memory card needed). " else "Backup + RAW saved to camera SD card (PC + Camera). "
                    log("Save destination 0x${java.lang.Long.toHexString(dest)} -> 0x${Integer.toHexString(want)}")
                    break
                } catch (e: CamErr) { throw e } catch (e: Exception) { log("Save destination not changed: ${e.message}") }
            }
            if (!ok) {
                sonyDestBlocked = true
                log("Could not change the save destination (it is 0x${java.lang.Long.toHexString(dest)}); photos may need a memory card")
            }
        }
    }

    private fun prepareSony() {
        setupNote = ""
        sonyAt = -1L
        sonyDestBlocked = false
        if (!ops.contains(0x9201) || !ops.contains(0x9202))
            throw CamErr("MODE", "The $camName is connected as a file-transfer drive, not for remote control. $SONY_HINT [$diag]")
        var r = sonyConnectPhase(1); if (r != OK) throw sonyFail("connect 1", r)
        r = sonyConnectPhase(2); if (r != OK) throw sonyFail("connect 2", r)
        val isA7M3 = camModel.contains("ILCE-7M3", ignoreCase = true)
        var ver = if (isA7M3) 3 else 2
        val preferV2 = !isA7M3 && camModel.contains("6400", ignoreCase = true)
        val vFirst = if (preferV2) 0xC8 else 0x12C
        val vSecond = if (preferV2) 0x12C else 0xC8
        for (t in 0 until 20) {
            val x = opRead(0x9202, vFirst, 1)
            val b = x.bytes
            if (x.code == OK && b.size >= 2) { ver = if (le16(b, 0) >= 0x12C) 3 else 2; break }
            if (!isA7M3 && x.code != BUSY) {
                val x2 = opRead(0x9202, vSecond, 1)
                val b2 = x2.bytes
                if (x2.code == OK && b2.size >= 2) { ver = if (le16(b2, 0) >= 0x12C) 3 else 2; break }
            }
            Thread.sleep(100)
        }
        sonyVer = ver
        r = sonyConnectPhase(3); if (r != OK) throw sonyFail("connect 3", r)
        sonyAt = now()
        sonyReleaseButtons(true)
        diag += "; sony protocol $ver"
        log("Sony connected, protocol $ver")
        // Remote control wins over the camera's own buttons ("application" priority).
        try { opWrite(0x9205, byteArrayOf(1), 0xD25A) } catch (e: CamErr) { throw e } catch (e: Exception) { log("Priority mode not set: ${e.message}") }
        // Several bodies (A7 III, A7R IV, ZV-1...) only take photos about 3 s after connecting:
        // wait here, while the booth shows "connecting", not during the first guest's photo.
        var p = ByteArray(0)
        while (now() - sonyAt < 3000) {
            val cur = sonyProps()
            if (cur.isNotEmpty()) p = cur
            Thread.sleep(150)
        }
        if (p.isEmpty()) p = sonyProps()
        // Ensure Single Shooting mode (0x5013 = 1) so continuous/bracket drive doesn't fire bursts.
        val scm = sonyPropInfo(p, 0x5013)
        if (scm != null && scm[0] >= 0 && scm[0] != 1L) {
            try {
                val sr = opWrite(0x9205, sonyScalarBytes(1, scm[1].toInt()), 0x5013)
                if (sr == OK) log("Still capture mode ${scm[0]} -> 1")
            } catch (e: CamErr) { throw e } catch (e: Exception) { log("Still capture mode not changed: ${e.message}") }
        }
        ensureSonySaveDest(p)
        live = true      // Sony live view has no start command: the frames are simply there
    }

    private fun sonyJpeg(d: ByteArray): ByteArray? {
        if (d.size <= 8) return null
        val off = u32(d, 0)           // header has JPEG offset + size; 8 zero bytes = no frame ready yet
        val fsize = u32(d, 4)
        if (off == 0L && fsize == 0L) return null
        var s = -1
        if (off >= 8 && off + 1 < d.size && d[off.toInt()] == 0xFF.toByte() && d[off.toInt() + 1] == 0xD8.toByte()) s = off.toInt()
        if (s < 0) s = jpegStart(d)
        if (s < 0) return null
        val limit = if (fsize > 0L && s.toLong() + fsize <= d.size) (s.toLong() + fsize).toInt() else d.size
        var e = -1
        for (k in limit - 2 downTo s + 1) if (d[k] == 0xFF.toByte() && d[k + 1] == 0xD9.toByte()) { e = k + 2; break }
        if (e <= s || e - s > 524_288) return null
        return d.copyOfRange(s, e)
    }

    private fun sonyFrame(): ByteArray? {
        live = true
        val t0 = now()
        var last = 0
        while (now() - t0 < 2500) {
            val lv = opRead(0x1009, SONY_LV)
            val r = lv.code
            last = r
            if (r == OK) {
                val b = lv.bytes
                if (b.size > 8) {
                    val j = sonyJpeg(b)
                    if (j != null) return j
                }
                Thread.sleep(25)
                continue
            }
            if (r == 0x2009) { Thread.sleep(50); continue }                         // InvalidObjectHandle: not ready yet
            Thread.sleep(if (r == 0x200F) 20 else 40)                               // AccessDenied: asked too fast
        }
        if (last != OK && last != BUSY && last != 0 && last != 0x2009)
            throw CamErr("LIVEVIEW", "The camera sends no live view (${hex(last)}). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.")
        return null
    }

    private fun sonyInfo(): IntArray {
        return try {
            val oi = opRead(0x1008, SONY_PHOTO)
            val b = oi.bytes
            val fmt = if (oi.code == OK && b.size >= 12) le16(b, 4) else 0
            val sz = if (oi.code == OK && b.size >= 12) le(b, 8) else 0
            intArrayOf(oi.code, fmt, sz)
        } catch (e: CamErr) { throw e } catch (_: Exception) { intArrayOf(0, 0, 0) }
    }

    private fun sonyCapture(): ByteArray {
        val t0 = now()
        // The first photo right after connecting has to wait for the camera to settle.
        sonyWait3s()
        if (!sonyDestBlocked) ensureSonySaveDest(sonyProps())
        // A photo left in the camera's memory by an earlier attempt would be handed over instead of this one.
        for (k in 0 until 4) {
            if (sonyVal(sonyProps(), 0xD215) < 0x8000) break
            downloadObject(SONY_PHOTO, 0, StringBuilder())
            log("Cleared an old photo from the camera's memory")
        }
        // Half press, full press (the camera focuses, then shoots).
        val lagSw = now()
        var r = sonyButton(0xD2C1, 2)
        if (r == OK) r = sonyButton(0xD2C2, 2)
        if (r != OK) {
            sonyReleaseButtons(true)
            throw CamErr("CAPTURE", "The camera refused the shutter (${hex(r)}). Check the mode dial isn't on video, the camera's menu is closed and it is in PC Remote mode.")
        }
        try {
            // Hold until focus is found (1 s at most). Manual focus needs no wait.
            if (sonyVal(sonyProps(), 0x500A) != 1L) {
                val h0 = now()
                while (now() - h0 < 1000) {
                    val p = sonyProps()
                    val ff = sonyVal(p, 0xD213)
                    val om = sonyVal(p, 0xD215)
                    if (ff == 2L || ff == 3L || om >= 0x8000) break
                    Thread.sleep(50)
                }
            }
        } finally {
            sonyReleaseButtons(true)
        }
        // Wait for the photo to appear in the camera's memory.
        var mem = -1L
        val e0 = now()
        while (now() - e0 < 15000) {
            mem = sonyVal(sonyProps(), 0xD215)
            if (mem >= 0x8000) { lastShutterMs = minOf(now() - lagSw, 10000L); break }
            Thread.sleep(100)
        }
        val cd = StringBuilder("memory " + (if (mem < 0) "?" else "0x" + java.lang.Long.toHexString(mem).uppercase()))
        if (mem < 0x8000) {
            log("No photo appeared: $cd")
            throw CamErr("FOCUS", "The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check the camera's Still Img. Save Dest. is PC Only and its Release w/o Card setting is Enable.")
        }
        // RAW+JPEG bodies can queue RAW (0x3000/0xB101) before or after JPEG (0x3801): peek format and skip RAW.
        var sawRaw = false
        var img = ByteArray(0)
        for (attempt in 0 until 3) {
            val info = sonyInfo()
            val ro = info[0]; val fmt = info[1]; val size = info[2]
            cd.append("; info ${hex(ro)} fmt ${hex(fmt)} $size B")
            if (fmt != 0 && fmt != 0x3801 && fmt != 0x3808) {
                sawRaw = true
                downloadObject(SONY_PHOTO, size, StringBuilder())
                log("Skipped non-JPEG Sony object ${hex(fmt)} ($size B)")
                val w0 = now()
                var more = false
                while (now() - w0 < 4000) {
                    if (sonyVal(sonyProps(), 0xD215) >= 0x8000) { more = true; break }
                    Thread.sleep(60)
                }
                if (!more) break
                continue
            }
            img = downloadObject(SONY_PHOTO, size, cd)          // whole photo, or in 1 MB pieces
            if (img.size >= 4 && img[0] == 0xFF.toByte() && img[1] == 0xD8.toByte()) break
            sawRaw = sawRaw || img.size >= 4
        }
        // Drain any trailing queued RAW object so the next shot starts clean.
        try {
            for (k in 0 until 2) {
                if (sonyVal(sonyProps(), 0xD215) < 0x8000) break
                val info = sonyInfo()
                if (info[0] != OK || (info[1] != 0 && info[1] != 0x3801 && info[1] != 0x3808)) {
                    downloadObject(SONY_PHOTO, info[2], StringBuilder())
                    log("Drained trailing Sony object ${hex(info[1])}")
                } else break
            }
        } catch (e: CamErr) { throw e } catch (_: Exception) { }
        log("Photo download: $cd")
        if (img.size < 4) {
            if (sawRaw) throw CamErr("CAPTURE", "The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.")
            throw CamErr("CAPTURE", "The photo didn't come through from the camera ($cd).")
        }
        if (!(img[0] == 0xFF.toByte() && img[1] == 0xD8.toByte())) throw CamErr("CAPTURE", "The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.")
        log("Photo ${img.size / 1024} KB in ${now() - t0} ms")
        return img
    }

    private fun sonyPollNewList(): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        val p = sonyProps()
        val mem = sonyVal(p, 0xD215)
        if (mem >= 0x8000) {
            for (k in 0 until 4) {
                val info = sonyInfo()
                val fmt = info[1]; val size = info[2]
                val cd = StringBuilder("sony_poll; info ${hex(info[0])} fmt ${hex(fmt)} $size B")
                if (fmt != 0 && fmt != 0x3801 && fmt != 0x3808) {
                    downloadObject(SONY_PHOTO, size, StringBuilder())
                    log("Skipped non-JPEG Sony roving object ${hex(fmt)}")
                    if (sonyVal(sonyProps(), 0xD215) < 0x8000) break
                    continue
                }
                val img = downloadObject(SONY_PHOTO, size, cd)
                log("Sony roving photo download: $cd")
                if (img.size > 4 && img[0] == 0xFF.toByte() && img[1] == 0xD8.toByte()) out.add(img)
                if (sonyVal(sonyProps(), 0xD215) < 0x8000) break
            }
        }
        return out
    }

    private fun sonyPollNew(): ByteArray? = sonyPollNewList().firstOrNull()

    // ================================================================ Roving DSLR Bridge Public API

    fun isCameraOpen(): Boolean = synchronized(lock) { conn != null }

    fun cameraName(): String = synchronized(lock) {
        val n = if (camName.isNotEmpty()) camName else (dev?.productName ?: "")
        if (n.isNotEmpty()) n else "DSLR Camera"
    }

    fun cameraBattery(): Int = synchronized(lock) {
        try { battery() } catch (_: Exception) { -1 }
    }

    fun cameraSetupNote(): String = synchronized(lock) { setupNote }

    fun setRovingSaveToCard(enabled: Boolean) = synchronized(lock) {
        val changed = rovingSaveToCard != enabled
        rovingSaveToCard = enabled
        if (changed && rovingMode && conn != null) {
            closeCamera()
        }
    }

    fun ensureOpen(roving: Boolean = true, saveToCard: Boolean = rovingSaveToCard): Boolean = synchronized(lock) {
        rovingSaveToCard = saveToCard
        val wantCard = if (roving) rovingSaveToCard else saveToCard
        if (conn != null) {
            if (rovingMode == roving && keepOnCard == wantCard) {
                try { alive(); return true } catch (_: Exception) { closeCamera() }
            } else {
                closeCamera()
            }
        }
        try {
            openCamera(false, roving = roving, saveToCard = wantCard)
            conn != null
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Polls the camera for all newly captured JPEG photos (handles burst shots cleanly).
     */
    fun pollNewPhotos(): List<ByteArray> = synchronized(lock) {
        if (conn == null) return emptyList()
        try {
            if (canon) canonPollNewList()
            else if (sony) sonyPollNewList()
            else nikonPollNewList()
        } catch (e: Exception) {
            log("pollNewPhotos: ${e.message}")
            emptyList()
        }
    }

    fun pollNewPhoto(): ByteArray? = pollNewPhotos().firstOrNull()

    /**
     * Manually triggers camera capture and returns JPEG bytes.
     */
    fun triggerCapture(): ByteArray? = synchronized(lock) {
        if (conn == null) return null
        try {
            capture()
        } catch (e: Exception) {
            log("triggerCapture error: ${e.message}")
            null
        }
    }
}
