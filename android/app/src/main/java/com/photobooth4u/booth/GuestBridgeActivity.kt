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
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
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
import android.webkit.WebResourceError
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
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
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
        private const val PROBE_TIMEOUT_MS = 3500
        private const val LOOPBACK_PROBE_TIMEOUT_MS = 1200
        private val IPV4_RE = Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$")
    }

    private data class LocalRoute(
        val network: Network?,
        val localAddr: Inet4Address,
        val prefix: Int,
        val ifaceName: String
    )

    private data class ProbeOutcome(
        val baseUrl: String,
        val network: Network?,
        val localAddr: Inet4Address?,
        val ok: Boolean,
        val httpCode: Int = 0,
        val error: String = ""
    )

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
    private val cameraOpening = AtomicBoolean(false)
    private val lastFrameAt = AtomicLong(0L)
    private val rng = SecureRandom()

    private var camThread: HandlerThread? = null
    private var camHandler: Handler? = null
    @Volatile private var camRestartRunnable: Runnable? = null
    private var cameraManager: CameraManager? = null
    @Volatile private var cameraDevice: CameraDevice? = null
    @Volatile private var captureSession: CameraCaptureSession? = null
    private var previewReader: ImageReader? = null
    private var stillReader: ImageReader? = null

    private var frontCamId: String? = null
    private var backCamId: String? = null
    private var activeCamId: String? = null
    private var desiredFacing: String = "front"
    @Volatile private var activeLensFront: Boolean = true
    // The spoken countdown: the laptop sends the words, this tablet says them (page: window.__PBVoice, same as the booth app).
    private var voiceBridge: VoiceBridge? = null
    private var sensorOrientation = 0
    private var previewSize = Size(960, 720)
    private var stillSize = Size(1920, 1440)
    @Volatile private var stillCapMaxW = 3264

    @Volatile private var latestUprightJpeg: ByteArray? = null
    @Volatile private var pendingShotId: String? = null
    @Volatile private var pendingShotTimeout: Runnable? = null

    private var connectivityManager: ConnectivityManager? = null
    private val trackedNetworks: MutableSet<Network> = Collections.newSetFromMap(ConcurrentHashMap<Network, Boolean>())
    private val lanNetworkCallbacks = ArrayList<ConnectivityManager.NetworkCallback>()
    @Volatile private var activeBaseUrl: String = ""
    @Volatile private var activeNetwork: Network? = null
    @Volatile private var activeLocalAddr: Inet4Address? = null
    private var lastScannedCandidates: List<String> = emptyList()
    private var webReloadRunnable: Runnable? = null
    @Volatile private var wsSocket: Socket? = null
    @Volatile private var wsOut: OutputStream? = null
    private val wsWriteLock = Any()
    private val wsRunning = AtomicBoolean(false)
    private val wsGen = AtomicLong(0L)
    @Volatile private var sessionActive = false

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
        lastScannedCandidates = candidates
        urlInput.setText(candidates.first())
        resolveAndConnect(candidates)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersiveMode()

        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        registerOfflineLanCallbacks()
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        desiredFacing = prefs.getString(KEY_FACING, "front") ?: "front"
        activeLensFront = (desiredFacing != "back")
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
        unregisterOfflineLanCallbacks()
        stopCamThread()
        netExec.shutdownNow()
        voiceBridge?.shutdown()
        voiceBridge = null
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
            // The guest page speaks the laptop's countdown with this tablet's own text-to-speech voices.
            val voice = VoiceBridge(this@GuestBridgeActivity)
            voiceBridge = voice
            addJavascriptInterface(voice, "__PBVoice")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    if (sessionActive && request?.isForMainFrame == true && activeBaseUrl.isNotEmpty()) {
                        Log.w(TAG, "Guest WebView error ${error?.errorCode}: ${error?.description}")
                        scheduleWebViewRecovery()
                    }
                }
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
            text = "1. Connect both devices to the same Wi-Fi router (online or offline) or the laptop's Booth Wi-Fi / Hotspot.\n2. On the laptop, open Setup → 7 Session → Screen & lock → Guest screen and scan the QR above (or paste the link below)."
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
                val parsed = parseQrCandidates(raw)
                val list = if (parsed.size == 1 && lastScannedCandidates.size > 1 && lastScannedCandidates.first() == parsed.first()) {
                    lastScannedCandidates
                } else {
                    parsed
                }
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

    // ---------- Offline-safe local Wi-Fi / Ethernet network binding ----------
    // On offline routers or laptop hotspots (no internet), Android marks Wi-Fi unvalidated and routes
    // default sockets & WebView over mobile data or drops them, causing timeouts. Registering callbacks
    // with NET_CAPABILITY_INTERNET removed both discovers offline Wi-Fi handles on Android 10+/HarmonyOS
    // and keeps the OS from dropping the offline router while the bridge runs.

    private fun registerOfflineLanCallbacks() {
        val cm = connectivityManager ?: return
        val transports = intArrayOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_ETHERNET)
        for (tr in transports) {
            try {
                val req = NetworkRequest.Builder()
                    .addTransportType(tr)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                val cb = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        trackedNetworks.add(network)
                    }
                    override fun onLost(network: Network) {
                        trackedNetworks.remove(network)
                    }
                }
                cm.registerNetworkCallback(req, cb)
                lanNetworkCallbacks.add(cb)
            } catch (e: Exception) {
                Log.w(TAG, "registerOfflineLanCallbacks failed for transport $tr", e)
            }
        }
    }

    private fun unregisterOfflineLanCallbacks() {
        val cm = connectivityManager ?: return
        for (cb in lanNetworkCallbacks) {
            try { cm.unregisterNetworkCallback(cb) } catch (_: Exception) { }
        }
        lanNetworkCallbacks.clear()
        trackedNetworks.clear()
    }

    private fun ipLong(a: Inet4Address): Long =
        a.address.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }

    private fun subnetMask(prefix: Int): Long =
        if (prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - prefix.coerceAtMost(32))) and 0xFFFFFFFFL

    @Suppress("DEPRECATION")
    private fun localRoutes(): List<LocalRoute> {
        val out = ArrayList<LocalRoute>()
        try {
            val cm = connectivityManager
            if (cm != null) {
                val allNets = LinkedHashSet<Network>()
                allNets.addAll(trackedNetworks)
                try { allNets.addAll(cm.allNetworks.toList()) } catch (_: Exception) { }
                for (n in allNets) {
                    val caps = cm.getNetworkCapabilities(n) ?: continue
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
                    if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                        !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    ) continue
                    val lp = cm.getLinkProperties(n) ?: continue
                    val ifName = lp.interfaceName ?: ""
                    for (la in lp.linkAddresses) {
                        val a = la.address
                        if (a is Inet4Address && !a.isLoopbackAddress && !a.isLinkLocalAddress) {
                            out.add(LocalRoute(n, a, la.prefixLength, ifName))
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "localRoutes ConnectivityManager scan failed", e)
        }
        try {
            val nis = NetworkInterface.getNetworkInterfaces()
            while (nis != null && nis.hasMoreElements()) {
                val ni = nis.nextElement()
                if (!ni.isUp || ni.isLoopback) continue
                val nm = ni.name.lowercase()
                if (nm.startsWith("rmnet") || nm.startsWith("ccmni") || nm.startsWith("pdp") ||
                    nm.startsWith("tun") || nm.startsWith("ppp") || nm.startsWith("v4-") || nm.startsWith("dummy")
                ) continue
                for (ia in ni.interfaceAddresses) {
                    val a = ia.address
                    if (a is Inet4Address && a.isSiteLocalAddress && out.none { it.localAddr == a }) {
                        out.add(LocalRoute(null, a, ia.networkPrefixLength.toInt(), ni.name))
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "localRoutes interface scan failed", e)
        }
        return out
    }

    private fun matchLocalRoute(host: String, routes: List<LocalRoute> = localRoutes()): LocalRoute? {
        if (host.isBlank() || host == "127.0.0.1" || host == "localhost") return null
        if (!IPV4_RE.matches(host)) return null
        return try {
            val target = InetAddress.getByName(host) as? Inet4Address ?: return null
            val tv = ipLong(target)
            for (r in routes) {
                if (r.network == null) continue
                val mask = subnetMask(r.prefix)
                if ((ipLong(r.localAddr) and mask) == (tv and mask)) return r
            }
            for (r in routes) {
                val mask = subnetMask(r.prefix)
                if ((ipLong(r.localAddr) and mask) == (tv and mask)) return r
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun hostOf(urlStr: String): String = try {
        URI(urlStr).host ?: ""
    } catch (_: Exception) {
        ""
    }

    private fun hostPortOf(urlStr: String): String = try {
        val u = URI(urlStr)
        val h = u.host ?: urlStr
        if (u.port > 0) "$h:${u.port}" else h
    } catch (_: Exception) {
        urlStr
    }

    private fun bindBridgeNetwork(network: Network?) {
        if (network != null && !sessionActive) return
        try {
            connectivityManager?.bindProcessToNetwork(network)
        } catch (e: Exception) {
            Log.w(TAG, "bindProcessToNetwork failed", e)
        }
    }

    private fun openBridgeHttp(url: URL, network: Network?, connectMs: Int, readMs: Int): HttpURLConnection {
        val conn = (if (network != null) network.openConnection(url) else url.openConnection()) as HttpURLConnection
        conn.connectTimeout = connectMs
        conn.readTimeout = readMs
        conn.useCaches = false
        return conn
    }

    private fun createBridgeSocket(network: Network?, localAddr: Inet4Address?): Socket {
        if (network != null) {
            try {
                return network.socketFactory.createSocket()
            } catch (e: Exception) {
                Log.w(TAG, "network.socketFactory.createSocket failed, falling back", e)
            }
        }
        if (localAddr != null) {
            val s = Socket()
            try {
                s.bind(InetSocketAddress(localAddr, 0))
            } catch (e: Exception) {
                Log.w(TAG, "localAddr socket bind failed", e)
            }
            return s
        }
        return Socket()
    }

    private fun probeOnce(cand: String, network: Network?, localAddr: Inet4Address?, timeoutMs: Int): ProbeOutcome {
        var conn: HttpURLConnection? = null
        return try {
            conn = openBridgeHttp(URL("$cand/hello"), network, timeoutMs, timeoutMs).apply {
                requestMethod = "GET"
                setRequestProperty("Connection", "close")
            }
            val code = conn.responseCode
            if (code == 200) {
                val txt = conn.inputStream.bufferedReader().use { it.readText() }
                if (txt.contains("photobooth4u-bridge")) {
                    ProbeOutcome(cand, network, localAddr, ok = true, httpCode = 200)
                } else {
                    ProbeOutcome(cand, network, localAddr, ok = false, httpCode = 200, error = "wrong service")
                }
            } else {
                ProbeOutcome(cand, network, localAddr, ok = false, httpCode = code, error = "HTTP $code")
            }
        } catch (e: SocketTimeoutException) {
            ProbeOutcome(cand, network, localAddr, ok = false, error = "timeout")
        } catch (e: ConnectException) {
            ProbeOutcome(cand, network, localAddr, ok = false, error = "refused")
        } catch (e: Exception) {
            ProbeOutcome(cand, network, localAddr, ok = false, error = e.message ?: e.javaClass.simpleName)
        } finally {
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    private fun probeViaBoundSocket(cand: String, localAddr: Inet4Address, timeoutMs: Int): ProbeOutcome {
        var sock: Socket? = null
        return try {
            val u = URI(cand)
            val host = u.host ?: return ProbeOutcome(cand, null, localAddr, ok = false, error = "bad host")
            val port = if (u.port > 0) u.port else 80
            val path = (u.rawPath ?: "") + "/hello"
            sock = createBridgeSocket(null, localAddr)
            sock.soTimeout = timeoutMs
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            val out = sock.getOutputStream()
            val req = "GET $path HTTP/1.1\r\nHost: $host:$port\r\nConnection: close\r\n\r\n"
            out.write(req.toByteArray(Charsets.UTF_8))
            out.flush()
            val resp = sock.getInputStream().bufferedReader().use { it.readText() }
            val statusLine = resp.lineSequence().firstOrNull() ?: ""
            val code = statusLine.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            if (code == 200 && resp.contains("photobooth4u-bridge")) {
                ProbeOutcome(cand, null, localAddr, ok = true, httpCode = 200)
            } else {
                ProbeOutcome(cand, null, localAddr, ok = false, httpCode = code, error = if (code > 0) "HTTP $code" else "wrong service")
            }
        } catch (e: SocketTimeoutException) {
            ProbeOutcome(cand, null, localAddr, ok = false, error = "timeout")
        } catch (e: ConnectException) {
            ProbeOutcome(cand, null, localAddr, ok = false, error = "refused")
        } catch (e: Exception) {
            ProbeOutcome(cand, null, localAddr, ok = false, error = e.message ?: e.javaClass.simpleName)
        } finally {
            try { sock?.close() } catch (_: Exception) { }
        }
    }

    private fun probeCandidate(cand: String, routes: List<LocalRoute>): ProbeOutcome {
        val host = hostOf(cand)
        if (host == "127.0.0.1" || host == "localhost") {
            return probeOnce(cand, null, null, LOOPBACK_PROBE_TIMEOUT_MS)
        }
        val matched = matchLocalRoute(host, routes)
        if (matched != null) {
            if (matched.network == null) {
                // Non-CM interface (e.g. USB Tethering rndis0 / Wi-Fi Direct p2p): bind source IP directly
                // so cellular data never hijacks the probe when offline.
                val bound = probeViaBoundSocket(cand, matched.localAddr, PROBE_TIMEOUT_MS)
                if (bound.ok || bound.httpCode == 403) return bound
                val fallback = probeOnce(cand, null, matched.localAddr, 1500)
                return if (fallback.ok || fallback.httpCode == 403) fallback else bound
            }
            val first = probeOnce(cand, matched.network, matched.localAddr, PROBE_TIMEOUT_MS)
            if (first.ok || first.httpCode == 403) return first
            // Only retry unbound if binding itself threw a non-timeout/non-refused OS error.
            if (first.error != "timeout" && first.error != "refused") {
                val fallback = probeOnce(cand, null, matched.localAddr, 1500)
                if (fallback.ok || fallback.httpCode == 403) return fallback
            }
            return first
        }
        // Target IP is on another subnet (e.g. multi-subnet router or stale adapter): try Wi-Fi/Ethernet
        // networks explicitly before the default route so offline Wi-Fi still beats mobile data.
        val lanNets = routes.mapNotNull { it.network }.distinct()
        var lastErr = ProbeOutcome(cand, null, null, ok = false, error = "unreachable")
        val perTry = if (lanNets.isNotEmpty()) 2200 else PROBE_TIMEOUT_MS
        for (net in lanNets) {
            val r = probeOnce(cand, net, null, perTry)
            if (r.ok || r.httpCode == 403) return r
            lastErr = r
        }
        val def = probeOnce(cand, null, null, perTry)
        return if (def.ok || def.httpCode == 403 || lanNets.isEmpty()) def else lastErr
    }

    private fun resolveAndConnect(candidates: List<String>) {
        if (candidates.isEmpty()) return
        connectBtn.isEnabled = false
        statusText.text = "Connecting to laptop…"
        val capped = candidates.take(6)
        netExec.execute {
            val routes = localRoutes()
            val lock = ReentrantLock()
            val cond = lock.newCondition()
            val outcomes = arrayOfNulls<ProbeOutcome>(capped.size)
            var completed = 0
            var firstOkAt = 0L
            val startAt = System.currentTimeMillis()
            val futures = ArrayList<Future<*>>(capped.size)

            for (idx in capped.indices) {
                val cand = capped[idx]
                futures.add(netExec.submit(Callable {
                    val res = probeCandidate(cand, routes)
                    lock.lock()
                    try {
                        outcomes[idx] = res
                        completed++
                        if (res.ok && firstOkAt == 0L) firstOkAt = System.currentTimeMillis()
                        cond.signalAll()
                    } finally {
                        lock.unlock()
                    }
                    res
                }))
            }

            // Wait for the highest-priority candidate (e.g. USB Tether) without stalling on dead adapters:
            // index 0 wins immediately; if a fallback index succeeds, allow 500ms for higher-priority probes.
            lock.lock()
            try {
                while (true) {
                    val now = System.currentTimeMillis()
                    if (outcomes[0]?.ok == true) break
                    if (completed >= capped.size) break
                    if (firstOkAt > 0L && now - firstOkAt >= 500L) break
                    val ceilRem = 5000L - (now - startAt)
                    if (ceilRem <= 0L) break
                    val waitMs = if (firstOkAt > 0L) minOf(ceilRem, 500L - (now - firstOkAt)) else ceilRem
                    if (waitMs <= 0L) break
                    try {
                        cond.await(waitMs, TimeUnit.MILLISECONDS)
                    } catch (_: InterruptedException) {
                        break
                    }
                }
            } finally {
                lock.unlock()
            }

            val picked = outcomes.firstOrNull { it?.ok == true }
            futures.forEach { try { it.cancel(true) } catch (_: Exception) { } }

            val allOutcomes = outcomes.filterNotNull()
            val expired = allOutcomes.any { it.httpCode == 403 }
            val lanTried = capped.filter { val h = hostOf(it); h != "127.0.0.1" && h != "localhost" }
            val anyTimeout = allOutcomes.any {
                val h = hostOf(it.baseUrl)
                h != "127.0.0.1" && h != "localhost" && it.error == "timeout"
            }
            val triedLabel = (if (lanTried.isNotEmpty()) lanTried else capped).take(3).joinToString(", ") { hostPortOf(it) }

            mainHandler.post {
                connectBtn.isEnabled = true
                if (picked == null) {
                    val msg = when {
                        expired -> "Bridge pairing code expired. Re-scan the new QR code in Setup → 7 Session on the laptop."
                        anyTimeout -> "Timed out reaching $triedLabel. Make sure both devices are on the same Wi-Fi, Router AP Isolation is off, and Windows Firewall allows photobooth4u (set the laptop Wi-Fi to Private)."
                        else -> "Could not reach laptop ($triedLabel). Make sure both devices are on the same Wi-Fi router or laptop Booth Wi-Fi / Hotspot and try again."
                    }
                    statusText.text = msg
                    Toast.makeText(this, if (expired) "Pairing expired — re-scan QR." else "Could not reach laptop.", Toast.LENGTH_LONG).show()
                } else {
                    startBridgeSession(picked.baseUrl, picked.network, picked.localAddr)
                }
            }
        }
    }

    private fun bestNetworkForHost(host: String): Pair<Network?, Inet4Address?> {
        if (host.isBlank() || host == "127.0.0.1" || host == "localhost") return Pair(null, null)
        val routes = localRoutes()
        val matched = matchLocalRoute(host, routes)
        if (matched != null) return Pair(matched.network, matched.localAddr)
        val cur = activeNetwork
        if (cur != null && routes.any { it.network == cur }) return Pair(cur, null)
        return Pair(routes.firstOrNull { it.network != null }?.network, null)
    }

    private fun scheduleWebViewRecovery() {
        webReloadRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            if (!sessionActive || activeBaseUrl.isEmpty()) return@Runnable
            val targetUrl = "$activeBaseUrl/guest"
            netExec.execute {
                val (net, localAddr) = bestNetworkForHost(hostOf(activeBaseUrl))
                activeNetwork = net
                activeLocalAddr = localAddr
                mainHandler.post {
                    if (!sessionActive) return@post
                    bindBridgeNetwork(net)
                    webView.loadUrl(targetUrl)
                }
            }
        }
        webReloadRunnable = r
        mainHandler.postDelayed(r, 2000L)
    }

    private fun startBridgeSession(baseUrl: String, network: Network? = null, localAddr: Inet4Address? = null) {
        activeBaseUrl = normalizeBridgeBase(baseUrl)
        activeNetwork = network
        activeLocalAddr = localAddr
        stillCapMaxW = 3264
        urlInput.setText(activeBaseUrl)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_BASE_URL, activeBaseUrl).apply()
        sessionActive = true
        bindBridgeNetwork(network)
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
        wsGen.incrementAndGet()
        webReloadRunnable?.let { mainHandler.removeCallbacks(it) }
        webReloadRunnable = null
        try { wsSocket?.close() } catch (_: Exception) { }
        wsSocket = null
        wsOut = null
        activeNetwork = null
        activeLocalAddr = null
        bindBridgeNetwork(null)
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

    private fun scheduleCameraRestart(delayMs: Long = 1200L) {
        if (!sessionActive) return
        camRestartRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            camRestartRunnable = null
            if (sessionActive && hasCamPerm() && cameraDevice == null) {
                startCameraIfReady()
            }
        }
        camRestartRunnable = r
        mainHandler.postDelayed(r, delayMs)
    }

    @SuppressLint("MissingPermission")
    private fun startCameraIfReady() {
        if (!sessionActive || !hasCamPerm() || !previewView.isAvailable || cameraDevice != null) return
        if (!cameraOpening.compareAndSet(false, true)) return
        val cm = cameraManager
        if (cm == null) { cameraOpening.set(false); return }
        val camId = (if (desiredFacing == "back") backCamId else frontCamId) ?: frontCamId ?: backCamId
        if (camId == null) { cameraOpening.set(false); return }
        activeCamId = camId
        try {
            val chars = cm.getCameraCharacteristics(camId)
            sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            activeLensFront = (chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT)
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            if (map != null) {
                val yuvSizes = map.getOutputSizes(ImageFormat.YUV_420_888) ?: emptyArray()
                // Keep live preview YUV stream <= 960x720 so Huawei Kirin / Android Camera2 HAL stays smooth
                // while stillSize remains full-resolution (up to 3264x2448 / 8MP) for crisp prints.
                previewSize = chooseBestSize(yuvSizes, 960, 720, 4.0 / 3.0)
                val jpegSizes = map.getOutputSizes(ImageFormat.JPEG) ?: yuvSizes
                stillSize = chooseBestSize(jpegSizes, stillCapMaxW, (stillCapMaxW * 3) / 4, previewSize.width.toDouble() / max(1, previewSize.height))
            }
            ensureCamThread()
            cm.openCamera(camId, object : CameraDevice.StateCallback() {
                override fun onOpened(dev: CameraDevice) {
                    cameraOpening.set(false)
                    if (!sessionActive) {
                        try { dev.close() } catch (_: Exception) { }
                        return
                    }
                    cameraDevice = dev
                    createSession(dev)
                }
                override fun onDisconnected(dev: CameraDevice) {
                    cameraOpening.set(false)
                    try { dev.close() } catch (_: Exception) { }
                    if (cameraDevice == dev) cameraDevice = null
                    Log.w(TAG, "Camera disconnected — scheduling restart")
                    scheduleCameraRestart(1200L)
                }
                override fun onError(dev: CameraDevice, error: Int) {
                    cameraOpening.set(false)
                    try { dev.close() } catch (_: Exception) { }
                    if (cameraDevice == dev) cameraDevice = null
                    Log.e(TAG, "Camera error $error — scheduling restart")
                    scheduleCameraRestart(1500L)
                }
            }, camHandler)
        } catch (e: Exception) {
            cameraOpening.set(false)
            Log.e(TAG, "openCamera failed", e)
            scheduleCameraRestart(1800L)
        }
    }

    private fun chooseBestSize(sizes: Array<Size>, maxW: Int, maxH: Int, targetAspect: Double): Size {
        val fit = sizes.filter { it.width <= maxW && it.height <= maxH && it.width >= 640 }
        val pool = if (fit.isNotEmpty()) fit else sizes.toList()
        return pool.minWithOrNull(compareBy<Size> {
            val a = it.width.toDouble() / max(1, it.height)
            abs(a - targetAspect)
        }.thenByDescending { it.width * it.height }) ?: Size(960, 720)
    }

    private fun createSession(dev: CameraDevice) {
        val st = previewView.surfaceTexture
        if (st == null) {
            try { dev.close() } catch (_: Exception) { }
            if (cameraDevice == dev) cameraDevice = null
            scheduleCameraRestart(800L)
            return
        }
        st.setDefaultBufferSize(previewSize.width, previewSize.height)
        val texSurface = Surface(st)

        previewReader?.close()
        previewReader = ImageReader.newInstance(previewSize.width, previewSize.height, ImageFormat.YUV_420_888, 3).apply {
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
                    Log.e(TAG, "setRepeatingRequest failed — restarting camera", e)
                    try { dev.close() } catch (_: Exception) { }
                    if (cameraDevice == dev) cameraDevice = null
                    scheduleCameraRestart(1500L)
                }
            }
            override fun onConfigureFailed(session: CameraCaptureSession) {
                Log.e(TAG, "createCaptureSession failed — retrying with smaller still size")
                if (stillCapMaxW > 1920) stillCapMaxW = 1920
                try { dev.close() } catch (_: Exception) { }
                if (cameraDevice == dev) cameraDevice = null
                scheduleCameraRestart(1500L)
            }
        }, camHandler)
    }

    private fun stopCamera() {
        camRestartRunnable?.let { mainHandler.removeCallbacks(it) }
        camRestartRunnable = null
        cameraOpening.set(false)
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
        return if (activeLensFront) {
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
        // Android Camera2 (Camera3OutputStream / SurfaceFlinger) automatically mirrors TextureView horizontally
        // for LENS_FACING_FRONT (NATIVE_WINDOW_TRANSFORM_FLIP_H), while LENS_FACING_BACK is un-mirrored.
        // Raw ImageReader frames (laptop live preview + full-res JPEG stills) are never auto-mirrored.
        // Flip TextureView only when the booth's desired mirror state differs from Android's native mirror:
        //   Front + Mirror ON  -> already mirrored by Android (no extra flip)
        //   Front + Mirror OFF -> undo Android's auto-mirror (-1)
        //   Rear  + Mirror ON  -> apply mirror (-1)
        //   Rear  + Mirror OFF -> keep un-mirrored (no flip)
        if (pvMirror != activeLensFront) {
            m.postScale(-1f, 1f, cx, cy)
        }
        previewView.setTransform(m)
    }

    private fun onPreviewImage(img: Image) {
        val now = System.currentTimeMillis()
        if (now - lastFrameAt.get() < PREVIEW_FRAME_INTERVAL_MS) return
        if (!camConnected.get() || !previewSending.compareAndSet(false, true)) return
        lastFrameAt.set(now)
        try {
            // Copy raw YUV bytes quickly on camHandler so img.close() returns the HAL buffer right away
            // (prevents Huawei Kirin / Camera2 ImageReader starvation), then encode & transmit off-thread.
            val w = img.width
            val h = img.height
            val rot = jpegRotationDeg()
            val nv21 = yuv420ToNv21(img)
            netExec.execute {
                try {
                    val baos = ByteArrayOutputStream()
                    YuvImage(nv21, ImageFormat.NV21, w, h, null)
                        .compressToJpeg(Rect(0, 0, w, h), 72, baos)
                    var jpg = baos.toByteArray()
                    if (rot != 0) {
                        jpg = rotateJpeg(jpg, rot)
                    }
                    latestUprightJpeg = jpg
                    if (camConnected.get()) {
                        sendWsFrame(0x2, jpg)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "preview encode/send error", e)
                } finally {
                    previewSending.set(false)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "preview copy error", e)
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
        val vRowStride = vPlane.rowStride
        val vPixStride = vPlane.pixelStride
        val uRowStride = uPlane.rowStride
        val uPixStride = uPlane.pixelStride
        val halfH = h / 2
        val halfW = w / 2
        val vLim = vBuf.limit()
        val uLim = uBuf.limit()
        for (r in 0 until halfH) {
            val vBase = r * vRowStride
            val uBase = r * uRowStride
            for (c in 0 until halfW) {
                val vOff = vBase + c * vPixStride
                val uOff = uBase + c * uPixStride
                out[pos++] = if (vOff < vLim) vBuf.get(vOff) else 128.toByte()
                out[pos++] = if (uOff < uLim) uBuf.get(uOff) else 128.toByte()
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

    private fun postBytesViaBoundSocket(url: URL, localAddr: Inet4Address, bytes: ByteArray): Boolean {
        var sock: Socket? = null
        return try {
            val host = url.host
            val port = if (url.port > 0) url.port else 80
            val path = url.file.ifEmpty { "/" }
            sock = createBridgeSocket(null, localAddr)
            sock.soTimeout = 12000
            sock.connect(InetSocketAddress(host, port), 6000)
            val out = sock.getOutputStream()
            val hdr = "POST $path HTTP/1.1\r\nHost: $host:$port\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            out.write(hdr.toByteArray(Charsets.UTF_8))
            out.write(bytes)
            out.flush()
            val line = sock.getInputStream().bufferedReader().readLine() ?: ""
            val code = line.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "bound-socket shot upload failed", e)
            false
        } finally {
            try { sock?.close() } catch (_: Exception) { }
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
            val uploadUrl = URL("$base/cam/shot?id=$shotId")
            fun sendOn(net: Network?): Boolean {
                var conn: HttpURLConnection? = null
                return try {
                    conn = openBridgeHttp(uploadUrl, net, 6000, 12000).apply {
                        requestMethod = "POST"
                        doOutput = true
                        setFixedLengthStreamingMode(bytes.size)
                        setRequestProperty("Content-Type", "image/jpeg")
                    }
                    conn.outputStream.use { it.write(bytes) }
                    conn.responseCode in 200..299
                } catch (e: Exception) {
                    Log.w(TAG, "shot upload attempt failed", e)
                    false
                } finally {
                    try { conn?.disconnect() } catch (_: Exception) { }
                }
            }
            fun tryUpload(net: Network?, localAddr: Inet4Address?): Boolean {
                if (net != null) return sendOn(net)
                if (localAddr != null) return postBytesViaBoundSocket(uploadUrl, localAddr, bytes) || sendOn(null)
                return sendOn(null)
            }
            val firstNet = activeNetwork
            val firstAddr = activeLocalAddr
            if (!tryUpload(firstNet, firstAddr) && sessionActive) {
                val (freshNet, freshAddr) = bestNetworkForHost(hostOf(base))
                if (freshNet != activeNetwork) {
                    activeNetwork = freshNet
                    bindBridgeNetwork(freshNet)
                }
                activeLocalAddr = freshAddr
                if (!tryUpload(freshNet, freshAddr)) {
                    Log.e(TAG, "shot upload failed after retry")
                }
            }
        }
    }

    // ---------- Minimal RFC-6455 WebSocket client for Camera2 ----------
    private fun startCameraWebSocket() {
        val myGen = wsGen.incrementAndGet()
        wsRunning.set(true)
        netExec.execute {
            while (wsRunning.get() && sessionActive && wsGen.get() == myGen) {
                var sock: Socket? = null
                try {
                    val uri = URI(activeBaseUrl)
                    val host = uri.host ?: break
                    val port = if (uri.port > 0) uri.port else 80
                    val path = (uri.rawPath ?: "") + "/ws?role=cam"

                    val (net, localAddr) = bestNetworkForHost(host)
                    if (!wsRunning.get() || !sessionActive || wsGen.get() != myGen) break
                    if (net != activeNetwork) {
                        activeNetwork = net
                        bindBridgeNetwork(net)
                    }
                    activeLocalAddr = localAddr

                    val s = createBridgeSocket(net, localAddr)
                    sock = s
                    s.connect(InetSocketAddress(host, port), 4000)
                    s.tcpNoDelay = true
                    s.keepAlive = true
                    s.soTimeout = 30000
                    if (!wsRunning.get() || !sessionActive || wsGen.get() != myGen) {
                        try { s.close() } catch (_: Exception) { }
                        break
                    }
                    wsSocket = s
                    val out = s.getOutputStream()
                    wsOut = out
                    val inp = s.getInputStream()

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
                        s.close()
                        Thread.sleep(1500)
                        continue
                    }

                    camConnected.set(true)
                    sendCameraHello()
                    readWsLoop(inp)
                } catch (_: Exception) {
                    // Refresh network binding on reconnect in case Wi-Fi bounced or changed.
                    activeNetwork = null
                } finally {
                    try { sock?.close() } catch (_: Exception) { }
                    if (wsGen.get() == myGen) {
                        camConnected.set(false)
                        if (wsSocket === sock) {
                            wsSocket = null
                            wsOut = null
                        }
                    }
                }
                if (wsRunning.get() && sessionActive && wsGen.get() == myGen) {
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
