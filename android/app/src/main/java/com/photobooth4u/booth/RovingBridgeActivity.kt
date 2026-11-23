package com.photobooth4u.booth

import android.annotation.SuppressLint
import android.Manifest
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.util.Log
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
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
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
        private const val RETRY_DELAY_MS = 3500L
        private const val UPLOAD_OK = 0
        private const val UPLOAD_RETRY = 1
        private const val UPLOAD_TOO_BIG = 2
    }

    /** Lightweight metadata for session photos history */
    data class SessionPhoto(
        val thumbFile: File,
        val timeStr: String,
        @Volatile var success: Boolean,
        val sizeBytes: Long,
        @Volatile var pendingFile: File? = null
    )

    private val isRunning = AtomicBoolean(false)
    private var workerThread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ingestExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val uploadExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val drainQueued = AtomicBoolean(false)
    private val isDraining = AtomicBoolean(false)
    private val pendingSeq = AtomicInteger(0)
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val retryRunnable = Runnable { kickRetryQueue(0L) }
    private var localCameraHelper: UsbCameraHelper? = null

    private var targetUrl: String = ""
    private var vibrateOnSend: Boolean = true
    private var sentPhotosCount: Int = 0

    // UI elements
    private lateinit var rootLayout: FrameLayout
    private lateinit var statusPill: TextView
    private lateinit var cameraTitle: TextView
    private lateinit var cameraSub: TextView
    private lateinit var laptopInput: EditText
    private lateinit var connectionStatusText: TextView
    private lateinit var statsCountText: TextView
    private lateinit var lastSentText: TextView
    private lateinit var thumbnailView: ImageView
    private lateinit var pendingBanner: LinearLayout
    private lateinit var pendingBannerText: TextView
    private lateinit var triggerButton: Button
    private lateinit var pocketLockOverlay: FrameLayout
    private lateinit var pocketStatsText: TextView

    // Session Gallery & Preview Overlays
    private lateinit var galleryOverlay: FrameLayout
    private lateinit var galleryGrid: GridView
    private lateinit var galleryEmptyText: TextView
    private lateinit var galleryTitleText: TextView
    private lateinit var galleryRetryBtn: Button
    private lateinit var photoPreviewOverlay: FrameLayout
    private lateinit var previewRetryBtn: Button
    private var previewingPhoto: SessionPhoto? = null
    private var galleryAdapter: GalleryGridAdapter? = null

    // Updates & Changelog Overlay
    private lateinit var updatesOverlay: FrameLayout
    private lateinit var updatesStatusText: TextView
    private lateinit var updatesDownloadBtn: Button

    private val sessionPhotos = mutableListOf<SessionPhoto>()
    private var lastPhotoBitmap: Bitmap? = null

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
        // Keep worker & auto-retry alive if pocket lock is active, otherwise pause timers cleanly
        if (pocketLockOverlay.visibility != View.VISIBLE) {
            stopWorker()
            mainHandler.removeCallbacks(retryRunnable)
        }
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
        try { ingestExecutor.shutdownNow() } catch (_: Exception) { }
        try { uploadExecutor.shutdownNow() } catch (_: Exception) { }
        try {
            localCameraHelper?.stop()
            localCameraHelper = null
        } catch (_: Exception) { }
        lastPhotoBitmap?.recycle()
        lastPhotoBitmap = null
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
    }

    private fun savePrefs() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, targetUrl.trim())
            .putBoolean(KEY_VIBRATE, vibrateOnSend)
            .apply()
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

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
            gravity = Gravity.CENTER_HORIZONTAL
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
            "v" + (pInfo.versionName ?: "1.1.2")
        } catch (_: Exception) {
            "v1.1.2"
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
            setOnClickListener { showGalleryOverlay() }
        }

        thumbnailView = ImageView(this).apply {
            background = makeCard(Color.parseColor("#E4DCCF"), 8f)
            scaleType = ImageView.ScaleType.CENTER_CROP
            layoutParams = LinearLayout.LayoutParams(dp(70), dp(70))
            isClickable = true
            isFocusable = true
            setOnClickListener { showGalleryOverlay() }
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
            text = "🖼️ Tap to view all sent photos ➔"
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

        val galleryBtn = Button(this).apply {
            text = "🖼️ View Sent Photos Gallery"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            background = makeCard(Color.parseColor("#E4DCCF"), 12f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(46)).apply {
                topMargin = dp(10)
            }
            layoutParams = lp
            setOnClickListener { showGalleryOverlay() }
        }
        content.addView(galleryBtn)

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

        val lockSub = TextView(this).apply {
            text = "Shutter is LIVE. Clicks will beam to laptop\n(or queue safely if Wi-Fi drops)."
            textSize = 13f
            setTextColor(Color.parseColor("#9A958F"))
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        centerCol.addView(lockSub)

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
        Toast.makeText(this, "Pocket Lock ON. Shutter is still live!", Toast.LENGTH_SHORT).show()
    }

    private fun hidePocketLock() {
        pocketLockOverlay.visibility = View.GONE
        val lp = window.attributes
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
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
            text = "📸 Sent Photos (0)"
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
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            visibility = View.GONE
            setOnClickListener { retryPendingNow() }
        }
        bar.addView(galleryRetryBtn)

        val queueInGalleryBtn = Button(this).apply {
            text = "🖥️ Laptop Queue"
            textSize = 12f
            setTextColor(Color.parseColor("#1D6FA5"))
            setTypeface(typeface, Typeface.BOLD)
            background = makeCard(Color.parseColor("#EAF3FA"), 14f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { openLaptopQueue() }
        }
        bar.addView(queueInGalleryBtn)

        val clearBtn = Button(this).apply {
            text = "🗑️"
            textSize = 14f
            background = makeCard(Color.parseColor("#E4DCCF"), 14f)
            val lp = LinearLayout.LayoutParams(dp(38), dp(38)).apply {
                rightMargin = dp(8)
            }
            layoutParams = lp
            setOnClickListener { clearSessionGallery() }
        }
        bar.addView(clearBtn)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.parseColor("#6B666C"))
            background = makeCard(Color.parseColor("#E4DCCF"), 19f)
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
            setOnClickListener { hideGalleryOverlay() }
        }
        bar.addView(closeBtn)
        container.addView(bar)

        val subHint = TextView(this).apply {
            text = "Tap any photo to enlarge • Unsent shots auto-upload when Wi-Fi reconnects."
            textSize = 11f
            setTextColor(Color.parseColor("#8E8884"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(4)
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }
        container.addView(subHint)

        galleryEmptyText = TextView(this).apply {
            text = "No photos taken yet in this session.\n\nConnect your DSLR and snap photos with the camera shutter—they will stream to the laptop and appear here!"
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
        galleryGrid = GridView(this).apply {
            numColumns = 3
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
            setPadding(dp(16), dp(16), dp(16), dp(16))
            val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
                setMargins(dp(16), dp(24), dp(16), dp(24))
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
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(320)).apply {
                topMargin = dp(12)
                bottomMargin = dp(12)
            }
            layoutParams = lp
        }
        card.addView(iv)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

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

        val queueBtn = Button(this).apply {
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
        btnRow.addView(queueBtn)

        val dismissBtn = Button(this).apply {
            text = "Close"
            textSize = 13f
            setTextColor(Color.WHITE)
            background = makeCard(Color.parseColor("#332F36"), 10f)
            layoutParams = LinearLayout.LayoutParams(dp(80), dp(42))
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
            text = "Version 1.1.2 (Current Release)"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1B7358"))
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
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.1.2"
        } catch (_: Exception) {
            "1.1.2"
        }
    }

    private fun showGalleryOverlay() {
        notifyGalleryChanged()
        galleryOverlay.visibility = View.VISIBLE
    }

    private fun hideGalleryOverlay() {
        galleryOverlay.visibility = View.GONE
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

        val mb = String.format(Locale.US, "%.1f MB", photo.sizeBytes / (1024.0 * 1024.0))
        infoText?.text = "Captured at ${photo.timeStr} • $mb"
        if (photo.success) {
            statusText?.text = "● Sent to Laptop Base Station"
            statusText?.setTextColor(Color.parseColor("#2EA66B"))
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.GONE
        } else if (photo.pendingFile?.exists() == true) {
            statusText?.text = "● Queued — auto-uploads when Wi-Fi reconnects"
            statusText?.setTextColor(Color.parseColor("#F59E0B"))
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.VISIBLE
        } else {
            statusText?.text = "● Upload Failed / Pending"
            statusText?.setTextColor(Color.parseColor("#C93D27"))
            if (::previewRetryBtn.isInitialized) previewRetryBtn.visibility = View.GONE
        }

        photoPreviewOverlay.visibility = View.VISIBLE
    }

    private fun clearSessionGallery() {
        val pending = pendingCount()
        if (pending > 0) {
            AlertDialog.Builder(this)
                .setTitle("Unsent Photos Queued")
                .setMessage("$pending photo(s) are still waiting to upload to the laptop.")
                .setPositiveButton("Clear Sent Only") { _, _ ->
                    synchronized(sessionPhotos) {
                        val it = sessionPhotos.iterator()
                        while (it.hasNext()) {
                            val p = it.next()
                            if (p.success || p.pendingFile?.exists() != true) {
                                try { p.thumbFile.delete() } catch (_: Exception) { }
                                it.remove()
                            }
                        }
                    }
                    notifyGalleryChanged()
                    refreshQueueUi()
                    Toast.makeText(this, "Cleared sent photos; kept $pending queued", Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton("Delete All") { _, _ ->
                    for (f in listPendingFiles()) {
                        try { f.delete() } catch (_: Exception) { }
                    }
                    synchronized(sessionPhotos) {
                        for (p in sessionPhotos) {
                            try { p.thumbFile.delete() } catch (_: Exception) { }
                            try { p.pendingFile?.delete() } catch (_: Exception) { }
                        }
                        sessionPhotos.clear()
                    }
                    notifyGalleryChanged()
                    refreshQueueUi()
                    Toast.makeText(this, "All photos and pending queue cleared", Toast.LENGTH_SHORT).show()
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
        val count = synchronized(sessionPhotos) { sessionPhotos.size }
        if (::galleryTitleText.isInitialized) {
            galleryTitleText.text = "📸 Sent Photos ($count)"
        }
        if (::galleryEmptyText.isInitialized && ::galleryGrid.isInitialized) {
            if (count == 0) {
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

    private fun saveCompressedThumbnail(bytes: ByteArray): File? {
        return try {
            val opts = BitmapFactory.Options().apply {
                inSampleSize = 4 // read 1/4 width & height into memory for fast decoding
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
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
                scaled.compress(Bitmap.CompressFormat.JPEG, 75, out)
                out.flush()
            }
            scaled.recycle()
            file
        } catch (e: Exception) {
            Log.w(TAG, "Error saving compressed thumbnail: ${e.message}")
            null
        }
    }

    private fun updateThumbnailFromFile(file: File) {
        try {
            val bmp = BitmapFactory.decodeFile(file.absolutePath) ?: return
            lastPhotoBitmap?.recycle()
            lastPhotoBitmap = bmp
            thumbnailView.setImageBitmap(bmp)
        } catch (e: Exception) {
            Log.w(TAG, "Thumbnail display error: ${e.message}")
        }
    }

    private inner class GalleryGridAdapter : BaseAdapter() {
        override fun getCount(): Int = synchronized(sessionPhotos) { sessionPhotos.size }
        override fun getItem(position: Int): SessionPhoto = synchronized(sessionPhotos) { sessionPhotos[position] }
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val photo = getItem(position)
            val cell = (convertView as? FrameLayout) ?: FrameLayout(this@RovingBridgeActivity).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(110))
                background = makeCard(Color.WHITE, 12f)
                clipToOutline = true

                val iv = ImageView(this@RovingBridgeActivity).apply {
                    tag = "iv"
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                }
                addView(iv)

                val badge = TextView(this@RovingBridgeActivity).apply {
                    tag = "badge"
                    textSize = 10f
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
            val badge = cell.findViewWithTag<TextView>("badge")

            if (iv != null) {
                try {
                    val bmp = if (photo.thumbFile.exists()) BitmapFactory.decodeFile(photo.thumbFile.absolutePath) else null
                    iv.setImageBitmap(bmp)
                } catch (_: Exception) {
                    iv.setImageDrawable(null)
                }
            }

            if (badge != null) {
                if (photo.success) {
                    badge.text = "${photo.timeStr} ✓"
                    badge.background = makeCard(Color.parseColor("#CC1B7358"), 6f)
                } else if (photo.pendingFile?.exists() == true) {
                    badge.text = "${photo.timeStr} ⏳"
                    badge.background = makeCard(Color.parseColor("#CCD97706"), 6f)
                } else {
                    badge.text = "${photo.timeStr} ✗"
                    badge.background = makeCard(Color.parseColor("#CCC83924"), 6f)
                }
            }

            cell.setOnClickListener {
                showPhotoPreview(photo)
            }

            return cell
        }
    }

    // ================================================================ BACKGROUND WORKER

    private fun startWorker() {
        if (isRunning.getAndSet(true)) return
        workerThread = Thread({
            Log.i(TAG, "Roving bridge worker started")
            while (isRunning.get()) {
                try {
                    val cam = getCameraHelper()
                    if (!cam.isCameraOpen()) {
                        cam.ensureOpen()
                    }

                    val connected = cam.isCameraOpen()
                    val camName = if (connected) cam.cameraName() else "No DSLR Connected"
                    val battery = if (connected) cam.cameraBattery() else -1

                    mainHandler.post {
                        updateCameraStatus(connected, camName, battery)
                    }

                    if (connected) {
                        // Check for newly captured photo from physical shutter press
                        val jpegBytes = cam.pollNewPhoto()
                        if (jpegBytes != null && jpegBytes.isNotEmpty()) {
                            enqueueCapturedPhoto(jpegBytes)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error in worker loop: ${e.message}")
                }

                try { Thread.sleep(250) } catch (_: InterruptedException) { break }
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

    private fun updateCameraStatus(connected: Boolean, name: String, battery: Int) {
        if (connected) {
            statusPill.text = "● READY"
            statusPill.setTextColor(Color.parseColor("#2EA66B"))
            statusPill.background = makeCard(Color.parseColor("#EAF7EF"), 10f)
            cameraTitle.text = name
            cameraSub.text = if (battery >= 0) "Connected via USB • Battery $battery%" else "Connected via USB • Ready to shoot"
            triggerButton.isEnabled = true
        } else {
            statusPill.text = "● DISCONNECTED"
            statusPill.setTextColor(Color.parseColor("#C93D27"))
            statusPill.background = makeCard(Color.parseColor("#FBEBE8"), 10f)
            cameraTitle.text = "No DSLR Connected"
            cameraSub.text = "Plug your Canon, Nikon, or Sony DSLR into this phone with a USB cable."
            triggerButton.isEnabled = false
        }
    }

    // ================================================================ OFFLINE QUEUE & PHOTO UPLOADER

    private fun getPendingDir(): File {
        val d = File(filesDir, "rove_pending")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun listPendingFiles(): List<File> {
        val dir = getPendingDir()
        val files = dir.listFiles() ?: return emptyList()
        return files.filter { it.isFile && it.name.endsWith(".jpg", ignoreCase = true) }
            .sortedBy { it.name }
    }

    private fun pendingCount(): Int = listPendingFiles().size

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

    private fun saveThumbnailFromFile(file: File): File? {
        return try {
            val opts = BitmapFactory.Options().apply { inSampleSize = 4 }
            val bmp = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
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
                scaled.compress(Bitmap.CompressFormat.JPEG, 75, out)
                out.flush()
            }
            scaled.recycle()
            thumb
        } catch (e: Exception) {
            Log.w(TAG, "Error creating thumbnail from pending file: ${e.message}")
            null
        }
    }

    private fun restorePendingQueue() {
        ingestExecutor.execute {
            val files = listPendingFiles()
            if (files.isEmpty()) {
                mainHandler.post { refreshQueueUi() }
                return@execute
            }
            val restored = mutableListOf<SessionPhoto>()
            for (f in files) {
                val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(f.lastModified()))
                val thumb = saveThumbnailFromFile(f) ?: File(getThumbsDir(), "missing_${f.name}")
                restored.add(0, SessionPhoto(thumb, timeStr, false, f.length(), f))
            }
            synchronized(sessionPhotos) {
                sessionPhotos.addAll(restored)
            }
            val latestThumb = restored.firstOrNull()?.thumbFile
            mainHandler.post {
                if (latestThumb != null && latestThumb.exists()) updateThumbnailFromFile(latestThumb)
                lastSentText.text = "⏳ ${files.size} queued photo(s) restored — waiting for laptop Wi-Fi…"
                refreshQueueUi()
                notifyGalleryChanged()
                if (targetUrl.trim().isNotEmpty()) {
                    kickRetryQueue(400L)
                }
            }
        }
    }

    private fun registerNetworkMonitor() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            connectivityManager = cm
            val req = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (pendingCount() > 0) kickRetryQueue(400L)
                }

                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (pendingCount() > 0) kickRetryQueue(400L)
                }
            }
            networkCallback = cb
            cm.registerNetworkCallback(req, cb)
        } catch (e: Exception) {
            Log.w(TAG, "Network monitor unavailable: ${e.message}")
        }
    }

    private fun unregisterNetworkMonitor() {
        try {
            val cb = networkCallback ?: return
            connectivityManager?.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        } finally {
            networkCallback = null
            connectivityManager = null
        }
    }

    private fun refreshQueueUi() {
        val pending = pendingCount()
        if (::statsCountText.isInitialized) {
            if (pending > 0) {
                statsCountText.text = "$sentPhotosCount Sent • $pending Queued"
                statsCountText.setTextColor(Color.parseColor("#D97706"))
            } else {
                statsCountText.text = "$sentPhotosCount Photos Sent"
                statsCountText.setTextColor(Color.parseColor("#2EA66B"))
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
            pocketStatsText.text = if (pending > 0) {
                "Sent: $sentPhotosCount • Queued: $pending (auto-retrying)"
            } else {
                "Sent: $sentPhotosCount"
            }
        }
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
        mainHandler.post {
            mainHandler.removeCallbacks(retryRunnable)
            if (isFinishing || isDestroyed) return@post
            if (delayMs > 0L) {
                if (pendingCount() > 0 && targetUrl.trim().isNotEmpty()) {
                    mainHandler.postDelayed(retryRunnable, delayMs)
                }
            } else {
                scheduleDrain()
            }
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

        // 1. Cache lightweight thumbnail & persist full-res JPEG to disk queue so nothing is lost on disconnect
        val thumbFile = saveCompressedThumbnail(bytes)
        val pendingFile = savePendingPhotoFile(bytes)

        if (pendingFile == null) {
            // Disk fallback: try direct in-memory upload if storage couldn't write
            val res = if (currentTarget.isNotEmpty()) uploadBytesToLaptop(currentTarget, bytes) else UPLOAD_RETRY
            val ok = (res == UPLOAD_OK)
            if (thumbFile != null) {
                val item = SessionPhoto(thumbFile, timeStr, ok, bytes.size.toLong(), null)
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
                if (thumbFile != null && thumbFile.exists()) updateThumbnailFromFile(thumbFile)
                refreshQueueUi()
                notifyGalleryChanged()
            }
            return
        }

        val displayThumb = thumbFile ?: File(getThumbsDir(), "missing_${pendingFile.name}")
        val item = SessionPhoto(displayThumb, timeStr, false, bytes.size.toLong(), pendingFile)
        synchronized(sessionPhotos) { sessionPhotos.add(0, item) }

        mainHandler.post {
            if (displayThumb.exists()) updateThumbnailFromFile(displayThumb)
            if (currentTarget.isEmpty()) {
                lastSentText.text = "⏳ Queued on phone — scan Laptop QR to send"
                Toast.makeText(this, "Photo queued! Scan Laptop QR to send.", Toast.LENGTH_SHORT).show()
            } else {
                val qCount = pendingCount()
                lastSentText.text = if (qCount > 1) "📤 Uploading ($qCount in queue)…" else "📤 Sending photo…"
            }
            refreshQueueUi()
            notifyGalleryChanged()
            if (currentTarget.isNotEmpty()) {
                scheduleDrain()
            }
        }
    }

    private fun drainPendingQueue() {
        drainQueued.set(false)
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
            if (!isLaptopReachable(clean)) {
                val n = pendingCount()
                mainHandler.post {
                    lastSentText.text = "⏳ $n queued — waiting for laptop Wi-Fi…"
                    refreshQueueUi()
                    if (n > 0 && (pocketLockOverlay.visibility == View.VISIBLE || !isFinishing)) {
                        kickRetryQueue(RETRY_DELAY_MS)
                    }
                }
                return
            }

            val files = listPendingFiles()
            for ((idx, file) in files.withIndex()) {
                if (!file.exists()) continue
                val liveClean = cleanUrl(targetUrl.trim())
                if (liveClean.isEmpty() || liveClean != clean) {
                    if (liveClean.isNotEmpty()) kickRetryQueue(150L)
                    break
                }

                val total = files.size
                mainHandler.post {
                    lastSentText.text = if (total > 1) "📤 Sending ${idx + 1}/$total queued photos…" else "📤 Sending photo…"
                }

                val t0 = System.currentTimeMillis()
                val res = uploadFileToLaptop(clean, file)
                if (res == UPLOAD_OK) {
                    val elapsed = System.currentTimeMillis() - t0
                    val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    val sentPath = file.absolutePath
                    try { file.delete() } catch (_: Exception) { }

                    val remAfter = pendingCount()
                    mainHandler.post {
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
                    mainHandler.post {
                        lastSentText.text = "Photo rejected by laptop (>80 MB limit)"
                        Toast.makeText(this, "Photo too large for laptop (>80 MB)", Toast.LENGTH_LONG).show()
                        refreshQueueUi()
                    }
                    break
                } else {
                    val rem = pendingCount()
                    mainHandler.post {
                        lastSentText.text = "⏳ $rem queued — Wi-Fi lost, auto-retrying…"
                        refreshQueueUi()
                        kickRetryQueue(RETRY_DELAY_MS)
                    }
                    return
                }
            }

            if (pendingCount() > 0 && cleanUrl(targetUrl.trim()).isNotEmpty()) {
                kickRetryQueue(250L)
            }
        } finally {
            isDraining.set(false)
        }
    }

    private fun isLaptopReachable(cleanBaseUrl: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            val pingUrl = URL("$cleanBaseUrl/hello")
            conn = pingUrl.openConnection() as HttpURLConnection
            conn.connectTimeout = 2000
            conn.readTimeout = 2000
            val code = conn.responseCode
            code in 200..299
        } catch (_: Exception) {
            false
        } finally {
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    private fun uploadFileToLaptop(cleanBaseUrl: String, file: File): Int {
        var conn: HttpURLConnection? = null
        try {
            val len = file.length()
            if (len <= 0L) return UPLOAD_RETRY
            val target = URL("$cleanBaseUrl/photo?name=${file.name}")
            conn = target.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 5000
            conn.readTimeout = 20000
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(len)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
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
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    private fun uploadBytesToLaptop(baseUrl: String, bytes: ByteArray): Int {
        var conn: HttpURLConnection? = null
        try {
            val clean = cleanUrl(baseUrl)
            val name = "rove_" + System.currentTimeMillis() + ".jpg"
            val target = URL("$clean/photo?name=$name")
            conn = target.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 5000
            conn.readTimeout = 20000
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
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
        Thread({
            var ok = false
            var msg = ""
            try {
                val pingUrl = URL("$targetUrl/hello")
                val c = pingUrl.openConnection() as HttpURLConnection
                c.connectTimeout = 4000
                c.readTimeout = 4000
                val code = c.responseCode
                ok = (code in 200..299)
                msg = if (ok) "Connected! Laptop ready." else "Laptop answered HTTP $code"
            } catch (e: Exception) {
                msg = "Could not reach laptop: ${e.message}"
            }

            mainHandler.post {
                connectionStatusText.text = if (ok) "✅ $msg" else "❌ $msg"
                connectionStatusText.setTextColor(if (ok) Color.parseColor("#2EA66B") else Color.parseColor("#C93D27"))
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
                refreshQueueUi()
                if (ok && pendingCount() > 0) {
                    kickRetryQueue(100L)
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
