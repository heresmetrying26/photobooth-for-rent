package com.photobooth4u.booth

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.herohan.uvcapp.CameraHelper
import com.herohan.uvcapp.ICameraHelper
import com.serenegiant.usb.IFrameCallback
import com.serenegiant.usb.Size
import com.serenegiant.usb.UVCCamera
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A plain USB webcam (Logitech Brio / C270 / C920, any UVC camera) plugged into the tablet.
 *
 * Path 1: on tablets whose Android shows USB webcams as an "external" Camera2 camera (Android 14+, maker
 * dependent) the WebView's getUserMedia already sees the webcam, so nothing is done here ([nativeExternal]).
 *
 * Path 2 (Samsung Tab A / S9 FE, Xiaomi Pad... where Android does not): the app opens the webcam itself through
 * libuvc (UVCAndroid) and the booth page reads JPEG frames from http://127.0.0.1:17321/uvc/frame, wrapping them in
 * a canvas stream so the rest of the booth treats it like any webcam.
 *
 * Calls (served by [UsbCameraHelper]'s local server):
 *   GET  /uvc         -> { devices:[{name}], native, open, size, note }
 *   POST /uvc/open    -> opens the first UVC webcam (asks USB permission), best resolution that really streams
 *   GET  /uvc/frame   -> latest frame as JPEG (204 when none yet, 410 when the webcam is gone)
 *   POST /uvc/close
 */
class UvcWebcam(private val ctx: Context) {

    companion object {
        private const val TAG = "PBUvc"
        private const val VS_FRAME_MJPEG = 7          // UVC spec VS_FRAME_MJPEG
        private const val MAX_PREVIEW_W = 1920        // Tab A11 / S9 FE / most Xiaomi pads have USB 2.0 ports: 1080p max
        private const val FIRST_FRAME_MS = 4000L      // a mode that sends nothing in this time is skipped
        private const val STALL_MS = 6000L            // open but silent this long = lost (power / cable)
    }

    class Reply(val status: Int, val type: String, val body: ByteArray)

    private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private val main = Handler(Looper.getMainLooper())
    private val lock = Object()

    private var helper: ICameraHelper? = null
    private var device: UsbDevice? = null
    @Volatile private var opened = false
    @Volatile private var gone = false
    @Volatile private var lastError = ""
    private var candidates: List<Size> = emptyList()
    private var candIdx = 0
    private var size: Size? = null
    private var openLatch: CountDownLatch? = null

    // latest frame (NV21), turned into JPEG only when the page asks
    private var nv21: ByteArray? = null
    private var frameW = 0
    private var frameH = 0
    @Volatile private var frameSeq = 0L
    @Volatile private var lastFrameAt = 0L
    private var jpegSeq = -1L
    private var jpeg: ByteArray? = null

    // ---------------------------------------------------------------- devices

    private fun isUvc(d: UsbDevice): Boolean {
        for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == 14) return true   // USB Video class
        return false
    }

    private fun webcams(): List<UsbDevice> = usb.deviceList.values.filter { isUvc(it) }

    /** True when Android itself already offers a USB webcam to apps (Camera2 LENS_FACING_EXTERNAL): use Path 1. */
    fun nativeExternal(): Boolean = try {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        cm.cameraIdList.any { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_EXTERNAL }
    } catch (e: Exception) { false }

    // ---------------------------------------------------------------- HTTP

    fun route(method: String, path: String): Reply = try {
        when {
            method == "GET" && path == "/uvc" -> json(status())
            method == "POST" && path == "/uvc/open" -> json(open())
            method == "GET" && path == "/uvc/frame" -> frameReply()
            method == "POST" && path == "/uvc/close" -> { close(); json(JSONObject()) }
            else -> Reply(404, "application/json", err("NOTFOUND", "Not found"))
        }
    } catch (e: Exception) {
        Log.w(TAG, "uvc call $path failed", e)
        Reply(409, "application/json", err("ERROR", e.message ?: e.javaClass.simpleName))
    }

    private fun json(o: JSONObject) = Reply(200, "application/json", o.put("ok", true).toString().toByteArray())
    private fun err(code: String, msg: String) = JSONObject().put("ok", false).put("code", code).put("error", msg).toString().toByteArray()

    private fun status(): JSONObject {
        val native = nativeExternal()
        val arr = JSONArray()
        if (!native) for (d in webcams()) arr.put(JSONObject().put("name", d.productName ?: "USB webcam").put("maker", d.manufacturerName ?: ""))
        val s = size
        return JSONObject().put("devices", arr).put("native", native).put("open", opened)
            .put("size", if (opened && s != null) "${s.width}x${s.height}" else "")
            .put("note", lastError)
    }

    private fun frameReply(): Reply {
        if (gone) return Reply(410, "application/json", err("GONE", "The webcam was unplugged or lost power. Use a powered USB-C hub, then replug it."))
        if (!opened) return Reply(409, "application/json", err("CLOSED", "Webcam not open"))
        if (lastFrameAt > 0 && System.currentTimeMillis() - lastFrameAt > STALL_MS) {
            lastError = "The webcam stopped sending pictures. It may need more power: use a powered USB-C hub."
            return Reply(410, "application/json", err("STALL", lastError))
        }
        val j = jpegNow(80) ?: return Reply(204, "image/jpeg", ByteArray(0))
        return Reply(200, "image/jpeg", j)
    }

    private fun jpegNow(quality: Int): ByteArray? = synchronized(lock) {
        val data = nv21 ?: return null
        if (jpegSeq == frameSeq && jpeg != null) return jpeg
        val out = ByteArrayOutputStream(frameW * frameH / 4)
        YuvImage(data, ImageFormat.NV21, frameW, frameH, null).compressToJpeg(Rect(0, 0, frameW, frameH), quality, out)
        jpeg = out.toByteArray(); jpegSeq = frameSeq
        jpeg
    }

    // ---------------------------------------------------------------- open / close

    private fun open(): JSONObject {
        if (opened && !gone && System.currentTimeMillis() - lastFrameAt < STALL_MS) return status()
        close()
        val d = webcams().firstOrNull() ?: throw IllegalStateException("No USB webcam found. Plug it in (USB-C OTG adapter or hub) and try again.")
        gone = false; lastError = ""; device = d
        val latch = CountDownLatch(1)
        openLatch = latch
        main.post {
            try {
                val h = helper ?: CameraHelper().also { helper = it; it.setStateCallback(callback) }
                h.selectDevice(d)   // asks the USB permission when needed, then onDeviceOpen
            } catch (e: Exception) { lastError = e.message ?: "open failed"; latch.countDown() }
        }
        // permission dialog + up to a few resolutions tried
        latch.await(90, TimeUnit.SECONDS)
        if (!opened) {
            val why = lastError.ifEmpty { "The webcam did not start. Unplug and replug it (use a powered hub if it keeps failing), then try again." }
            close()
            throw IllegalStateException(why)
        }
        return status()
    }

    fun close() {
        opened = false
        val h = helper
        if (h != null) main.post { try { h.closeCamera() } catch (_: Exception) { } }
        synchronized(lock) { nv21 = null; jpeg = null; jpegSeq = -1 }
        lastFrameAt = 0
    }

    fun release() {
        close()
        val h = helper; helper = null
        if (h != null) main.post { try { h.release() } catch (_: Exception) { } }
    }

    /** MJPEG modes first (YUYV above 720p does not fit USB 2.0), biggest that fits [MAX_PREVIEW_W] first, bigger ones last. */
    private fun orderSizes(all: List<Size>): List<Size> {
        val uniq = all.distinctBy { "${it.type}:${it.width}x${it.height}" }
        val fit = uniq.filter { it.width <= MAX_PREVIEW_W }
            .sortedWith(compareByDescending<Size> { it.type == VS_FRAME_MJPEG }.thenByDescending { it.width * it.height })
        val big = uniq.filter { it.width > MAX_PREVIEW_W }.sortedByDescending { it.width * it.height }
        return fit + big
    }

    private fun tryNextSize() {
        val h = helper ?: return
        if (candIdx >= candidates.size) {
            lastError = "The webcam opened but sent no picture at any size. Try a powered USB-C hub or another cable."
            openLatch?.countDown(); return
        }
        val s = candidates[candIdx++]
        size = s
        Log.i(TAG, "trying ${s.width}x${s.height} type=${s.type}")
        try {
            h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
            h.openCamera(s)
        } catch (e: Exception) {
            Log.w(TAG, "size failed", e)
            main.post { tryNextSize() }
        }
    }

    private val frameCallback = IFrameCallback { buf ->
        val s = size ?: return@IFrameCallback
        val n = buf.remaining()
        val need = s.width * s.height * 3 / 2
        if (n < need) return@IFrameCallback
        synchronized(lock) {
            var a = nv21
            if (a == null || a.size != need) { a = ByteArray(need); nv21 = a }
            buf.get(a, 0, need)
            frameW = s.width; frameH = s.height
            frameSeq++
        }
        lastFrameAt = System.currentTimeMillis()
        if (!opened) { opened = true; openLatch?.countDown() }
    }

    private val callback = object : ICameraHelper.StateCallback {
        override fun onAttach(device: UsbDevice?) { }

        override fun onDeviceOpen(device: UsbDevice?, isFirstOpen: Boolean) {
            val all = try { helper?.supportedSizeList ?: emptyList() } catch (e: Exception) { emptyList<Size>() }
            candidates = orderSizes(all)
            candIdx = 0
            Log.i(TAG, "webcam ${device?.productName}: ${all.size} modes")
            if (candidates.isEmpty()) { try { helper?.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21); helper?.openCamera() } catch (_: Exception) { } }
            else tryNextSize()
        }

        override fun onCameraOpen(device: UsbDevice?) {
            try { helper?.startPreview() } catch (e: Exception) { Log.w(TAG, "startPreview", e) }
            // a mode that sends nothing: close it and try the next one
            val tried = size
            main.postDelayed({
                if (!opened && size === tried && helper != null && (openLatch?.count ?: 0L) > 0L) {
                    Log.i(TAG, "no frames at ${tried?.width}x${tried?.height}, next")
                    try { helper?.closeCamera() } catch (_: Exception) { }
                    main.postDelayed({ tryNextSize() }, 400)
                }
            }, FIRST_FRAME_MS)
        }

        override fun onCameraClose(device: UsbDevice?) { }
        override fun onDeviceClose(device: UsbDevice?) { }

        override fun onDetach(device: UsbDevice?) {
            if (device != null && device.deviceName == this@UvcWebcam.device?.deviceName) {
                gone = true; opened = false
                lastError = "The webcam was unplugged."
                openLatch?.countDown()
            }
        }

        override fun onCancel(device: UsbDevice?) {
            lastError = "The tablet needs your OK to use the webcam. Tap Try Again and choose OK when Android asks (tick \"Always\")."
            openLatch?.countDown()
        }
    }
}
