package com.photobooth4u.booth

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
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
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Dedicated Roving DSLR Bridge:
 * Connects to a wired DSLR (Canon, Nikon, Sony) via USB, listens for physical shutter clicks,
 * and streams captured JPEGs in real time over Wi-Fi to the laptop's desktop booth app.
 */
class RovingBridgeActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "RovingBridge"
        private const val PREFS = "photobooth_roving"
        private const val KEY_URL = "target_laptop_url"
        private const val KEY_VIBRATE = "vibrate_on_send"
    }

    private val isRunning = AtomicBoolean(false)
    private var workerThread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val uploadExecutor: ExecutorService = Executors.newSingleThreadExecutor()
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
    private lateinit var triggerButton: Button
    private lateinit var pocketLockOverlay: FrameLayout

    private var lastPhotoBitmap: Bitmap? = null

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        loadPrefs()
        buildUi()
    }

    override fun onResume() {
        super.onResume()
        startWorker()
    }

    override fun onPause() {
        super.onPause()
        // Keep worker alive if pocket lock is active, otherwise pause
        if (pocketLockOverlay.visibility != View.VISIBLE) {
            stopWorker()
        }
    }

    override fun onDestroy() {
        stopWorker()
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
        var u = raw.trim().replace(Regex("/+photos$"), "").replace(Regex("/+$"), "")
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

        val sub = TextView(this).apply {
            text = "Wired DSLR ➔ Wireless Laptop Streamer"
            textSize = 12f
            setTextColor(Color.parseColor("#8E8884"))
        }
        titleCol.addView(sub)
        topBar.addView(titleCol)

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
            text = "🎯 Target Laptop URL"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
        }
        lapCard.addView(lapLabel)

        val lapHint = TextView(this).apply {
            text = "Enter the send link from the Photographer Desk on your laptop:"
            textSize = 12f
            setTextColor(Color.parseColor("#8E8884"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(2)
            layoutParams = lp
        }
        lapCard.addView(lapHint)

        laptopInput = EditText(this).apply {
            hint = "http://192.168.1.100:47777/send/..."
            setText(targetUrl)
            textSize = 13f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = makeCard(Color.parseColor("#F5F1EA"), 8f)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            layoutParams = lp
        }
        lapCard.addView(laptopInput)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
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
        }

        thumbnailView = ImageView(this).apply {
            background = makeCard(Color.parseColor("#E4DCCF"), 8f)
            scaleType = ImageView.ScaleType.CENTER_CROP
            layoutParams = LinearLayout.LayoutParams(dp(70), dp(70))
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
        statsCard.addView(statsCol)
        content.addView(statsCard)

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

        scroll.addView(content)
        rootLayout.addView(scroll)

        // --- Pocket Lock Overlay View ---
        buildPocketLockOverlay()
        rootLayout.addView(pocketLockOverlay)

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
            text = "Shutter is LIVE. Clicks will beam to laptop.\nScreen touches are locked."
            textSize = 13f
            setTextColor(Color.parseColor("#9A958F"))
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(6)
            layoutParams = lp
        }
        centerCol.addView(lockSub)

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

    // ================================================================ BACKGROUND WORKER

    private fun startWorker() {
        if (isRunning.getAndSet(true)) return
        workerThread = Thread({
            Log.i(TAG, "Roving bridge worker started")
            while (isRunning.get()) {
                try {
                    val cam = UsbCameraHelper.activeInstance
                    if (cam != null) {
                        val isOpen = cam.isCameraOpen()
                        if (!isOpen) {
                            cam.ensureOpen()
                        }
                    val cam = getCameraHelper()
                    val isOpen = cam.isCameraOpen()
                    if (!isOpen) {
                        cam.ensureOpen()
                    }

                        val connected = cam.isCameraOpen()
                        val camName = if (connected) cam.cameraName() else "No DSLR Connected"
                        val battery = if (connected) cam.cameraBattery() else -1
                    val connected = cam.isCameraOpen()
                    val camName = if (connected) cam.cameraName() else "No DSLR Connected"
                    val battery = if (connected) cam.cameraBattery() else -1

                        mainHandler.post {
                            updateCameraStatus(connected, camName, battery)
                        }
                    mainHandler.post {
                        updateCameraStatus(connected, camName, battery)
                    }

                        if (connected) {
                            // Check for newly captured photo from physical shutter press
                            val jpegBytes = cam.pollNewPhoto()
                            if (jpegBytes != null && jpegBytes.isNotEmpty()) {
                    if (connected) {
                        // Check for newly captured photo from physical shutter press
                        val jpegBytes = cam.pollNewPhoto()
                        if (jpegBytes != null && jpegBytes.isNotEmpty()) {
                            uploadExecutor.execute {
                                handlePhotoCaptured(jpegBytes)
                            }
                        }
                    } else {
                        mainHandler.post {
                            updateCameraStatus(false, "Camera helper offline", -1)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error in worker loop: ${e.message}")
                }

                try { Thread.sleep(300) } catch (_: InterruptedException) { break }
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

    // ================================================================ PHOTO UPLOADER

    private fun handlePhotoCaptured(bytes: ByteArray) {
        val t0 = System.currentTimeMillis()
        val currentTarget = targetUrl.trim()
        if (currentTarget.isEmpty()) {
            mainHandler.post {
                Toast.makeText(this, "Photo taken, but no Laptop URL configured!", Toast.LENGTH_SHORT).show()
                updateThumbnail(bytes)
            }
            return
        }

        val success = uploadPhotoToLaptop(currentTarget, bytes)
        mainHandler.post {
            if (success) {
                sentPhotosCount++
                statsCountText.text = "$sentPhotosCount Photos Sent"
                val timeStr = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                lastSentText.text = "Last photo sent at $timeStr (${(System.currentTimeMillis() - t0)}ms)"
                updateThumbnail(bytes)
                vibrateSuccess()
            } else {
                lastSentText.text = "Upload failed! Check Wi-Fi connection to laptop."
                Toast.makeText(this, "Could not reach laptop. Check Wi-Fi!", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun uploadPhotoToLaptop(baseUrl: String, bytes: ByteArray): Boolean {
        var conn: HttpURLConnection? = null
        try {
            val clean = cleanUrl(baseUrl)
            val name = "rove_" + System.currentTimeMillis() + ".jpg"
            val target = URL("$clean/photo?name=$name")
            conn = target.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 5000
            conn.readTimeout = 15000
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("Access-Control-Allow-Origin", "*")

            conn.outputStream.use { it.write(bytes); it.flush() }
            val code = conn.responseCode
            return code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "Failed to upload photo to laptop: ${e.message}")
            return false
        } finally {
            conn?.disconnect()
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
        val cam = UsbCameraHelper.activeInstance
        if (cam == null || !cam.isCameraOpen()) {
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
                        handlePhotoCaptured(bytes)
                        uploadExecutor.execute {
                            handlePhotoCaptured(bytes)
                        }
                        Toast.makeText(this, "Photo snapped & beaming to laptop!", Toast.LENGTH_SHORT).show()
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
