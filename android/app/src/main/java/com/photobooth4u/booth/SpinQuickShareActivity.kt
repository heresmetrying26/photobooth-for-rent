package com.photobooth4u.booth

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.VideoView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.EnumMap

/**
 * Universal (Phone + Tablet) post-spin quick share modal for Android Standalone 360 Mode.
 * Always supports offline local Wi-Fi QR + Android Share / Save; enables WhatsApp redirect & Email when online.
 */
class SpinQuickShareActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_VIDEO_PATH = "video_path"
        const val EXTRA_LOCAL_PAGE_URL = "local_page_url"
        const val EXTRA_STATION_URL = "station_url"
        const val EXTRA_EVENT_TITLE = "event_title"
        const val EXTRA_SLUG = "slug"
        const val EXTRA_FILENAME = "filename"
        const val EXTRA_ONLINE_URL = "online_url"

        private const val DRIVE_SCRIPT_URL =
            "https://script.google.com/macros/s/AKfycbxv0WfF9rxFY9QlseCoSjrA7vePwHE-Uc8QTURZYyN6yIzcTj4SIlktEWT6Xnaw6Pv9OA/exec"

        private val MAIL_SIMPLE_RE = Regex("^[^\\s@<>\"']+@[^\\s@<>\"']+\\.[^\\s@<>\"']+$")

        /** Live active quick-share screen so background Drive upload updates it directly if still visible */
        @Volatile
        var currentVisible: SpinQuickShareActivity? = null

        fun normalizeWhatsAppPhone(raw: String): String {
            var digits = raw.filter { it.isDigit() || it == '+' }
            if (digits.isEmpty()) return ""
            when {
                digits.startsWith("+") -> digits = digits.substring(1)
                digits.startsWith("09") && digits.length == 11 -> digits = "63" + digits.substring(1)
                digits.startsWith("9") && digits.length == 10 -> digits = "63$digits"
                digits.startsWith("0") -> digits = digits.trimStart('0')
            }
            return if (digits.length in 7..15 && digits.all { it.isDigit() }) digits else ""
        }

        fun generateQrBitmap(content: String, sizePx: Int = 520): Bitmap? {
            if (content.isEmpty()) return null
            return try {
                val hints = EnumMap<EncodeHintType, Any>(EncodeHintType::class.java)
                hints[EncodeHintType.MARGIN] = 1
                val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
                val w = matrix.width
                val h = matrix.height
                val pixels = IntArray(w * h)
                for (y in 0 until h) {
                    val off = y * w
                    for (x in 0 until w) {
                        pixels[off + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
                    }
                }
                Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply {
                    setPixels(pixels, 0, w, 0, 0, w, h)
                }
            } catch (_: Throwable) {
                null
            }
        }

        private fun encodeQueryValue(v: String): String {
            return URLEncoder.encode(v, "UTF-8").replace("+", "%20")
        }

        /** Shared background Google Drive uploader so both QuickShare popup & skip-popup mode sync online links */
        fun uploadClipInBackground(
            appCtx: android.content.Context,
            videoFile: File,
            slug: String,
            filename: String,
            onResult: ((cloudUrl: String, statusNote: String) -> Unit)? = null
        ) {
            val local = PBLocal.ensureActive(appCtx)
            val ctx = PBLocal.spinContext
            val lic = AppLicence(appCtx.applicationContext)
            val licStr = ctx.licence.ifEmpty { lic.currentLicenceString() ?: "" }
            val midStr = ctx.mid.ifEmpty { lic.machineId() }
            if (!local.isOnline() || ctx.driveFolderId.isEmpty() || ctx.folderKey.isEmpty() || licStr.isEmpty()) return
            if (!videoFile.exists() || videoFile.length() <= 0L) return
            if (videoFile.length() > 27L * 1024L * 1024L) {
                onResult?.invoke("", "Clip >27 MB — use Local Wi-Fi QR or Quick Share")
                return
            }

            Thread({
                var cloudUrl = ""
                var statusNote = "Local Wi-Fi QR & Share ready (cloud upload busy)"
                var conn: HttpURLConnection? = null
                try {
                    val tReq = JSONObject()
                        .put("folderKey", ctx.folderKey)
                        .put("licence", licStr)
                        .put("mid", midStr)
                    conn = (URL("${AppLicence.SERVER}/api/ticket").openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        connectTimeout = 12000
                        readTimeout = 15000
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                    }
                    conn.outputStream.use { it.write(tReq.toString().toByteArray(Charsets.UTF_8)) }
                    val tCode = conn.responseCode
                    val tTxt = (if (tCode in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
                    try { conn.disconnect() } catch (_: Exception) { }
                    val tObj = try { JSONObject(tTxt) } catch (_: Exception) { null }
                    val ticket = tObj?.optString("ticket", "") ?: ""
                    if (tCode == 200 && ticket.isNotEmpty()) {
                        val bytes = videoFile.readBytes()
                        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                        val upObj = JSONObject()
                            .put("filename", filename)
                            .put("mimeType", "video/mp4")
                            .put("imageBase64", b64)
                            .put("ticket", ticket)
                        val uConn = (URL(DRIVE_SCRIPT_URL).openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            connectTimeout = 15000
                            readTimeout = 90000
                            doOutput = true
                            setRequestProperty("Content-Type", "text/plain;charset=utf-8")
                        }
                        uConn.outputStream.use { it.write(upObj.toString().toByteArray(Charsets.UTF_8)) }
                        val uCode = uConn.responseCode
                        val uTxt = (if (uCode in 200..299) uConn.inputStream else uConn.errorStream)
                            ?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
                        try { uConn.disconnect() } catch (_: Exception) { }
                        val uJson = try { JSONObject(uTxt) } catch (_: Exception) { null }
                        val fid = uJson?.optString("id", "") ?: ""
                        if (uCode == 200 && uJson?.optBoolean("ok", false) == true && fid.isNotEmpty()) {
                            cloudUrl = "${AppLicence.SERVER}/g/${ctx.driveFolderId}#$fid"
                        }
                    } else {
                        statusNote = "Offline/Local QR ready (could not reach cloud ticket)"
                    }
                } catch (_: Exception) {
                } finally {
                    try { conn?.disconnect() } catch (_: Exception) { }
                }
                if (cloudUrl.isNotEmpty() && slug.isNotEmpty() && filename.isNotEmpty()) {
                    PBLocal.setOnlineShareUrl(slug, filename, cloudUrl)
                }
                onResult?.invoke(cloudUrl, statusNote)
            }, "pb-spin-upload").start()
        }
    }

    private lateinit var videoFile: File
    private var localPageUrl: String = ""
    private var stationUrl: String = ""
    private var eventTitle: String = "360 Video Booth"
    private var slug: String = ""
    private var filename: String = ""
    private var onlineShareUrl: String = ""
    private var isMuted: Boolean = true
    private var activePlayer: MediaPlayer? = null

    private lateinit var videoView: VideoView
    private lateinit var muteBtn: Button
    private lateinit var qrImage: ImageView
    private lateinit var qrSubLabel: TextView
    private lateinit var onlineStatusLabel: TextView
    private lateinit var onlineControlsBox: LinearLayout
    private lateinit var waInput: EditText
    private lateinit var waBtn: Button
    private lateinit var mailInput: EditText
    private lateinit var mailBtn: Button
    private lateinit var feedbackLabel: TextView
    private lateinit var mainRow: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val vPath = intent.getStringExtra(EXTRA_VIDEO_PATH) ?: ""
        videoFile = File(vPath)
        localPageUrl = intent.getStringExtra(EXTRA_LOCAL_PAGE_URL) ?: ""
        stationUrl = intent.getStringExtra(EXTRA_STATION_URL) ?: ""
        eventTitle = (intent.getStringExtra(EXTRA_EVENT_TITLE) ?: "").ifBlank { "360 Video Booth" }
        slug = intent.getStringExtra(EXTRA_SLUG) ?: ""
        filename = intent.getStringExtra(EXTRA_FILENAME) ?: videoFile.name
        onlineShareUrl = intent.getStringExtra(EXTRA_ONLINE_URL) ?: ""

        currentVisible = this
        buildUI()
        startVideoPlayback()
        refreshShareState()
        startCloudUploadIfConfigured()
    }

    override fun onDestroy() {
        if (currentVisible === this) currentVisible = null
        try { videoView.stopPlayback() } catch (_: Exception) { }
        activePlayer = null
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyResponsiveAxis()
    }

    private fun px(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun roundedBg(colorHex: String, radiusDp: Int = 12, strokeColor: String? = null): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = px(radiusDp).toFloat()
            setColor(Color.parseColor(colorHex))
            if (strokeColor != null) setStroke(px(1), Color.parseColor(strokeColor))
        }
    }

    private fun applyResponsiveAxis() {
        val sw = resources.configuration.screenWidthDp
        val wide = sw >= 620
        mainRow.orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        val childCount = mainRow.childCount
        for (i in 0 until childCount) {
            val child = mainRow.getChildAt(i)
            val lp = child.layoutParams as? LinearLayout.LayoutParams ?: continue
            if (wide) {
                lp.width = 0
                lp.height = LinearLayout.LayoutParams.MATCH_PARENT
                lp.weight = 1f
                if (i == 0) lp.rightMargin = px(12) else lp.rightMargin = 0
                lp.bottomMargin = 0
            } else {
                lp.width = LinearLayout.LayoutParams.MATCH_PARENT
                lp.height = LinearLayout.LayoutParams.WRAP_CONTENT
                lp.weight = 0f
                lp.rightMargin = 0
                if (i == 0) lp.bottomMargin = px(14) else lp.bottomMargin = 0
            }
            child.layoutParams = lp
        }
    }

    private fun buildUI() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#110F16"))
            setPadding(px(14), px(12), px(14), px(14))
        }
        setContentView(root)

        // Top Bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(px(2), px(4), px(2), px(10))
        }
        val badge = TextView(this).apply {
            text = "  360 READY TO SHARE  "
            textSize = 11f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = roundedBg("#C93D27", 8)
            setPadding(px(6), px(4), px(6), px(4))
        }
        val titleLbl = TextView(this).apply {
            text = eventTitle
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = px(10)
                rightMargin = px(8)
            }
        }
        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(Color.WHITE)
            background = roundedBg("#29FFFFFF", 18)
            layoutParams = LinearLayout.LayoutParams(px(36), px(36))
            setOnClickListener { finish() }
        }
        topBar.addView(badge)
        topBar.addView(titleLbl)
        topBar.addView(closeBtn)
        root.addView(topBar)

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        root.addView(scroll)

        mainRow = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        }
        scroll.addView(mainRow)

        // Video preview card
        val videoBox = FrameLayout(this).apply {
            background = roundedBg("#000000", 16, "#24FFFFFF")
            minimumHeight = px(280)
            setPadding(px(2), px(2), px(2), px(2))
        }
        videoView = VideoView(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, px(340), Gravity.CENTER)
        }
        muteBtn = Button(this).apply {
            text = "🔇 Tap for Sound"
            textSize = 12f
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = roundedBg("#CC16141C", 14)
            setPadding(px(12), px(6), px(12), px(6))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END
            ).apply {
                rightMargin = px(10)
                bottomMargin = px(10)
            }
            setOnClickListener {
                isMuted = !isMuted
                val vol = if (isMuted) 0f else 1f
                try { activePlayer?.setVolume(vol, vol) } catch (_: Exception) { }
                text = if (isMuted) "🔇 Tap for Sound" else "🔊 Sound On"
            }
        }
        videoBox.addView(videoView)
        videoBox.addView(muteBtn)

        // Share Card
        val shareCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = roundedBg("#1B1922", 16, "#24FFFFFF")
            setPadding(px(18), px(18), px(18), px(18))
        }

        val qrHeading = TextView(this).apply {
            text = "Scan to Save 360 Video"
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        qrSubLabel = TextView(this).apply {
            textSize = 12.5f
            setTextColor(Color.parseColor("#B8B4BE"))
            gravity = Gravity.CENTER
            setPadding(0, px(4), 0, px(12))
        }

        val qrBg = FrameLayout(this).apply {
            background = roundedBg("#FFFFFF", 14)
            setPadding(px(10), px(10), px(10), px(10))
        }
        qrImage = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(px(172), px(172))
        }
        qrBg.addView(qrImage)

        val shareSheetBtn = Button(this).apply {
            text = "📤 Save / Quick Share Video"
            textSize = 14.5f
            isAllCaps = false
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = roundedBg("#C93D27", 12)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(46)).apply {
                topMargin = px(14)
            }
            setOnClickListener { openAndroidShareSheet() }
        }

        onlineStatusLabel = TextView(this).apply {
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#8CD9AD"))
            gravity = Gravity.CENTER
            setPadding(0, px(10), 0, px(6))
        }

        onlineControlsBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        // WhatsApp Row
        val waRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = px(8)
            }
        }
        waInput = EditText(this).apply {
            hint = "WhatsApp number (e.g. 0917...)"
            setHintTextColor(Color.parseColor("#8D8994"))
            setTextColor(Color.WHITE)
            textSize = 13.5f
            inputType = InputType.TYPE_CLASS_PHONE
            background = roundedBg("#16FFFFFF", 10, "#2CFFFFFF")
            setPadding(px(12), px(10), px(12), px(10))
            layoutParams = LinearLayout.LayoutParams(0, px(42), 1f).apply { rightMargin = px(8) }
        }
        waBtn = Button(this).apply {
            text = "WhatsApp"
            isAllCaps = false
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = roundedBg("#1F8E4D", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(42))
            setPadding(px(14), 0, px(14), 0)
            setOnClickListener { sendWhatsApp() }
        }
        waRow.addView(waInput)
        waRow.addView(waBtn)

        // Email Row
        val mailRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        mailInput = EditText(this).apply {
            hint = "Guest email (optional)"
            setHintTextColor(Color.parseColor("#8D8994"))
            setTextColor(Color.WHITE)
            textSize = 13.5f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            background = roundedBg("#16FFFFFF", 10, "#2CFFFFFF")
            setPadding(px(12), px(10), px(12), px(10))
            layoutParams = LinearLayout.LayoutParams(0, px(42), 1f).apply { rightMargin = px(8) }
        }
        mailBtn = Button(this).apply {
            text = "Send Email"
            isAllCaps = false
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = roundedBg("#2BFFFFFF", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(42))
            setPadding(px(14), 0, px(14), 0)
            setOnClickListener { sendEmail() }
        }
        mailRow.addView(mailInput)
        mailRow.addView(mailBtn)

        onlineControlsBox.addView(waRow)
        onlineControlsBox.addView(mailRow)

        feedbackLabel = TextView(this).apply {
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#E0DCE5"))
            gravity = Gravity.CENTER
            setPadding(0, px(8), 0, px(4))
        }

        val stationLbl = TextView(this).apply {
            text = if (stationUrl.isEmpty()) "Connect to Wi-Fi/Hotspot to open a separate Sharing Station"
            else "Sharing Station live at: $stationUrl"
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.parseColor("#A49FA9"))
            gravity = Gravity.CENTER
            setPadding(0, px(4), 0, px(10))
        }

        val doneBtn = Button(this).apply {
            text = "✓ Done — Next Spin"
            isAllCaps = false
            textSize = 14.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = roundedBg("#24FFFFFF", 12)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(46))
            setOnClickListener { finish() }
        }

        shareCard.addView(qrHeading)
        shareCard.addView(qrSubLabel)
        shareCard.addView(qrBg)
        shareCard.addView(shareSheetBtn)
        shareCard.addView(onlineStatusLabel)
        shareCard.addView(onlineControlsBox)
        shareCard.addView(feedbackLabel)
        shareCard.addView(stationLbl)
        shareCard.addView(doneBtn)

        mainRow.addView(videoBox)
        mainRow.addView(shareCard)
        applyResponsiveAxis()
    }

    private fun startVideoPlayback() {
        if (!videoFile.exists()) return
        videoView.setVideoPath(videoFile.absolutePath)
        videoView.setOnPreparedListener { mp ->
            activePlayer = mp
            mp.isLooping = true
            val v = if (isMuted) 0f else 1f
            mp.setVolume(v, v)
            videoView.start()
        }
        videoView.setOnErrorListener { _, _, _ -> true }
    }

    private fun refreshShareState() {
        val qrTarget = onlineShareUrl.ifEmpty { localPageUrl }
        qrImage.setImageBitmap(generateQrBitmap(qrTarget))

        val online = PBLocal.ensureActive(this).isOnline()
        if (onlineShareUrl.isNotEmpty() && online) {
            qrSubLabel.text = "Scan QR to save (cloud link ready)"
            onlineControlsBox.visibility = View.VISIBLE
            onlineStatusLabel.text = "☁️ Online: WhatsApp & Email ready"
            onlineStatusLabel.setTextColor(Color.parseColor("#8CD9AD"))
        } else {
            qrSubLabel.text = if (localPageUrl.isEmpty())
                "Join Wi-Fi/Hotspot for QR download, or tap Quick Share below"
            else "Join booth Wi-Fi & scan QR to save in browser"
            onlineControlsBox.visibility = View.GONE
            if (onlineStatusLabel.text.isNullOrBlank()) {
                onlineStatusLabel.text = if (online)
                    "Local Wi-Fi QR ready (set Google Drive folder in Setup for WhatsApp/Email links)"
                else "Offline mode — scan QR code, Save, or Quick Share"
            }
            onlineStatusLabel.setTextColor(Color.parseColor("#B8B4BE"))
        }
    }

    private fun openAndroidShareSheet() {
        if (!videoFile.exists()) return
        try {
            val uri: Uri = FileProvider.getUriForFile(this, "${packageName}.updates", videoFile)
            val share = Intent(Intent.ACTION_SEND).apply {
                type = "video/mp4"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(share, "Save or Share 360 Video"))
        } catch (e: Exception) {
            feedbackLabel.text = "Could not open Share sheet: ${e.message}"
        }
    }

    private fun sendWhatsApp() {
        val online = PBLocal.ensureActive(this).isOnline()
        if (!online || onlineShareUrl.isEmpty()) {
            feedbackLabel.text = "Online link needed for WhatsApp."
            return
        }
        val phone = normalizeWhatsAppPhone(waInput.text?.toString() ?: "")
        if (phone.isEmpty()) {
            feedbackLabel.text = "Enter a valid WhatsApp number (e.g. 09171234567)."
            return
        }
        val msg = "Here is your 360 video from $eventTitle: $onlineShareUrl"
        val appUri = Uri.parse("whatsapp://send?phone=${encodeQueryValue(phone)}&text=${encodeQueryValue(msg)}")
        val webUri = Uri.parse("https://wa.me/${encodeQueryValue(phone)}?text=${encodeQueryValue(msg)}")
        try {
            feedbackLabel.text = "Opening WhatsApp…"
            startActivity(Intent(Intent.ACTION_VIEW, appUri))
        } catch (_: Exception) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, webUri))
            } catch (_: Exception) {
                feedbackLabel.text = "Could not open WhatsApp on this device."
            }
        }
    }

    private fun sendEmail() {
        val online = PBLocal.ensureActive(this).isOnline()
        if (!online || onlineShareUrl.isEmpty()) {
            feedbackLabel.text = "Online link needed to send email."
            return
        }
        val to = (mailInput.text?.toString() ?: "").trim()
        if (!MAIL_SIMPLE_RE.matches(to)) {
            feedbackLabel.text = "Enter a valid email address."
            return
        }
        mailBtn.isEnabled = false
        mailBtn.text = "Sending…"
        feedbackLabel.text = ""

        val ctx = PBLocal.spinContext
        val lic = AppLicence(applicationContext)
        val licStr = ctx.licence.ifEmpty { lic.currentLicenceString() ?: "" }
        val midStr = ctx.mid.ifEmpty { lic.machineId() }
        val payload = JSONObject()
            .put("to", to)
            .put("shareUrl", onlineShareUrl)
            .put("eventName", eventTitle)
            .put("kind", "video")
        if (ctx.driveFolderId.isNotEmpty()) payload.put("folderId", ctx.driveFolderId)
        if (ctx.opKey.isNotEmpty()) payload.put("k", ctx.opKey)
        if (licStr.isNotEmpty()) payload.put("licence", licStr)
        if (midStr.isNotEmpty()) payload.put("mid", midStr)

        Thread({
            var ok = false
            var errMsg: String? = null
            var conn: HttpURLConnection? = null
            try {
                val url = URL("${AppLicence.SERVER}/api/station-mail")
                conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 15000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val txt = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
                val j = try { JSONObject(txt) } catch (_: Exception) { null }
                if (code == 200 && j?.optBoolean("ok", false) == true) {
                    ok = true
                } else {
                    errMsg = j?.optString("error", "")?.ifBlank { null }
                }
            } catch (_: Exception) {
            } finally {
                try { conn?.disconnect() } catch (_: Exception) { }
            }

            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                mailBtn.isEnabled = true
                mailBtn.text = "Send Email"
                if (ok) {
                    feedbackLabel.text = "✓ Email sent to $to"
                    mailInput.setText("")
                } else {
                    val subj = "$eventTitle — Your 360 Video"
                    val bodyTxt = "Watch and save your 360 video:\n\n$onlineShareUrl"
                    val mailto = Uri.parse(
                        "mailto:${Uri.encode(to)}?subject=${encodeQueryValue(subj)}&body=${encodeQueryValue(bodyTxt)}"
                    )
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, mailto))
                    } catch (_: Exception) { }
                    feedbackLabel.text = errMsg ?: "Opening Email app…"
                }
            }
        }, "pb-spin-mail").start()
    }

    private fun startCloudUploadIfConfigured() {
        val local = PBLocal.ensureActive(this)
        val ctx = PBLocal.spinContext
        val licStr = ctx.licence.ifEmpty { AppLicence(applicationContext).currentLicenceString() ?: "" }
        if (onlineShareUrl.isNotEmpty()) return
        if (!local.isOnline() || ctx.driveFolderId.isEmpty() || ctx.folderKey.isEmpty() || licStr.isEmpty()) return
        if (videoFile.length() <= 27L * 1024L * 1024L) {
            onlineStatusLabel.text = "☁️ Syncing to cloud for WhatsApp & Email…"
        }
        uploadClipInBackground(applicationContext, videoFile, slug, filename) { cloudUrl, statusNote ->
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (cloudUrl.isNotEmpty()) {
                    onlineShareUrl = cloudUrl
                    refreshShareState()
                } else {
                    onlineStatusLabel.text = statusNote
                }
            }
        }
    }
}
