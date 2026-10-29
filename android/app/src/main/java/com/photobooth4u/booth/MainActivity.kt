package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayInputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var btBridge: BTBridge
    private lateinit var pbLocal: PBLocal
    private var shareServer: LocalShareServer? = null
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null

    private val PREFS_NAME = "photobooth_prefs"
    private val PREF_URL = "booth_url"
    private val PREF_LIVE = "use_live_url"
    private val DEFAULT_URL = "https://photobooth4u.netlify.app/"
    private val BASE_URL   = "https://photobooth4u.netlify.app/"
    private val ASSET_BOOTH = "booth.html"
    private var offlineLoaded = false

    private val REQ_CAMERA_PERMISSION = 2001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Keep tablet screen awake during the event
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 2. Hide system navigation and status bars for Kiosk mode
        hideSystemBars()

        // 3. Set up WebView container
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#F5F1EA"))
        setContentView(root)

        webView = WebView(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        // 4. Configure WebView Settings
        configureWebView()

        // 5. Inject BTBridge into JavaScript context (window.__BTBridge)
        btBridge = BTBridge(this, webView)
        webView.addJavascriptInterface(btBridge, "__BTBridge")

        // 5b. Offline photos: saved on this tablet through window.__PBLocal, and shown to guests' phones
        // over the booth Wi-Fi by a small web server in the app (no internet needed).
        pbLocal = PBLocal(this)
        webView.addJavascriptInterface(pbLocal, "__PBLocal")
        val share = LocalShareServer(pbLocal)
        shareServer = share
        Thread {
            try { share.start() } catch (e: Exception) { /* guests just won't get a QR */ }
        }.start()

        // 6. Request camera permissions if needed
        checkAndRequestPermissions()

        // 7. Prevent accidental exit by guests (back button confirmation)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    showExitConfirmation()
                }
            }
        })

        // 8. Venue kiosk: boot the bundled booth. Live web is opt-in (long-press), and only
        // attempted when the tablet actually has a network right now — otherwise there's no
        // point waiting on a request that can only fail, so go straight to the offline booth.
        if (useLiveUrl() && isNetworkAvailable()) {
            webView.loadUrl(getSavedUrl())
        } else {
            loadOfflineBooth()
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemBars()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        btBridge.disconnect()
        shareServer?.stop()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val s: WebSettings = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.displayZoomControls = false
        s.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.safeBrowsingEnabled = false
        }

        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false

        // ChromeClient for camera / microphone permissions & file chooser
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // Automatically grant camera and microphone access to the booth
                activityGrantPermissions(request)
            }

            override fun onShowFileChooser(
                mWebView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "image/*"
                }
                try {
                    startActivityForResult(intent, 3001)
                } catch (e: Exception) {
                    fileUploadCallback = null
                    return false
                }
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val host = uri.host ?: ""
                // Keep booth and sub-paths in WebView; open external links in browser
                if (host.contains("photobooth4u.netlify.app") || host.contains("localhost") || host.contains("127.0.0.1")) {
                    return false
                }
                return try {
                    val intent = Intent(Intent.ACTION_VIEW, uri)
                    startActivity(intent)
                    true
                } catch (e: Exception) {
                    false
                }
            }

            // If the live web page fails for ANY reason (offline, DNS error, timeout,
            // a generic error code), fall back to the bundled booth.html so the kiosk
            // keeps working at the venue without internet. There's no legitimate reason
            // for the main frame to fail here other than "can't reach the live site", and
            // Android's own ERR_INTERNET_DISCONNECTED often comes back as a generic/unknown
            // error code rather than one of the specific ones, so this no longer filters by code.
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true && !offlineLoaded) {
                    loadOfflineBooth()
                }
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M && !offlineLoaded) {
                    loadOfflineBooth()
                }
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return interceptOfflineRequest(request) ?: super.shouldInterceptRequest(view, request)
            }
        }

        // Secret operator gesture: Long press with 2 fingers or header hold to change booth URL
        webView.setOnLongClickListener {
            showUrlConfigDialog()
            true
        }
    }

    // ── Offline kiosk fallback ──────────────────────────────────────────────────
    // Reads booth.html from assets, injects the Android __PB config block so the
    // booth knows it is running in kiosk mode and can use BTBridge, then loads
    // it via loadDataWithBaseURL so localStorage / IndexedDB still work at the
    // photobooth4u.netlify.app origin (which is where the user would have unlocked).
    private fun loadOfflineBooth() {
        offlineLoaded = true
        runOnUiThread {
            try {
                val raw = assets.open(ASSET_BOOTH).bufferedReader().use { it.readText() }

                // Inject Android kiosk config so booth.html behaves like the
                // desktop app (all features on, GIF mode, thermal printing, etc.)
                val pbConfig = buildString {
                    append("<script>")
                    // window.__PB lets the booth enable GIF, retake, lock, pay, printing features
                    append("window.__PB=window.__PB||{};")
                    append("window.__PB.desktop={v:'1.0.6',os:'android'};")
                    // Tells the booth that photos are saved by this app and shared over the booth Wi-Fi
                    append("window.__PB.android=true;")
                    // Mark it as a rental-style session so all features are visible
                    append("window.__PB.type='rental';")
                    append("window.__PB.gifOpt=true;")
                    append("window.__PB.retakeOpt=true;")
                    append("window.__PB.lockOpt=true;")
                    append("window.__PB.payOpt=false;")
                    append("window.__PB.traditional=false;")
                    append("window.__PB.watermark=false;")
                    append("window.__PB.exp=").append(System.currentTimeMillis() + 365L * 24 * 3600 * 1000).append(";")  // 1-year local session
                    append("window.__PB.print=window.__PB.print||{enabled:true,sizes:['receipt80','receipt58','4x6','2x6']};")
                    // Report offline so Drive / pay / vouchers skip at once instead of hanging on DNS.
                    // Photos don't need the internet: the app saves them (__PBLocal) and LocalShareServer shares them.
                    append("try{Object.defineProperty(Navigator.prototype,'onLine',{get:function(){return false;},configurable:true});}catch(e){}")
                    append("</script>")
                }

                // Inject the config just before </head>
                val html = if (raw.contains("</head>", ignoreCase = true)) {
                    raw.replace("</head>", "$pbConfig\n</head>", ignoreCase = true)
                } else {
                    pbConfig + raw
                }

                webView.loadDataWithBaseURL(
                    BASE_URL,     // origin — localStorage keys match the live booth
                    html,
                    "text/html",
                    "UTF-8",
                    null
                )
            } catch (e: Exception) {
                Toast.makeText(this, "Could not load offline booth: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun interceptOfflineRequest(request: WebResourceRequest?): WebResourceResponse? {
        if (!offlineLoaded) return null
        val url = request?.url ?: return null
        val host = (url.host ?: "").lowercase()
        val path = url.path ?: ""
        if (host.contains("fonts.googleapis.com") || host.contains("fonts.gstatic.com")) {
            return webResponse("text/css", ByteArray(0))
        }
        if (path.startsWith("/api/") || host.contains("catbox.moe") || host.contains("qrserver.com") ||
            host.contains("script.google.com") || host.contains("drive.google.com")
        ) {
            return webResponse(
                "application/json",
                """{"ok":false,"error":"offline"}""".toByteArray(Charsets.UTF_8),
                503,
                "Offline"
            )
        }
        return null
    }

    private fun webResponse(
        mime: String,
        body: ByteArray,
        status: Int = 200,
        reason: String = "OK"
    ): WebResourceResponse {
        return WebResourceResponse(
            mime,
            "utf-8",
            status,
            reason,
            mapOf("Access-Control-Allow-Origin" to "*"),
            ByteArrayInputStream(body)
        )
    }

    private fun activityGrantPermissions(request: PermissionRequest) {
        runOnUiThread {
            request.grant(request.resources)
        }
    }

    private fun checkAndRequestPermissions() {
        val permissions = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
            permissions.add(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            permissions.add(Manifest.permission.BLUETOOTH)
            permissions.add(Manifest.permission.BLUETOOTH_ADMIN)
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }

        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQ_CAMERA_PERMISSION)
        }
    }

    // A real connectivity check, not just a saved preference — the operator may have set
    // a live URL while testing and then taken the tablet to a venue with no Wi-Fi.
    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun getSavedUrl(): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(PREF_URL, DEFAULT_URL) ?: DEFAULT_URL
    }

    private fun useLiveUrl(): Boolean {
        return getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(PREF_LIVE, false)
    }

    private fun setUseLiveUrl(live: Boolean) {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putBoolean(PREF_LIVE, live).apply()
    }

    private fun saveUrl(url: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(PREF_URL, url).apply()
    }

    private fun showUrlConfigDialog() {
        val input = EditText(this)
        input.setText(getSavedUrl())
        input.setSelection(input.text.length)

        AlertDialog.Builder(this)
            .setTitle("Booth Configuration")
            .setMessage("This tablet boots the bundled booth (no internet). Save a URL only if you want the live website instead.")
            .setView(input)
            .setPositiveButton("Save live URL") { _, _ ->
                val newUrl = input.text.toString().trim()
                if (newUrl.isNotBlank()) {
                    saveUrl(newUrl)
                    setUseLiveUrl(true)
                    offlineLoaded = false
                    webView.loadUrl(newUrl)
                    Toast.makeText(this, "Loading $newUrl", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("Bundled booth (offline)") { _, _ ->
                setUseLiveUrl(false)
                offlineLoaded = false
                loadOfflineBooth()
                Toast.makeText(this, "Loaded offline booth from device", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showExitConfirmation() {
        AlertDialog.Builder(this)
            .setTitle("Exit Photo Booth?")
            .setMessage("Are you sure you want to exit the kiosk application?")
            .setPositiveButton("Exit") { _, _ ->
                finish()
            }
            .setNegativeButton("Stay", null)
            .show()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 3001) {
            val results = if (resultCode == RESULT_OK && data != null) {
                val clip = data.clipData
                if (clip != null) {
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                } else {
                    data.data?.let { arrayOf(it) }
                }
            } else null
            fileUploadCallback?.onReceiveValue(results)
            fileUploadCallback = null
        }
    }
}
