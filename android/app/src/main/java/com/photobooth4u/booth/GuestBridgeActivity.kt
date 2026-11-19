package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.graphics.YuvImage
import android.graphics.drawable.GradientDrawable
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.text.InputType
import android.util.Base64
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.max

/**
 * Guest Screen + Camera Bridge for running photobooth4u on a Windows/Mac laptop
 * while using a Huawei MatePad Pro (or Android tablet) as the Guest Screen and Camera.
 */
class GuestBridgeActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "GuestBridge"
        private const val PREFS = "photobooth_guest_bridge"
        private const val KEY_BASE_URL = "bridge_base_url"
        private const val KEY_FACING = "bridge_cam_facing"
        private const val PREVIEW_FRAME_INTERVAL_MS = 45L // ~22 fps preview to laptop
    }

    private lateinit var root: FrameLayout
    private lateinit var previewView: TextureView
    private lateinit var webView: WebView
    private lateinit var pairingLayer: FrameLayout
    private lateinit var urlInput: EditText
    private lateinit var statusText: TextView
    private lateinit var connectBtn: Button

    private val mainHandler = Handler(Looper.getMainLooper())
    private val netExec = Executors.newCachedThreadPool()
    private val camConnected = AtomicBoolean(false)
    private val previewSending = AtomicBoolean(false)
    private val lastFrameAt = AtomicLong(0L)
    private val rng = SecureRandom()

    private var camThread: HandlerThread? = null
    private var camHandler: Handler? = null
    private var cameraManager: CameraManager? = null
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var previewReader: ImageReader? = null
    private var stillReader: ImageReader? = null

    private var frontCamId: String? = null
    private var backCamId: String? = null
    private var activeCamId: String? = null
    private var desiredFacing: String = "front"
    private var sensorOrientation = 0
    private var previewSize = Size(1280, 960)
    private var stillSize = Size(1920, 1440)

    @Volatile private var latestUprightJpeg: ByteArray? = null
    @Volatile private var pendingShotId: String? = null
    @Volatile private var pendingShotTimeout: Runnable? = null

    private var activeBaseUrl: String = ""
    private var wsSocket: Socket? = null
    private var wsOut: OutputStream? = null
    private val wsWriteLock = Any()
    private val wsRunning = AtomicBoolean(false)
    private var sessionActive = false

    // Preview rect from WebView
    private var pvLeft = 0
    private var pvTop = 0
    private var pvW = 0
    private var pvH = 0
    private var pvVisible = false
    private var pvMirror = true

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            if (sessionActive) startCameraIfReady()
        } else {
            Toast.makeText(this, "Camera permission is required to stream the tablet camera.", Toast.LENGTH_LONG).show()
        }
    }

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents?.trim() ?: return@registerForActivityResult
        val candidates = parseQrCandidates(raw)
        if (candidates.isEmpty()) {
            Toast.makeText(this, "Not a valid photobooth4u bridge QR code.", Toast.LENGTH_SHORT).show()
            return@registerForActivityResult
        }
        urlInput.setText(candidates.first())
        resolveAndConnect(candidates)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersiveMode()

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        desiredFacing = prefs.getString(KEY_FACING, "front") ?: "front"
        val savedUrl = prefs.getString(KEY_BASE_URL, "") ?: ""

        cameraManager = getSystemService(Context.CAMERA_SERVICE) as CameraManager
        discoverCameras()

        buildUi(savedUrl)
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (sessionActive) showOperatorMenu()
                else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
        if (sessionActive && hasCamPerm()) {
            startCameraIfReady()
        }
    }

    override fun onPause() {
        stopCamera()
        super.onPause()
    }

    override fun onDestroy() {
        stopBridgeSession()
        stopCamThread()
        netExec.shutdownNow()
        super.onDestroy()
    }

    private fun applyImmersiveMode() {
        try {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            val ctrl = WindowInsetsControllerCompat(window, window.decorView)
            ctrl.hide(WindowInsetsCompat.Type.systemBars())
            ctrl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } catch (_: Exception) { }
    }

    private fun hasCamPerm(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun discoverCameras() {
        val cm = cameraManager ?: return
        try {
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                if (facing == CameraCharacteristics.LENS_FACING_FRONT && frontCamId == null) frontCamId = id
                if (facing == CameraCharacteristics.LENS_FACING_BACK && backCamId == null) backCamId = id
            }
        } catch (e: Exception) {
            Log.e(TAG, "discoverCameras failed", e)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi(savedUrl: String) {
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0D0C0E"))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        previewView = TextureView(this).apply {
            visibility = View.GONE
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                    applyPreviewTransform()
                    if (sessionActive && hasCamPerm()) startCameraIfReady()
                }
                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
                    applyPreviewTransform()
                }
                override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean = true
                override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
            }
        }
        root.addView(previewView, FrameLayout.LayoutParams(1, 1))

        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            visibility = View.GONE
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            addJavascriptInterface(BridgeJsApi(), "__PBTabletBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // Subtle long-press hotspot in top-left corner for operator menu while guest screen runs
        val menuCorner = View(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setOnLongClickListener {
                if (sessionActive) showOperatorMenu()
                true
            }
        }
        root.addView(menuCorner, FrameLayout.LayoutParams(dp(72), dp(72), Gravity.TOP or Gravity.START))

        // Pairing screen overlay
        pairingLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F5F1EA"))
        }
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(36), dp(28), dp(36))
        }

        val title = TextView(this).apply {
            text = "Laptop Guest Screen + Camera Bridge"
            textSize = 24f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            gravity = Gravity.CENTER
        }
        val subtitle = TextView(this).apply {
            text = "Use this Huawei / Android tablet as the photobooth4u Guest Screen & Camera connected to your Windows laptop."
            textSize = 14f
            setTextColor(Color.parseColor("#5A5560"))
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(20))
        }

        val scanBtn = Button(this).apply {
            text = "📷 Scan Pairing QR on Laptop"
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = pillBg("#C93D27")
            setPadding(dp(24), dp(14), dp(24), dp(14))
            setOnClickListener {
                val opts = ScanOptions().apply {
                    setPrompt("Scan the Tablet Bridge QR in photobooth4u Setup → Guest screen")
                    setBeepEnabled(true)
                    setOrientationLocked(false)
                }
                qrLauncher.launch(opts)
            }
        }

        val tip = TextView(this).apply {
            text = "1. Plug in USB-C and turn on USB Tethering (or join the laptop's booth Wi-Fi).\n2. On the laptop, open Setup → Guest screen and scan the QR above (or paste the link below)."
            textSize = 13f
            setTextColor(Color.parseColor("#5A5560"))
            setPadding(0, dp(18), 0, dp(10))
        }

        urlInput = EditText(this).apply {
            hint = "http://192.168.137.1:47777/bridge/..."
            setText(savedUrl)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.parseColor("#1C1A1E"))
            setHintTextColor(Color.parseColor("#9B959C"))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), Color.parseColor("#D6CEC1"))
            }
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, dp(8))
        }
        connectBtn = Button(this).apply {
            text = "Connect"
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = pillBg("#1C1A1E")
            setPadding(dp(24), dp(12), dp(24), dp(12))
            setOnClickListener {
                val raw = urlInput.text.toString().trim()
                val list = parseQrCandidates(raw)
                if (list.isEmpty()) {
                    Toast.makeText(this@GuestBridgeActivity, "Enter the bridge address from the laptop.", Toast.LENGTH_SHORT).show()
                } else {
                    resolveAndConnect(list)
                }
            }
        }
        val flipBtn = Button(this).apply {
            text = "Camera: ${if (desiredFacing == "back") "Rear" else "Front"}"
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#1C1A1E"))
            background = pillBg("#E6DFD3")
            setPadding(dp(18), dp(12), dp(18), dp(12))
            setOnClickListener {
                desiredFacing = if (desiredFacing == "front") "back" else "front"
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_FACING, desiredFacing).apply()
                text = "Camera: ${if (desiredFacing == "back") "Rear" else "Front"}"
            }
        }
        val backBtn = Button(this).apply {
            text = "Exit"
            textSize = 14f
            setTextColor(Color.parseColor("#5A5560"))
            background = pillBg("#EDE8DE")
            setPadding(dp(18), dp(12), dp(18), dp(12))
            setOnClickListener { finish() }
        }
        btnRow.addView(connectBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(10) })
        btnRow.addView(flipBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(10) })
        btnRow.addView(backBtn)

        statusText = TextView(this).apply {
            text = if (savedUrl.isNotEmpty()) "Ready — tap Connect or scan QR." else "Ready to pair."
            textSize = 13f
            setTextColor(Color.parseColor("#6B666C"))
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        }

        card.addView(title)
        card.addView(subtitle)
        card.addView(scanBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(tip)
        card.addView(urlInput, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(btnRow)
        card.addView(statusText)

        val holder = FrameLayout(this)
        holder.addView(card, FrameLayout.LayoutParams(dp(540).coerceAtMost(resources.displayMetrics.widthPixels), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        scroll.addView(holder)
        pairingLayer.addView(scroll)
        root.addView(pairingLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun pillBg(hex: String) = GradientDrawable().apply {
        setColor(Color.parseColor(hex))
        cornerRadius = dp(99).toFloat()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun normalizeBridgeBase(raw: String): String {
        var u = raw.trim().trimEnd('/')
        if (u.endsWith("/guest")) u = u.dropLast(6)
        if (u.endsWith("/hello")) u = u.dropLast(6)
        return u.trimEnd('/')
    }

    private fun parseQrCandidates(raw: String): List<String> {
        val out = LinkedHashSet<String>()
        if (raw.startsWith("{")) {
            try {
                val j = JSONObject(raw)
                val primary = normalizeBridgeBase(j.optString("url", ""))
                if (primary.startsWith("http")) out.add(primary)
                val arr: JSONArray? = j.optJSONArray("urls")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val u = normalizeBridgeBase(arr.optString(i, ""))
                        if (u.startsWith("http")) out.add(u)
                    }
                }
            } catch (_: Exception) { }
        } else if (raw.startsWith("http://") || raw.startsWith("https://")) {
            out.add(normalizeBridgeBase(raw))
        }
        return out.toList()
    }

    private fun resolveAndConnect(candidates: List<String>) {
        connectBtn.isEnabled = false
        statusText.text = "Connecting to laptop…"
        netExec.execute {
            var picked: String? = null
            for (cand in candidates) {
                try {
                    val conn = (URL("$cand/hello").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 1800
                        readTimeout = 1800
                        requestMethod = "GET"
                    }
                    if (conn.responseCode == 200) {
                        val txt = conn.inputStream.bufferedReader().readText()
                        if (txt.contains("photobooth4u-bridge")) {
                            picked = cand
                            conn.disconnect()
                            break
                        }
                    }
                    conn.disconnect()
                } catch (_: Exception) { }
            }
            mainHandler.post {
                connectBtn.isEnabled = true
                if (picked == null) {
                    statusText.text = "Could not reach laptop. Check USB Tethering or booth Wi-Fi and try again."
                    Toast.makeText(this, "Could not reach laptop.", Toast.LENGTH_LONG).show()
                } else {
                    startBridgeSession(picked)
                }
            }
        }
    }

    private fun startBridgeSession(baseUrl: String) {
        activeBaseUrl = normalizeBridgeBase(baseUrl)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_BASE_URL, activeBaseUrl).apply()
        sessionActive = true
        pairingLayer.visibility = View.GONE
        webView.visibility = View.VISIBLE
        previewView.visibility = View.VISIBLE

        if (!hasCamPerm()) {
            permLauncher.launch(Manifest.permission.CAMERA)
        } else {
            startCameraIfReady()
        }
        startCameraWebSocket()
        webView.loadUrl("$activeBaseUrl/guest")
    }

    private fun stopBridgeSession() {
        sessionActive = false
        wsRunning.set(false)
        try { wsSocket?.close() } catch (_: Exception) { }
        wsSocket = null
        wsOut = null
        stopCamera()
        webView.loadUrl("about:blank")
        webView.visibility = View.GONE
        previewView.visibility = View.GONE
        pairingLayer.visibility = View.VISIBLE
        statusText.text = "Disconnected. Tap Connect to resume."
    }

    private fun showOperatorMenu() {
        val items = arrayOf(
            "Switch Camera (now: ${if (desiredFacing == "back") "Rear" else "Front"})",
            "Change Laptop / Re-scan QR",
            "Exit Bridge"
        )
        AlertDialog.Builder(this)
            .setTitle("Tablet Bridge")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> switchCameraFacing()
                    1 -> stopBridgeSession()
                    2 -> { stopBridgeSession(); finish() }
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun switchCameraFacing() {
        desiredFacing = if (desiredFacing == "front") "back" else "front"
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_FACING, desiredFacing).apply()
        stopCamera()
        startCameraIfReady()
        sendCamJson(JSONObject().apply {
            put("type", "status")
            put("facing", desiredFacing)
            put("width", previewSize.width)
            put("height", previewSize.height)
        })
    }

    // ---------- Camera2 Foreground Engine ----------
    private fun ensureCamThread() {
        if (camThread == null) {
            camThread = HandlerThread("BridgeCam").also { it.start() }
            camHandler = Handler(camThread!!.looper)
        }
    }

    private fun stopCamThread() {
        try { camThread?.quitSafely() } catch (_: Exception) { }
        camThread = null
        camHandler = null
    }

    @SuppressLint("MissingPermission")
    private fun startCameraIfReady() {
        if (!sessionActive || !hasCamPerm() || !previewView.isAvailable || cameraDevice != null) return
        val cm = cameraManager ?: return
        val camId = (if (desiredFacing == "back") backCamId else frontCamId) ?: frontCamId ?: backCamId ?: return
        activeCamId = camId
        try {
            val chars = cm.getCameraCharacteristics(camId)
            sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            if (map != null) {
                val yuvSizes = map.getOutputSizes(ImageFormat.YUV_420_888) ?: emptyArray()
                previewSize = chooseBestSize(yuvSizes, 1280, 960, 4.0 / 3.0)
                val jpegSizes = map.getOutputSizes(ImageFormat.JPEG) ?: yuvSizes
                stillSize = chooseBestSize(jpegSizes, 3264, 2448, previewSize.width.toDouble() / max(1, previewSize.height))
            }
            ensureCamThread()
            cm.openCamera(camId, object : CameraDevice.StateCallback() {
                override fun onOpened(dev: CameraDevice) {
                    cameraDevice = dev
                    createSession(dev)
                }
                override fun onDisconnected(dev: CameraDevice) {
                    dev.close()
                    if (cameraDevice == dev) cameraDevice = null
                }
                override fun onError(dev: CameraDevice, error: Int) {
                    dev.close()
                    if (cameraDevice == dev) cameraDevice = null
                    Log.e(TAG, "Camera error $error")
                }
            }, camHandler)
        } catch (e: Exception) {
            Log.e(TAG, "openCamera failed", e)
        }
    }

    private fun chooseBestSize(sizes: Array<Size>, maxW: Int, maxH: Int, targetAspect: Double): Size {
        val fit = sizes.filter { it.width <= maxW && it.height <= maxH && it.width >= 640 }
        val pool = if (fit.isNotEmpty()) fit else sizes.toList()
        return pool.minWithOrNull(compareBy<Size> {
            val a = it.width.toDouble() / max(1, it.height)
            abs(a - targetAspect)
        }.thenByDescending { it.width * it.height }) ?: Size(1280, 720)
    }

    private fun createSession(dev: CameraDevice) {
        val st = previewView.surfaceTexture ?: return
        st.setDefaultBufferSize(previewSize.width, previewSize.height)
        val texSurface = Surface(st)

        previewReader?.close()
        previewReader = ImageReader.newInstance(previewSize.width, previewSize.height, ImageFormat.YUV_420_888, 2).apply {
            setOnImageAvailableListener({ reader ->
                val img = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    onPreviewImage(img)
                } finally {
                    img.close()
                }
            }, camHandler)
        }

        stillReader?.close()
        stillReader = ImageReader.newInstance(stillSize.width, stillSize.height, ImageFormat.JPEG, 2).apply {
            setOnImageAvailableListener({ reader ->
                val img = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    val buf = img.planes[0].buffer
                    val bytes = ByteArray(buf.remaining())
                    buf.get(bytes)
                    deliverStillShot(bytes)
                } finally {
                    img.close()
                }
            }, camHandler)
        }

        val surfaces = listOf(texSurface, previewReader!!.surface, stillReader!!.surface)
        @Suppress("DEPRECATION")
        dev.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) {
                if (cameraDevice != dev) return
                captureSession = session
                try {
                    val req = dev.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                        addTarget(texSurface)
                        addTarget(previewReader!!.surface)
                        set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    }.build()
                    session.setRepeatingRequest(req, null, camHandler)
                    mainHandler.post { applyPreviewTransform() }
                    sendCameraHello()
                } catch (e: Exception) {
                    Log.e(TAG, "setRepeatingRequest failed", e)
                }
            }
            override fun onConfigureFailed(session: CameraCaptureSession) {
                Log.e(TAG, "createCaptureSession failed")
            }
        }, camHandler)
    }

    private fun stopCamera() {
        try { captureSession?.close() } catch (_: Exception) { }
        captureSession = null
        try { cameraDevice?.close() } catch (_: Exception) { }
        cameraDevice = null
        try { previewReader?.close() } catch (_: Exception) { }
        previewReader = null
        try { stillReader?.close() } catch (_: Exception) { }
        stillReader = null
    }

    private fun displayRotationDeg(): Int {
        val rot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }
        return when (rot) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    private fun jpegRotationDeg(): Int {
        val devRot = displayRotationDeg()
        return if (desiredFacing == "front") {
            (sensorOrientation + devRot) % 360
        } else {
            (sensorOrientation - devRot + 360) % 360
        }
    }

    private fun applyPreviewTransform() {
        if (!previewView.isAvailable || pvW <= 0 || pvH <= 0) return
        val lp = (previewView.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(pvW, pvH)
        if (!pvVisible) {
            // Never INVISIBLE or GONE while the camera runs. A TextureView that is not shown stops taking the camera's pictures,
            // the camera then stalls, and the laptop gets one live picture every few seconds. When the laptop does not want the
            // tablet's own preview on screen, keep the view shown but 2 px big and almost see-through so it keeps draining.
            lp.width = 2
            lp.height = 2
            lp.leftMargin = 0
            lp.topMargin = 0
            previewView.layoutParams = lp
            previewView.alpha = 0.02f
            previewView.visibility = View.VISIBLE
            return
        }
        lp.width = pvW
        lp.height = pvH
        lp.leftMargin = pvLeft
        lp.topMargin = pvTop
        previewView.layoutParams = lp
        previewView.alpha = 1f
        previewView.visibility = View.VISIBLE

        val viewW = pvW.toFloat()
        val viewH = pvH.toFloat()
        val devRot = displayRotationDeg()
        val bufW = previewSize.width.toFloat()
        val bufH = previewSize.height.toFloat()

        // Android Camera2 aligns TextureView upright at ROTATION_0 (natural device orientation).
        val rot0W = if (sensorOrientation % 180 == 90) bufH else bufW
        val rot0H = if (sensorOrientation % 180 == 90) bufW else bufH
        val uprightW = if (devRot == 90 || devRot == 270) rot0H else rot0W
        val uprightH = if (devRot == 90 || devRot == 270) rot0W else rot0H

        val cx = viewW / 2f
        val cy = viewH / 2f
        val m = Matrix()
        m.setScale(rot0W / viewW, rot0H / viewH, cx, cy)
        if (devRot != 0) {
            m.postRotate(-devRot.toFloat(), cx, cy)
        }
        val fillScale = max(viewW / max(1f, uprightW), viewH / max(1f, uprightH))
        m.postScale(fillScale, fillScale, cx, cy)
        if (pvMirror && desiredFacing == "front") {
            m.postScale(-1f, 1f, cx, cy)
        }
        previewView.setTransform(m)
    }

    private fun onPreviewImage(img: Image) {
        val now = System.currentTimeMillis()
        if (now - lastFrameAt.get() < PREVIEW_FRAME_INTERVAL_MS) return
        if (!camConnected.get() || previewSending.get()) return
        lastFrameAt.set(now)
        previewSending.set(true)
        try {
            val nv21 = yuv420ToNv21(img)
            val baos = ByteArrayOutputStream()
            YuvImage(nv21, ImageFormat.NV21, img.width, img.height, null)
                .compressToJpeg(Rect(0, 0, img.width, img.height), 72, baos)
            var jpg = baos.toByteArray()
            val rot = jpegRotationDeg()
            if (rot != 0) {
                jpg = rotateJpeg(jpg, rot)
            }
            latestUprightJpeg = jpg
            netExec.execute {
                try {
                    sendWsFrame(0x2, jpg)
                } finally {
                    previewSending.set(false)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "preview encode error", e)
            previewSending.set(false)
        }
    }

    private fun yuv420ToNv21(img: Image): ByteArray {
        val w = img.width
        val h = img.height
        val out = ByteArray(w * h * 3 / 2)
        val yPlane = img.planes[0]
        val uPlane = img.planes[1]
        val vPlane = img.planes[2]
        val yBuf: ByteBuffer = yPlane.buffer
        val uBuf: ByteBuffer = uPlane.buffer
        val vBuf: ByteBuffer = vPlane.buffer
        yBuf.rewind()
        uBuf.rewind()
        vBuf.rewind()
        val yRowStride = yPlane.rowStride
        var pos = 0
        if (yRowStride == w && yBuf.remaining() >= w * h) {
            yBuf.get(out, 0, w * h)
            pos = w * h
        } else {
            val row = ByteArray(w)
            for (r in 0 until h) {
                yBuf.position(r * yRowStride)
                val avail = minOf(w, yBuf.remaining())
                yBuf.get(row, 0, avail)
                System.arraycopy(row, 0, out, pos, avail)
                pos += w
            }
        }
        val uvRowStride = vPlane.rowStride
        val uvPixStride = vPlane.pixelStride
        val halfH = h / 2
        val halfW = w / 2
        val vLim = vBuf.limit()
        val uLim = uBuf.limit()
        for (r in 0 until halfH) {
            val base = r * uvRowStride
            for (c in 0 until halfW) {
                val off = base + c * uvPixStride
                out[pos++] = if (off < vLim) vBuf.get(off) else 128.toByte()
                out[pos++] = if (off < uLim) uBuf.get(off) else 128.toByte()
            }
        }
        return out
    }

    private fun rotateJpeg(jpg: ByteArray, deg: Int): ByteArray {
        val bmp = BitmapFactory.decodeByteArray(jpg, 0, jpg.size) ?: return jpg
        val m = Matrix().apply { postRotate(deg.toFloat()) }
        val rot = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, false)
        if (rot !== bmp) bmp.recycle()
        val out = ByteArrayOutputStream()
        rot.compress(Bitmap.CompressFormat.JPEG, 78, out)
        rot.recycle()
        return out.toByteArray()
    }

    private fun triggerStillCapture(shotId: String) {
        pendingShotId = shotId
        pendingShotTimeout?.let { mainHandler.removeCallbacks(it) }
        val fallback = Runnable {
            val id = pendingShotId
            if (id == shotId) {
                val jpg = latestUprightJpeg
                if (jpg != null) deliverStillShot(jpg)
                else {
                    pendingShotId = null
                    sendCamJson(JSONObject().apply {
                        put("type", "shotError")
                        put("id", shotId)
                        put("error", "Camera did not capture in time")
                    })
                }
            }
        }
        pendingShotTimeout = fallback
        mainHandler.postDelayed(fallback, 4500)

        val dev = cameraDevice
        val sess = captureSession
        val sr = stillReader
        if (dev == null || sess == null || sr == null) {
            fallback.run()
            return
        }
        camHandler?.post {
            try {
                val req = dev.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                    addTarget(sr.surface)
                    set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    set(CaptureRequest.JPEG_ORIENTATION, jpegRotationDeg())
                    set(CaptureRequest.JPEG_QUALITY, 92.toByte())
                }.build()
                sess.capture(req, object : CameraCaptureSession.CaptureCallback() {
                    override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {}
                }, camHandler)
            } catch (e: Exception) {
                Log.w(TAG, "still capture failed, using preview frame", e)
                mainHandler.post(fallback)
            }
        }
    }

    private fun deliverStillShot(bytes: ByteArray) {
        val shotId = pendingShotId ?: return
        pendingShotId = null
        pendingShotTimeout?.let { mainHandler.removeCallbacks(it) }
        pendingShotTimeout = null
        val base = activeBaseUrl
        if (base.isEmpty()) return
        netExec.execute {
            try {
                val conn = (URL("$base/cam/shot?id=$shotId").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 5000
                    readTimeout = 8000
                    setFixedLengthStreamingMode(bytes.size)
                    setRequestProperty("Content-Type", "image/jpeg")
                }
                conn.outputStream.use { it.write(bytes) }
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "shot upload failed", e)
            }
        }
    }

    // ---------- Minimal RFC-6455 WebSocket client for Camera2 ----------
    private fun startCameraWebSocket() {
        wsRunning.set(true)
        netExec.execute {
            while (wsRunning.get() && sessionActive) {
                try {
                    val uri = URI(activeBaseUrl)
                    val host = uri.host ?: break
                    val port = if (uri.port > 0) uri.port else 80
                    val path = (uri.rawPath ?: "") + "/ws?role=cam"

                    val sock = Socket()
                    sock.connect(InetSocketAddress(host, port), 3000)
                    sock.tcpNoDelay = true
                    wsSocket = sock
                    val out = sock.getOutputStream()
                    wsOut = out
                    val inp = sock.getInputStream()

                    val keyBytes = ByteArray(16).also { rng.nextBytes(it) }
                    val wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
                    val req = "GET $path HTTP/1.1\r\n" +
                        "Host: $host:$port\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: $wsKey\r\n" +
                        "Sec-WebSocket-Version: 13\r\n\r\n"
                    out.write(req.toByteArray(Charsets.UTF_8))
                    out.flush()

                    if (!readHttpUpgradeHeaders(inp)) {
                        sock.close()
                        Thread.sleep(1500)
                        continue
                    }

                    camConnected.set(true)
                    sendCameraHello()
                    readWsLoop(inp)
                } catch (_: Exception) {
                } finally {
                    camConnected.set(false)
                    try { wsSocket?.close() } catch (_: Exception) { }
                    wsSocket = null
                    wsOut = null
                }
                if (wsRunning.get() && sessionActive) {
                    try { Thread.sleep(1500) } catch (_: InterruptedException) { break }
                }
            }
        }
    }

    private fun readHttpUpgradeHeaders(inp: InputStream): Boolean {
        val sb = StringBuilder()
        var b: Int
        while (true) {
            b = inp.read()
            if (b < 0) return false
            sb.append(b.toChar())
            if (sb.length >= 4 && sb.substring(sb.length - 4) == "\r\n\r\n") break
            if (sb.length > 8192) return false
        }
        return sb.toString().startsWith("HTTP/1.1 101")
    }

    private fun readWsLoop(inp: InputStream) {
        while (wsRunning.get() && sessionActive) {
            val b0 = inp.read()
            if (b0 < 0) break
            val b1 = inp.read()
            if (b1 < 0) break
            val opcode = b0 and 0x0f
            val masked = (b1 and 0x80) != 0
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) {
                val hi = inp.read(); val lo = inp.read()
                if (hi < 0 || lo < 0) break
                len = ((hi shl 8) or lo).toLong()
            } else if (len == 127L) {
                val b = ByteArray(8)
                if (!readExact(inp, b, 8)) break
                len = ByteBuffer.wrap(b).long
            }
            if (len < 0 || len > 4 * 1024 * 1024) break
            val mask = if (masked) ByteArray(4).also { if (!readExact(inp, it, 4)) return } else null
            val payload = ByteArray(len.toInt())
            if (len > 0 && !readExact(inp, payload, payload.size)) break
            if (mask != null) {
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
            }
            when (opcode) {
                0x8 -> break
                0x9 -> sendWsFrame(0xA, payload)
                0x1 -> handleServerCmd(String(payload, Charsets.UTF_8))
            }
        }
    }

    private fun readExact(inp: InputStream, buf: ByteArray, len: Int): Boolean {
        var off = 0
        while (off < len) {
            val r = inp.read(buf, off, len - off)
            if (r <= 0) return false
            off += r
        }
        return true
    }

    private fun sendWsFrame(opcode: Int, payload: ByteArray) {
        val out = wsOut ?: return
        val mask = ByteArray(4).also { rng.nextBytes(it) }
        val len = payload.size
        val header = when {
            len < 126 -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or len).toByte())
            len < 65536 -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or 126).toByte(), (len shr 8).toByte(), (len and 0xff).toByte())
            else -> byteArrayOf(
                (0x80 or opcode).toByte(), (0x80 or 127).toByte(),
                0, 0, 0, 0,
                (len shr 24).toByte(), (len shr 16).toByte(), (len shr 8).toByte(), (len and 0xff).toByte()
            )
        }
        val masked = ByteArray(len)
        for (i in 0 until len) masked[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        synchronized(wsWriteLock) {
            try {
                out.write(header)
                out.write(mask)
                if (len > 0) out.write(masked)
                out.flush()
            } catch (_: Exception) {
                try { wsSocket?.close() } catch (_: Exception) { }
            }
        }
    }

    private fun sendCamJson(obj: JSONObject) {
        if (!camConnected.get()) return
        val bytes = obj.toString().toByteArray(Charsets.UTF_8)
        netExec.execute {
            if (camConnected.get()) sendWsFrame(0x1, bytes)
        }
    }

    private fun sendCameraHello() {
        val rot = jpegRotationDeg()
        val uprightW = if (rot == 90 || rot == 270) previewSize.height else previewSize.width
        val uprightH = if (rot == 90 || rot == 270) previewSize.width else previewSize.height
        val cams = JSONArray()
        frontCamId?.let { cams.put(JSONObject().put("id", it).put("facing", "front")) }
        backCamId?.let { cams.put(JSONObject().put("id", it).put("facing", "back")) }
        sendCamJson(JSONObject().apply {
            put("type", "hello")
            put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            put("facing", desiredFacing)
            put("cameras", cams)
            put("width", uprightW)
            put("height", uprightH)
        })
    }

    private fun handleServerCmd(raw: String) {
        try {
            val j = JSONObject(raw)
            when (j.optString("type")) {
                "capture" -> {
                    val id = j.optString("id", "")
                    if (id.isNotEmpty()) triggerStillCapture(id)
                }
                "switchCam" -> mainHandler.post { switchCameraFacing() }
                "setFacing" -> {
                    val want = if (j.optString("facing") == "back") "back" else "front"
                    if (want != desiredFacing) mainHandler.post { switchCameraFacing() }
                }
                "live" -> {
                    if (j.optBoolean("on", true) && cameraDevice == null) {
                        mainHandler.post { startCameraIfReady() }
                    }
                }
            }
        } catch (_: Exception) { }
    }

    inner class BridgeJsApi {
        @JavascriptInterface
        fun setPreviewRect(left: Int, top: Int, width: Int, height: Int, visible: Boolean, mirror: Boolean, bgHex: String?) {
            mainHandler.post {
                pvLeft = left
                pvTop = top
                pvW = width
                pvH = height
                pvVisible = visible
                pvMirror = mirror
                if (!bgHex.isNullOrEmpty()) {
                    try { root.setBackgroundColor(Color.parseColor(bgHex)) } catch (_: Exception) { }
                }
                applyPreviewTransform()
            }
        }
    }
}
