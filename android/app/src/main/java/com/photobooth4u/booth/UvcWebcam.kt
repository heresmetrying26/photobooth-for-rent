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
import com.herohan.uvcapp.CameraException
import com.herohan.uvcapp.CameraHelper
import com.herohan.uvcapp.ICameraHelper
import com.serenegiant.usb.IFrameCallback
import com.serenegiant.usb.Size
import com.serenegiant.usb.UVCCamera
import com.serenegiant.usb.UVCParam
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
 * Path 2 (Samsung Tab A11 / S9 FE, Xiaomi Pad... where Android does not): the app opens the webcam itself through
 * libuvc (UVCAndroid) and the booth page reads JPEG frames from http://127.0.0.1:17321/uvc/frame, wrapping them in
 * a canvas stream so the rest of the booth treats it like any webcam.
 *
 * Calls (served by [UsbCameraHelper]'s local server):
 *   GET  /uvc                      -> { devices:[{name,maker}], native, open, size, max, preview, note }
 *   POST /uvc/open?preview=...     -> opens webcam at requested cap: auto | max | 1080 | 720 | 480
 *   GET  /uvc/frame                -> latest preview frame as JPEG (204 when none/switching, 410 when gone/stalled)
 *   POST /uvc/capture?mode=max     -> captures a full-res still (briefly switches to camera's max mode, then restores preview)
 *   POST /uvc/close
 */
class UvcWebcam(private val ctx: Context) {

    companion object {
        private const val TAG = "PBUvc"
        private const val VS_FRAME_MJPEG = UVCCamera.UVC_VS_FRAME_MJPEG
        private const val FIRST_FRAME_MS = 3800L      // a mode that sends nothing in this time is skipped
        private const val STALL_MS = 6500L            // open but silent this long = lost (power / cable)
        private const val STILL_WAIT_MS = 2600L       // max wait per high-res mode when capturing a still
    }

    class Reply(val status: Int, val type: String, val body: ByteArray)

    private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private val main = Handler(Looper.getMainLooper())
    private val opLock = Any()
    private val frameLock = Any()

    private var helper: ICameraHelper? = null
    private var device: UsbDevice? = null
    @Volatile private var opened = false
    @Volatile private var gone = false
    @Volatile private var switching = false
    @Volatile private var lastError = ""
    @Volatile private var activePref = "auto"
    @Volatile private var maxLabel = ""

    private var allSizes: List<Size> = emptyList()
    private var candidates: List<Size> = emptyList()
    private var candIdx = 0
    @Volatile private var size: Size? = null
    private var busyRetries = 0
    private val failedStillKeys = HashSet<String>()

    private var openLatch: CountDownLatch? = null
    private var cameraOpenLatch: CountDownLatch? = null
    private var stillLatch: CountDownLatch? = null
    private var restoreLatch: CountDownLatch? = null
    @Volatile private var targetStillSize: Size? = null

    // latest frame (NV21), turned into JPEG only when the page asks
    private var nv21: ByteArray? = null
    @Volatile private var frameW = 0
    @Volatile private var frameH = 0
    @Volatile private var frameSeq = 0L
    @Volatile private var modeFrameCount = 0
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

    fun route(method: String, path: String, query: String = ""): Reply = try {
        when {
            method == "GET" && path == "/uvc" -> json(status())
            method == "POST" && path == "/uvc/open" -> json(open(parseParam(query, "preview").ifEmpty { "auto" }))
            method == "GET" && path == "/uvc/frame" -> frameReply()
            method == "POST" && path == "/uvc/capture" -> Reply(200, "image/jpeg", captureStill(query))
            method == "POST" && path == "/uvc/close" -> { close(); json(JSONObject()) }
            else -> Reply(404, "application/json", err("NOTFOUND", "Not found"))
        }
    } catch (e: Exception) {
        Log.w(TAG, "uvc call $path failed", e)
        Reply(409, "application/json", err("ERROR", e.message ?: e.javaClass.simpleName))
    }

    private fun parseParam(query: String, key: String): String {
        if (query.isEmpty()) return ""
        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            if (eq > 0 && part.substring(0, eq) == key) return part.substring(eq + 1).lowercase()
        }
        return ""
    }

    private fun json(o: JSONObject) = Reply(200, "application/json", o.put("ok", true).toString().toByteArray())
    private fun err(code: String, msg: String) = JSONObject().put("ok", false).put("code", code).put("error", msg).toString().toByteArray()

    private fun status(): JSONObject {
        val native = nativeExternal()
        val arr = JSONArray()
        if (!native) for (d in webcams()) arr.put(JSONObject().put("name", d.productName ?: "USB webcam").put("maker", d.manufacturerName ?: ""))
        val s = size
        return JSONObject().put("devices", arr).put("native", native).put("open", opened)
            .put("size", if ((opened || switching) && s != null) "${s.width}x${s.height}" else "")
            .put("max", maxLabel)
            .put("preview", activePref)
            .put("note", lastError)
    }

    private fun frameReply(): Reply {
        if (gone) return Reply(410, "application/json", err("GONE", "The webcam was unplugged or lost power. Use a powered USB-C hub, then replug it."))
        if (switching) return Reply(204, "image/jpeg", ByteArray(0))
        if (!opened) return Reply(409, "application/json", err("CLOSED", "Webcam not open"))
        if (lastFrameAt > 0 && System.currentTimeMillis() - lastFrameAt > STALL_MS) {
            lastError = "The webcam stopped sending pictures. It may need more power: use a powered USB-C hub."
            return Reply(410, "application/json", err("STALL", lastError))
        }
        val j = jpegNow(82, false) ?: return Reply(204, "image/jpeg", ByteArray(0))
        return Reply(200, "image/jpeg", j)
    }

    private fun jpegNow(quality: Int, forceFreshEncode: Boolean): ByteArray? = synchronized(frameLock) {
        val data = nv21 ?: return null
        val w = frameW; val h = frameH
        if (w <= 0 || h <= 0 || data.size < w * h * 3 / 2) return null
        if (!forceFreshEncode && jpegSeq == frameSeq && jpeg != null) return jpeg
        val out = ByteArrayOutputStream(w * h / 4)
        YuvImage(data, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), quality, out)
        val encoded = out.toByteArray()
        if (!forceFreshEncode) { jpeg = encoded; jpegSeq = frameSeq }
        encoded
    }

    // ---------------------------------------------------------------- open / close

    private fun normalizePref(raw: String): String =
        if (raw == "max" || raw == "1080" || raw == "720" || raw == "480") raw else "auto"

    private fun open(rawPref: String): JSONObject = synchronized(opLock) {
        val pref = normalizePref(rawPref)
        val healthy = opened && !gone && !switching && helper?.isCameraOpened == true &&
            (lastFrameAt == 0L || System.currentTimeMillis() - lastFrameAt < STALL_MS)
        if (healthy && pref == activePref) return status()

        // Already open and streaming, operator just switched Preview size (e.g. 1080p -> 720p / 480p / Max):
        if (healthy && allSizes.isNotEmpty()) {
            activePref = pref
            opened = false
            lastError = ""
            val latch = CountDownLatch(1)
            openLatch = latch
            main.post {
                candidates = orderSizes(allSizes, pref)
                candIdx = 0
                tryNextSize()
            }
            latch.await(30, TimeUnit.SECONDS)
            if (opened) return status()
        }

        closeLocked()
        val d = webcams().firstOrNull() ?: throw IllegalStateException("No USB webcam found. Plug it in (USB-C OTG adapter or hub) and try again.")
        gone = false; lastError = ""; activePref = pref
        if (device?.deviceName != d.deviceName) failedStillKeys.clear()
        device = d
        busyRetries = 0
        allSizes = emptyList()
        candidates = emptyList()
        candIdx = 0
        size = null

        val latch = CountDownLatch(1)
        openLatch = latch
        main.post {
            try {
                val h = helper ?: CameraHelper().also { helper = it; it.setStateCallback(callback) }
                h.selectDevice(d)   // asks the USB permission when needed, then onDeviceOpen -> openCamera -> onCameraOpen
            } catch (e: Exception) { lastError = e.message ?: "open failed"; latch.countDown() }
        }
        // permission dialog + up to a few resolutions tried
        latch.await(90, TimeUnit.SECONDS)
        openLatch = null
        if (!opened) {
            val why = lastError.ifEmpty { "The webcam did not start. Unplug and replug it (use a powered hub if it keeps failing), then try again." }
            closeLocked()
            throw IllegalStateException(why)
        }
        return status()
    }

    fun close() = synchronized(opLock) { closeLocked() }

    private fun closeLocked() {
        opened = false
        switching = false
        targetStillSize = null
        val h = helper
        if (h != null) main.post {
            try { h.stopPreview() } catch (_: Exception) { }
            try { h.closeCamera() } catch (_: Exception) { }
        }
        synchronized(frameLock) { nv21 = null; jpeg = null; jpegSeq = -1; frameW = 0; frameH = 0 }
        lastFrameAt = 0
    }

    fun release() = synchronized(opLock) {
        closeLocked()
        val h = helper; helper = null
        if (h != null) main.post { try { h.release() } catch (_: Exception) { } }
    }

    // ---------------------------------------------------------------- capture full-res still

    private fun captureStill(query: String): ByteArray = synchronized(opLock) {
        if (gone) throw IllegalStateException("The webcam was unplugged or lost power.")
        if (!opened || helper == null) throw IllegalStateException("Webcam not open.")
        val cur = size
        val wantMax = query.contains("mode=max")
        if (!wantMax || cur == null || allSizes.isEmpty()) {
            return jpegNow(92, true) ?: throw IllegalStateException("No webcam picture ready yet.")
        }

        val bigModes = buildStillCandidates(allSizes, cur)
        if (bigModes.isEmpty()) {
            // Already streaming at the camera's highest usable resolution (e.g. C270 at 720p, or Brio at 4K)
            return jpegNow(92, true) ?: throw IllegalStateException("No webcam picture ready yet.")
        }

        val prev = cur
        switching = true
        var stillBytes: ByteArray? = null
        try {
            for (big in bigModes) {
                val key = sizeKey(big)
                val latch = CountDownLatch(1)
                stillLatch = latch
                targetStillSize = big
                modeFrameCount = 0
                if (!switchStreamBlocking(big)) {
                    failedStillKeys.add(key)
                    continue
                }
                latch.await(STILL_WAIT_MS, TimeUnit.MILLISECONDS)
                stillLatch = null
                if (frameW == big.width && frameH == big.height && modeFrameCount >= 1) {
                    stillBytes = jpegNow(92, true)
                    if (stillBytes != null) {
                        Log.i(TAG, "captured max still at ${big.width}x${big.height}@${big.fps}")
                        break
                    }
                }
                failedStillKeys.add(key)
            }
        } finally {
            stillLatch = null
            targetStillSize = null
            val rLatch = CountDownLatch(1)
            restoreLatch = rLatch
            modeFrameCount = 0
            if (switchStreamBlocking(prev)) {
                rLatch.await(2000L, TimeUnit.MILLISECONDS)
            }
            restoreLatch = null
            lastFrameAt = System.currentTimeMillis()
            opened = helper?.isCameraOpened == true && !gone
            switching = false
        }

        return stillBytes ?: jpegNow(92, true) ?: throw IllegalStateException("Could not read still frame from webcam.")
    }

    /** Switches the open camera to [target] (reopening mUVCCamera if a failed setPreviewSize closed it). */
    private fun switchStreamBlocking(target: Size): Boolean {
        val h = helper ?: return false
        size = target
        if (h.isCameraOpened) {
            val done = CountDownLatch(1)
            main.post {
                try {
                    h.stopPreview()
                    h.setPreviewSize(target)
                    h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                    h.startPreview()
                } catch (e: Exception) {
                    Log.w(TAG, "switchStream ${target.width}x${target.height} failed", e)
                } finally {
                    done.countDown()
                }
            }
            done.await(1500L, TimeUnit.MILLISECONDS)
            // CameraInternal.setPreviewSize destroys mUVCCamera asynchronously if USB bandwidth negotiation fails; give mAsyncHandler a beat
            try { Thread.sleep(160) } catch (_: InterruptedException) { }
            if (h.isCameraOpened) return true
        }
        // Reopen mUVCCamera directly with target size & platform quirks
        val cLatch = CountDownLatch(1)
        cameraOpenLatch = cLatch
        main.post {
            try {
                h.openCamera(UVCParam(target, UVCCamera.getRecommendedPlatformQuirks()))
            } catch (e: Exception) {
                cLatch.countDown()
            }
        }
        cLatch.await(3000L, TimeUnit.MILLISECONDS)
        cameraOpenLatch = null
        return h.isCameraOpened
    }

    // ---------------------------------------------------------------- resolution ordering

    private fun sizeKey(s: Size): String = "${s.type}:${s.width}x${s.height}@${s.fps}"

    private fun lowFpsVariant(s: Size): Size? {
        val list = s.fpsList ?: return null
        val low = list.filter { it in 5 until s.fps }.minOrNull() ?: return null
        return Size(s.type, s.width, s.height, low, list)
    }

    /** Candidates larger than [cur] for Max photo mode, preferring MJPEG and trying lower FPS on USB 2.0 ports. */
    private fun buildStillCandidates(all: List<Size>, cur: Size): List<Size> {
        val curPixels = cur.width * cur.height
        val bigger = all.distinctBy { "${it.type}:${it.width}x${it.height}" }
            .filter { it.width * it.height > curPixels }
            .sortedWith(compareByDescending<Size> { it.type == VS_FRAME_MJPEG }.thenByDescending { it.width * it.height })
        val out = ArrayList<Size>()
        for (s in bigger) {
            if (!failedStillKeys.contains(sizeKey(s))) out.add(s)
            val low = lowFpsVariant(s)
            if (low != null && !failedStillKeys.contains(sizeKey(low))) out.add(low)
            if (out.size >= 5) break
        }
        return out
    }

    /**
     * Orders preview candidates for [pref] (`auto` | `max` | `1080` | `720` | `480`):
     * - MJPEG modes come before uncompressed YUYV (YUYV above 720p rarely fits USB 2.0).
     * - Modes within the chosen cap come first (largest to smallest), with smaller modes as automatic fallback.
     */
    private fun orderSizes(all: List<Size>, pref: String): List<Size> {
        val uniq = all.distinctBy { "${it.type}:${it.width}x${it.height}" }
        val (maxW, maxH) = when (pref) {
            "480" -> 854 to 480
            "720" -> 1280 to 720
            "max" -> Int.MAX_VALUE to Int.MAX_VALUE
            else -> 1920 to 1080   // "auto" and "1080"
        }
        val mjpegOrSmallYuyv: (Size) -> Int = { s ->
            when {
                s.type == VS_FRAME_MJPEG -> 2
                s.width <= 1280 && s.height <= 720 -> 1
                else -> 0
            }
        }
        val withinCap = uniq.filter { it.width <= maxW && it.height <= maxH }
            .sortedWith(compareByDescending(mjpegOrSmallYuyv).thenByDescending { it.width * it.height })

        val expanded = ArrayList<Size>()
        for (s in withinCap) {
            expanded.add(s)
            // When operator asks for "max" (e.g. 4K on Brio), also try lower FPS before stepping down to 1080p
            if (pref == "max" && s.width > 1920) {
                val low = lowFpsVariant(s)
                if (low != null) expanded.add(low)
            }
        }
        // Fallback if camera has no mode at or below the cap (e.g. unusual capture card with only 1080p when 720p asked)
        val aboveCap = uniq.filter { it.width > maxW || it.height > maxH }
            .sortedWith(compareByDescending(mjpegOrSmallYuyv).thenBy { it.width * it.height })
        return expanded + aboveCap
    }

    private fun tryNextSize() {
        val h = helper ?: return
        if (gone || (openLatch?.count ?: 0L) == 0L) return
        if (candIdx >= candidates.size) {
            lastError = "The webcam opened but sent no picture at any size. Try a powered USB-C hub or another cable."
            openLatch?.countDown()
            return
        }
        val s = candidates[candIdx++]
        size = s
        modeFrameCount = 0
        Log.i(TAG, "trying preview ${s.width}x${s.height}@${s.fps} type=${s.type} (pref=$activePref)")
        try {
            if (h.isCameraOpened) {
                h.stopPreview()
                h.setPreviewSize(s)
                h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                h.startPreview()
                // If CameraInternal.setPreviewSize rejected this mode on mAsyncHandler, it destroys mUVCCamera; skip quickly
                main.postDelayed({
                    if (!opened && !switching && size === s && helper != null && !h.isCameraOpened && (openLatch?.count ?: 0L) > 0L) {
                        Log.i(TAG, "mode ${s.width}x${s.height} rejected by camera/bus, trying next")
                        tryNextSize()
                    }
                }, 400L)
                armFirstFrameTimeout(s)
            } else {
                h.openCamera(UVCParam(s, UVCCamera.getRecommendedPlatformQuirks()))
            }
        } catch (e: Exception) {
            Log.w(TAG, "size failed", e)
            main.post { tryNextSize() }
        }
    }

    private fun armFirstFrameTimeout(tried: Size) {
        main.postDelayed({
            if (!opened && !switching && size === tried && helper != null && (openLatch?.count ?: 0L) > 0L) {
                Log.i(TAG, "no frames at ${tried.width}x${tried.height}, trying next")
                try { helper?.stopPreview() } catch (_: Exception) { }
                main.postDelayed({ tryNextSize() }, 250L)
            }
        }, FIRST_FRAME_MS)
    }

    // ---------------------------------------------------------------- callbacks

    private val frameCallback = IFrameCallback { buf ->
        val s = size ?: return@IFrameCallback
        val n = buf.remaining()
        val need = s.width * s.height * 3 / 2
        if (n < need) return@IFrameCallback
        synchronized(frameLock) {
            var a = nv21
            if (a == null || a.size != need) { a = ByteArray(need); nv21 = a }
            buf.get(a, 0, need)
            frameW = s.width; frameH = s.height
            frameSeq++
        }
        lastFrameAt = System.currentTimeMillis()
        val c = ++modeFrameCount
        if (switching) {
            val want = targetStillSize
            if (want != null && s.width == want.width && s.height == want.height && c >= 2) {
                stillLatch?.countDown()
            } else if (want == null) {
                restoreLatch?.countDown()
            }
        } else if (!opened) {
            opened = true
            openLatch?.countDown()
        }
    }

    private val callback = object : ICameraHelper.StateCallback {
        override fun onAttach(device: UsbDevice?) { }

        override fun onDeviceOpen(device: UsbDevice?, isFirstOpen: Boolean) {
            try {
                helper?.openCamera(UVCParam(null, UVCCamera.getRecommendedPlatformQuirks()))
            } catch (e: Exception) {
                lastError = e.message ?: "Could not open USB webcam."
                openLatch?.countDown()
            }
        }

        override fun onCameraOpen(device: UsbDevice?) {
            val h = helper ?: return
            // Reopen during captureStill / switchStreamBlocking:
            val cLatch = cameraOpenLatch
            if (cLatch != null && cLatch.count > 0L) {
                try {
                    h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                    h.startPreview()
                } catch (e: Exception) { Log.w(TAG, "reopen startPreview", e) }
                cLatch.countDown()
                return
            }

            // Initial open: mUVCCamera now exists, so supportedSizeList is populated!
            if (allSizes.isEmpty()) {
                val raw = try { h.supportedSizeList ?: emptyList() } catch (_: Exception) { emptyList<Size>() }
                allSizes = raw
                val biggest = raw.maxByOrNull { it.width * it.height }
                maxLabel = if (biggest != null) "${biggest.width}\u00d7${biggest.height}" else ""
                candidates = orderSizes(raw, activePref)
                candIdx = 0
                Log.i(TAG, "webcam ${device?.productName}: ${raw.size} modes, max=$maxLabel")
                if (candidates.isEmpty()) {
                    val cur = try { h.previewSize } catch (_: Exception) { null }
                    if (cur != null) size = cur
                    try {
                        h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                        h.startPreview()
                    } catch (e: Exception) { Log.w(TAG, "default startPreview", e) }
                    if (cur != null) armFirstFrameTimeout(cur)
                } else {
                    tryNextSize()
                }
                return
            }

            // Reopen during tryNextSize after a rejected setPreviewSize destroyed mUVCCamera:
            val cur = size
            try {
                h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                h.startPreview()
            } catch (e: Exception) { Log.w(TAG, "retry startPreview", e) }
            if (cur != null) armFirstFrameTimeout(cur)
        }

        override fun onCameraClose(device: UsbDevice?) { }
        override fun onDeviceClose(device: UsbDevice?) { }

        override fun onDetach(device: UsbDevice?) {
            if (device != null && device.deviceName == this@UvcWebcam.device?.deviceName) {
                gone = true; opened = false; switching = false
                lastError = "The webcam was unplugged."
                openLatch?.countDown()
                cameraOpenLatch?.countDown()
                stillLatch?.countDown()
                restoreLatch?.countDown()
            }
        }

        override fun onCancel(device: UsbDevice?) {
            lastError = "The tablet needs your OK to use the webcam. Tap Try Again and choose OK when Android asks (tick \"Always\")."
            openLatch?.countDown()
        }

        override fun onError(device: UsbDevice?, e: CameraException?) {
            Log.w(TAG, "webcam error code=${e?.code} msg=${e?.message}")
            val cLatch = cameraOpenLatch
            if (cLatch != null && cLatch.count > 0L) {
                cLatch.countDown()
                return
            }
            if (e?.code == CameraException.CAMERA_OPEN_ERROR_BUSY && busyRetries < 3 && (openLatch?.count ?: 0L) > 0L) {
                busyRetries++
                main.postDelayed({
                    try { helper?.openCamera(UVCParam(size, UVCCamera.getRecommendedPlatformQuirks())) } catch (_: Exception) { }
                }, 500L)
                return
            }
            if (allSizes.isNotEmpty() && candIdx < candidates.size && (openLatch?.count ?: 0L) > 0L) {
                main.postDelayed({ tryNextSize() }, 250L)
                return
            }
            lastError = if (e?.code == CameraException.CAMERA_OPEN_ERROR_BUSY) {
                "The webcam is busy or stuck. Unplug and replug its USB cable, then tap Try Again."
            } else {
                "Could not start the USB webcam. Unplug and replug it (use a powered USB-C hub if needed), then tap Try Again."
            }
            openLatch?.countDown()
        }
    }
}
