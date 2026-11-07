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
        private const val FIRST_FRAME_MS = 3200L      // a mode that sends nothing in this time is skipped
        private const val WARMUP_FRAME_MS = 5500L     // the very first mode gets longer: the camera is still waking up
        private const val BAD_MODE_DAYS = 3L          // a mode that reset the webcam is skipped for this long
        private const val MAX_TRIES = 8               // modes tried in one open, so a failing webcam is reported in ~30 s, not 90
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

    private val prefs = ctx.getSharedPreferences("pb_uvc", Context.MODE_PRIVATE)
    @Volatile private var crashedDuringOpen = false   // the webcam dropped off USB while a mode was being started
    @Volatile private var modeStartedAt = 0L

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

    // ---------------------------------------------------------------- trace (shown in the booth's "Copy camera log")

    private val traceLines = ArrayDeque<String>()
    private val t0 = System.currentTimeMillis()
    private fun tr(msg: String) {
        Log.i(TAG, msg)
        synchronized(traceLines) {
            traceLines.addLast("+${(System.currentTimeMillis() - t0) / 1000.0}s $msg")
            while (traceLines.size > 60) traceLines.removeFirst()
        }
    }
    private fun traceJson(): JSONArray = JSONArray().also { a -> synchronized(traceLines) { traceLines.forEach { a.put(it) } } }

    // ---------------------------------------------------------------- modes that reset the webcam / modes that worked

    private fun devKey(): String = device?.let { "${it.vendorId}:${it.productId}" } ?: "none"

    private fun badEntries(): Map<String, Long> {
        val now = System.currentTimeMillis()
        val out = HashMap<String, Long>()
        for (e in prefs.getStringSet("bad:" + devKey(), emptySet()) ?: emptySet()) {
            val i = e.lastIndexOf('|')
            val at = if (i > 0) e.substring(i + 1).toLongOrNull() else null
            if (at != null && now - at < BAD_MODE_DAYS * 86_400_000L) out[e.substring(0, i)] = at
        }
        return out
    }

    /** Modes that made this webcam reset itself or send nothing (too much USB bandwidth / power for this tablet port or hub). */
    private fun badKeys(): Set<String> = badEntries().keys

    // Modes that failed during the current open() call only (so "Max" and a forced size are never skipped on a later try).
    private val sessionBad = HashSet<String>()
    private fun sessionBadKeys(): Set<String> = synchronized(sessionBad) { HashSet(sessionBad) }

    private fun markBad(s: Size, why: String) {
        if (activePref.startsWith("x:")) { tr("keeping forced size ${describe(s)} ($why)"); return }
        synchronized(sessionBad) { sessionBad.add(sizeKey(s)) }
        if (activePref == "max") { tr("skipping ${describe(s)} for this try only ($why)"); return }
        val m = HashMap(badEntries())
        m[sizeKey(s)] = System.currentTimeMillis()
        prefs.edit().putStringSet("bad:" + devKey(), m.map { "${it.key}|${it.value}" }.toSet()).apply()
        tr("will skip ${describe(s)} from now on ($why)")
    }

    private fun clearBad() { prefs.edit().remove("bad:" + devKey()).apply() }

    private fun markGood(s: Size) {
        prefs.edit().putString("good:" + devKey() + ":" + activePref, "${s.type}:${s.width}:${s.height}:${s.fps}").apply()
    }

    /** The mode that gave a picture last time on this webcam goes first, so a good setup opens at once. */
    private fun lastGoodFirst(list: List<Size>, raw: List<Size>): List<Size> {
        if (activePref == "max" || activePref.startsWith("x:")) return list
        val g =prefs.getString("good:" + devKey() + ":" + activePref, null)?.split(':') ?: return list
        if (g.size != 4) return list
        val type = g[0].toIntOrNull(); val w = g[1].toIntOrNull(); val h = g[2].toIntOrNull(); val fps = g[3].toIntOrNull()
        if (type == null || w == null || h == null || fps == null) return list
        val base = raw.firstOrNull { it.type == type && it.width == w && it.height == h } ?: return list
        val good = if (base.fps == fps) base else Size(base.type, w, h, fps, base.fpsList)
        if (badKeys().contains(sizeKey(good))) return list
        return listOf(good) + list.filter { sizeKey(it) != sizeKey(good) }.take(MAX_TRIES - 1)
    }

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
        tr("call $path failed: ${e.message}")
        Reply(409, "application/json", JSONObject().put("ok", false).put("code", "ERROR")
            .put("error", e.message ?: e.javaClass.simpleName).put("trace", traceJson()).toString().toByteArray())
    }

    private fun parseParam(query: String, key: String): String {
        if (query.isEmpty()) return ""
        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            if (eq > 0 && part.substring(0, eq) == key) return try { java.net.URLDecoder.decode(part.substring(eq + 1), "UTF-8").lowercase() } catch (_: Exception) { part.substring(eq + 1).lowercase() }
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
        // Every USB device the tablet sees (vendor / product id, interface classes), so a camera that is not recognised as a
        // webcam can be looked at afterwards in the camera log. 14 = USB Video class (a normal webcam).
        val all = JSONArray()
        try {
            for (d in usb.deviceList.values) {
                val classes = JSONArray()
                for (i in 0 until d.interfaceCount) classes.put(d.getInterface(i).interfaceClass)
                val nm = try { d.productName ?: "" } catch (_: Exception) { "" }
                all.put(JSONObject().put("vid", d.vendorId).put("pid", d.productId).put("devClass", d.deviceClass)
                    .put("ifaces", classes).put("name", nm).put("perm", usb.hasPermission(d)))
            }
        } catch (_: Exception) { }
        return JSONObject().put("devices", arr).put("usb", all).put("native", native).put("open", opened)
            .put("size", if ((opened || switching) && s != null) "${s.width}x${s.height}" else "")
            .put("max", maxLabel)
            .put("preview", activePref)
            .put("note", lastError)
            .put("trace", traceJson())
            .put("modes", if (allSizes.isNotEmpty()) modesFrom(allSizes) else cachedModes())
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

    /** `auto` | `max` | `1080` | `720` | `480`, or `x:<type>:<w>:<h>:<fps>` = one exact size picked by the operator (forced, no fallback). */
    private fun normalizePref(raw: String): String =
        if (raw == "max" || raw == "1080" || raw == "720" || raw == "480" || Regex("x:\\d+:\\d+:\\d+:\\d+").matches(raw)) raw else "auto"

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

        synchronized(sessionBad) { sessionBad.clear() }
        for (attempt in 1..4) {
            crashedDuringOpen = false
            try {
                return openFresh(pref)
            } catch (e: IllegalStateException) {
                if (!crashedDuringOpen) throw e
                // The webcam dropped off USB while a mode was starting (not enough power / bandwidth). It comes back by itself in a
                // moment: wait for it, then carry on with the next mode (the one that reset it is now skipped).
                tr("webcam reset while starting (attempt $attempt); waiting for it to come back")
                if (!waitForWebcam(15000L)) break
                try { Thread.sleep(900) } catch (_: InterruptedException) { }
            }
        }
        throw IllegalStateException("The webcam keeps resetting itself while starting. Plug it into a powered USB hub (the tablet port cannot power it at this size), then tap Try Again.")
    }

    private fun waitForWebcam(ms: Long): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (webcams().isNotEmpty()) return true
            try { Thread.sleep(300) } catch (_: InterruptedException) { return false }
        }
        return false
    }

    private fun openFresh(pref: String): JSONObject {
        closeLocked()
        val d = webcams().firstOrNull() ?: throw IllegalStateException("No USB webcam found. Plug it in (USB-C OTG adapter or hub) and try again.")
        gone = false; lastError = ""; activePref = pref
        if (device?.deviceName != d.deviceName) failedStillKeys.clear()
        device = d
        tr("open: ${d.productName} ${Integer.toHexString(d.vendorId)}:${Integer.toHexString(d.productId)} permission=${usb.hasPermission(d)} preview=$pref hw=${android.os.Build.HARDWARE} sdk=${android.os.Build.VERSION.SDK_INT}")
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
        if (pref.startsWith("x:")) {   // forced: exactly this size, nothing else is tried
            val g = pref.split(':')
            val type = g.getOrNull(1)?.toIntOrNull(); val w = g.getOrNull(2)?.toIntOrNull()
            val h = g.getOrNull(3)?.toIntOrNull(); val fps = g.getOrNull(4)?.toIntOrNull()
            if (type != null && w != null && h != null && fps != null) {
                val base = all.firstOrNull { it.type == type && it.width == w && it.height == h }
                if (base != null) return listOf(if (base.fps == fps) base else Size(type, w, h, fps, base.fpsList))
            }
            tr("forced size $pref is not offered by this webcam; using Auto instead")
            return orderSizes(all, "auto")
        }
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
        // Standard sizes (720p, 480p...) before the odd ones some webcams list (1184x656, 752x416...), unless "Max" was asked for.
        val common = setOf("1920x1080", "1280x720", "1024x576", "960x540", "848x480", "800x600", "640x480", "640x360", "320x240")
        val isCommon: (Size) -> Int = { if (pref != "max" && common.contains("${it.width}x${it.height}")) 1 else 0 }
        val withinCap = uniq.filter { it.width <= maxW && it.height <= maxH }
            .sortedWith(compareByDescending(mjpegOrSmallYuyv).thenByDescending(isCommon).thenByDescending { it.width * it.height })

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
        return thinCandidates(expanded + aboveCap, pref)
    }

    /** Every size this webcam offers, for the booth's "Exact size" menu (MJPEG, plus small uncompressed ones; two frame rates each). */
    private fun modesFrom(raw: List<Size>): JSONArray {
        val a = JSONArray()
        val seen = HashSet<String>()
        val list = raw.filter { it.type == VS_FRAME_MJPEG || (it.width <= 1280 && it.height <= 720) }.ifEmpty { raw }
            .sortedWith(compareByDescending<Size> { it.width * it.height }.thenByDescending { it.type == VS_FRAME_MJPEG })
        for (s in list) {
            for (v in listOfNotNull(s, previewLowFps(s))) {
                val value = "x:${v.type}:${v.width}:${v.height}:${v.fps}"
                if (!seen.add(value)) continue
                a.put(JSONObject().put("v", value)
                    .put("label", "${v.width}×${v.height} ${if (v.type == VS_FRAME_MJPEG) "MJPEG" else "YUYV"} @${v.fps} fps"))
            }
        }
        return a
    }

    private fun cachedModes(): JSONArray = try {
        val d = webcams().firstOrNull()
        if (d == null) JSONArray() else JSONArray(prefs.getString("modes:${d.vendorId}:${d.productId}", "[]"))
    } catch (_: Exception) { JSONArray() }

    /** A lower frame rate of the same mode (>= 10 fps): asks the camera for less USB bandwidth, which weak tablet ports need. */
    private fun previewLowFps(s: Size): Size? {
        val list = s.fpsList ?: return null
        val low = list.filter { it in 10 until s.fps }.maxOrNull() ?: return null
        return Size(s.type, s.width, s.height, low, list)
    }

    /**
     * A webcam can list 20+ modes. Trying each one for several seconds took longer than the booth waits (the picture stayed
     * black, then the app gave up and closed the camera). Keep one mode per clearly different size, add a lower frame rate
     * for the first two sizes (weak USB ports), and never try more than [MAX_TRIES] in all.
     */
    private fun thinCandidates(list: List<Size>, pref: String): List<Size> {
        // Modes that reset this webcam (or sent nothing) before are not tried again; "Max" only skips what failed in this try.
        val bad = if (pref == "max") sessionBadKeys() else badKeys() + sessionBadKeys()
        val out = ArrayList<Size>()
        var lastArea = 0L
        var tiers = 0
        fun add(s: Size) { if (!bad.contains(sizeKey(s)) && out.none { sizeKey(it) == sizeKey(s) }) out.add(s) }
        for (s in list) {
            val area = s.width.toLong() * s.height
            if (tiers > 0 && lastArea == area) { add(s); continue }   // the "max" low-fps variant that orderSizes put right after its mode
            val far = tiers == 0 || area * 3 <= lastArea * 2 || area * 2 >= lastArea * 3
            if (!far) continue
            add(s); lastArea = area; tiers++
            if (pref != "max" && tiers <= 2) previewLowFps(s)?.let { add(it) }
            if (out.size >= MAX_TRIES) break
        }
        if (out.isEmpty()) { clearBad(); return list.take(MAX_TRIES) }   // everything was marked bad: forget that and start over
        return out.take(MAX_TRIES)
    }

    private fun describe(s: Size) = "${s.width}x${s.height}@${s.fps}${if (s.type == VS_FRAME_MJPEG) " mjpeg" else " yuyv"}"

    private fun tryNextSize() {
        val h = helper ?: return
        if (gone || (openLatch?.count ?: 0L) == 0L) return
        if (candIdx >= candidates.size) {
            lastError = "The webcam turned on but sent no picture at any size. Use a powered USB-C hub (the tablet port may not give it enough power), a short data cable, then tap Try Again."
            tr("gave up: no picture in any of ${candidates.size} modes")
            openLatch?.countDown()
            return
        }
        val s = candidates[candIdx++]
        size = s
        modeFrameCount = 0
        modeStartedAt = System.currentTimeMillis()
        tr("try${candIdx}/${candidates.size}: ${describe(s)} (pref=$activePref)")
        try {
            if (h.isCameraOpened) {
                h.stopPreview()
                h.setPreviewSize(s)
                h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                h.startPreview()
                // If CameraInternal.setPreviewSize rejected this mode on mAsyncHandler, it destroys mUVCCamera; skip quickly
                main.postDelayed({
                    if (!opened && !switching && size === s && helper != null && !h.isCameraOpened && (openLatch?.count ?: 0L) > 0L) {
                        tr("mode ${describe(s)} rejected by camera/bus, trying next")
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
                tr("no frames at ${describe(tried)} (frames seen: $modeFrameCount), trying next")
                if (candIdx > 1 && modeFrameCount == 0) markBad(tried, "no picture")
                try { helper?.stopPreview() } catch (_: Exception) { }
                main.postDelayed({ tryNextSize() }, 250L)
            }
        }, if (candIdx <= 1) WARMUP_FRAME_MS else FIRST_FRAME_MS)
    }

    // ---------------------------------------------------------------- callbacks

    private val frameCallback = IFrameCallback { buf ->
        val s = size ?: return@IFrameCallback
        val n = buf.remaining()
        val need = s.width * s.height * 3 / 2
        if (n < need) {
            if (modeFrameCount == 0) tr("frame too small: got $n bytes, need $need for ${s.width}x${s.height}")
            modeFrameCount++
            return@IFrameCallback
        }
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
            tr("first picture at ${s.width}x${s.height}")
            markGood(s)
            openLatch?.countDown()
        }
    }

    private val callback = object : ICameraHelper.StateCallback {
        override fun onAttach(device: UsbDevice?) { }

        override fun onDeviceOpen(device: UsbDevice?, isFirstOpen: Boolean) {
            tr("USB device opened (first=$isFirstOpen)")
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
                try { prefs.edit().putString("modes:" + devKey(), modesFrom(raw).toString()).apply() } catch (_: Exception) { }
                val biggest = raw.maxByOrNull { it.width * it.height }
                maxLabel = if (biggest != null) "${biggest.width}\u00d7${biggest.height}" else ""
                candidates = lastGoodFirst(orderSizes(raw, activePref), raw)
                candIdx = 0
                tr("camera opened: ${raw.size} modes, max=$maxLabel; will try " + candidates.joinToString(", ") { describe(it) })
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
                val starting = (openLatch?.count ?: 0L) > 0L && !opened
                val tried = size
                val soon = System.currentTimeMillis() - modeStartedAt < 8000L    // it dropped off right after this mode was started
                gone = true; opened = false; switching = false
                tr("webcam detached (unplugged or lost power)")
                if (tried != null && soon) {
                    if (starting) crashedDuringOpen = true
                    markBad(tried, "the webcam reset itself")
                }
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
            tr("webcam error code=${e?.code} msg=${e?.message}")
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
