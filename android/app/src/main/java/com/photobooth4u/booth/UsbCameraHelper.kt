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
import java.io.ByteArrayOutputStream
import java.io.IOException
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
 * A Nikon / DSLR camera plugged into the tablet's USB port.
 *
 * Chrome on a laptop talks to such a camera with WebUSB, but Android's WebView has no WebUSB, so the booth
 * page never saw the camera in this app. Here the app does what the photobooth4u Helper does on Windows: it
 * talks PTP (the camera's own USB protocol) through Android's USB host API and answers the booth page on
 * http://127.0.0.1:17321 with the same few calls (/camera, /camera/open, /camera/live, /camera/frame,
 * /camera/capture, /camera/battery), so the booth uses its existing "helper camera" path unchanged.
 *
 * Nikon only for now (live view + shutter through Nikon's PTP operations, like libgphoto2).
 */
class UsbCameraHelper(private val ctx: Context) {

    companion object {
        private const val TAG = "PBCam"
        const val PORT = 17321
        private const val ACTION_PERMISSION = "com.photobooth4u.booth.USB_CAMERA_PERMISSION"
        private val CAMERA_VENDORS = intArrayOf(0x04b0, 0x04a9, 0x054c, 0x04cb, 0x07b4, 0x04da, 0x0a17) // Nikon, Canon, Sony, Fujifilm, Olympus, Panasonic, Pentax

        // PTP
        private const val OC_GET_DEVICE_INFO = 0x1001
        private const val OC_OPEN_SESSION = 0x1002
        private const val OC_CLOSE_SESSION = 0x1003
        private const val OC_GET_OBJECT = 0x1009
        private const val OC_INITIATE_CAPTURE = 0x100E
        private const val OC_GET_DEVICE_PROP = 0x1015
        private const val OC_SET_DEVICE_PROP = 0x1016
        private const val RC_OK = 0x2001
        private const val RC_SESSION_OPEN = 0x201E
        private const val RC_BUSY = 0x2019
        private const val EC_OBJECT_ADDED = 0x4002
        private const val DPC_BATTERY = 0x5001
        // Nikon
        private const val OC_NIKON_CAPTURE_SDRAM = 0x90C0
        private const val OC_NIKON_GET_EVENT = 0x90C7
        private const val OC_NIKON_DEVICE_READY = 0x90C8
        private const val OC_NIKON_AF_CAPTURE_SDRAM = 0x90CB
        private const val OC_NIKON_START_LV = 0x9201
        private const val OC_NIKON_END_LV = 0x9202
        private const val OC_NIKON_GET_LV_IMG = 0x9203
        private const val RC_NIKON_BUSY = 0xA00B
        private const val DPC_NIKON_RECORDING_MEDIA = 0xD10B
        private const val SDRAM_HANDLE = 0xFFFF0001.toInt()
    }

    /** code: NOCAMERA / GONE / UNSUPPORTED / ERROR (what the booth page switches on). */
    private class CamErr(val code: String, message: String, val status: Int) : Exception(message)

    private class Resp(val code: Int, val params: IntArray, val data: ByteArray?)

    private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private val lock = Any()

    private var dev: UsbDevice? = null
    private var conn: UsbDeviceConnection? = null
    private var iface: UsbInterface? = null
    private var epIn: UsbEndpoint? = null
    private var epOut: UsbEndpoint? = null
    private var tid = 0
    private var pend = ByteArray(65536)
    private var pendLen = 0
    private val rbuf = ByteArray(16384)

    private var name = ""
    private var maker = ""
    private var ops = IntArray(0)
    private var live = false

    @Volatile private var server: ServerSocket? = null

    // ---------------------------------------------------------------- server

    @Synchronized
    fun start() {
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
            Log.i(TAG, "Camera helper listening on 127.0.0.1:$PORT")
        } catch (e: Exception) {
            Log.w(TAG, "Camera helper could not start", e)
        }
    }

    @Synchronized
    fun stop() {
        try { server?.close() } catch (_: IOException) { }
        server = null
        synchronized(lock) { closeQuietly() }
    }

    private fun handle(s: Socket) {
        s.use { sock ->
            try {
                sock.soTimeout = 10000
                val inp = sock.getInputStream().buffered()
                val line = readLine(inp) ?: return
                val parts = line.split(' ')
                if (parts.size < 2) return
                while (true) { val h = readLine(inp) ?: break; if (h.isEmpty()) break }   // headers (nothing in them is needed)
                val method = parts[0]
                val full = parts[1]
                val path = full.substringBefore('?').trimEnd('/')
                val query = if (full.contains('?')) full.substringAfter('?') else ""
                val out = sock.getOutputStream()
                if (method == "OPTIONS") { reply(out, 204, "text/plain", ByteArray(0)); return }
                try {
                    route(out, method, path, query)
                } catch (e: CamErr) {
                    reply(out, e.status, "application/json", err(e.code, e.message ?: "Camera problem").toByteArray())
                } catch (e: Exception) {
                    Log.w(TAG, "camera call failed", e)
                    reply(out, 409, "application/json", err("ERROR", e.message ?: e.javaClass.simpleName).toByteArray())
                }
            } catch (_: IOException) { }
        }
    }

    private fun readLine(i: java.io.InputStream): String? {
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
        val reason = when (status) { 200 -> "OK"; 204 -> "No Content"; 404 -> "Not Found"; 410 -> "Gone"; 501 -> "Not Implemented"; else -> "Error" }
        val h = "HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\n" +
            "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n" +
            "Access-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun json(out: OutputStream, o: JSONObject) = reply(out, 200, "application/json", o.put("ok", true).toString().toByteArray())

    private fun route(out: OutputStream, method: String, path: String, query: String) {
        when {
            method == "GET" && path == "/camera" -> json(out, listJson())
            method == "POST" && path == "/camera/open" -> json(out, open())
            method == "POST" && path == "/camera/live" -> { setLive(!query.contains("on=0")); json(out, JSONObject()) }
            method == "GET" && path == "/camera/frame" -> {
                val f = frame()
                if (f == null) reply(out, 204, "image/jpeg", ByteArray(0)) else reply(out, 200, "image/jpeg", f)
            }
            method == "POST" && path == "/camera/capture" -> reply(out, 200, "image/jpeg", capture())
            method == "GET" && path == "/camera/battery" -> json(out, JSONObject().put("battery", battery()))
            method == "POST" && path == "/camera/close" -> { synchronized(lock) { closeQuietly() }; json(out, JSONObject()) }
            method == "POST" && path == "/camera/free" -> json(out, JSONObject())
            else -> reply(out, 404, "application/json", err("NOTFOUND", "Not found").toByteArray())
        }
    }

    // ---------------------------------------------------------------- devices

    private fun isCamera(d: UsbDevice): Boolean {
        for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == 6) return true
        return CAMERA_VENDORS.contains(d.vendorId)
    }

    private fun listJson(): JSONObject {
        val arr = JSONArray()
        for (d in usb.deviceList.values) {
            if (!isCamera(d)) continue
            arr.put(JSONObject().put("name", d.productName ?: "USB camera").put("maker", d.manufacturerName ?: "").put("camera", true))
        }
        val o = JSONObject().put("devices", arr)
        synchronized(lock) { o.put("open", conn != null && dev != null && usb.deviceList.containsValue(dev)).put("name", name) }
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
        if (!usb.hasPermission(d)) throw CamErr("NOCAMERA", "The tablet needs your OK to use the camera. Tap Try Again and choose OK when Android asks.", 404)
    }

    // ---------------------------------------------------------------- PTP transport

    private fun gone(why: String): CamErr {
        closeQuietly()
        return CamErr("GONE", why, 410)
    }

    private fun send(b: ByteArray) {
        val c = conn ?: throw gone("The camera was unplugged.")
        val ep = epOut ?: throw gone("The camera was unplugged.")
        var off = 0
        while (off < b.size) {
            val n = minOf(16384, b.size - off)
            val chunk = if (off == 0 && n == b.size) b else b.copyOfRange(off, off + n)
            val r = c.bulkTransfer(ep, chunk, n, 5000)
            if (r < 0) throw gone("The camera stopped answering. Check it is on and the USB cable is plugged in.")
            off += n
        }
    }

    private fun fill(n: Int, timeoutMs: Int) {
        val c = conn ?: throw gone("The camera was unplugged.")
        val ep = epIn ?: throw gone("The camera was unplugged.")
        while (pendLen < n) {
            val r = c.bulkTransfer(ep, rbuf, rbuf.size, timeoutMs)
            if (r < 0) throw gone("The camera stopped answering. Check it is on and the USB cable is plugged in.")
            if (pendLen + r > pend.size) pend = pend.copyOf(maxOf(pend.size * 2, pendLen + r))
            System.arraycopy(rbuf, 0, pend, pendLen, r)
            pendLen += r
        }
    }

    private fun le(b: ByteArray, o: Int): Int = ByteBuffer.wrap(b, o, 4).order(ByteOrder.LITTLE_ENDIAN).int
    private fun le16(b: ByteArray, o: Int): Int = ByteBuffer.wrap(b, o, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF

    private fun container(type: Int, code: Int, t: Int, params: IntArray, payload: ByteArray? = null): ByteArray {
        val len = 12 + params.size * 4 + (payload?.size ?: 0)
        val bb = ByteBuffer.allocate(len).order(ByteOrder.LITTLE_ENDIAN)
        bb.putInt(len).putShort(type.toShort()).putShort(code.toShort()).putInt(t)
        params.forEach { bb.putInt(it) }
        if (payload != null) bb.put(payload)
        return bb.array()
    }

    /** One PTP operation: command, optional data out, then the camera's data (if any) and response. */
    private fun transact(op: Int, params: IntArray = IntArray(0), out: ByteArray? = null, timeoutMs: Int = 15000): Resp {
        pendLen = 0
        val t = ++tid
        send(container(1, op, t, params))
        if (out != null) send(container(2, op, t, IntArray(0), out))
        var data: ByteArray? = null
        while (true) {
            fill(12, timeoutMs)
            val len = le(pend, 0)
            if (len < 12 || len > 300_000_000) throw gone("The camera sent something unexpected. Unplug it and plug it in again.")
            fill(len, timeoutMs)
            val type = le16(pend, 4)
            val code = le16(pend, 6)
            val payload = pend.copyOfRange(12, len)
            System.arraycopy(pend, len, pend, 0, pendLen - len)
            pendLen -= len
            if (type == 2) data = payload
            else if (type == 3) return Resp(code, IntArray(payload.size / 4) { le(payload, it * 4) }, data)
        }
    }

    private fun expectOk(r: Resp, what: String) {
        if (r.code != RC_OK) throw CamErr("ERROR", "$what (camera answered 0x" + Integer.toHexString(r.code) + ")", 409)
    }

    // ---------------------------------------------------------------- open / close

    private class Rd(val b: ByteArray) {
        var p = 0
        fun u8() = if (p < b.size) b[p++].toInt() and 0xFF else 0
        fun u16(): Int { val v = if (p + 2 <= b.size) ByteBuffer.wrap(b, p, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF else 0; p += 2; return v }
        fun u32(): Int { val v = if (p + 4 <= b.size) ByteBuffer.wrap(b, p, 4).order(ByteOrder.LITTLE_ENDIAN).int else 0; p += 4; return v }
        fun str(): String { val n = u8(); val sb = StringBuilder(); repeat(n) { val c = u16(); if (c != 0) sb.append(c.toChar()) }; return sb.toString() }
        fun arr(): IntArray { val n = u32(); if (n < 0 || n > 4096) return IntArray(0); return IntArray(n) { u16() } }
    }

    private fun closeQuietly() {
        try {
            if (conn != null && live) try { transact(OC_NIKON_END_LV, timeoutMs = 2000) } catch (_: Exception) { }
            if (conn != null) try { transact(OC_CLOSE_SESSION, timeoutMs = 2000) } catch (_: Exception) { }
        } catch (_: Exception) { }
        try { iface?.let { conn?.releaseInterface(it) } } catch (_: Exception) { }
        try { conn?.close() } catch (_: Exception) { }
        conn = null; dev = null; iface = null; epIn = null; epOut = null
        live = false; pendLen = 0
    }

    private fun open(): JSONObject = synchronized(lock) {
        if (conn != null && dev != null && usb.deviceList.containsValue(dev)) {
            return@synchronized JSONObject().put("name", name).put("maker", maker)
        }
        closeQuietly()
        val d = usb.deviceList.values.firstOrNull { isCamera(it) }
            ?: throw CamErr("NOCAMERA", "No camera found. Plug it into the tablet with its USB cable and switch it on.", 404)
        requestPermission(d)
        val c = usb.openDevice(d) ?: throw CamErr("ERROR", "Android would not let the app open the camera. Unplug and replug it, then tap Try Again.", 409)
        var itf: UsbInterface? = null
        for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == 6) { itf = d.getInterface(i); break }
        if (itf == null) { c.close(); throw CamErr("UNSUPPORTED", "This camera is not in a USB mode the booth can control. Set its USB mode to PTP / MTP (Nikon: Setup menu > USB), then plug it in again.", 501) }
        if (!c.claimInterface(itf, true)) { c.close(); throw CamErr("ERROR", "Another app is using the camera. Close it, unplug and replug the camera, then tap Try Again.", 409) }
        var bi: UsbEndpoint? = null; var bo: UsbEndpoint? = null
        for (i in 0 until itf.endpointCount) {
            val e = itf.getEndpoint(i)
            if (e.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                if (e.direction == UsbConstants.USB_DIR_IN) bi = e else bo = e
            }
        }
        if (bi == null || bo == null) { c.releaseInterface(itf); c.close(); throw CamErr("ERROR", "The camera did not offer a USB data channel. Unplug and replug it.", 409) }
        dev = d; conn = c; iface = itf; epIn = bi; epOut = bo; tid = 0; pendLen = 0; live = false
        try {
            val s = transact(OC_OPEN_SESSION, intArrayOf(1))
            if (s.code != RC_OK && s.code != RC_SESSION_OPEN) throw CamErr("ERROR", "The camera would not start a session (0x" + Integer.toHexString(s.code) + "). Switch it off and on, then try again.", 409)
            val info = transact(OC_GET_DEVICE_INFO)
            expectOk(info, "Could not read the camera")
            val r = Rd(info.data ?: ByteArray(0))
            r.u16(); r.u32(); r.u16(); r.str(); r.u16()
            ops = r.arr(); r.arr(); r.arr(); r.arr(); r.arr()
            maker = r.str()
            val model = r.str()
            name = model.ifBlank { d.productName ?: "USB camera" }
            val nikon = maker.contains("nikon", ignoreCase = true) || d.vendorId == 0x04b0
            if (!nikon || !ops.contains(OC_NIKON_GET_LV_IMG)) {
                throw CamErr("UNSUPPORTED", "On the tablet the camera works with Nikon cameras for now. This one (" + name + ") can't be controlled yet; use a Nikon, or a camera that works as a USB webcam.", 501)
            }
        } catch (e: Exception) {
            closeQuietly()
            throw e
        }
        Log.i(TAG, "Camera connected: $maker $name")
        JSONObject().put("name", name).put("maker", maker)
    }

    // ---------------------------------------------------------------- live view / capture

    private fun setLive(on: Boolean) = synchronized(lock) {
        if (conn == null) throw CamErr("GONE", "The camera is not connected.", 410)
        if (!on) {
            if (live) try { transact(OC_NIKON_END_LV) } catch (e: CamErr) { throw e } catch (_: Exception) { }
            live = false
            return@synchronized
        }
        if (live) return@synchronized
        // Keep photos in the camera's memory, not on its card (best effort; not every body has it).
        try { transact(OC_SET_DEVICE_PROP, intArrayOf(DPC_NIKON_RECORDING_MEDIA), byteArrayOf(1)) } catch (e: CamErr) { throw e } catch (_: Exception) { }
        var code = 0
        for (i in 0 until 25) {
            code = transact(OC_NIKON_START_LV).code
            if (code == RC_OK || code == 0xA00E.toInt() /* already on */) break
            if (code != RC_BUSY && code != RC_NIKON_BUSY) break
            Thread.sleep(200)
        }
        if (code != RC_OK && code != 0xA00E) {
            throw CamErr("ERROR", "Live view didn't start (0x" + Integer.toHexString(code) + "). Close the camera's menu, take the lens cap off, set the mode dial to M, P, A or S and check the battery.", 409)
        }
        // Wait until the camera says it is ready for the first picture.
        for (i in 0 until 25) {
            if (transact(OC_NIKON_DEVICE_READY).code == RC_OK) break
            Thread.sleep(100)
        }
        live = true
    }

    private fun frame(): ByteArray? = synchronized(lock) {
        if (conn == null) throw CamErr("GONE", "The camera is not connected.", 410)
        if (!live) return@synchronized null
        val r = transact(OC_NIKON_GET_LV_IMG)
        if (r.code == RC_BUSY || r.code == RC_NIKON_BUSY) return@synchronized null
        if (r.code != RC_OK) throw CamErr("ERROR", "Live view stopped (0x" + Integer.toHexString(r.code) + ").", 409)
        jpegIn(r.data ?: return@synchronized null)
    }

    /** The JPEG inside Nikon's live view data (it comes after a short header). */
    private fun jpegIn(b: ByteArray): ByteArray? {
        var s = -1
        for (i in 0 until minOf(b.size - 1, 2000)) if (b[i] == 0xFF.toByte() && b[i + 1] == 0xD8.toByte()) { s = i; break }
        if (s < 0) return null
        var e = b.size
        for (i in b.size - 2 downTo s + 2) if (b[i] == 0xFF.toByte() && b[i + 1] == 0xD9.toByte()) { e = i + 2; break }
        return b.copyOfRange(s, e)
    }

    private fun capture(): ByteArray = synchronized(lock) {
        if (conn == null) throw CamErr("GONE", "The camera is not connected.", 410)
        try { transact(OC_SET_DEVICE_PROP, intArrayOf(DPC_NIKON_RECORDING_MEDIA), byteArrayOf(1)) } catch (e: CamErr) { throw e } catch (_: Exception) { }
        // Drain old events so only this photo's "object added" counts.
        try { transact(OC_NIKON_GET_EVENT) } catch (e: CamErr) { throw e } catch (_: Exception) { }
        // Memory capture first (autofocus one while live view is on), plain capture as the fallback.
        val attempts = ArrayList<Pair<Int, IntArray>>()
        if (live && ops.contains(OC_NIKON_AF_CAPTURE_SDRAM)) attempts.add(OC_NIKON_AF_CAPTURE_SDRAM to IntArray(0))
        if (ops.contains(OC_NIKON_CAPTURE_SDRAM)) attempts.add(OC_NIKON_CAPTURE_SDRAM to intArrayOf(SDRAM_HANDLE))
        attempts.add(OC_INITIATE_CAPTURE to intArrayOf(0, 0))
        var started = false
        var lastCode = 0
        for ((op, params) in attempts) {
            for (i in 0 until 15) {
                lastCode = transact(op, params).code
                if (lastCode != RC_BUSY && lastCode != RC_NIKON_BUSY) break
                Thread.sleep(200)
            }
            if (lastCode == RC_OK) { started = true; break }
        }
        if (!started) throw CamErr("ERROR", "The camera would not take the photo (0x" + Integer.toHexString(lastCode) + "). Check it is in focus, has a card (if required) and is not asleep.", 409)
        var handle = 0
        val until = System.currentTimeMillis() + 30000
        while (handle == 0 && System.currentTimeMillis() < until) {
            val ev = transact(OC_NIKON_GET_EVENT)
            val d = ev.data
            if (ev.code == RC_OK && d != null && d.size >= 2) {
                val n = le16(d, 0)
                for (i in 0 until n) {
                    val o = 2 + i * 6
                    if (o + 6 > d.size) break
                    if (le16(d, o) == EC_OBJECT_ADDED) { handle = le(d, o + 2); break }
                }
            }
            if (handle == 0) Thread.sleep(150)
        }
        if (handle == 0) throw CamErr("ERROR", "The photo never arrived from the camera. Try again.", 409)
        val obj = transact(OC_GET_OBJECT, intArrayOf(handle), timeoutMs = 30000)
        expectOk(obj, "Could not get the photo from the camera")
        obj.data ?: throw CamErr("ERROR", "The camera sent an empty photo.", 409)
    }

    private fun battery(): Int = synchronized(lock) {
        if (conn == null) throw CamErr("GONE", "The camera is not connected.", 410)
        try {
            val r = transact(OC_GET_DEVICE_PROP, intArrayOf(DPC_BATTERY))
            val d = r.data
            if (r.code == RC_OK && d != null && d.isNotEmpty()) d[0].toInt() and 0xFF else -1
        } catch (e: CamErr) { throw e } catch (_: Exception) { -1 }
    }
}
