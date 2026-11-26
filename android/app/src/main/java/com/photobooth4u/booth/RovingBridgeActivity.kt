package com.photobooth4u.booth

import android.annotation.SuppressLint
import android.Manifest
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.ExifInterface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.util.Log
import android.util.LruCache
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Dedicated Roving DSLR Bridge:
 * Connects to a wired DSLR (Canon, Nikon, Sony) via USB, listens for physical shutter clicks,
 * and streams captured JPEGs in real time over Wi-Fi to the laptop's desktop booth app.
 * Any photo shot while disconnected is queued to disk and auto-uploaded when Wi-Fi reconnects.
 */
class RovingBridgeActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "RovingBridge"
        private const val PREFS = "photobooth_roving"
        private const val KEY_URL = "target_laptop_url"
        private const val KEY_VIBRATE = "vibrate_on_send"
        private const val KEY_PICK_TO_SEND = "pick_to_send_mode"
        private const val KEY_BRIGHTNESS = "brightness_adjust"
        private const val KEY_SAVE_TO_CARD = "save_to_card_backup"
        private const val BRIGHTNESS_MIN = -30
        private const val BRIGHTNESS_MAX = 40
        private const val BRIGHTNESS_RANGE = BRIGHTNESS_MAX - BRIGHTNESS_MIN
        private const val RETRY_DELAY_MS = 1800L
        private const val WAKE_LOCK_TIMEOUT_MS = 2L * 60L * 60L * 1000L
        private const val UPLOAD_OK = 0
        private const val UPLOAD_RETRY = 1
        private const val UPLOAD_TOO_BIG = 2
        private val IPV4_RE = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
    }

    /** Lightweight metadata for session photos history */
    data class SessionPhoto(
        @Volatile var thumbFile: File,
        val timeStr: String,
        @Volatile var success: Boolean,
        val sizeBytes: Long,
        @Volatile var pendingFile: File? = null,
        @Volatile var stagedFile: File? = null,
        @Volatile var brightness: Int = 0,
        @Volatile var orient: String = "",
        @Volatile var promoting: Boolean = false
    ) {
        fun isStaged(): Boolean = !success && stagedFile?.exists() == true
        fun isQueued(): Boolean = !success && (promoting || pendingFile?.exists() == true)
    }

    private val isRunning = AtomicBoolean(false)
    private var workerThread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ingestExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val uploadExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val retryScheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var pendingRetryFuture: ScheduledFuture<*>? = null
    @Volatile private var nextRetryAtMs: Long = 0L
    private val drainQueued = AtomicBoolean(false)
    private val isDraining = AtomicBoolean(false)
    private val pendingSeq = AtomicInteger(0)
    private val restoreLatch = CountDownLatch(1)
    private var connectivityManager: ConnectivityManager? = null
    private val trackedLanNetworks: MutableSet<Network> =
        Collections.newSetFromMap(ConcurrentHashMap<Network, Boolean>())
    private val lanNetworkCallbacks = ArrayList<ConnectivityManager.NetworkCallback>()
    @Volatile private var activeUploadConn: HttpURLConnection? = null
    @Volatile private var activeUploadNetwork: Network? = null
    private val wakeLockSync = Any()
    private var wakeLock: PowerManager.WakeLock? = null
    private val retryRunnable = Runnable { kickRetryQueue(0L) }
    private var localCameraHelper: UsbCameraHelper? = null

    private var targetUrl: String = ""
    private var vibrateOnSend: Boolean = true
    @Volatile private var pickToSendMode: Boolean = false
    @Volatile private var defaultBrightness: Int = 0
    @Volatile private var saveToCardEnabled: Boolean = true
    private var sentPhotosCount: Int = 0

    // UI elements
    private lateinit var rootLayout: FrameLayout
    private lateinit var statusPill: TextView
    private lateinit var cameraTitle: TextView
    private lateinit var cameraSub: TextView
    private lateinit var laptopInput: EditText
    private lateinit var connectionStatusText: TextView
    private lateinit var modeAutoBtn: Button
    private lateinit var modePickBtn: Button
    private lateinit var modeHintText: TextView
    private lateinit var mainBrightnessLabel: TextView
    private lateinit var mainBrightnessSeek: SeekBar
    private lateinit var saveToCardSwitch: Switch
    private lateinit var statsCountText: TextView
    private lateinit var lastSentText: TextView
    private lateinit var thumbnailView: ImageView
    private lateinit var stagedBanner: LinearLayout
    private lateinit var stagedBannerText: TextView
    private lateinit var pendingBanner: LinearLayout
    private lateinit var pendingBannerText: TextView
    private lateinit var triggerButton: Button
    private lateinit var galleryOpenBtn: Button
    private lateinit var pocketLockOverlay: FrameLayout
    private lateinit var pocketSubText: TextView
    private lateinit var pocketStatsText: TextView

    // Session Gallery & Preview Overlays
    private lateinit var galleryOverlay: FrameLayout
    private lateinit var galleryGrid: GridView
    private lateinit var galleryEmptyText: TextView
    private lateinit var galleryTitleText: TextView
    private lateinit var gallerySubHint: TextView
    private lateinit var galleryRetryBtn: Button
    private lateinit var galleryFilterAllBtn: Button
    private lateinit var galleryFilterPickBtn: Button
    private lateinit var galleryFilterSentBtn: Button
    private lateinit var gallerySelectBtn: Button
    private lateinit var galleryBatchBar: LinearLayout
    private lateinit var galleryBatchSendBtn: Button
    private lateinit var galleryBatchDiscardBtn: Button
    private lateinit var photoPreviewOverlay: FrameLayout
    private lateinit var previewNavRow: LinearLayout
    private lateinit var previewPrevBtn: Button
    private lateinit var previewNextBtn: Button
    private lateinit var previewPosText: TextView
    private lateinit var previewBrightnessRow: LinearLayout
    private lateinit var previewBrightnessLabel: TextView
    private lateinit var previewBrightnessSeek: SeekBar
    private lateinit var previewSendStagedBtn: Button
    private lateinit var previewDiscardBtn: Button
    private lateinit var previewRetryBtn: Button
    private lateinit var previewQueueBtn: Button
    private var previewingPhoto: SessionPhoto? = null
    private var previewSyncingSlider: Boolean = false
    private var galleryAdapter: GalleryGridAdapter? = null
    private var galleryFilter: String = "all"
    private var gallerySelectMode: Boolean = false
    private val selectedStagedPaths = LinkedHashSet<String>()

    // Updates & Changelog Overlay
    private lateinit var updatesOverlay: FrameLayout
    private lateinit var updatesStatusText: TextView
    private lateinit var updatesDownloadBtn: Button

    private val sessionPhotos = mutableListOf<SessionPhoto>()
    private var lastPhotoBitmap: Bitmap? = null
    private val thumbCache = object : LruCache<String, Bitmap>(12 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = maxOf(1, value.byteCount / 1024)
    }
    @Volatile private var consecutiveUploadFails: Int = 0
    private var lastUiConnected: Boolean? = null
    private var lastUiName: String? = null
    private var lastUiBattery: Int = Int.MIN_VALUE
    private var lastUiSdHint: String? = null
    private var lastUiPillConnected: Boolean? = null
    private var lastWorkerBatteryAt: Long = 0L
    private var cachedWorkerBattery: Int = -1

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents?.trim()
        if (!raw.isNullOrEmpty()) {
            targetUrl = cleanUrl(raw)
            laptopInput.setText(targetUrl)
            savePrefs()
            testConnection()
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            launchQrScanner()
        } else {
            Toast.makeText(this, "Camera permission needed to scan the QR code", Toast.LENGTH_LONG).show()
        }
    }

    private fun startQrScanner() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchQrScanner()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchQrScanner() {
        val options = ScanOptions().apply {
            setPrompt("Point camera at Photographer Desk QR on your laptop")
            setBeepEnabled(true)
            setOrientationLocked(false)
            setBarcodeImageEnabled(false)
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        }
        qrScanLauncher.launch(options)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        cleanOldThumbnails()
        loadPrefs()
        buildUi()
        restorePendingQueue()
        registerNetworkMonitor()
    }

    override fun onResume() {
        super.onResume()
        startWorker()
        if (pendingCount() > 0) {
            kickRetryQueue(250L)
        }
    }

    override fun onPause() {
        super.onPause()
        // Keep USB shutter polling alive in Pocket Lock; keep queue auto-retry alive whenever photos are queued
        val pocketOn = ::pocketLockOverlay.isInitialized && pocketLockOverlay.visibility == View.VISIBLE
        if (!pocketOn) {
            stopWorker()
            if (pendingCount() == 0) {
                mainHandler.removeCallbacks(retryRunnable)
            }
        }
        syncWakeLock()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (::updatesOverlay.isInitialized && updatesOverlay.visibility == View.VISIBLE) {
            hideUpdatesOverlay()
            return
        }
        if (::photoPreviewOverlay.isInitialized && photoPreviewOverlay.visibility == View.VISIBLE) {
            previewingPhoto = null
            photoPreviewOverlay.visibility = View.GONE
            return
        }
        if (::galleryOverlay.isInitialized && galleryOverlay.visibility == View.VISIBLE) {
            hideGalleryOverlay()
            return
        }
        if (::pocketLockOverlay.isInitialized && pocketLockOverlay.visibility == View.VISIBLE) {
            return
        }
        super.onBackPressed()
    }

    override fun onDestroy() {
        stopWorker()
        mainHandler.removeCallbacks(retryRunnable)
        unregisterNetworkMonitor()
        releaseWakeLock()
        try { activeUploadConn?.disconnect() } catch (_: Exception) { }
        activeUploadConn = null
        activeUploadNetwork = null
        try { ingestExecutor.shutdownNow() } catch (_: Exception) { }
        try { uploadExecutor.shutdownNow() } catch (_: Exception) { }
        try { pendingRetryFuture?.cancel(true) } catch (_: Exception) { }
        try { retryScheduler.shutdownNow() } catch (_: Exception) { }
        try {
            localCameraHelper?.stop()
            localCameraHelper = null
        } catch (_: Exception) { }
        lastPhotoBitmap = null
        thumbCache.evictAll()
        super.onDestroy()
    }

    private fun getCameraHelper(): UsbCameraHelper {
        var cam = UsbCameraHelper.activeInstance
        if (cam == null) {
            if (localCameraHelper == null) {
                localCameraHelper = UsbCameraHelper(applicationContext).also { it.start() }
            }
            cam = localCameraHelper
        }
        return cam!!
    }

    private fun loadPrefs() {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        targetUrl = p.getString(KEY_URL, "") ?: ""
        vibrateOnSend = p.getBoolean(KEY_VIBRATE, true)
        pickToSendMode = p.getBoolean(KEY_PICK_TO_SEND, false)
        defaultBrightness = p.getInt(KEY_BRIGHTNESS, 0).coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        saveToCardEnabled = p.getBoolean(KEY_SAVE_TO_CARD, true)
    }

    private fun savePrefs() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, targetUrl.trim())
            .putBoolean(KEY_VIBRATE, vibrateOnSend)
            .putBoolean(KEY_PICK_TO_SEND, pickToSendMode)
            .putInt(KEY_BRIGHTNESS, defaultBrightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX))
            .putBoolean(KEY_SAVE_TO_CARD, saveToCardEnabled)
            .apply()
    }

    private fun formatBrightness(b: Int): String = when {
        b > 0 -> "+$b%"
        b < 0 -> "$b%"
        else -> "0% (Original)"
    }

    private fun brightnessColorFilter(brightness: Int): ColorMatrixColorFilter? {
        val b = brightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        if (b == 0) return null
        val gain = 1f + (b / 100f) * 1.15f
        val offset = b * 0.45f
        return ColorMatrixColorFilter(ColorMatrix(floatArrayOf(
            gain, 0f, 0f, 0f, offset,
            0f, gain, 0f, 0f, offset,
            0f, 0f, gain, 0f, offset,
            0f, 0f, 0f, 1f, 0f
        )))
    }

    private fun readExifOrientation(bytes: ByteArray): Int {
        return try {
            ExifInterface(ByteArrayInputStream(bytes))
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    private fun readExifOrientation(file: File): Int {
        return try {
            ExifInterface(file.absolutePath)
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    private fun applyExifRotation(bmp: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
            else -> return bmp
        }
        return try {
            Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true).also {
                if (it != bmp) bmp.recycle()
            }
        } catch (_: OutOfMemoryError) {
            bmp
        }
    }

    private fun classifyOrient(w: Int, h: Int): String {
        if (w <= 0 || h <= 0) return ""
        val ratio = w.toFloat() / h.toFloat()
        return when {
            ratio >= 1.08f -> "landscape"
            ratio <= 0.92f -> "portrait"
            else -> "square"
        }
    }

    private fun computeSafeSampleSize(w: Int, h: Int, maxDim: Int = 3600): Int {
        var sample = 1
        val longest = maxOf(w, h)
        while (longest / sample > maxDim) sample *= 2
        return sample
    }

    private fun readExifFromBytes(bytes: ByteArray): ExifInterface? = try {
        ExifInterface(ByteArrayInputStream(bytes))
    } catch (_: Exception) {
        null
    }

    private fun readExifFromFile(file: File): ExifInterface? = try {
        ExifInterface(file.absolutePath)
    } catch (_: Exception) {
        null
    }

    private fun buildExposureLut(brightness: Int): IntArray {
        val g = Math.pow(2.0, (brightness / 30.0) * 0.9)
        val lut = IntArray(256)
        for (i in 0..255) {
            val t = i / 255.0
            val v = ((t * g) / (1.0 + t * (g - 1.0)) * 255.0 + 0.5).toInt()
            lut[i] = v.coerceIn(0, 255)
        }
        return lut
    }

    private fun copyShootingExif(src: ExifInterface?, destFile: File) {
        if (src == null) return
        try {
            val outExif = ExifInterface(destFile.absolutePath)
            val tags = arrayOf(
                ExifInterface.TAG_MAKE,
                ExifInterface.TAG_MODEL,
                ExifInterface.TAG_EXPOSURE_TIME,
                ExifInterface.TAG_F_NUMBER,
                ExifInterface.TAG_ISO_SPEED_RATINGS,
                ExifInterface.TAG_FLASH
            )
            for (tag in tags) {
                val v = src.getAttribute(tag)
                if (!v.isNullOrEmpty()) outExif.setAttribute(tag, v)
            }
            outExif.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
            outExif.saveAttributes()
        } catch (_: Throwable) { }
    }

    private fun writeAdjustedJpegFile(raw: Bitmap, srcExif: ExifInterface?, orient: Int, brightness: Int, destFile: File): Boolean {
        val upright = applyExifRotation(raw, orient)
        val w = upright.width
        val h = upright.height
        val mutable = if (upright.isMutable && upright.config == Bitmap.Config.ARGB_8888) upright
        else upright.copy(Bitmap.Config.ARGB_8888, true).also { if (it != upright) upright.recycle() }
        val lut = buildExposureLut(brightness)
        val pixels = IntArray(w * h)
        mutable.getPixels(pixels, 0, w, 0, 0, w, h)
        for (i in pixels.indices) {
            val p = pixels[i]
            val r = lut[(p ushr 16) and 0xFF]
            val g = lut[(p ushr 8) and 0xFF]
            val b = lut[p and 0xFF]
            pixels[i] = (p and -0x1000000) or (r shl 16) or (g shl 8) or b
        }
        mutable.setPixels(pixels, 0, w, 0, 0, w, h)
        destFile.outputStream().use { out ->
            mutable.compress(Bitmap.CompressFormat.JPEG, 95, out)
            out.flush()
        }
        mutable.recycle()
        copyShootingExif(srcExif, destFile)
        return destFile.exists() && destFile.length() > 0L
    }

    /**
     * Bakes non-clipping exposure adjustment (+EXIF upright rotation & shooting EXIF) into a JPEG.
     * When brightness == 0, returns the original camera bytes untouched (zero re-encoding).
     */
    private fun applyBrightnessToJpegBytes(bytes: ByteArray, brightness: Int): ByteArray {
        val b = brightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        if (b == 0) return bytes
        var tmpFile: File? = null
        return try {
            val srcExif = readExifFromBytes(bytes)
            val orient = srcExif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) ?: ExifInterface.ORIENTATION_NORMAL
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val opts = BitmapFactory.Options().apply {
                inSampleSize = computeSafeSampleSize(bounds.outWidth, bounds.outHeight, 3600)
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return bytes
            tmpFile = File.createTempFile("rove_adj_", ".jpg", cacheDir)
            if (writeAdjustedJpegFile(raw, srcExif, orient, b, tmpFile)) {
                val out = tmpFile.readBytes()
                if (out.isNotEmpty()) out else bytes
            } else bytes
        } catch (e: Throwable) {
            Log.w(TAG, "Brightness adjust failed, using original JPEG: ${e.message}")
            bytes
        } finally {
            try { tmpFile?.delete() } catch (_: Exception) { }
        }
    }

    /**
     * Writes srcFile into destFile, baking exposure when != 0 or moving/copying raw bytes untouched when == 0.
     */
    private fun promoteStagedToPendingFile(srcFile: File, destFile: File, brightness: Int): Boolean {
        val b = brightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        val tmp = File(destFile.parentFile, "${destFile.name}.tmp")
        return try {
            if (b == 0) {
                if (srcFile.renameTo(destFile)) {
                    true
                } else {
                    srcFile.copyTo(tmp, overwrite = true)
                    val ok = tmp.renameTo(destFile) || run {
                        tmp.copyTo(destFile, overwrite = true)
                        tmp.delete()
                        true
                    }
                    if (ok) try { srcFile.delete() } catch (_: Exception) { }
                    ok
                }
            } else {
                val srcExif = readExifFromFile(srcFile)
                val orient = srcExif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) ?: ExifInterface.ORIENTATION_NORMAL
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(srcFile.absolutePath, bounds)
                val opts = BitmapFactory.Options().apply {
                    inSampleSize = computeSafeSampleSize(bounds.outWidth, bounds.outHeight, 3600)
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                val raw = BitmapFactory.decodeFile(srcFile.absolutePath, opts)
                if (raw == null) {
                    // Fallback to untouched copy if decode failed
                    srcFile.copyTo(destFile, overwrite = true)
                    try { srcFile.delete() } catch (_: Exception) { }
                    true
                } else {
                    writeAdjustedJpegFile(raw, srcExif, orient, b, tmp)
                    val moved = tmp.renameTo(destFile) || run {
                        tmp.copyTo(destFile, overwrite = true)
                        tmp.delete()
                        true
                    }
                    if (moved) try { srcFile.delete() } catch (_: Exception) { }
                    moved
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to promote staged photo: ${e.message}")
            try { tmp.delete() } catch (_: Exception) { }
            false
        }
    }

    private fun cleanUrl(raw: String): String {
        var u = raw.trim()
            .replace(Regex("/+(?:photos|photo)/?$"), "")
            .replace(Regex("/+$"), "")
        if (u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) {
            u = "http://$u"
        }
        return u
    }

    // ================================================================ UI BUILDER

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun makeCard(bg: Int = Color.WHITE, rad: Float = 16f): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(rad.toInt()).toFloat()
            setColor(bg)
        }
    }

    private fun buildUi() {
        rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F5F1EA"))
        }

        val scroll = ScrollView(this).apply {
            isFillViewport = true
        }

        val contentW = minOf(resources.displayMetrics.widthPixels, dp(720))
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(contentW, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL)
        }

        // --- Top Bar ---
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        val title = TextView(this).apply {
            text = "📷 Roving DSLR Bridge"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        titleCol.addView(title)

        val versionStr = try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            "v" + (pInfo.versionName ?: "1.1.5")
        } catch (_: Exception) {
            "v1.1.5"
        }

        val sub = TextView(this).apply {
            text = "$versionStr • Wired DSLR ➔ Wireless Streamer"
            textSize = 12f
            setTextColor(Color.parseColor("#8E8884"))
            isClickable = true
            isFocusable = true
            setOnClickListener { showUpdatesOverlay() }
        }
        titleCol.addView(sub)
        topBar.addView(titleCol)

        val queueBtn = Button(this).apply {
            text = "🖥️ Queue"
            textSize = 12f
            setTextColor(Color.parseColor("#1D6FA5"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#EAF3FA"), 16f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { openLaptopQueue() }
        }
        topBar.addView(queueBtn)

        val guideBtn = Button(this).apply {
            text = "📖 Guide"
            textSize = 12f
            setTextColor(Color.parseColor("#C93D27"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#FCE8E6"), 16f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38))
            lp.rightMargin = dp(8)
            layoutParams = lp
            setOnClickListener {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://photobooth4u.netlify.app/photobooth4u-roving-dslr-guide.pdf"))
                    startActivity(intent)
                } catch (e: Exception) {
                    Toast.makeText(this@RovingBridgeActivity, "Could not open guide: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
        topBar.addView(guideBtn)

        val updatesTopBtn = Button(this).apply {
            text = "✨"
            textSize = 14f
            background = makeCard(Color.parseColor("#FEF5E7"), 16f)
            val lp = LinearLayout.LayoutParams(dp(38), dp(38)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { showUpdatesOverlay() }
        }
        topBar.addView(updatesTopBtn)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.parseColor("#6B666C"))
            background = makeCard(Color.parseColor("#E4DCCF"), 20f)
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
            setOnClickListener { finish() }
        }
        topBar.addView(closeBtn)
        content.addView(topBar)

        // --- Camera Status Card ---
        val camCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 16f)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(16)
            layoutParams = lp
        }

        val camRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        statusPill = TextView(this).apply {
            text = "● WAITING"
            textSize = 11f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#C93D27"))
            background = makeCard(Color.parseColor("#FBEBE8"), 10f)
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }
        camRow.addView(statusPill)

        val spacer = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        }
        camRow.addView(spacer)

        val otgHint = TextView(this).apply {
            text = "USB OTG"
            textSize = 11f
            setTextColor(Color.parseColor("#9A958F"))
        }
        camRow.addView(otgHint)
        camCard.addView(camRow)

        cameraTitle = TextView(this).apply {
            text = "No DSLR Connected"
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(8)
            layoutParams = lp
        }
        camCard.addView(cameraTitle)

        cameraSub = TextView(this).apply {
            text = "Plug your Canon, Nikon, or Sony DSLR into this phone with a USB cable."
            textSize = 13f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(4)
            layoutParams = lp
        }
        camCard.addView(cameraSub)
        content.addView(camCard)

        // --- Laptop Pairing Card ---
        val lapCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 16f)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(14)
            layoutParams = lp
        }

        val lapLabel = TextView(this).apply {
            text = "🎯 Base Station Connection"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        lapCard.addView(lapLabel)

        val lapHint = TextView(this).apply {
            text = "Point camera at the Photographer Desk QR on your laptop to connect in 1 second:"
            textSize = 12f
            setTextColor(Color.parseColor("#8E8884"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(2)
            layoutParams = lp
        }
        lapCard.addView(lapHint)

        // Instant Camera QR Code Scanner button
        val scanQrBtn = Button(this).apply {
            text = "📷 Scan QR Code on Laptop"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#C93D27"), 12f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48))
            lp.topMargin = dp(10)
            layoutParams = lp
            setOnClickListener { startQrScanner() }
        }
        lapCard.addView(scanQrBtn)

        val manualDivider = TextView(this).apply {
            text = "— or enter laptop address manually —"
            textSize = 11f
            setTextColor(Color.parseColor("#A39DA6"))
            gravity = Gravity.CENTER_HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
        }
        lapCard.addView(manualDivider)

        laptopInput = EditText(this).apply {
            hint = "http://192.168.1.100:49152/send/..."
            setText(targetUrl)
            textSize = 13f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = makeCard(Color.parseColor("#F5F1EA"), 8f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        lapCard.addView(laptopInput)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(8)
            layoutParams = lp
        }

        val saveBtn = Button(this).apply {
            text = "Save & Test Connection"
            textSize = 13f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#1C1A1E"), 10f)
            val lp = LinearLayout.LayoutParams(0, dp(42), 1f)
            layoutParams = lp
            setOnClickListener { testConnection() }
        }
        btnRow.addView(saveBtn)

        val pasteBtn = Button(this).apply {
            text = "📋 Paste"
            textSize = 13f
            setTextColor(Color.parseColor("#1C1A1E"))
            background = makeCard(Color.parseColor("#E4DCCF"), 10f)
            val lp = LinearLayout.LayoutParams(dp(86), dp(42)).apply {
                leftMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { pasteFromClipboard() }
        }
        btnRow.addView(pasteBtn)
        lapCard.addView(btnRow)

        connectionStatusText = TextView(this).apply {
            text = if (targetUrl.isNotEmpty()) "Target configured" else "No laptop URL set"
            textSize = 12f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        lapCard.addView(connectionStatusText)
        content.addView(lapCard)

        // --- Send Mode & Brightness Card ---
        val modeCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 16f)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(14)
            layoutParams = lp
        }

        val modeTitle = TextView(this).apply {
            text = "🎛️ Send Mode & Brightness"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        modeCard.addView(modeTitle)

        val modeRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
        }

        modeAutoBtn = Button(this).apply {
            text = "⚡ Auto-Send All"
            textSize = 12.5f
            setTypeface(typeface, Typeface.BOLD)
            val lp = LinearLayout.LayoutParams(0, dp(42), 1f).apply { rightMargin = dp(6) }
            layoutParams = lp
            setOnClickListener {
                pickToSendMode = false
                savePrefs()
                refreshSendModeUi()
                refreshQueueUi()
                Toast.makeText(this@RovingBridgeActivity, "Auto-Send ON: new DSLR shots stream right away", Toast.LENGTH_SHORT).show()
            }
        }
        modeRow.addView(modeAutoBtn)

        modePickBtn = Button(this).apply {
            text = "☑️ Pick to Send"
            textSize = 12.5f
            setTypeface(typeface, Typeface.BOLD)
            val lp = LinearLayout.LayoutParams(0, dp(42), 1f).apply { leftMargin = dp(6) }
            layoutParams = lp
            setOnClickListener {
                pickToSendMode = true
                savePrefs()
                refreshSendModeUi()
                refreshQueueUi()
                Toast.makeText(this@RovingBridgeActivity, "Pick-to-Send ON: review & choose shots before sending", Toast.LENGTH_SHORT).show()
            }
        }
        modeRow.addView(modePickBtn)
        modeCard.addView(modeRow)

        modeHintText = TextView(this).apply {
            textSize = 11.5f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        modeCard.addView(modeHintText)

        // Brightness adjustment before sending to laptop
        val brightDivider = View(this).apply {
            setBackgroundColor(Color.parseColor("#EFE9DF"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                topMargin = dp(12)
                bottomMargin = dp(10)
            }
            layoutParams = lp
        }
        modeCard.addView(brightDivider)

        val brightHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        mainBrightnessLabel = TextView(this).apply {
            text = "☀️ Brightness before sending: ${formatBrightness(defaultBrightness)}"
            textSize = 12.5f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        brightHeader.addView(mainBrightnessLabel)
        modeCard.addView(brightHeader)

        mainBrightnessSeek = SeekBar(this).apply {
            max = BRIGHTNESS_RANGE
            progress = defaultBrightness - BRIGHTNESS_MIN
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(4)
            }
            layoutParams = lp
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    val v = (progress + BRIGHTNESS_MIN).coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
                    defaultBrightness = v
                    refreshMainBrightnessUi(updateSeek = false)
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) { }
                override fun onStopTrackingTouch(seekBar: SeekBar?) { savePrefs() }
            })
        }
        modeCard.addView(mainBrightnessSeek)

        val presetRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        val brightPresets = listOf(-10 to "-10%", 0 to "Reset 0%", 10 to "+10%", 20 to "+20%", 30 to "+30%")
        brightPresets.forEachIndexed { idx, (valB, lbl) ->
            val pb = Button(this).apply {
                text = lbl
                textSize = 11f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.parseColor("#4A444D"))
                background = makeCard(Color.parseColor("#F5F1EA"), 8f)
                setPadding(dp(4), 0, dp(4), 0)
                val lp = LinearLayout.LayoutParams(0, dp(32), 1f).apply {
                    if (idx > 0) leftMargin = dp(5)
                }
                layoutParams = lp
                setOnClickListener {
                    defaultBrightness = valB
                    savePrefs()
                    refreshMainBrightnessUi(updateSeek = true)
                }
            }
            presetRow.addView(pb)
        }
        modeCard.addView(presetRow)

        val cardDiv = View(this).apply {
            setBackgroundColor(Color.parseColor("#ECE6DD"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                topMargin = dp(12)
                bottomMargin = dp(10)
            }
            layoutParams = lp
        }
        modeCard.addView(cardDiv)

        val sdRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val sdTextCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(10)
            }
        }
        sdTextCol.addView(TextView(this).apply {
            text = "💾 Save Backup + RAW on Camera SD Card"
            textSize = 13.5f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        })
        sdTextCol.addView(TextView(this).apply {
            text = "Keeps full RAW (.CR3 / .NEF / .ARW) + JPEG on your camera SD card while sending JPEGs to Laptop."
            textSize = 11.5f
            setTextColor(Color.parseColor("#6B666C"))
        })
        @SuppressLint("UseSwitchCompatOrMaterialCode")
        saveToCardSwitch = Switch(this).apply {
            isChecked = saveToCardEnabled
            setOnCheckedChangeListener { _, isChecked ->
                saveToCardEnabled = isChecked
                savePrefs()
                UsbCameraHelper.activeInstance?.setRovingSaveToCard(isChecked)
                localCameraHelper?.setRovingSaveToCard(isChecked)
            }
        }
        sdRow.addView(sdTextCol)
        sdRow.addView(saveToCardSwitch)
        modeCard.addView(sdRow)

        content.addView(modeCard)
        refreshSendModeUi()

        // --- Live Activity Stats Card ---
        val statsCard = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = makeCard(Color.WHITE, 16f)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(14)
            layoutParams = lp
            isClickable = true
            isFocusable = true
            setOnClickListener { showGalleryOverlay(if (stagedCount() > 0) "pick" else "all") }
        }

        thumbnailView = ImageView(this).apply {
            background = makeCard(Color.parseColor("#1E1C21"), 8f)
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = LinearLayout.LayoutParams(dp(70), dp(70))
            isClickable = true
            isFocusable = true
            setOnClickListener { showGalleryOverlay(if (stagedCount() > 0) "pick" else "all") }
        }
        statsCard.addView(thumbnailView)

        val statsCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            lp.leftMargin = dp(14)
            layoutParams = lp
        }

        statsCountText = TextView(this).apply {
            text = "0 Photos Sent"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#2EA66B"))
        }
        statsCol.addView(statsCountText)

        lastSentText = TextView(this).apply {
            text = "Waiting for first shutter click…"
            textSize = 12f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(4)
            layoutParams = lp
        }
        statsCol.addView(lastSentText)

        val tapHint = TextView(this).apply {
            text = "🖼️ Tap to review, pick & adjust photos ➔"
            textSize = 11f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1D6FA5"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        statsCol.addView(tapHint)

        statsCard.addView(statsCol)
        content.addView(statsCard)

        // --- Staged Pick-to-Send Review Banner ---
        stagedBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = makeCard(Color.parseColor("#EEF2FF"), 14f)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
            visibility = View.GONE
        }

        stagedBannerText = TextView(this).apply {
            text = "☑️ 0 photo(s) waiting for your pick"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#3730A3"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        stagedBanner.addView(stagedBannerText)

        val reviewPickBtn = Button(this).apply {
            text = "☑️ Review"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#4F46E5"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                leftMargin = dp(8)
            }
            layoutParams = lp
            setPadding(dp(12), 0, dp(12), 0)
            setOnClickListener { showGalleryOverlay("pick") }
        }
        stagedBanner.addView(reviewPickBtn)

        val sendAllBannerBtn = Button(this).apply {
            text = "📤 All"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2EA66B"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                leftMargin = dp(6)
            }
            layoutParams = lp
            setPadding(dp(10), 0, dp(10), 0)
            setOnClickListener { confirmSendAllStaged() }
        }
        stagedBanner.addView(sendAllBannerBtn)
        content.addView(stagedBanner)

        // --- Offline Queue & Auto-Retry Banner ---
        pendingBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = makeCard(Color.parseColor("#FEF5E7"), 14f)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
            visibility = View.GONE
        }

        pendingBannerText = TextView(this).apply {
            text = "⏳ 0 queued — auto-uploads when Wi-Fi returns"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#9A5B04"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        pendingBanner.addView(pendingBannerText)

        val retryNowBtn = Button(this).apply {
            text = "🔄 Retry Now"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#D97706"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                leftMargin = dp(10)
            }
            layoutParams = lp
            setPadding(dp(12), 0, dp(12), 0)
            setOnClickListener { retryPendingNow() }
        }
        pendingBanner.addView(retryNowBtn)
        content.addView(pendingBanner)

        // --- Action Buttons ---
        val actRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(18)
            layoutParams = lp
        }

        triggerButton = Button(this).apply {
            text = "📸 Test Shutter"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2EA66B"), 12f)
            val lp = LinearLayout.LayoutParams(0, dp(48), 1f)
            lp.rightMargin = dp(8)
            layoutParams = lp
            setOnClickListener { testShutterTrigger() }
        }
        actRow.addView(triggerButton)

        val pocketBtn = Button(this).apply {
            text = "🔒 Pocket Mode"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#5A535C"), 12f)
            val lp = LinearLayout.LayoutParams(0, dp(48), 1f)
            lp.leftMargin = dp(8)
            layoutParams = lp
            setOnClickListener { showPocketLock() }
        }
        actRow.addView(pocketBtn)
        content.addView(actRow)

        galleryOpenBtn = Button(this).apply {
            text = "🖼️ View Photos Gallery"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            background = makeCard(Color.parseColor("#E4DCCF"), 12f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(46)).apply {
                topMargin = dp(10)
            }
            layoutParams = lp
            setOnClickListener { showGalleryOverlay(if (stagedCount() > 0) "pick" else "all") }
        }
        content.addView(galleryOpenBtn)

        val updatesCard = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(10)
            }
            layoutParams = lp
            isClickable = true
            isFocusable = true
            setOnClickListener { showUpdatesOverlay() }
        }

        val updCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            layoutParams = lp
        }

        val updTitle = TextView(this).apply {
            text = "✨ Version $versionStr • What's New"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        updCol.addView(updTitle)

        val updSub = TextView(this).apply {
            text = "Check online updates & release changelog"
            textSize = 11f
            setTextColor(Color.parseColor("#8E8884"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(2)
            }
            layoutParams = lp
        }
        updCol.addView(updSub)
        updatesCard.addView(updCol)

        val updBtn = Button(this).apply {
            text = "Updates ➔"
            textSize = 12f
            setTextColor(Color.parseColor("#1D6FA5"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#EAF3FA"), 10f)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34))
            setOnClickListener { showUpdatesOverlay() }
        }
        updatesCard.addView(updBtn)
        content.addView(updatesCard)

        scroll.addView(content)
        rootLayout.addView(scroll)

        // --- Overlays ---
        buildPocketLockOverlay()
        rootLayout.addView(pocketLockOverlay)

        buildGalleryOverlay()
        rootLayout.addView(galleryOverlay)

        buildPhotoPreviewOverlay()
        rootLayout.addView(photoPreviewOverlay)

        buildUpdatesOverlay()
        rootLayout.addView(updatesOverlay)

        setContentView(rootLayout)
    }

    private fun refreshSendModeUi() {
        if (!::modeAutoBtn.isInitialized || !::modePickBtn.isInitialized) return
        if (pickToSendMode) {
            modeAutoBtn.background = makeCard(Color.parseColor("#F5F1EA"), 10f)
            modeAutoBtn.setTextColor(Color.parseColor("#6B666C"))
            modePickBtn.background = makeCard(Color.parseColor("#4F46E5"), 10f)
            modePickBtn.setTextColor(Color.WHITE)
            if (::modeHintText.isInitialized) {
                modeHintText.text = "☑️ Shots stay on this phone first — review, adjust brightness & tap Send on the ones you want on the laptop."
            }
        } else {
            modeAutoBtn.background = makeCard(Color.parseColor("#2EA66B"), 10f)
            modeAutoBtn.setTextColor(Color.WHITE)
            modePickBtn.background = makeCard(Color.parseColor("#F5F1EA"), 10f)
            modePickBtn.setTextColor(Color.parseColor("#6B666C"))
            if (::modeHintText.isInitialized) {
                modeHintText.text = "⚡ Every DSLR shutter click streams straight to the laptop (or queues safely if Wi-Fi drops)."
            }
        }
        if (::pocketSubText.isInitialized) {
            pocketSubText.text = if (pickToSendMode) {
                "Shutter is LIVE (Pick-to-Send mode).\nShots save on phone until you pick which to send."
            } else {
                "Shutter is LIVE. Clicks will beam to laptop\n(or queue safely if Wi-Fi drops)."
            }
        }
    }

    private fun refreshMainBrightnessUi(updateSeek: Boolean) {
        val b = defaultBrightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        if (::mainBrightnessLabel.isInitialized) {
            mainBrightnessLabel.text = "☀️ Brightness before sending: ${formatBrightness(b)}"
            mainBrightnessLabel.setTextColor(
                if (b != 0) Color.parseColor("#C93D27") else Color.parseColor("#1C1A1E")
            )
        }
        if (updateSeek && ::mainBrightnessSeek.isInitialized) {
            mainBrightnessSeek.progress = b - BRIGHTNESS_MIN
        }
    }

    private fun buildPocketLockOverlay() {
        pocketLockOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0A0A0C"))
            visibility = View.GONE
            isClickable = true
            isFocusable = true
        }

        val centerCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
        }

        val lockIcon = TextView(this).apply {
            text = "🔒"
            textSize = 48f
            gravity = Gravity.CENTER
        }
        centerCol.addView(lockIcon)

        val lockTitle = TextView(this).apply {
            text = "Pocket Lock Active"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(12)
            layoutParams = lp
        }
        centerCol.addView(lockTitle)

        pocketSubText = TextView(this).apply {
            text = if (pickToSendMode) {
                "Shutter is LIVE (Pick-to-Send mode).\nShots save on phone until you pick which to send."
            } else {
                "Shutter is LIVE. Clicks will beam to laptop\n(or queue safely if Wi-Fi drops)."
            }
            textSize = 13f
            setTextColor(Color.parseColor("#9A958F"))
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        centerCol.addView(pocketSubText)

        pocketStatsText = TextView(this).apply {
            text = "Sent: 0"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#C4BEB9"))
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
        }
        centerCol.addView(pocketStatsText)

        var tapCount = 0
        val unlockBtn = Button(this).apply {
            text = "Tap 3 times to Unlock"
            textSize = 14f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#252329"), 12f)
            val lp = LinearLayout.LayoutParams(dp(220), dp(48))
            lp.topMargin = dp(32)
            layoutParams = lp
            setOnClickListener {
                tapCount++
                if (tapCount >= 3) {
                    tapCount = 0
                    hidePocketLock()
                } else {
                    text = "Tap ${3 - tapCount} more times…"
                }
            }
        }
        centerCol.addView(unlockBtn)
        pocketLockOverlay.addView(centerCol)
    }

    private fun showPocketLock() {
        pocketLockOverlay.visibility = View.VISIBLE
        // Dim screen brightness to save battery in pocket
        val lp = window.attributes
        lp.screenBrightness = 0.05f
        window.attributes = lp
        syncWakeLock()
        Toast.makeText(this, "Pocket Lock ON. Shutter is still live!", Toast.LENGTH_SHORT).show()
    }

    private fun hidePocketLock() {
        pocketLockOverlay.visibility = View.GONE
        val lp = window.attributes
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
        syncWakeLock()
    }

    // ================================================================ SESSION GALLERY & PREVIEWS (OPTION A & 3)

    private fun buildGalleryOverlay() {
        galleryOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F5F1EA"))
            visibility = View.GONE
            isClickable = true
            isFocusable = true
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setPadding(dp(16), dp(20), dp(16), dp(16))
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        galleryTitleText = TextView(this).apply {
            text = "📸 Session Photos (0)"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        bar.addView(galleryTitleText)

        galleryRetryBtn = Button(this).apply {
            text = "🔄 Retry (0)"
            textSize = 12f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#D97706"), 14f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setPadding(dp(10), 0, dp(10), 0)
            visibility = View.GONE
            setOnClickListener { retryPendingNow() }
        }
        bar.addView(galleryRetryBtn)

        val queueInGalleryBtn = Button(this).apply {
            text = "🖥️ Queue"
            textSize = 12f
            setTextColor(Color.parseColor("#1D6FA5"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#EAF3FA"), 14f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setPadding(dp(10), 0, dp(10), 0)
            setOnClickListener { openLaptopQueue() }
        }
        bar.addView(queueInGalleryBtn)

        val clearBtn = Button(this).apply {
            text = "🗑️"
            textSize = 14f
            background = makeCard(Color.parseColor("#E4DCCF"), 14f)
            val lp = LinearLayout.LayoutParams(dp(36), dp(36)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setOnClickListener { clearSessionGallery() }
        }
        bar.addView(clearBtn)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.parseColor("#6B666C"))
            background = makeCard(Color.parseColor("#E4DCCF"), 18f)
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
            setOnClickListener { hideGalleryOverlay() }
        }
        bar.addView(closeBtn)
        container.addView(bar)

        // Filter & Multi-Select Bar
        val filterRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
            }
            layoutParams = lp
        }

        galleryFilterAllBtn = Button(this).apply {
            text = "All (0)"
            textSize = 11.5f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, dp(10), 0)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setOnClickListener {
                galleryFilter = "all"
                gallerySelectMode = false
                selectedStagedPaths.clear()
                notifyGalleryChanged()
            }
        }
        filterRow.addView(galleryFilterAllBtn)

        galleryFilterPickBtn = Button(this).apply {
            text = "☑️ To Pick (0)"
            textSize = 11.5f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, dp(10), 0)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setOnClickListener {
                galleryFilter = "pick"
                notifyGalleryChanged()
            }
        }
        filterRow.addView(galleryFilterPickBtn)

        galleryFilterSentBtn = Button(this).apply {
            text = "✓ Sent (0)"
            textSize = 11.5f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, dp(10), 0)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply {
                rightMargin = dp(6)
            }
            layoutParams = lp
            setOnClickListener {
                galleryFilter = "sent"
                gallerySelectMode = false
                selectedStagedPaths.clear()
                notifyGalleryChanged()
            }
        }
        filterRow.addView(galleryFilterSentBtn)

        val filterSpacer = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        }
        filterRow.addView(filterSpacer)

        gallerySelectBtn = Button(this).apply {
            text = "☑ Multi-Pick"
            textSize = 11.5f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, dp(10), 0)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32))
            visibility = View.GONE
            setOnClickListener {
                gallerySelectMode = !gallerySelectMode
                if (!gallerySelectMode) selectedStagedPaths.clear()
                else if (galleryFilter == "sent") galleryFilter = "pick"
                notifyGalleryChanged()
            }
        }
        filterRow.addView(gallerySelectBtn)
        container.addView(filterRow)

        // Batch Actions Bar (Send All / Send Selected / Discard Selected)
        galleryBatchBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = makeCard(Color.parseColor("#EEF2FF"), 12f)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
            }
            layoutParams = lp
            visibility = View.GONE
        }

        galleryBatchSendBtn = Button(this).apply {
            text = "📤 Send All (0)"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2EA66B"), 10f)
            val lp = LinearLayout.LayoutParams(0, dp(36), 1f)
            layoutParams = lp
            setOnClickListener {
                if (gallerySelectMode) {
                    sendSelectedStagedPhotos()
                } else {
                    confirmSendAllStaged()
                }
            }
        }
        galleryBatchBar.addView(galleryBatchSendBtn)

        galleryBatchDiscardBtn = Button(this).apply {
            text = "🗑️ Discard (0)"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#C93D27"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                leftMargin = dp(8)
            }
            layoutParams = lp
            setPadding(dp(12), 0, dp(12), 0)
            visibility = View.GONE
            setOnClickListener { discardSelectedStagedPhotos() }
        }
        galleryBatchBar.addView(galleryBatchDiscardBtn)
        container.addView(galleryBatchBar)

        gallerySubHint = TextView(this).apply {
            text = "Tap any photo to preview, adjust brightness, or pick to send to laptop."
            textSize = 11f
            setTextColor(Color.parseColor("#8E8884"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
                bottomMargin = dp(10)
            }
            layoutParams = lp
        }
        container.addView(gallerySubHint)

        galleryEmptyText = TextView(this).apply {
            text = "No photos taken yet in this session.\n\nConnect your DSLR and snap photos with the camera shutter—they will appear here!"
            textSize = 13f
            setTextColor(Color.parseColor("#8E8884"))
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply {
                topMargin = dp(60)
            }
            layoutParams = lp
            visibility = View.VISIBLE
        }
        container.addView(galleryEmptyText)

        galleryAdapter = GalleryGridAdapter()
        val screenWidthDp = resources.displayMetrics.widthPixels / resources.displayMetrics.density
        val gridCols = when {
            screenWidthDp >= 840f -> 5
            screenWidthDp >= 560f -> 4
            else -> 3
        }
        galleryGrid = GridView(this).apply {
            numColumns = gridCols
            horizontalSpacing = dp(8)
            verticalSpacing = dp(8)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            isVerticalScrollBarEnabled = true
            adapter = galleryAdapter
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            layoutParams = lp
            visibility = View.GONE
        }
        container.addView(galleryGrid)

        galleryOverlay.addView(container)
    }

    private fun buildPhotoPreviewOverlay() {
        photoPreviewOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#EB0A0A0C"))
            visibility = View.GONE
            isClickable = true
            isFocusable = true
            setOnClickListener {
                previewingPhoto = null
                visibility = View.GONE
            }
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.parseColor("#1C1A1E"), 16f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
                setMargins(dp(14), dp(18), dp(14), dp(18))
            }
            layoutParams = lp
            isClickable = true
            isFocusable = true
            setOnClickListener { /* prevent closing when tapping card */ }
        }

        val headRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        val infoCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        val infoTitle = TextView(this).apply {
            tag = "preview_info"
            text = "Photo Preview"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
        }
        infoCol.addView(infoTitle)

        val statusText = TextView(this).apply {
            tag = "preview_status"
            text = "● Sent to Laptop Base Station"
            textSize = 11f
            setTextColor(Color.parseColor("#2EA66B"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(2)
            }
            layoutParams = lp
        }
        infoCol.addView(statusText)
        headRow.addView(infoCol)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#332F36"), 16f)
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
            setOnClickListener {
                previewingPhoto = null
                photoPreviewOverlay.visibility = View.GONE
            }
        }
        headRow.addView(closeBtn)
        card.addView(headRow)

        val iv = ImageView(this).apply {
            tag = "preview_iv"
            scaleType = ImageView.ScaleType.FIT_CENTER
            background = makeCard(Color.BLACK, 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(290)).apply {
                topMargin = dp(10)
                bottomMargin = dp(8)
            }
            layoutParams = lp
        }
        card.addView(iv)

        // Prev / Next photo navigation bar
        previewNavRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(8)
            }
            layoutParams = lp
        }

        previewPrevBtn = Button(this).apply {
            text = "‹ Prev"
            textSize = 12f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2D2932"), 8f)
            layoutParams = LinearLayout.LayoutParams(dp(76), dp(34))
            setOnClickListener { navigatePreview(-1) }
        }
        previewNavRow.addView(previewPrevBtn)

        previewPosText = TextView(this).apply {
            text = "1 / 1"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#C4BEB9"))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        previewNavRow.addView(previewPosText)

        previewNextBtn = Button(this).apply {
            text = "Next ›"
            textSize = 12f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2D2932"), 8f)
            layoutParams = LinearLayout.LayoutParams(dp(76), dp(34))
            setOnClickListener { navigatePreview(1) }
        }
        previewNavRow.addView(previewNextBtn)
        card.addView(previewNavRow)

        // Live Brightness Adjustment Box (for staged photos before sending)
        previewBrightnessRow = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.parseColor("#27242C"), 12f)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(10)
            }
            layoutParams = lp
            visibility = View.GONE
        }

        val pvBrightHead = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        previewBrightnessLabel = TextView(this).apply {
            text = "☀️ Brightness: 0% (Original)"
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        pvBrightHead.addView(previewBrightnessLabel)

        val pvQuickPresets = listOf(0 to "0%", 10 to "+10%", 20 to "+20%")
        pvQuickPresets.forEach { (valB, lbl) ->
            val qb = Button(this).apply {
                text = lbl
                textSize = 11f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.WHITE)
                background = makeCard(Color.parseColor("#3B3642"), 8f)
                setPadding(dp(8), 0, dp(8), 0)
                val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(28)).apply {
                    leftMargin = dp(5)
                }
                layoutParams = lp
                setOnClickListener {
                    val p = previewingPhoto ?: return@setOnClickListener
                    p.brightness = valB
                    applyPreviewBrightnessUi(valB, updateSeek = true)
                    notifyGalleryChanged()
                }
            }
            pvBrightHead.addView(qb)
        }
        previewBrightnessRow.addView(pvBrightHead)

        previewBrightnessSeek = SeekBar(this).apply {
            max = BRIGHTNESS_RANGE
            progress = -BRIGHTNESS_MIN
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(4)
            }
            layoutParams = lp
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (previewSyncingSlider) return
                    val v = (progress + BRIGHTNESS_MIN).coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
                    previewingPhoto?.brightness = v
                    applyPreviewBrightnessUi(v, updateSeek = false)
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) { }
                override fun onStopTrackingTouch(seekBar: SeekBar?) {
                    notifyGalleryChanged()
                }
            })
        }
        previewBrightnessRow.addView(previewBrightnessSeek)
        card.addView(previewBrightnessRow)

        // Action Buttons Row
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        previewSendStagedBtn = Button(this).apply {
            text = "📤 Send to Laptop"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2EA66B"), 10f)
            val lp = LinearLayout.LayoutParams(0, dp(44), 1f).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            visibility = View.GONE
            setOnClickListener {
                val p = previewingPhoto ?: return@setOnClickListener
                approveStagedPhoto(p, advancePreview = true)
            }
        }
        btnRow.addView(previewSendStagedBtn)

        previewDiscardBtn = Button(this).apply {
            text = "🗑️ Skip"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#C93D27"), 10f)
            val lp = LinearLayout.LayoutParams(dp(92), dp(44))
            layoutParams = lp
            visibility = View.GONE
            setOnClickListener {
                val p = previewingPhoto ?: return@setOnClickListener
                discardStagedPhoto(p, advancePreview = true)
            }
        }
        btnRow.addView(previewDiscardBtn)

        previewRetryBtn = Button(this).apply {
            text = "🔄 Send Now"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#D97706"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setPadding(dp(12), 0, dp(12), 0)
            visibility = View.GONE
            setOnClickListener { retryPendingNow() }
        }
        btnRow.addView(previewRetryBtn)

        previewQueueBtn = Button(this).apply {
            text = "🖥️ View on Laptop Queue"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#1D6FA5"), 10f)
            val lp = LinearLayout.LayoutParams(0, dp(42), 1f).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener {
                previewingPhoto = null
                photoPreviewOverlay.visibility = View.GONE
                openLaptopQueue()
            }
        }
        btnRow.addView(previewQueueBtn)

        val dismissBtn = Button(this).apply {
            text = "Close"
            textSize = 13f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#332F36"), 10f)
            layoutParams = LinearLayout.LayoutParams(dp(74), dp(42))
            setOnClickListener {
                previewingPhoto = null
                photoPreviewOverlay.visibility = View.GONE
            }
        }
        btnRow.addView(dismissBtn)
        card.addView(btnRow)

        photoPreviewOverlay.addView(card)
    }

    // ================================================================ UPDATES & CHANGELOG OVERLAY

    private fun buildUpdatesOverlay() {
        updatesOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F5F1EA"))
            visibility = View.GONE
            isClickable = true
            isFocusable = true
        }

        val scroll = ScrollView(this).apply {
            isFillViewport = true
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding(dp(16), dp(20), dp(16), dp(32))
        }

        // Top bar
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        val title = TextView(this).apply {
            text = "✨ App Updates & What's New"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        bar.addView(title)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.parseColor("#6B666C"))
            background = makeCard(Color.parseColor("#E4DCCF"), 19f)
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
            setOnClickListener { hideUpdatesOverlay() }
        }
        bar.addView(closeBtn)
        container.addView(bar)

        // Version & Live Check Card
        val checkCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 16f)
            setPadding(dp(18), dp(16), dp(18), dp(16))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(16)
            }
            layoutParams = lp
        }

        val curVerText = TextView(this).apply {
            text = "Installed Version: v${getCurrentVersionName()}"
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        checkCard.addView(curVerText)

        updatesStatusText = TextView(this).apply {
            text = "Tap 'Check Online' to verify the latest release on GitHub."
            textSize = 12f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(4)
            }
            layoutParams = lp
        }
        checkCard.addView(updatesStatusText)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(12)
            }
            layoutParams = lp
        }

        val checkBtn = Button(this).apply {
            text = "🔄 Check Online"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#1C1A1E"), 10f)
            val lp = LinearLayout.LayoutParams(0, dp(42), 1f).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { checkOnlineUpdates(updatesStatusText, updatesDownloadBtn) }
        }
        btnRow.addView(checkBtn)

        val webBtn = Button(this).apply {
            text = "🌐 Downloads Page"
            textSize = 12f
            setTextColor(Color.parseColor("#1D6FA5"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#EAF3FA"), 10f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42))
            layoutParams = lp
            setOnClickListener {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://photobooth4u.netlify.app/downloads/#roving-bridge")))
                } catch (e: Exception) {
                    Toast.makeText(this@RovingBridgeActivity, "Could not open browser: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
        btnRow.addView(webBtn)
        checkCard.addView(btnRow)

        updatesDownloadBtn = Button(this).apply {
            text = "📥 Download Update"
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#2EA66B"), 10f)
            visibility = View.GONE
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)).apply {
                topMargin = dp(10)
            }
            layoutParams = lp
        }
        checkCard.addView(updatesDownloadBtn)
        container.addView(checkCard)

        // Changelog section title
        val changelogTitle = TextView(this).apply {
            text = "📜 Release Notes & Changelog"
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(20)
                bottomMargin = dp(8)
            }
            layoutParams = lp
        }
        container.addView(changelogTitle)

        // Card v1.1.5
        val card115 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }

        val header115 = TextView(this).apply {
            text = "Version 1.1.5 (Current Release)"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1B7358"))
        }
        card115.addView(header115)

        val notes115 = TextView(this).apply {
            text = "• 💾 Save Backup + RAW on Camera SD Card: Optional toggle keeps full RAW + JPEG copies safely on your camera SD card while streaming JPEGs to your laptop.\n" +
                   "• 🚀 Faster Gallery & Background Retry: Adds cached review thumbnails and smoother background reconnect retries when booth Wi-Fi fluctuates."
            textSize = 12f
            setTextColor(Color.parseColor("#423D44"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card115.addView(notes115)
        container.addView(card115)

        // Card v1.1.4
        val card114 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }

        val header114 = TextView(this).apply {
            text = "Version 1.1.4"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1B7358"))
        }
        card114.addView(header114)

        val notes114 = TextView(this).apply {
            text = "• ☑️ Pick-to-Send Mode: Switch between Auto-Send All and Pick to Send so DSLR shots wait on your phone for review — send only the best shots one by one, multi-pick batches, or skip blinks.\n" +
                   "• ☀️ Brightness Adjustment Before Sending: Slide brightness (-30% to +40%) with live preview per photo or a default boost for dim venues (0% keeps the untouched original camera JPEG).\n" +
                   "• 🖼️ Portrait & Landscape Review Gallery: Uncropped EXIF-upright thumbnails with Port/Land badges, To Pick / Sent filters, and Prev/Next review controls."
            textSize = 12f
            setTextColor(Color.parseColor("#423D44"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card114.addView(notes114)
        container.addView(card114)

        // Card v1.1.3
        val card113 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }

        val header113 = TextView(this).apply {
            text = "Version 1.1.3"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        card113.addView(header113)

        val notes113 = TextView(this).apply {
            text = "• 📶 Offline Wi-Fi Routing Fix: Binds local uploads directly to the booth Wi-Fi / hotspot even when mobile data (4G/5G) is enabled.\n" +
                   "• ⚡ Instant Reconnect & Mid-Upload Recovery: Detects DHCP IPv4 ready events, aborts stalled sockets immediately on Wi-Fi drop, and uses fresh connections.\n" +
                   "• 🔋 Screen-Off Pocket Reliability: Holds a partial wake lock while Pocket Mode or pending uploads are active so photos still capture & upload if the screen locks.\n" +
                   "• 🛡️ Queue Hardening: Quarantines oversized (>80 MB) or corrupt files instead of stalling the queue, prevents startup restore races, and sends upload IDs to prevent duplicates."
            textSize = 12f
            setTextColor(Color.parseColor("#423D44"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card113.addView(notes113)
        container.addView(card113)

        // Card v1.1.2
        val card112 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }

        val header112 = TextView(this).apply {
            text = "Version 1.1.2"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        card112.addView(header112)

        val notes112 = TextView(this).apply {
            text = "• 📦 Offline Disk Queue: Photos shot while out of Wi-Fi range now save safely to phone storage instead of failing.\n" +
                   "• 🔄 Automatic Reconnect Upload: Automatically detects when booth Wi-Fi returns and uploads queued photos in order.\n" +
                   "• ⏳ Live Pending Counter & Retry Now: See queued shots on the home screen, Pocket Lock, and Gallery, plus 1-tap manual retry.\n" +
                   "• 🗑️ Safe Gallery Clear: Protects pending unsent photos from accidental clearing."
            textSize = 12f
            setTextColor(Color.parseColor("#423D44"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card112.addView(notes112)
        container.addView(card112)

        // Card v1.1.0
        val card110 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }

        val header110 = TextView(this).apply {
            text = "Version 1.1.0 – 1.1.1"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        card110.addView(header110)

        val notes110 = TextView(this).apply {
            text = "• 📸 In-App Session Photos Gallery: View all captured shots in a 3-column chronological grid.\n" +
                   "• 🔍 Fullscreen Preview: Tap any thumbnail to view an enlarged preview with file size and timestamp.\n" +
                   "• 🖥️ Instant Laptop Queue: Tap the new 🖥️ Queue button to open the laptop base station queue in your browser over Wi-Fi.\n" +
                   "• ⚡ Zero-Lag Micro-Caching: 30KB thumbnail generation on a background thread that keeps shooting at 100% full speed.\n" +
                   "• ✨ In-App Updates Center: Check for new releases online with direct download link and changelog."
            textSize = 12f
            setTextColor(Color.parseColor("#423D44"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card110.addView(notes110)
        container.addView(card110)

        // Card v1.0.0
        val card100 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = makeCard(Color.WHITE, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            layoutParams = lp
        }

        val header100 = TextView(this).apply {
            text = "Version 1.0.0 (Initial Release)"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        card100.addView(header100)

        val notes100 = TextView(this).apply {
            text = "• 🚀 Standalone Android Companion: Dedicated app with no booth license code or kiosk mode required.\n" +
                   "• 🔌 Wired DSLR USB OTG: Native PTP support for Canon EOS, Nikon, and Sony Alpha cameras.\n" +
                   "• 🎯 1-Second QR Pairing: Point camera at the laptop Photographer Desk to connect instantly.\n" +
                   "• 🔒 Pocket Lock Mode: Dims screen to 5% and blocks touches while keeping physical shutter live.\n" +
                   "• 📳 Haptic Vibration Feedback: Confirms successful delivery to the laptop directly in your pocket."
            textSize = 12f
            setTextColor(Color.parseColor("#6B666C"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
            layoutParams = lp
        }
        card100.addView(notes100)
        container.addView(card100)

        scroll.addView(container)
        updatesOverlay.addView(scroll)
    }

    private fun showUpdatesOverlay() {
        updatesOverlay.visibility = View.VISIBLE
        checkOnlineUpdates(updatesStatusText, updatesDownloadBtn)
    }

    private fun hideUpdatesOverlay() {
        updatesOverlay.visibility = View.GONE
    }

    private fun checkOnlineUpdates(statusView: TextView, actionBtn: Button) {
        statusView.text = "Checking GitHub for updates…"
        statusView.setTextColor(Color.parseColor("#6B666C"))
        actionBtn.visibility = View.GONE

        Thread({
            var latestTag = ""
            var downloadUrl = ""
            try {
                val url = URL("https://api.github.com/repos/heresmetrying26/photobooth-for-rent/releases?per_page=60")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.setRequestProperty("User-Agent", "photobooth4u-roving-bridge")
                conn.setRequestProperty("Accept", "application/vnd.github.v3+json")
                try {
                    if (conn.responseCode in 200..299) {
                        val jsonStr = conn.inputStream.bufferedReader().use { it.readText() }
                        val arr = JSONArray(jsonStr)
                        for (i in 0 until arr.length()) {
                            val obj = arr.getJSONObject(i)
                            if (obj.optBoolean("draft", false)) continue
                            val tag = obj.optString("tag_name", "")
                            if (tag.startsWith("roving-v")) {
                                val ver = tag.removePrefix("roving-v")
                                if (latestTag.isEmpty() || compareVersions(ver, latestTag) > 0) {
                                    latestTag = ver
                                    downloadUrl = ""
                                    val assets = obj.optJSONArray("assets")
                                    if (assets != null) {
                                        for (j in 0 until assets.length()) {
                                            val asset = assets.getJSONObject(j)
                                            if (asset.optString("name") == "roving-dslr-bridge-android.apk") {
                                                downloadUrl = asset.optString("browser_download_url")
                                                break
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    try { conn.disconnect() } catch (_: Exception) { }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Update check failed: ${e.message}")
            }

            mainHandler.post {
                val currentVer = getCurrentVersionName()
                if (latestTag.isNotEmpty()) {
                    val isNewer = compareVersions(latestTag, currentVer) > 0
                    if (isNewer) {
                        statusView.text = "🚀 New version v$latestTag is available!"
                        statusView.setTextColor(Color.parseColor("#2EA66B"))
                        actionBtn.text = "📥 Download v$latestTag APK"
                        actionBtn.visibility = View.VISIBLE
                        actionBtn.setOnClickListener {
                            val target = downloadUrl.ifEmpty { "https://photobooth4u.netlify.app/downloads/#roving-bridge" }
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
                            } catch (e: Exception) {
                                Toast.makeText(this, "Could not open browser: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    } else {
                        statusView.text = "✅ You're up to date (v$currentVer is the latest)."
                        statusView.setTextColor(Color.parseColor("#2EA66B"))
                    }
                } else {
                    statusView.text = "Could not check online (offline or no internet)."
                    statusView.setTextColor(Color.parseColor("#6B666C"))
                }
            }
        }, "update-check").start()
    }

    private fun compareVersions(v1: String, v2: String): Int {
        val p1 = v1.trim().removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }
        val p2 = v2.trim().removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }
        val maxLen = maxOf(p1.size, p2.size)
        for (i in 0 until maxLen) {
            val num1 = p1.getOrElse(i) { 0 }
            val num2 = p2.getOrElse(i) { 0 }
            if (num1 != num2) return num1.compareTo(num2)
        }
        return 0
    }

    private fun getCurrentVersionName(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.1.5"
        } catch (_: Exception) {
            "1.1.5"
        }
    }

    private fun filteredGalleryPhotos(): List<SessionPhoto> = synchronized(sessionPhotos) {
        when (galleryFilter) {
            "pick" -> sessionPhotos.filter { it.isStaged() }
            "sent" -> sessionPhotos.filter { !it.isStaged() }
            else -> sessionPhotos.toList()
        }
    }

    private fun showGalleryOverlay(initialFilter: String? = null) {
        if (initialFilter != null) {
            galleryFilter = initialFilter
        } else if (stagedCount() > 0 && galleryFilter == "sent") {
            galleryFilter = "pick"
        }
        gallerySelectMode = false
        selectedStagedPaths.clear()
        notifyGalleryChanged()
        galleryOverlay.visibility = View.VISIBLE
    }

    private fun hideGalleryOverlay() {
        gallerySelectMode = false
        selectedStagedPaths.clear()
        galleryOverlay.visibility = View.GONE
    }

    private fun applyPreviewBrightnessUi(brightness: Int, updateSeek: Boolean) {
        val b = brightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
        val iv = if (::photoPreviewOverlay.isInitialized) photoPreviewOverlay.findViewWithTag<ImageView>("preview_iv") else null
        iv?.colorFilter = brightnessColorFilter(b)
        if (::previewBrightnessLabel.isInitialized) {
            previewBrightnessLabel.text = "☀️ Brightness: ${formatBrightness(b)}"
            previewBrightnessLabel.setTextColor(
                if (b != 0) Color.parseColor("#FBBF24") else Color.WHITE
            )
        }
        if (updateSeek && ::previewBrightnessSeek.isInitialized) {
            previewSyncingSlider = true
            previewBrightnessSeek.progress = b - BRIGHTNESS_MIN
            previewSyncingSlider = false
        }
    }

    private fun navigatePreview(delta: Int) {
        val current = previewingPhoto ?: return
        val list = filteredGalleryPhotos()
        if (list.isEmpty()) return
        val idx = list.indexOf(current)
        if (idx < 0) {
            showPhotoPreview(list.first())
            return
        }
        val next = (idx + delta).coerceIn(0, list.lastIndex)
        if (next != idx) showPhotoPreview(list[next])
    }

    private fun showPhotoPreview(photo: SessionPhoto) {
        if (!::photoPreviewOverlay.isInitialized) return
        previewingPhoto = photo
        val iv = photoPreviewOverlay.findViewWithTag<ImageView>("preview_iv")
        val infoText = photoPreviewOverlay.findViewWithTag<TextView>("preview_info")
        val statusText = photoPreviewOverlay.findViewWithTag<TextView>("preview_status")

        try {
            val bmp = if (photo.thumbFile.exists()) BitmapFactory.decodeFile(photo.thumbFile.absolutePath) else null
            iv?.setImageBitmap(bmp)
        } catch (_: Exception) {
            iv?.setImageDrawable(null)
        }

        val list = filteredGalleryPhotos()
        val idx = list.indexOf(photo)
        if (::previewNavRow.isInitialized) {
            if (list.size > 1 && idx >= 0) {
                previewNavRow.visibility = View.VISIBLE
                previewPosText.text = "${idx + 1} / ${list.size}"
                previewPrevBtn.isEnabled = idx > 0
                previewPrevBtn.alpha = if (idx > 0) 1f else 0.4f
                previewNextBtn.isEnabled = idx < list.lastIndex
                previewNextBtn.alpha = if (idx < list.lastIndex) 1f else 0.4f
            } else {
                previewNavRow.visibility = View.GONE
            }
        }

        val mb = String.format(Locale.US, "%.1f MB", photo.sizeBytes / (1024.0 * 1024.0))
        val orientTag = when (photo.orient) {
            "portrait" -> " • ▯ Portrait"
            "landscape" -> " • ▭ Landscape"
            else -> ""
        }
        infoText?.text = "Captured at ${photo.timeStr} • $mb$orientTag"

        if (photo.isStaged()) {
            statusText?.text = "● Ready to review — adjust brightness & tap Send to Laptop"
            statusText?.setTextColor(Color.parseColor("#A5B4FC"))
            if (::previewBrightnessRow.isInitialized) previewBrightnessRow.visibility = View.VISIBLE
            if (::previewSendStagedBtn.isInitialized) previewSendStagedBtn.visibility = View.VISIBLE
            if (::previewDiscardBtn.isInitialized) previewDiscardBtn.visibility = View.VISIBLE
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.GONE
            if (::previewQueueBtn.isInitialized) previewQueueBtn.visibility = View.GONE
            applyPreviewBrightnessUi(photo.brightness, updateSeek = true)
        } else if (photo.success) {
            val bNote = if (photo.brightness != 0) " (${formatBrightness(photo.brightness)})" else ""
            statusText?.text = "● Sent to Laptop Base Station$bNote"
            statusText?.setTextColor(Color.parseColor("#2EA66B"))
            if (::previewBrightnessRow.isInitialized) previewBrightnessRow.visibility = View.GONE
            if (::previewSendStagedBtn.isInitialized) previewSendStagedBtn.visibility = View.GONE
            if (::previewDiscardBtn.isInitialized) previewDiscardBtn.visibility = View.GONE
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.GONE
            if (::previewQueueBtn.isInitialized) previewQueueBtn.visibility = View.VISIBLE
            iv?.colorFilter = null
        } else if (photo.isQueued()) {
            statusText?.text = if (photo.promoting) "● Preparing & queuing photo…" else "● Queued — auto-uploads when Wi-Fi reconnects"
            statusText?.setTextColor(Color.parseColor("#F59E0B"))
            if (::previewBrightnessRow.isInitialized) previewBrightnessRow.visibility = View.GONE
            if (::previewSendStagedBtn.isInitialized) previewSendStagedBtn.visibility = View.GONE
            if (::previewDiscardBtn.isInitialized) previewDiscardBtn.visibility = View.GONE
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = if (photo.promoting) View.GONE else View.VISIBLE
            if (::previewQueueBtn.isInitialized) previewQueueBtn.visibility = View.VISIBLE
            iv?.colorFilter = null
        } else {
            statusText?.text = "● Upload Failed / Pending"
            statusText?.setTextColor(Color.parseColor("#C93D27"))
            if (::previewBrightnessRow.isInitialized) previewBrightnessRow.visibility = View.GONE
            if (::previewSendStagedBtn.isInitialized) previewSendStagedBtn.visibility = View.GONE
            if (::previewDiscardBtn.isInitialized) previewDiscardBtn.visibility = View.GONE
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.GONE
            if (::previewQueueBtn.isInitialized) previewQueueBtn.visibility = View.VISIBLE
            iv?.colorFilter = null
        }

        photoPreviewOverlay.visibility = View.VISIBLE
    }

    private fun nextStagedAfter(current: SessionPhoto): SessionPhoto? {
        return synchronized(sessionPhotos) {
            val staged = sessionPhotos.filter { it.isStaged() }
            if (staged.isEmpty()) {
                null
            } else {
                val idx = staged.indexOf(current)
                if (idx >= 0 && idx + 1 < staged.size) staged[idx + 1]
                else staged.firstOrNull { it != current }
            }
        }
    }

    private fun approveStagedPhoto(photo: SessionPhoto, advancePreview: Boolean) {
        val srcFile = synchronized(sessionPhotos) {
            val f = photo.stagedFile
            if (f == null || !f.exists()) null
            else {
                photo.stagedFile = null
                photo.promoting = true
                f
            }
        } ?: return
        selectedStagedPaths.remove(srcFile.absolutePath)
        val nextPhoto = if (advancePreview) nextStagedAfter(photo) else null
        val adjBrightness = photo.brightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)

        if (advancePreview) {
            if (nextPhoto != null) {
                showPhotoPreview(nextPhoto)
            } else {
                previewingPhoto = null
                photoPreviewOverlay.visibility = View.GONE
                Toast.makeText(this, "📤 Sending photo — all waiting shots reviewed!", Toast.LENGTH_SHORT).show()
            }
        }

        ingestExecutor.execute {
            val seq = pendingSeq.incrementAndGet() % 10000
            val baseName = String.format(Locale.US, "rove_%013d_%04d.jpg", System.currentTimeMillis(), seq)
            val destFile = File(getPendingDir(), baseName)
            val ok = promoteStagedToPendingFile(srcFile, destFile, adjBrightness)
            if (ok && destFile.exists()) {
                photo.pendingFile = destFile
                photo.promoting = false
                // Refresh thumbnail to reflect baked exposure when brightness != 0
                if (adjBrightness != 0) {
                    val fresh = saveThumbnailFromFile(destFile)
                    if (fresh != null) {
                        try {
                            thumbCache.remove(photo.thumbFile.absolutePath)
                            fresh.first.copyTo(photo.thumbFile, overwrite = true)
                            fresh.first.delete()
                        } catch (_: Exception) { }
                    }
                }
                mainHandler.post {
                    if (isFinishing || isDestroyed) return@post
                    if (photo.thumbFile.exists()) updateThumbnailFromFile(photo.thumbFile, 0)
                    lastSentText.text = if (targetUrl.trim().isEmpty()) {
                        "⏳ Approved & queued — scan Laptop QR to send"
                    } else {
                        "📤 Sending selected photo" + (if (adjBrightness != 0) " (${formatBrightness(adjBrightness)})…" else "…")
                    }
                    refreshQueueUi()
                    notifyGalleryChanged()
                    if (targetUrl.trim().isNotEmpty()) kickRetryQueue(0L)
                }
            } else {
                // Restore staged reference if disk promotion failed
                if (srcFile.exists()) photo.stagedFile = srcFile
                photo.promoting = false
                mainHandler.post {
                    if (isFinishing || isDestroyed) return@post
                    Toast.makeText(this, "Could not prepare photo for upload", Toast.LENGTH_SHORT).show()
                    refreshQueueUi()
                    notifyGalleryChanged()
                }
            }
        }
    }

    private fun discardStagedPhoto(photo: SessionPhoto, advancePreview: Boolean) {
        val nextPhoto = if (advancePreview) nextStagedAfter(photo) else null
        synchronized(sessionPhotos) {
            photo.stagedFile?.let { f ->
                selectedStagedPaths.remove(f.absolutePath)
                try { f.delete() } catch (_: Exception) { }
            }
            photo.stagedFile = null
            try { photo.thumbFile.delete() } catch (_: Exception) { }
            sessionPhotos.remove(photo)
        }
        if (advancePreview) {
            if (nextPhoto != null) {
                showPhotoPreview(nextPhoto)
            } else {
                previewingPhoto = null
                photoPreviewOverlay.visibility = View.GONE
            }
        }
        refreshQueueUi()
        notifyGalleryChanged()
        Toast.makeText(this, "Skipped photo (not sent to laptop)", Toast.LENGTH_SHORT).show()
    }

    private fun confirmSendAllStaged() {
        val staged = synchronized(sessionPhotos) { sessionPhotos.filter { it.isStaged() } }
        if (staged.isEmpty()) {
            Toast.makeText(this, "No waiting photos to send", Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Send All ${staged.size} Waiting Photo(s)?")
            .setMessage("All ${staged.size} picked/waiting photo(s) will be sent to the laptop base station with their current brightness settings.")
            .setPositiveButton("Send All (${staged.size})") { _, _ ->
                approveStagedList(staged)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun sendSelectedStagedPhotos() {
        val picked = synchronized(sessionPhotos) {
            sessionPhotos.filter { p -> p.isStaged() && p.stagedFile?.absolutePath in selectedStagedPaths }
        }
        if (picked.isEmpty()) {
            Toast.makeText(this, "Tap photos to select them first", Toast.LENGTH_SHORT).show()
            return
        }
        gallerySelectMode = false
        selectedStagedPaths.clear()
        approveStagedList(picked)
    }

    private fun discardSelectedStagedPhotos() {
        val picked = synchronized(sessionPhotos) {
            sessionPhotos.filter { p -> p.isStaged() && p.stagedFile?.absolutePath in selectedStagedPaths }
        }
        if (picked.isEmpty()) return
        AlertDialog.Builder(this)
            .setTitle("Discard ${picked.size} Photo(s)?")
            .setMessage("Selected photo(s) will be removed from this phone and not sent to the laptop.")
            .setPositiveButton("Discard (${picked.size})") { _, _ ->
                synchronized(sessionPhotos) {
                    for (p in picked) {
                        p.stagedFile?.let { f ->
                            selectedStagedPaths.remove(f.absolutePath)
                            try { f.delete() } catch (_: Exception) { }
                        }
                        p.stagedFile = null
                        try { p.thumbFile.delete() } catch (_: Exception) { }
                        sessionPhotos.remove(p)
                    }
                }
                gallerySelectMode = false
                selectedStagedPaths.clear()
                refreshQueueUi()
                notifyGalleryChanged()
                Toast.makeText(this, "Discarded ${picked.size} photo(s)", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun approveStagedList(list: List<SessionPhoto>) {
        if (list.isEmpty()) return
        // Send oldest-first so photos land on laptop in capture order
        val ordered = list.reversed()
        for (p in ordered) {
            approveStagedPhoto(p, advancePreview = false)
        }
        Toast.makeText(this, "📤 Queued ${ordered.size} photo(s) to send to laptop", Toast.LENGTH_SHORT).show()
    }

    private fun clearSessionGallery() {
        val pending = pendingCount()
        val staged = stagedCount()
        if (pending > 0 || staged > 0) {
            val parts = mutableListOf<String>()
            if (staged > 0) parts.add("$staged waiting for your pick")
            if (pending > 0) parts.add("$pending uploading")
            AlertDialog.Builder(this)
                .setTitle("Unsent Photos Remaining")
                .setMessage("${parts.joinToString(" and ")}.")
                .setPositiveButton("Clear Sent Only") { _, _ ->
                    synchronized(sessionPhotos) {
                        val it = sessionPhotos.iterator()
                        while (it.hasNext()) {
                            val p = it.next()
                            if (p.success || (!p.isQueued() && !p.isStaged())) {
                                try { p.thumbFile.delete() } catch (_: Exception) { }
                                it.remove()
                            }
                        }
                    }
                    notifyGalleryChanged()
                    refreshQueueUi()
                    Toast.makeText(this, "Cleared sent photos; kept unsent shots", Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton("Delete All") { _, _ ->
                    for (f in listPendingFiles()) {
                        try { f.delete() } catch (_: Exception) { }
                    }
                    for (f in listStagedFiles()) {
                        try { f.delete() } catch (_: Exception) { }
                    }
                    selectedStagedPaths.clear()
                    synchronized(sessionPhotos) {
                        for (p in sessionPhotos) {
                            try { p.thumbFile.delete() } catch (_: Exception) { }
                            try { p.pendingFile?.delete() } catch (_: Exception) { }
                            try { p.stagedFile?.delete() } catch (_: Exception) { }
                        }
                        sessionPhotos.clear()
                    }
                    notifyGalleryChanged()
                    refreshQueueUi()
                    Toast.makeText(this, "All photos and queues cleared", Toast.LENGTH_SHORT).show()
                }
                .setNeutralButton("Cancel", null)
                .show()
            return
        }

        synchronized(sessionPhotos) {
            for (p in sessionPhotos) {
                try { p.thumbFile.delete() } catch (_: Exception) { }
            }
            sessionPhotos.clear()
        }
        notifyGalleryChanged()
        refreshQueueUi()
        Toast.makeText(this, "Session photos cleared", Toast.LENGTH_SHORT).show()
    }

    private fun notifyGalleryChanged() {
        val totalCount: Int
        val stagedNum: Int
        val sentNum: Int
        synchronized(sessionPhotos) {
            totalCount = sessionPhotos.size
            stagedNum = sessionPhotos.count { it.isStaged() }
            sentNum = totalCount - stagedNum
            // Prune stale selection paths
            val validPaths = sessionPhotos.mapNotNull { if (it.isStaged()) it.stagedFile?.absolutePath else null }.toSet()
            selectedStagedPaths.retainAll(validPaths)
        }
        if (stagedNum == 0 && gallerySelectMode) {
            gallerySelectMode = false
            selectedStagedPaths.clear()
        }
        val visible = filteredGalleryPhotos()

        if (::galleryTitleText.isInitialized) {
            galleryTitleText.text = if (stagedNum > 0) "☑️ Review & Pick ($stagedNum)" else "📸 Session Photos ($totalCount)"
        }
        if (::galleryFilterAllBtn.isInitialized) {
            galleryFilterAllBtn.text = "All ($totalCount)"
            galleryFilterAllBtn.background = makeCard(Color.parseColor(if (galleryFilter == "all") "#1C1A1E" else "#E4DCCF"), 10f)
            galleryFilterAllBtn.setTextColor(if (galleryFilter == "all") Color.WHITE else Color.parseColor("#4A444D"))
        }
        if (::galleryFilterPickBtn.isInitialized) {
            galleryFilterPickBtn.text = "☑️ To Pick ($stagedNum)"
            galleryFilterPickBtn.background = makeCard(Color.parseColor(if (galleryFilter == "pick") "#4F46E5" else "#E4DCCF"), 10f)
            galleryFilterPickBtn.setTextColor(if (galleryFilter == "pick") Color.WHITE else Color.parseColor("#3730A3"))
        }
        if (::galleryFilterSentBtn.isInitialized) {
            galleryFilterSentBtn.text = "✓ Sent ($sentNum)"
            galleryFilterSentBtn.background = makeCard(Color.parseColor(if (galleryFilter == "sent") "#2EA66B" else "#E4DCCF"), 10f)
            galleryFilterSentBtn.setTextColor(if (galleryFilter == "sent") Color.WHITE else Color.parseColor("#166534"))
        }
        if (::gallerySelectBtn.isInitialized) {
            gallerySelectBtn.visibility = if (stagedNum > 0) View.VISIBLE else View.GONE
            gallerySelectBtn.text = if (gallerySelectMode) "Cancel Pick" else "☑ Multi-Pick"
            gallerySelectBtn.background = makeCard(Color.parseColor(if (gallerySelectMode) "#4F46E5" else "#E4DCCF"), 10f)
            gallerySelectBtn.setTextColor(if (gallerySelectMode) Color.WHITE else Color.parseColor("#1C1A1E"))
        }
        if (::galleryBatchBar.isInitialized) {
            if (gallerySelectMode && stagedNum > 0) {
                val selN = selectedStagedPaths.size
                galleryBatchBar.visibility = View.VISIBLE
                galleryBatchSendBtn.text = "📤 Send Selected ($selN)"
                galleryBatchSendBtn.isEnabled = selN > 0
                galleryBatchSendBtn.alpha = if (selN > 0) 1f else 0.5f
                galleryBatchDiscardBtn.visibility = View.VISIBLE
                galleryBatchDiscardBtn.text = "🗑️ Discard ($selN)"
                galleryBatchDiscardBtn.isEnabled = selN > 0
                galleryBatchDiscardBtn.alpha = if (selN > 0) 1f else 0.5f
            } else if (stagedNum > 0 && (galleryFilter == "pick" || galleryFilter == "all")) {
                galleryBatchBar.visibility = View.VISIBLE
                galleryBatchSendBtn.text = "📤 Send All Waiting ($stagedNum)"
                galleryBatchSendBtn.isEnabled = true
                galleryBatchSendBtn.alpha = 1f
                galleryBatchDiscardBtn.visibility = View.GONE
            } else {
                galleryBatchBar.visibility = View.GONE
            }
        }
        if (::gallerySubHint.isInitialized) {
            gallerySubHint.text = when {
                gallerySelectMode -> "Tap waiting shots to check/uncheck them, then tap Send Selected."
                stagedNum > 0 -> "Tap a photo to preview, adjust brightness & Send to Laptop — or long-press to multi-pick."
                else -> "Tap any photo to enlarge • Unsent shots auto-upload when Wi-Fi reconnects."
            }
        }
        if (::galleryEmptyText.isInitialized && ::galleryGrid.isInitialized) {
            if (visible.isEmpty()) {
                galleryEmptyText.text = when {
                    totalCount == 0 -> "No photos taken yet in this session.\n\nConnect your DSLR and snap photos with the camera shutter—they will appear here!"
                    galleryFilter == "pick" -> "All caught up!\n\nNo photos waiting for review right now."
                    else -> "No sent photos yet.\n\nSwitch to ☑️ To Pick to choose shots to send to the laptop."
                }
                galleryEmptyText.visibility = View.VISIBLE
                galleryGrid.visibility = View.GONE
            } else {
                galleryEmptyText.visibility = View.GONE
                galleryGrid.visibility = View.VISIBLE
            }
        }
        galleryAdapter?.notifyDataSetChanged()
    }

    private fun openLaptopQueue() {
        val raw = laptopInput.text.toString().trim().ifEmpty { targetUrl.trim() }
        if (raw.isEmpty()) {
            Toast.makeText(this, "Connect to laptop first by scanning the Photographer Desk QR code", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val clean = cleanUrl(raw)
            val targetWeb = if (clean.contains("/send/") && !clean.endsWith("/photos")) "$clean/photos" else clean
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(targetWeb))
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "Could not open browser: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun getThumbsDir(): File {
        val d = File(cacheDir, "rove_thumbs")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun cleanOldThumbnails() {
        try {
            val dir = getThumbsDir()
            val files = dir.listFiles() ?: return
            val oneDayAgo = System.currentTimeMillis() - (24 * 60 * 60 * 1000)
            for (f in files) {
                if (f.lastModified() < oneDayAgo) {
                    f.delete()
                }
            }
        } catch (_: Exception) { }
    }

    private fun loadCachedThumbnail(file: File): Bitmap? {
        val key = file.absolutePath
        thumbCache.get(key)?.let { if (!it.isRecycled) return it }
        if (!file.exists()) return null
        val bmp = try { BitmapFactory.decodeFile(key) } catch (_: Exception) { null } ?: return null
        thumbCache.put(key, bmp)
        return bmp
    }

    private fun saveCompressedThumbnail(bytes: ByteArray): Pair<File, String>? {
        return try {
            val orientExif = readExifOrientation(bytes)
            val opts = BitmapFactory.Options().apply {
                inSampleSize = 4 // read 1/4 width & height into memory for fast decoding
            }
            val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            val bmp = applyExifRotation(raw, orientExif)
            val orientLabel = classifyOrient(bmp.width, bmp.height)
            val maxDim = 480
            val w = bmp.width
            val h = bmp.height
            val scaled = if (w > maxDim || h > maxDim) {
                val ratio = if (w > h) maxDim.toFloat() / w else maxDim.toFloat() / h
                val sw = (w * ratio).toInt().coerceAtLeast(1)
                val sh = (h * ratio).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(bmp, sw, sh, true).also {
                    if (it != bmp) bmp.recycle()
                }
            } else {
                bmp
            }

            val file = File(getThumbsDir(), "thumb_${System.currentTimeMillis()}_${(100..999).random()}.jpg")
            file.outputStream().use { out ->
                scaled.compress(Bitmap.CompressFormat.JPEG, 78, out)
                out.flush()
            }
            thumbCache.put(file.absolutePath, scaled)
            Pair(file, orientLabel)
        } catch (e: Exception) {
            Log.w(TAG, "Error saving compressed thumbnail: ${e.message}")
            null
        }
    }

    private fun updateThumbnailFromFile(file: File, previewBrightness: Int = 0) {
        try {
            val bmp = loadCachedThumbnail(file) ?: return
            lastPhotoBitmap = bmp
            thumbnailView.setImageBitmap(bmp)
            thumbnailView.colorFilter = brightnessColorFilter(previewBrightness)
        } catch (e: Exception) {
            Log.w(TAG, "Thumbnail display error: ${e.message}")
        }
    }

    private inner class GalleryGridAdapter : BaseAdapter() {
        override fun getCount(): Int = filteredGalleryPhotos().size
        override fun getItem(position: Int): SessionPhoto = filteredGalleryPhotos()[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val list = filteredGalleryPhotos()
            if (list.isEmpty()) return convertView ?: View(this@RovingBridgeActivity)
            val photo = list[position.coerceIn(0, list.lastIndex)]
            val cell = (convertView as? FrameLayout) ?: FrameLayout(this@RovingBridgeActivity).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(118))
                background = makeCard(Color.parseColor("#1E1C21"), 12f)
                clipToOutline = true

                val iv = ImageView(this@RovingBridgeActivity).apply {
                    tag = "iv"
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                }
                addView(iv)

                val orientBadge = TextView(this@RovingBridgeActivity).apply {
                    tag = "orient_badge"
                    textSize = 9.5f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    setPadding(dp(5), dp(1), dp(5), dp(1))
                    val olp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        gravity = Gravity.TOP or Gravity.START
                        setMargins(dp(4), dp(4), 0, 0)
                    }
                    layoutParams = olp
                }
                addView(orientBadge)

                val selBadge = TextView(this@RovingBridgeActivity).apply {
                    tag = "sel_badge"
                    textSize = 11f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    setPadding(dp(6), dp(2), dp(6), dp(2))
                    val slp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        gravity = Gravity.TOP or Gravity.END
                        setMargins(0, dp(4), dp(4), 0)
                    }
                    layoutParams = slp
                }
                addView(selBadge)

                val badge = TextView(this@RovingBridgeActivity).apply {
                    tag = "badge"
                    textSize = 9.5f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    setPadding(dp(6), dp(2), dp(6), dp(2))
                    val blp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        gravity = Gravity.BOTTOM or Gravity.START
                        setMargins(dp(4), 0, 0, dp(4))
                    }
                    layoutParams = blp
                }
                addView(badge)
            }

            val iv = cell.findViewWithTag<ImageView>("iv")
            val orientBadge = cell.findViewWithTag<TextView>("orient_badge")
            val selBadge = cell.findViewWithTag<TextView>("sel_badge")
            val badge = cell.findViewWithTag<TextView>("badge")

            if (iv != null) {
                try {
                    val bmp = loadCachedThumbnail(photo.thumbFile)
                    iv.setImageBitmap(bmp)
                    iv.colorFilter = if (photo.isStaged()) brightnessColorFilter(photo.brightness) else null
                } catch (_: Exception) {
                    iv.setImageDrawable(null)
                    iv.colorFilter = null
                }
            }

            if (orientBadge != null) {
                when (photo.orient) {
                    "portrait" -> {
                        orientBadge.text = "▯ Port"
                        orientBadge.background = makeCard(Color.parseColor("#E65B4BD6"), 6f)
                        orientBadge.visibility = View.VISIBLE
                    }
                    "landscape" -> {
                        orientBadge.text = "▭ Land"
                        orientBadge.background = makeCard(Color.parseColor("#E60D7C66"), 6f)
                        orientBadge.visibility = View.VISIBLE
                    }
                    else -> orientBadge.visibility = View.GONE
                }
            }

            val stagedPath = photo.stagedFile?.absolutePath
            val isChecked = gallerySelectMode && photo.isStaged() && stagedPath != null && stagedPath in selectedStagedPaths
            if (selBadge != null) {
                if (gallerySelectMode && photo.isStaged()) {
                    selBadge.text = if (isChecked) "✓" else "○"
                    selBadge.background = makeCard(
                        Color.parseColor(if (isChecked) "#4F46E5" else "#99000000"),
                        10f
                    )
                    selBadge.visibility = View.VISIBLE
                } else if (photo.isStaged() && photo.brightness != 0) {
                    selBadge.text = "☀${if (photo.brightness > 0) "+" else ""}${photo.brightness}%"
                    selBadge.background = makeCard(Color.parseColor("#CCF59E0B"), 6f)
                    selBadge.visibility = View.VISIBLE
                } else {
                    selBadge.visibility = View.GONE
                }
            }

            if (badge != null) {
                if (photo.isStaged()) {
                    badge.text = "${photo.timeStr} ☑️"
                    badge.background = makeCard(Color.parseColor("#E64F46E5"), 6f)
                } else if (photo.success) {
                    badge.text = "${photo.timeStr} ✓"
                    badge.background = makeCard(Color.parseColor("#CC1B7358"), 6f)
                } else if (photo.isQueued()) {
                    badge.text = "${photo.timeStr} ⏳"
                    badge.background = makeCard(Color.parseColor("#CCD97706"), 6f)
                } else {
                    badge.text = "${photo.timeStr} ✗"
                    badge.background = makeCard(Color.parseColor("#CCC83924"), 6f)
                }
            }

            cell.setOnClickListener {
                if (gallerySelectMode && photo.isStaged() && stagedPath != null) {
                    if (!selectedStagedPaths.add(stagedPath)) selectedStagedPaths.remove(stagedPath)
                    notifyGalleryChanged()
                } else {
                    showPhotoPreview(photo)
                }
            }
            cell.setOnLongClickListener {
                if (photo.isStaged() && stagedPath != null) {
                    gallerySelectMode = true
                    selectedStagedPaths.add(stagedPath)
                    notifyGalleryChanged()
                    true
                } else {
                    false
                }
            }

            return cell
        }
    }

    // ================================================================ BACKGROUND WORKER

    private fun startWorker() {
        if (isRunning.getAndSet(true)) return
        lastWorkerBatteryAt = 0L
        workerThread = Thread({
            Log.i(TAG, "Roving bridge worker started")
            while (isRunning.get()) {
                var drainedAny = false
                var connectedNow = false
                try {
                    val cam = getCameraHelper()
                    cam.setRovingSaveToCard(saveToCardEnabled)
                    if (!cam.isCameraOpen()) {
                        cam.ensureOpen(roving = true, saveToCard = saveToCardEnabled)
                        lastWorkerBatteryAt = 0L
                    }

                    val connected = cam.isCameraOpen()
                    connectedNow = connected
                    val camName = if (connected) cam.cameraName() else "No DSLR Connected"
                    val nowMs = System.currentTimeMillis()
                    if (connected && (lastWorkerBatteryAt == 0L || nowMs - lastWorkerBatteryAt >= 5000L)) {
                        cachedWorkerBattery = cam.cameraBattery()
                        lastWorkerBatteryAt = nowMs
                    } else if (!connected) {
                        cachedWorkerBattery = -1
                        lastWorkerBatteryAt = 0L
                    }
                    val battery = if (connected) cachedWorkerBattery else -1
                    val note = if (connected) cam.cameraSetupNote().trim() else ""
                    val sdHint = if (note.isNotEmpty()) note else if (saveToCardEnabled) "Backup + RAW saved to camera SD card" else ""

                    if (lastUiConnected != connected || lastUiName != camName || lastUiBattery != battery || lastUiSdHint != sdHint) {
                        lastUiConnected = connected
                        lastUiName = camName
                        lastUiBattery = battery
                        lastUiSdHint = sdHint
                        mainHandler.post {
                            if (!isFinishing && !isDestroyed) updateCameraStatus(connected, camName, battery, note)
                        }
                    }

                    if (connected) {
                        // Drain all newly captured JPEGs (including burst clicks) from the camera
                        val photos = cam.pollNewPhotos()
                        if (photos.isNotEmpty()) {
                            drainedAny = true
                            for (jpegBytes in photos) {
                                if (jpegBytes.isNotEmpty()) enqueueCapturedPhoto(jpegBytes)
                            }
                        }
                    }
                    if (!isDraining.get() && !drainQueued.get() && System.currentTimeMillis() >= nextRetryAtMs && cleanUrl(targetUrl.trim()).isNotEmpty() && pendingCount() > 0) {
                        scheduleDrain()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error in worker loop: ${e.message}")
                }

                val waitMs = when {
                    drainedAny -> 15L
                    connectedNow -> 80L
                    else -> 250L
                }
                try { Thread.sleep(waitMs) } catch (_: InterruptedException) { break }
            }
            Log.i(TAG, "Roving bridge worker stopped")
        }, "roving-bridge-worker").apply {
            isDaemon = true
            start()
        }
    }

    private fun stopWorker() {
        isRunning.set(false)
        workerThread?.interrupt()
        workerThread = null
    }

    private fun updateCameraStatus(connected: Boolean, name: String, battery: Int, note: String = "") {
        if (connected) {
            if (lastUiPillConnected != true) {
                statusPill.text = "● READY"
                statusPill.setTextColor(Color.parseColor("#2EA66B"))
                statusPill.background = makeCard(Color.parseColor("#EAF7EF"), 10f)
                lastUiPillConnected = true
            }
            cameraTitle.text = name
            val base = if (battery >= 0) "Connected via USB • Battery $battery%" else "Connected via USB • Ready to shoot"
            val sdHint = if (note.isNotEmpty()) note else if (saveToCardEnabled) "Backup + RAW saved to camera SD card" else ""
            cameraSub.text = if (sdHint.isNotEmpty()) "$base\n💾 $sdHint" else base
            triggerButton.isEnabled = true
        } else {
            if (lastUiPillConnected != false) {
                statusPill.text = "● DISCONNECTED"
                statusPill.setTextColor(Color.parseColor("#C93D27"))
                statusPill.background = makeCard(Color.parseColor("#FBEBE8"), 10f)
                lastUiPillConnected = false
            }
            cameraTitle.text = "No DSLR Connected"
            cameraSub.text = "Plug your Canon, Nikon, or Sony DSLR into this phone or tablet with a USB cable."
            triggerButton.isEnabled = false
        }
    }

    // ================================================================ OFFLINE QUEUE & PHOTO UPLOADER

    private fun getPendingDir(): File {
        val d = File(filesDir, "rove_pending")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun getStagedDir(): File {
        val d = File(filesDir, "rove_staged")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun getFailedDir(): File {
        val d = File(filesDir, "rove_failed")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun quarantineFile(file: File): File? {
        return try {
            val dest = File(getFailedDir(), file.name)
            if (file.renameTo(dest)) dest else {
                file.copyTo(dest, overwrite = true)
                file.delete()
                dest
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not quarantine ${file.name}: ${e.message}")
            try { file.delete() } catch (_: Exception) { }
            null
        }
    }

    private fun listPendingFiles(): List<File> {
        val dir = getPendingDir()
        val files = dir.listFiles() ?: return emptyList()
        return files.filter { it.isFile && it.name.endsWith(".jpg", ignoreCase = true) }
            .sortedBy { it.name }
    }

    private fun pendingCount(): Int = listPendingFiles().size

    private fun listStagedFiles(): List<File> {
        val dir = getStagedDir()
        val files = dir.listFiles() ?: return emptyList()
        return files.filter { it.isFile && it.name.endsWith(".jpg", ignoreCase = true) }
            .sortedBy { it.name }
    }

    private fun stagedCount(): Int = listStagedFiles().size

    private fun saveStagedPhotoFile(bytes: ByteArray): File? {
        return try {
            val dir = getStagedDir()
            val seq = pendingSeq.incrementAndGet() % 10000
            val baseName = String.format(Locale.US, "stage_%013d_%04d.jpg", System.currentTimeMillis(), seq)
            val tmp = File(dir, "$baseName.tmp")
            val dest = File(dir, baseName)
            tmp.outputStream().use { out ->
                out.write(bytes)
                out.flush()
            }
            if (tmp.renameTo(dest)) dest else {
                tmp.copyTo(dest, overwrite = true)
                tmp.delete()
                dest
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error saving staged photo: ${e.message}")
            null
        }
    }

    private fun savePendingPhotoFile(bytes: ByteArray): File? {
        return try {
            val dir = getPendingDir()
            val seq = pendingSeq.incrementAndGet() % 10000
            val baseName = String.format(Locale.US, "rove_%013d_%04d.jpg", System.currentTimeMillis(), seq)
            val tmp = File(dir, "$baseName.tmp")
            val dest = File(dir, baseName)
            tmp.outputStream().use { out ->
                out.write(bytes)
                out.flush()
            }
            if (tmp.renameTo(dest)) dest else {
                tmp.copyTo(dest, overwrite = true)
                tmp.delete()
                dest
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error saving pending photo: ${e.message}")
            null
        }
    }

    private fun saveThumbnailFromFile(file: File): Pair<File, String>? {
        return try {
            val orientExif = readExifOrientation(file)
            val opts = BitmapFactory.Options().apply { inSampleSize = 4 }
            val raw = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
            val bmp = applyExifRotation(raw, orientExif)
            val orientLabel = classifyOrient(bmp.width, bmp.height)
            val maxDim = 480
            val w = bmp.width
            val h = bmp.height
            val scaled = if (w > maxDim || h > maxDim) {
                val ratio = if (w > h) maxDim.toFloat() / w else maxDim.toFloat() / h
                val sw = (w * ratio).toInt().coerceAtLeast(1)
                val sh = (h * ratio).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(bmp, sw, sh, true).also {
                    if (it != bmp) bmp.recycle()
                }
            } else {
                bmp
            }
            val thumb = File(getThumbsDir(), "thumb_${System.currentTimeMillis()}_${(100..999).random()}.jpg")
            thumb.outputStream().use { out ->
                scaled.compress(Bitmap.CompressFormat.JPEG, 78, out)
                out.flush()
            }
            scaled.recycle()
            Pair(thumb, orientLabel)
        } catch (e: Exception) {
            Log.w(TAG, "Error creating thumbnail from pending file: ${e.message}")
            null
        }
    }

    private fun restorePendingQueue() {
        ingestExecutor.execute {
            try {
                // Clean up abandoned .tmp files left behind if the app was killed mid-write
                val staleCutoff = System.currentTimeMillis() - 60_000L
                listOf(getPendingDir(), getStagedDir()).forEach { dir ->
                    dir.listFiles()?.forEach { f ->
                        if (f.isFile && f.name.endsWith(".tmp") && f.lastModified() < staleCutoff) {
                            try { f.delete() } catch (_: Exception) { }
                        }
                    }
                }

                val pendingFiles = listPendingFiles()
                val stagedFiles = listStagedFiles()
                if (pendingFiles.isEmpty() && stagedFiles.isEmpty()) {
                    mainHandler.post { refreshQueueUi() }
                    return@execute
                }
                val restored = mutableListOf<SessionPhoto>()
                for (f in pendingFiles) {
                    if (!f.exists() || f.length() <= 0L) {
                        try { f.delete() } catch (_: Exception) { }
                        continue
                    }
                    val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(f.lastModified()))
                    val thPair = saveThumbnailFromFile(f)
                    val thumb = thPair?.first ?: File(getThumbsDir(), "missing_${f.name}")
                    val orient = thPair?.second ?: ""
                    restored.add(0, SessionPhoto(thumb, timeStr, false, f.length(), pendingFile = f, stagedFile = null, brightness = 0, orient = orient))
                }
                for (f in stagedFiles) {
                    if (!f.exists() || f.length() <= 0L) {
                        try { f.delete() } catch (_: Exception) { }
                        continue
                    }
                    val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(f.lastModified()))
                    val thPair = saveThumbnailFromFile(f)
                    val thumb = thPair?.first ?: File(getThumbsDir(), "missing_${f.name}")
                    val orient = thPair?.second ?: ""
                    restored.add(0, SessionPhoto(thumb, timeStr, false, f.length(), pendingFile = null, stagedFile = f, brightness = defaultBrightness, orient = orient))
                }
                if (restored.isNotEmpty()) {
                    synchronized(sessionPhotos) {
                        sessionPhotos.addAll(restored)
                    }
                }
                val latest = restored.firstOrNull()
                val pCount = pendingFiles.size
                val sCount = stagedFiles.size
                mainHandler.post {
                    if (isFinishing || isDestroyed) return@post
                    if (latest != null && latest.thumbFile.exists()) {
                        updateThumbnailFromFile(latest.thumbFile, if (latest.isStaged()) latest.brightness else 0)
                    }
                    if (sCount > 0) {
                        lastSentText.text = "☑️ $sCount photo(s) waiting for your pick" + (if (pCount > 0) " • $pCount queued" else "")
                    } else if (pCount > 0) {
                        lastSentText.text = "⏳ $pCount queued photo(s) restored — waiting for laptop Wi-Fi…"
                    }
                    refreshQueueUi()
                    notifyGalleryChanged()
                    if (pCount > 0 && targetUrl.trim().isNotEmpty()) {
                        kickRetryQueue(300L)
                    }
                }
            } finally {
                restoreLatch.countDown()
            }
        }
    }

    private fun syncWakeLock() {
        synchronized<Unit>(wakeLockSync) {
            val pocketOn = ::pocketLockOverlay.isInitialized && pocketLockOverlay.visibility == View.VISIBLE
            val shouldHold = !isFinishing && !isDestroyed && (pocketOn || pendingCount() > 0)
            try {
                if (shouldHold) {
                    if (wakeLock == null) {
                        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "photobooth4u:RovingBridgeQueue")?.apply {
                            setReferenceCounted(false)
                        }
                    }
                    val wl = wakeLock
                    if (wl != null && !wl.isHeld) {
                        wl.acquire(WAKE_LOCK_TIMEOUT_MS)
                    }
                } else {
                    val wl = wakeLock
                    if (wl != null && wl.isHeld) {
                        wl.release()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "WakeLock sync error: ${e.message}")
            }
            Unit
        }
    }

    private fun releaseWakeLock() {
        synchronized<Unit>(wakeLockSync) {
            try {
                val wl = wakeLock
                if (wl != null && wl.isHeld) {
                    wl.release()
                }
            } catch (_: Exception) {
            } finally {
                wakeLock = null
            }
            Unit
        }
    }

    // ---------- Offline-safe Wi-Fi / Ethernet network binding ----------
    // On offline routers or laptop hotspots (no internet), Android marks Wi-Fi unvalidated and routes
    // default URL.openConnection() calls over mobile data (4G/5G), causing timeouts even when Wi-Fi
    // is connected. Tracking Wi-Fi/Ethernet Network handles with NET_CAPABILITY_INTERNET removed lets
    // us bind laptop HTTP traffic directly to the booth Wi-Fi interface.

    private fun registerNetworkMonitor() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        connectivityManager = cm
        val transports = intArrayOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_ETHERNET)
        for (tr in transports) {
            try {
                val req = NetworkRequest.Builder()
                    .addTransportType(tr)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                val cb = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        trackedLanNetworks.add(network)
                        if (pendingCount() > 0) kickRetryQueue(400L)
                    }

                    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                        trackedLanNetworks.add(network)
                        if (pendingCount() > 0) kickRetryQueue(400L)
                    }

                    override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                        trackedLanNetworks.add(network)
                        if (pendingCount() > 0) kickRetryQueue(250L)
                    }

                    override fun onLost(network: Network) {
                        trackedLanNetworks.remove(network)
                        if (activeUploadNetwork != null && activeUploadNetwork == network) {
                            try { activeUploadConn?.disconnect() } catch (_: Exception) { }
                        }
                    }
                }
                cm.registerNetworkCallback(req, cb)
                lanNetworkCallbacks.add(cb)
            } catch (e: Exception) {
                Log.w(TAG, "Network monitor unavailable for transport $tr: ${e.message}")
            }
        }
    }

    private fun unregisterNetworkMonitor() {
        val cm = connectivityManager
        if (cm != null) {
            for (cb in lanNetworkCallbacks) {
                try { cm.unregisterNetworkCallback(cb) } catch (_: Exception) { }
            }
        }
        lanNetworkCallbacks.clear()
        trackedLanNetworks.clear()
        connectivityManager = null
    }

    private fun ipLong(a: Inet4Address): Long =
        a.address.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }

    private fun subnetMask(prefix: Int): Long =
        if (prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - prefix.coerceAtMost(32))) and 0xFFFFFFFFL

    private fun hostOf(urlStr: String): String = try {
        URI(urlStr).host ?: ""
    } catch (_: Exception) {
        ""
    }

    private fun isPrivateLanHost(host: String): Boolean {
        val h = host.trim().lowercase(Locale.US)
        if (h.isEmpty()) return false
        if (h.endsWith(".local")) return true
        if (!IPV4_RE.matches(h)) return false
        val parts = h.split(".")
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        return a == 10 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)
    }

    @Suppress("DEPRECATION")
    private fun resolveLanNetwork(urlStr: String): Network? {
        val host = hostOf(urlStr)
        if (host.isBlank() || host == "127.0.0.1" || host == "localhost") return null
        val cm = connectivityManager ?: (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager) ?: return null
        val allNets = LinkedHashSet<Network>()
        allNets.addAll(trackedLanNetworks)
        try { allNets.addAll(cm.allNetworks.toList()) } catch (_: Exception) { }

        val targetIp = if (IPV4_RE.matches(host)) {
            try { InetAddress.getByName(host) as? Inet4Address } catch (_: Exception) { null }
        } else null
        val targetLong = targetIp?.let { ipLong(it) }

        var fallbackLan: Network? = null
        for (n in allNets) {
            val caps = try { cm.getNetworkCapabilities(n) } catch (_: Exception) { null } ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            ) continue
            val lp = try { cm.getLinkProperties(n) } catch (_: Exception) { null } ?: continue
            for (la in lp.linkAddresses) {
                val addr = la.address
                if (addr is Inet4Address && !addr.isLoopbackAddress) {
                    if (fallbackLan == null) fallbackLan = n
                    if (targetLong != null) {
                        val mask = subnetMask(la.prefixLength)
                        if ((ipLong(addr) and mask) == (targetLong and mask)) {
                            return n
                        }
                    }
                }
            }
        }
        return if (isPrivateLanHost(host)) fallbackLan else null
    }

    private fun openLanConnection(url: URL, connectMs: Int, readMs: Int, forceDefault: Boolean = false): Pair<HttpURLConnection, Network?> {
        val net = if (forceDefault) null else resolveLanNetwork(url.toString())
        val conn = (if (net != null) net.openConnection(url) else url.openConnection()) as HttpURLConnection
        conn.connectTimeout = connectMs
        conn.readTimeout = readMs
        conn.useCaches = false
        conn.setRequestProperty("Connection", "close")
        return Pair(conn, net)
    }

    private fun refreshQueueUi() {
        val pending = pendingCount()
        val staged = stagedCount()
        if (::statsCountText.isInitialized) {
            when {
                staged > 0 && pending > 0 -> {
                    statsCountText.text = "$sentPhotosCount Sent • $staged To Pick • $pending Queued"
                    statsCountText.setTextColor(Color.parseColor("#4F46E5"))
                }
                staged > 0 -> {
                    statsCountText.text = "$sentPhotosCount Sent • $staged To Pick"
                    statsCountText.setTextColor(Color.parseColor("#4F46E5"))
                }
                pending > 0 -> {
                    statsCountText.text = "$sentPhotosCount Sent • $pending Queued"
                    statsCountText.setTextColor(Color.parseColor("#D97706"))
                }
                else -> {
                    statsCountText.text = "$sentPhotosCount Photos Sent"
                    statsCountText.setTextColor(Color.parseColor("#2EA66B"))
                }
            }
        }
        if (::stagedBanner.isInitialized && ::stagedBannerText.isInitialized) {
            if (staged > 0) {
                stagedBannerText.text = "☑️ $staged photo(s) waiting for your pick"
                stagedBanner.visibility = View.VISIBLE
            } else {
                stagedBanner.visibility = View.GONE
            }
        }
        if (::galleryOpenBtn.isInitialized) {
            if (staged > 0) {
                galleryOpenBtn.text = "☑️ Review & Pick Photos ($staged waiting)"
                galleryOpenBtn.setTextColor(Color.WHITE)
                galleryOpenBtn.background = makeCard(Color.parseColor("#4F46E5"), 12f)
            } else {
                galleryOpenBtn.text = "🖼️ View Photos Gallery"
                galleryOpenBtn.setTextColor(Color.parseColor("#1C1A1E"))
                galleryOpenBtn.background = makeCard(Color.parseColor("#E4DCCF"), 12f)
            }
        }
        if (::pendingBanner.isInitialized && ::pendingBannerText.isInitialized) {
            if (pending > 0) {
                val hasUrl = targetUrl.trim().isNotEmpty()
                pendingBannerText.text = if (hasUrl) {
                    "⏳ $pending photo(s) queued — auto-uploads on Wi-Fi"
                } else {
                    "⏳ $pending photo(s) queued — scan Laptop QR to send"
                }
                pendingBanner.visibility = View.VISIBLE
            } else {
                pendingBanner.visibility = View.GONE
            }
        }
        if (::galleryRetryBtn.isInitialized) {
            if (pending > 0) {
                galleryRetryBtn.text = "🔄 Retry ($pending)"
                galleryRetryBtn.visibility = View.VISIBLE
            } else {
                galleryRetryBtn.visibility = View.GONE
            }
        }
        if (::pocketStatsText.isInitialized) {
            val bits = mutableListOf("Sent: $sentPhotosCount")
            if (staged > 0) bits.add("To Pick: $staged")
            if (pending > 0) bits.add("Queued: $pending")
            pocketStatsText.text = bits.joinToString(" • ")
        }
        syncWakeLock()
    }

    private fun retryPendingNow() {
        val clean = cleanUrl(laptopInput.text.toString().ifBlank { targetUrl })
        if (clean.isEmpty()) {
            Toast.makeText(this, "Scan the Photographer Desk QR code on your laptop first!", Toast.LENGTH_SHORT).show()
            return
        }
        if (clean != targetUrl) {
            targetUrl = clean
            laptopInput.setText(clean)
            savePrefs()
        }
        val pending = pendingCount()
        if (pending == 0) {
            refreshQueueUi()
            Toast.makeText(this, "No pending photos to send", Toast.LENGTH_SHORT).show()
            return
        }
        lastSentText.text = "🔄 Retrying $pending queued photo(s)…"
        kickRetryQueue(0L)
    }

    private fun kickRetryQueue(delayMs: Long = 0L) {
        mainHandler.removeCallbacks(retryRunnable)
        try { pendingRetryFuture?.cancel(false) } catch (_: Exception) { }
        if (isFinishing || isDestroyed) return
        if (delayMs > 0L) {
            nextRetryAtMs = System.currentTimeMillis() + delayMs
            if (!retryScheduler.isShutdown && pendingCount() > 0 && targetUrl.trim().isNotEmpty()) {
                try {
                    pendingRetryFuture = retryScheduler.schedule({
                        nextRetryAtMs = 0L
                        if (!isFinishing && !isDestroyed && pendingCount() > 0 && targetUrl.trim().isNotEmpty()) {
                            scheduleDrain()
                        }
                    }, delayMs, TimeUnit.MILLISECONDS)
                } catch (_: Exception) {
                    mainHandler.postDelayed(retryRunnable, delayMs)
                }
            }
        } else {
            nextRetryAtMs = 0L
            scheduleDrain()
        }
    }

    private fun scheduleDrain() {
        if (uploadExecutor.isShutdown) return
        if (drainQueued.compareAndSet(false, true)) {
            try {
                uploadExecutor.execute { drainPendingQueue() }
            } catch (_: Exception) {
                drainQueued.set(false)
            }
        }
    }

    private fun enqueueCapturedPhoto(bytes: ByteArray) {
        if (ingestExecutor.isShutdown) return
        ingestExecutor.execute {
            handlePhotoCaptured(bytes)
        }
    }

    private fun handlePhotoCaptured(bytes: ByteArray) {
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val currentTarget = targetUrl.trim()
        val isPickMode = pickToSendMode
        val adjBrightness = defaultBrightness.coerceIn(BRIGHTNESS_MIN, BRIGHTNESS_MAX)

        // 1. Pick-to-Send mode: save full-res original to staged folder so photographer reviews,
        //    optionally adjusts brightness, and chooses which shots to send to the laptop.
        if (isPickMode) {
            val thPair = saveCompressedThumbnail(bytes)
            val thumbFile = thPair?.first
            val orient = thPair?.second ?: ""
            val stagedFile = saveStagedPhotoFile(bytes)
            if (stagedFile == null) {
                mainHandler.post {
                    lastSentText.text = "Could not save photo to phone storage!"
                    Toast.makeText(this, "Storage full — could not save photo for review!", Toast.LENGTH_SHORT).show()
                    refreshQueueUi()
                }
                return
            }
            val displayThumb = thumbFile ?: File(getThumbsDir(), "missing_${stagedFile.name}")
            val item = SessionPhoto(
                thumbFile = displayThumb,
                timeStr = timeStr,
                success = false,
                sizeBytes = bytes.size.toLong(),
                pendingFile = null,
                stagedFile = stagedFile,
                brightness = adjBrightness,
                orient = orient
            )
            synchronized(sessionPhotos) { sessionPhotos.add(0, item) }
            val waitCount = stagedCount()
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                if (displayThumb.exists()) updateThumbnailFromFile(displayThumb, adjBrightness)
                lastSentText.text = "☑️ Captured at $timeStr ($waitCount waiting for your pick)"
                refreshQueueUi()
                notifyGalleryChanged()
                // If photographer already has Gallery open on Pick tab, keep live list fresh;
                // if Preview isn't open and screen isn't pocket-locked, keep flow effortless.
            }
            return
        }

        // 2. Auto-Send mode: apply configured brightness boost if != 0, else keep raw DSLR JPEG untouched.
        val outBytes = if (adjBrightness != 0) applyBrightnessToJpegBytes(bytes, adjBrightness) else bytes
        val pendingFile = savePendingPhotoFile(outBytes)

        if (pendingFile == null) {
            // Disk fallback: try direct in-memory upload if storage couldn't write
            val thPair = saveCompressedThumbnail(outBytes)
            val thumbFile = thPair?.first
            val orient = thPair?.second ?: ""
            val res = if (currentTarget.isNotEmpty()) uploadBytesToLaptop(currentTarget, outBytes) else UPLOAD_RETRY
            val ok = (res == UPLOAD_OK)
            if (thumbFile != null) {
                val item = SessionPhoto(thumbFile, timeStr, ok, outBytes.size.toLong(), pendingFile = null, stagedFile = null, brightness = adjBrightness, orient = orient)
                synchronized(sessionPhotos) { sessionPhotos.add(0, item) }
            }
            mainHandler.post {
                if (ok) {
                    sentPhotosCount++
                    lastSentText.text = "Last photo sent at $timeStr"
                    vibrateSuccess()
                } else {
                    lastSentText.text = "Could not save photo to phone storage!"
                    Toast.makeText(this, "Storage full — could not queue photo!", Toast.LENGTH_SHORT).show()
                }
                if (thumbFile != null && thumbFile.exists()) updateThumbnailFromFile(thumbFile, 0)
                refreshQueueUi()
                notifyGalleryChanged()
            }
            return
        }

        // Register SessionPhoto BEFORE scheduleDrain() so fast LAN uploads never finish before item exists!
        val placeholderThumb = File(getThumbsDir(), "missing_${pendingFile.name}")
        val item = SessionPhoto(placeholderThumb, timeStr, false, outBytes.size.toLong(), pendingFile = pendingFile, stagedFile = null, brightness = adjBrightness, orient = "")
        synchronized(sessionPhotos) { sessionPhotos.add(0, item) }
        if (currentTarget.isNotEmpty()) {
            nextRetryAtMs = 0L
            scheduleDrain()
        }

        val thPair = saveCompressedThumbnail(outBytes)
        if (thPair != null) {
            item.thumbFile = thPair.first
            item.orient = thPair.second
        }
        val displayThumb = item.thumbFile

        mainHandler.post {
            if (isFinishing || isDestroyed) return@post
            if (displayThumb.exists()) updateThumbnailFromFile(displayThumb, 0)
            if (currentTarget.isEmpty()) {
                lastSentText.text = "⏳ Queued on phone — scan Laptop QR to send"
                Toast.makeText(this, "Photo queued! Scan Laptop QR to send.", Toast.LENGTH_SHORT).show()
            } else if (!item.success && item.pendingFile != null) {
                val qCount = pendingCount()
                val bTag = if (adjBrightness != 0) " (${formatBrightness(adjBrightness)})" else ""
                lastSentText.text = if (qCount > 1) "📤 Uploading$bTag ($qCount in queue)…" else "📤 Sending photo$bTag…"
            }
            refreshQueueUi()
            notifyGalleryChanged()
            if (currentTarget.isNotEmpty() && pendingCount() > 0) {
                scheduleDrain()
            }
        }
    }

    private fun drainPendingQueue() {
        drainQueued.set(false)
        try {
            restoreLatch.await(5, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            return
        }
        val initialFiles = listPendingFiles()
        if (initialFiles.isEmpty()) {
            mainHandler.post { refreshQueueUi() }
            return
        }
        val clean = cleanUrl(targetUrl.trim())
        if (clean.isEmpty()) {
            mainHandler.post {
                lastSentText.text = "⏳ ${initialFiles.size} photo(s) queued — scan Laptop QR to send"
                refreshQueueUi()
            }
            return
        }

        if (!isDraining.compareAndSet(false, true)) return
        try {
            val preFiles = listPendingFiles()
            if (consecutiveUploadFails > 0 || preFiles.size > 2) {
                if (!isLaptopReachable(clean)) {
                    val n = pendingCount()
                    mainHandler.post {
                        if (isFinishing || isDestroyed) return@post
                        lastSentText.text = "⏳ $n queued — waiting for laptop Wi-Fi…"
                        refreshQueueUi()
                        if (n > 0) {
                            kickRetryQueue(RETRY_DELAY_MS)
                        }
                    }
                    return
                }
            }

            val files = listPendingFiles()
            var madeProgress = false
            var urlChanged = false
            for ((idx, file) in files.withIndex()) {
                if (isFinishing || isDestroyed) break
                if (!file.exists()) continue
                if (file.length() <= 0L) {
                    val corruptPath = file.absolutePath
                    try { file.delete() } catch (_: Exception) { }
                    madeProgress = true
                    mainHandler.post {
                        synchronized(sessionPhotos) {
                            for (p in sessionPhotos) {
                                if (p.pendingFile?.absolutePath == corruptPath) {
                                    p.success = false
                                    p.pendingFile = null
                                    break
                                }
                            }
                        }
                        refreshQueueUi()
                        notifyGalleryChanged()
                    }
                    continue
                }
                val liveClean = cleanUrl(targetUrl.trim())
                if (liveClean.isEmpty() || liveClean != clean) {
                    urlChanged = liveClean.isNotEmpty()
                    break
                }

                val total = files.size
                mainHandler.post {
                    if (!isFinishing && !isDestroyed) {
                        lastSentText.text = if (total > 1) "📤 Sending ${idx + 1}/$total queued photos…" else "📤 Sending photo…"
                    }
                }

                val t0 = System.currentTimeMillis()
                val res = uploadFileToLaptop(clean, file)
                if (res == UPLOAD_OK) {
                    consecutiveUploadFails = 0
                    madeProgress = true
                    val elapsed = System.currentTimeMillis() - t0
                    val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    val sentPath = file.absolutePath
                    try { file.delete() } catch (_: Exception) { }

                    val remAfter = pendingCount()
                    mainHandler.post {
                        if (isFinishing || isDestroyed) return@post
                        synchronized(sessionPhotos) {
                            for (p in sessionPhotos) {
                                if (p.pendingFile?.absolutePath == sentPath) {
                                    p.success = true
                                    p.pendingFile = null
                                    break
                                }
                            }
                        }
                        sentPhotosCount++
                        lastSentText.text = if (remAfter == 0) {
                            "Last photo sent at $timeStr (${elapsed}ms)"
                        } else {
                            "Sent at $timeStr (${elapsed}ms) • $remAfter left…"
                        }
                        vibrateSuccess()
                        refreshQueueUi()
                        notifyGalleryChanged()
                        val pv = previewingPhoto
                        if (pv != null && photoPreviewOverlay.visibility == View.VISIBLE && pv.pendingFile == null) {
                            showPhotoPreview(pv)
                        }
                    }
                } else if (res == UPLOAD_TOO_BIG) {
                    consecutiveUploadFails = 0
                    val skippedPath = file.absolutePath
                    quarantineFile(file)
                    madeProgress = true
                    mainHandler.post {
                        if (isFinishing || isDestroyed) return@post
                        synchronized(sessionPhotos) {
                            for (p in sessionPhotos) {
                                if (p.pendingFile?.absolutePath == skippedPath) {
                                    p.success = false
                                    p.pendingFile = null
                                    break
                                }
                            }
                        }
                        lastSentText.text = "Skipped oversized photo (>80 MB, kept in local backup)"
                        Toast.makeText(this, "Photo >80 MB kept in local backup; continuing queue", Toast.LENGTH_LONG).show()
                        refreshQueueUi()
                        notifyGalleryChanged()
                    }
                    continue
                } else {
                    consecutiveUploadFails++
                    val rem = pendingCount()
                    mainHandler.post {
                        if (isFinishing || isDestroyed) return@post
                        lastSentText.text = "⏳ $rem queued — Wi-Fi lost, auto-retrying…"
                        refreshQueueUi()
                        if (rem > 0) {
                            kickRetryQueue(RETRY_DELAY_MS)
                        }
                    }
                    return
                }
            }

            if (urlChanged) {
                kickRetryQueue(150L)
            } else if (pendingCount() > 0 && cleanUrl(targetUrl.trim()).isNotEmpty()) {
                kickRetryQueue(if (madeProgress) 250L else RETRY_DELAY_MS)
            }
        } finally {
            isDraining.set(false)
        }
    }

    private fun isLaptopReachable(cleanBaseUrl: String): Boolean {
        val pingUrl = try { URL("$cleanBaseUrl/hello") } catch (_: Exception) { return false }
        var conn: HttpURLConnection? = null
        var usedNet: Network? = null
        try {
            val pair = openLanConnection(pingUrl, 2000, 2000)
            conn = pair.first
            usedNet = pair.second
            val code = conn.responseCode
            if (code in 200..299) return true
        } catch (_: Exception) {
            // Fall through to default route only for non-private hosts
        } finally {
            try { conn?.disconnect() } catch (_: Exception) { }
        }
        if (usedNet != null && !isPrivateLanHost(hostOf(cleanBaseUrl))) {
            var fallback: HttpURLConnection? = null
            try {
                fallback = openLanConnection(pingUrl, 2000, 2000, forceDefault = true).first
                return fallback.responseCode in 200..299
            } catch (_: Exception) {
                return false
            } finally {
                try { fallback?.disconnect() } catch (_: Exception) { }
            }
        }
        return false
    }

    private fun uploadFileToLaptop(cleanBaseUrl: String, file: File): Int {
        var conn: HttpURLConnection? = null
        try {
            val len = file.length()
            if (len <= 0L) return UPLOAD_RETRY
            val encName = Uri.encode(file.name)
            val target = URL("$cleanBaseUrl/photo?name=$encName&id=$encName")
            val pair = openLanConnection(target, 5000, 20000)
            conn = pair.first
            activeUploadConn = conn
            activeUploadNetwork = pair.second
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(len)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("X-Rove-Id", file.name)
            conn.setRequestProperty("Access-Control-Allow-Origin", "*")

            FileInputStream(file).use { input ->
                conn.outputStream.use { out ->
                    val buf = ByteArray(16384)
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        out.write(buf, 0, read)
                    }
                    out.flush()
                }
            }
            val code = conn.responseCode
            return when {
                code in 200..299 -> UPLOAD_OK
                code == 413 -> UPLOAD_TOO_BIG
                else -> UPLOAD_RETRY
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to upload queued photo ${file.name}: ${e.message}")
            return UPLOAD_RETRY
        } finally {
            activeUploadConn = null
            activeUploadNetwork = null
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    private fun uploadBytesToLaptop(baseUrl: String, bytes: ByteArray): Int {
        var conn: HttpURLConnection? = null
        try {
            val clean = cleanUrl(baseUrl)
            val name = "rove_" + System.currentTimeMillis() + ".jpg"
            val target = URL("$clean/photo?name=$name&id=$name")
            val pair = openLanConnection(target, 5000, 20000)
            conn = pair.first
            activeUploadConn = conn
            activeUploadNetwork = pair.second
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("X-Rove-Id", name)
            conn.setRequestProperty("Access-Control-Allow-Origin", "*")

            conn.outputStream.use { it.write(bytes); it.flush() }
            val code = conn.responseCode
            return when {
                code in 200..299 -> UPLOAD_OK
                code == 413 -> UPLOAD_TOO_BIG
                else -> UPLOAD_RETRY
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to upload photo to laptop: ${e.message}")
            return UPLOAD_RETRY
        } finally {
            activeUploadConn = null
            activeUploadNetwork = null
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    private fun updateThumbnail(bytes: ByteArray) {
        try {
            val opts = BitmapFactory.Options().apply {
                inSampleSize = 8 // scale down for quick thumbnail
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            lastPhotoBitmap?.recycle()
            lastPhotoBitmap = bmp
            thumbnailView.setImageBitmap(bmp)
        } catch (e: Exception) {
            Log.w(TAG, "Thumbnail error: ${e.message}")
        }
    }

    private fun vibrateSuccess() {
        if (!vibrateOnSend) return
        try {
            val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(120, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(120)
            }
        } catch (_: Exception) { }
    }

    // ================================================================ TESTS & TRIGGERS

    private fun testConnection() {
        val raw = laptopInput.text.toString().trim()
        if (raw.isEmpty()) {
            Toast.makeText(this, "Please enter the laptop URL", Toast.LENGTH_SHORT).show()
            return
        }
        targetUrl = cleanUrl(raw)
        laptopInput.setText(targetUrl)
        savePrefs()

        connectionStatusText.text = "Testing connection to $targetUrl…"
        val testUrl = targetUrl
        Thread({
            var ok = false
            var msg = ""
            var c: HttpURLConnection? = null
            var usedNet: Network? = null
            try {
                val pingUrl = URL("$testUrl/hello")
                val pair = openLanConnection(pingUrl, 4000, 4000)
                c = pair.first
                usedNet = pair.second
                val code = c.responseCode
                ok = (code in 200..299)
                msg = if (ok) "Connected! Laptop ready." else "Laptop answered HTTP $code"
            } catch (e: Exception) {
                msg = "Could not reach laptop: ${e.message}"
                if (usedNet != null && !isPrivateLanHost(hostOf(testUrl))) {
                    var fb: HttpURLConnection? = null
                    try {
                        fb = openLanConnection(URL("$testUrl/hello"), 4000, 4000, forceDefault = true).first
                        val code = fb.responseCode
                        ok = (code in 200..299)
                        msg = if (ok) "Connected! Laptop ready." else "Laptop answered HTTP $code"
                    } catch (_: Exception) {
                    } finally {
                        try { fb?.disconnect() } catch (_: Exception) { }
                    }
                }
            } finally {
                try { c?.disconnect() } catch (_: Exception) { }
            }

            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                connectionStatusText.text = if (ok) "✅ $msg" else "❌ $msg"
                connectionStatusText.setTextColor(if (ok) Color.parseColor("#2EA66B") else Color.parseColor("#C93D27"))
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
                refreshQueueUi()
                if (pendingCount() > 0) {
                    kickRetryQueue(if (ok) 100L else RETRY_DELAY_MS)
                }
            }
        }, "test-connection").start()
    }

    private fun pasteFromClipboard() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = cm?.primaryClip
        if (clip != null && clip.itemCount > 0) {
            val text = clip.getItemAt(0).text?.toString()?.trim() ?: ""
            if (text.isNotEmpty()) {
                laptopInput.setText(text)
                testConnection()
                return
            }
        }
        Toast.makeText(this, "Clipboard is empty", Toast.LENGTH_SHORT).show()
    }

    private fun testShutterTrigger() {
        val cam = getCameraHelper()
        if (!cam.isCameraOpen()) {
            Toast.makeText(this, "DSLR is not connected", Toast.LENGTH_SHORT).show()
            return
        }

        triggerButton.isEnabled = false
        triggerButton.text = "Capturing…"
        Thread({
            try {
                val bytes = cam.triggerCapture()
                mainHandler.post {
                    triggerButton.isEnabled = true
                    triggerButton.text = "📸 Test Shutter"
                    if (bytes != null && bytes.isNotEmpty()) {
                        enqueueCapturedPhoto(bytes)
                        Toast.makeText(this, "Photo snapped & queued for laptop!", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this, "Shutter refused or no photo returned", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                mainHandler.post {
                    triggerButton.isEnabled = true
                    triggerButton.text = "📸 Test Shutter"
                    Toast.makeText(this, "Shutter failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }, "manual-trigger").start()
    }
}
