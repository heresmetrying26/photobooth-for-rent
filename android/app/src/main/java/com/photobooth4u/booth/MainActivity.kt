package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private lateinit var btBridge: BTBridge
    private lateinit var pbLocal: PBLocal
    private lateinit var licence: AppLicence
    private var shareServer: LocalShareServer? = null
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null

    // This tablet's rental-code entitlements, from the last time status() said ok —
    // what the bundled booth is actually allowed to turn on, and when it stops.
    private var activeFeat: JSONObject? = null
    private var activeExp: Long? = null

    // The native "enter your code" screen shown over the WebView until this tablet
    // is activated (see AppLicence). Built once, then shown/hidden.
    private var gateRoot: LinearLayout? = null
    private var gateMessage: TextView? = null
    private var gateCode: EditText? = null
    private var gateButton: Button? = null
    private var gateReason: String = ""
    private val checkinHandler = Handler(Looper.getMainLooper())
    private val checkinLoop = object : Runnable {
        override fun run() {
            if (::licence.isInitialized && isNetworkAvailable()) {
                licence.checkin { /* applied silently; a lapsed licence gates at the next boot */ }
            }
            checkinHandler.postDelayed(this, 10 * 60_000L)
        }
    }

    private val PREFS_NAME = "photobooth_prefs"
    private val PREF_URL = "booth_url"
    private val PREF_LIVE = "use_live_url"
    private val DEFAULT_URL = "https://photobooth4u.netlify.app/"
    private val BASE_URL   = "https://photobooth4u.netlify.app/"
    private val ASSET_BOOTH = "booth.html"
    private var offlineLoaded = false
    private var pageErrorToasts = 0

    private val REQ_CAMERA_PERMISSION = 2001

    // ---- New version prompt ----
    // At launch (never mid-session) ask the site for the newest tablet app; when this one is older, offer the
    // download. "Update" opens the APK in the browser, and Android then offers to install it over this app.
    private fun checkForAppUpdate() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("update_checked", 0L) < 6 * 3600_000L || !isNetworkAvailable()) return
        Thread {
            try {
                val c = URL(BASE_URL + "api/updates").openConnection() as HttpURLConnection
                c.connectTimeout = 6000; c.readTimeout = 6000
                val body = c.inputStream.bufferedReader().use { it.readText() }
                prefs.edit().putLong("update_checked", now).apply()
                val a = JSONObject(body).optJSONObject("android") ?: return@Thread
                val latest = a.optString("version"); val url = a.optString("url")
                val mine = packageManager.getPackageInfo(packageName, 0).versionName ?: return@Thread
                if (latest.isEmpty() || !url.startsWith("https://") || !versionNewer(latest, mine)) return@Thread
                if (now < prefs.getLong("update_snooze_" + latest, 0L)) return@Thread
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    AlertDialog.Builder(this)
                        .setTitle("New version available")
                        .setMessage("photobooth4u " + latest + " is ready (this tablet has " + mine + "). Update between events, not during a session.")
                        .setPositiveButton("Update") { _, _ -> try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { } }
                        .setNegativeButton("Later") { _, _ -> prefs.edit().putLong("update_snooze_" + latest, System.currentTimeMillis() + 24 * 3600_000L).apply() }
                        .show()
                }
            } catch (e: Exception) { /* offline or the site is down: try again next launch */ }
        }.start()
    }

    private fun versionNewer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }; val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) { val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }; if (p != q) return p > q }
        return false
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Keep tablet screen awake during the event
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 2. Hide system navigation and status bars for Kiosk mode
        hideSystemBars()

        // 3. Set up WebView container
        root = FrameLayout(this)
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

        // 5c. This tablet's offline-app licence — the same signed-licence system the
        // desktop app uses, tied to a rental code's "offline app" add-on. The booth stays
        // behind the activation screen until a code unlocks it (needs Wi-Fi once); after
        // that it keeps working offline until the code's next check-in is due.
        licence = AppLicence(this)

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

        // 8. Venue kiosk: boot the bundled booth once this tablet is activated (step 5c).
        // Live web is opt-in (long-press), and only attempted when the tablet actually has
        // a network right now — otherwise there's no point waiting on a request that can
        // only fail, so go straight to the offline booth.
        bootWithLicence()
        checkForAppUpdate()
        checkinHandler.postDelayed(checkinLoop, 10 * 60_000L)
    }

    // Applies this tablet's current licence status: shows the activation screen when it
    // isn't activated (or has lapsed), otherwise boots the booth with that code's actual
    // entitlements. Called at launch, after a successful activation, and from the gate's
    // retry buttons.
    private fun bootWithLicence() {
        val st = licence.status()
        if (!st.ok) {
            showActivationGate(st)
            return
        }
        hideActivationGate()
        activeFeat = st.payload?.optJSONObject("feat")
        activeExp = if (st.payload != null && st.payload.has("exp") && !st.payload.isNull("exp")) st.payload.optLong("exp") else null
        if (useLiveUrl() && isNetworkAvailable()) {
            webView.loadUrl(getSavedUrl())
        } else {
            loadOfflineBooth()
        }
    }

    private fun showActivationGate(st: AppLicence.LicStatus) {
        offlineLoaded = false
        gateReason = st.reason
        var view = gateRoot
        if (view == null) {
            view = buildGateView()
            gateRoot = view
            root.addView(
                view,
                FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            )
        }
        view.visibility = View.VISIBLE
        gateMessage?.text = st.message.ifBlank { "Enter this tablet's rental code. It needs Wi-Fi once to activate, then keeps working offline." }
        gateButton?.isEnabled = true
        when (st.reason) {
            "checkin" -> {
                gateCode?.visibility = View.GONE
                gateButton?.text = "Retry now"
            }
            "clock" -> {
                gateCode?.visibility = View.GONE
                gateButton?.text = "I fixed it — retry"
            }
            else -> {
                gateCode?.visibility = View.VISIBLE
                gateButton?.text = "Activate"
            }
        }
    }

    private fun hideActivationGate() {
        gateRoot?.visibility = View.GONE
    }

    private fun buildGateView(): LinearLayout {
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()

        val container = LinearLayout(this)
        container.orientation = LinearLayout.VERTICAL
        container.gravity = Gravity.CENTER
        container.setBackgroundColor(Color.parseColor("#F5F1EA"))
        container.setPadding(px(32), px(32), px(32), px(32))

        val title = TextView(this)
        title.text = "Activate this tablet"
        title.textSize = 22f
        title.setTypeface(title.typeface, Typeface.BOLD)
        title.setTextColor(Color.parseColor("#1C1A1E"))
        title.gravity = Gravity.CENTER
        container.addView(title)

        val msg = TextView(this)
        msg.textSize = 15f
        msg.setTextColor(Color.parseColor("#6B666C"))
        msg.gravity = Gravity.CENTER
        val mp = LinearLayout.LayoutParams(px(520), LinearLayout.LayoutParams.WRAP_CONTENT)
        mp.topMargin = px(12)
        msg.layoutParams = mp
        container.addView(msg)
        gateMessage = msg

        val input = EditText(this)
        input.hint = "Rental code"
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        val ip = LinearLayout.LayoutParams(px(320), LinearLayout.LayoutParams.WRAP_CONTENT)
        ip.topMargin = px(20)
        input.layoutParams = ip
        container.addView(input)
        gateCode = input

        val btn = Button(this)
        btn.text = "Activate"
        val bp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        bp.topMargin = px(16)
        btn.layoutParams = bp
        btn.setOnClickListener { onGateButton() }
        container.addView(btn)
        gateButton = btn

        val note = TextView(this)
        note.text = "This tablet's ID: " + licence.machineId()
        note.textSize = 11f
        note.setTextColor(Color.parseColor("#9A958F"))
        val np = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        np.topMargin = px(28)
        note.layoutParams = np
        container.addView(note)

        return container
    }

    private fun onGateButton() {
        val btn = gateButton ?: return
        when (gateReason) {
            "clock" -> bootWithLicence()
            "checkin" -> {
                btn.isEnabled = false; btn.text = "Checking…"
                licence.checkin(force = true) { result ->
                    if (result == "ok") { bootWithLicence(); return@checkin }
                    btn.isEnabled = true; btn.text = "Retry now"
                    gateMessage?.text = if (result == "revoked") licence.status().message
                        else "Still can’t reach photobooth4u. Check the Wi-Fi and try again."
                }
            }
            else -> {
                val code = gateCode?.text?.toString() ?: ""
                btn.isEnabled = false; btn.text = "Activating…"
                licence.activate(code) { ok, error ->
                    if (ok) { bootWithLicence(); return@activate }
                    btn.isEnabled = true; btn.text = "Activate"
                    gateMessage?.text = error ?: "Couldn’t activate. Try again."
                }
            }
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
        checkinHandler.removeCallbacksAndMessages(null)
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
            // The 360 capture screen sends its clip to the booth laptop over the booth Wi-Fi (plain http://<laptop>:47777),
            // which a page loaded over https could not do in the stricter mode. The app only ever loads the booth's own pages.
            s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.safeBrowsingEnabled = false
        }

        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false

        // ChromeClient for camera / microphone permissions & file chooser
        webView.webChromeClient = object : WebChromeClient() {
            // Page errors go to Logcat, and the first few show on screen so a booth that
            // loads but won't respond (e.g. "Tap to start" does nothing) says why.
            override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                if (m != null && m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e("PBBooth", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    if (pageErrorToasts < 3) {
                        pageErrorToasts++
                        Toast.makeText(this@MainActivity, "Booth error: ${m.message().take(160)} (line ${m.lineNumber()})", Toast.LENGTH_LONG).show()
                    }
                }
                return true
            }

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
    // Escapes a string for a single-quoted JS literal inside the injected config below.
    private fun jsStr(v: String): String = "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"

    private fun loadOfflineBooth() {
        offlineLoaded = true
        runOnUiThread {
            try {
                val raw = assets.open(ASSET_BOOTH).bufferedReader().use { it.readText() }

                // This tablet's real entitlements, from its activated rental code's "offline
                // app" add-on (see AppLicence / bootWithLicence) — not hard-coded, so a code
                // without GIF mode, retakes, vouchers, etc. doesn't get them here either, and
                // the booth actually stops once the code's own exp date passes.
                val feat = activeFeat
                val print = feat?.optJSONObject("print")
                val printEnabled = print?.optBoolean("enabled", true) ?: true
                val printSizesArr = print?.optJSONArray("sizes")
                val printSizesJs = if (printSizesArr != null) {
                    (0 until printSizesArr.length()).joinToString(",") { jsStr(printSizesArr.optString(it)) }
                } else "'receipt80','receipt58','4x6','2x6'"
                val gifOpt = feat?.optBoolean("gifOpt", true) ?: true
                val retakeOpt = feat?.optBoolean("retakeOpt", true) ?: true
                val lockOpt = feat?.optBoolean("lockOpt", true) ?: true
                val payOpt = feat?.optBoolean("vouchers", false) ?: false
                val traditional = feat?.optBoolean("traditional", false) ?: false
                // Extras every package includes (missing = on): vintage looks, photographer desk, flipbook, video guestbook
                val exObj = feat?.optJSONObject("extras")
                val extrasJs = listOf("vintage", "roving", "flipbook", "video", "spin360").joinToString(",") { it + ":" + (exObj?.optBoolean(it, true) ?: true) }
                // null means a lifetime code (desktop's own "never expires" sentinel, matching netlify/lib/core.mjs LIFETIME_EXP)
                val expMs = activeExp ?: 253402300799000L

                // Inject Android kiosk config so booth.html turns on exactly what this code pays for.
                val pbConfig = buildString {
                    append("<script>")
                    // window.__PB lets the booth enable GIF, retake, lock, pay, printing features
                    append("window.__PB=window.__PB||{};")
                    append("window.__PB.desktop={v:").append(jsStr(AppLicence.APP_VERSION)).append(",os:'android'};")
                    // Tells the booth that photos are saved by this app and shared over the booth Wi-Fi
                    append("window.__PB.android=true;")
                    // Offline mode: the booth hides QR payment (it needs the internet); vouchers and GIFs still work
                    append("window.__PB.offline=true;")
                    // Mark it as a rental-style session so all features are visible
                    append("window.__PB.type='rental';")
                    append("window.__PB.gifOpt=").append(gifOpt).append(";")
                    append("window.__PB.extras={").append(extrasJs).append("};")
                    append("window.__PB.retakeOpt=").append(retakeOpt).append(";")
                    append("window.__PB.lockOpt=").append(lockOpt).append(";")
                    append("window.__PB.payOpt=").append(payOpt).append(";")
                    append("window.__PB.traditional=").append(traditional).append(";")
                    append("window.__PB.watermark=false;")
                    append("window.__PB.exp=").append(expMs).append(";")   // this rental code's own expiry, not a fixed local grant
                    append("window.__PB.print={enabled:").append(printEnabled).append(",sizes:[").append(printSizesJs).append("]};")
                    // Report offline so Drive / pay / vouchers skip at once instead of hanging on DNS.
                    // Photos don't need the internet: the app saves them (__PBLocal) and LocalShareServer shares them.
                    append("try{Object.defineProperty(Navigator.prototype,'onLine',{get:function(){return false;},configurable:true});}catch(e){}")
                    append("</script>")
                }

                // Inject the config just before </head>
                val html = if (raw.contains("</head>", ignoreCase = true)) {
                    // First </head> only: booth.html has another one inside a JS string further down
                    raw.replaceFirst("</head>", "$pbConfig\n</head>", ignoreCase = true)
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
            .setMessage("Choose how this tablet runs.\n\nOffline: works with no internet (no QR payment; photos, GIFs and vouchers still work).\n\nOnline: opens the live website below (QR payment available, needs internet).")
            .setView(input)
            .setPositiveButton("Online (live site)") { _, _ ->
                val newUrl = input.text.toString().trim()
                if (newUrl.isNotBlank()) {
                    saveUrl(newUrl)
                    setUseLiveUrl(true)
                    offlineLoaded = false
                    webView.loadUrl(newUrl)
                    Toast.makeText(this, "Loading $newUrl", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("Offline") { _, _ ->
                setUseLiveUrl(false)
                offlineLoaded = false
                bootWithLicence()
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
