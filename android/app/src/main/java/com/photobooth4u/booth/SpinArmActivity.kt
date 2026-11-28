package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.MeteringRectangle
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.OpenableColumns
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
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
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Native Android Standalone 360 Booth & Arm Camera Companion.
 * Mounts on the spinning 360 arm, reads hardware gyroscope at ~50 Hz, supports guided
 * 2-step calibration, captures 30/60/120 fps clips on Camera2, and either renders
 * on-device (Slow-Mo, Speed Ramp, Boomerang, PNG overlay, titles, color look, music -> Sharing Station)
 * or streams clips over Wi-Fi to the desktop 360 Desk.
 */
class SpinArmActivity : AppCompatActivity(), SensorEventListener {

    companion object {
        private const val TAG = "SpinArm360"
        private const val PREFS = "pb4u_spin_arm"
        private const val KEY_SEND_URL = "send_url"
        private const val KEY_START_THRESH = "start_thresh"
        private const val KEY_STOP_THRESH = "stop_thresh"
        private const val KEY_THRESH_CALIBRATED = "thresh_calibrated"
        private const val KEY_CAL_INTRO_SEEN = "cal_intro_seen"
        private const val KEY_LENS = "lens"
        private const val KEY_FPS = "fps"
        private const val KEY_SAVE_GALLERY = "save_gallery"
        private const val KEY_STANDALONE = "standalone_mode"
        private const val KEY_MOTION = "sa_motion"
        private const val KEY_ASPECT = "sa_aspect"
        private const val KEY_LOOK = "sa_look"
        private const val KEY_OVERLAY_FILE = "sa_overlay"
        private const val KEY_MUSIC_FILE = "sa_music"
        private const val KEY_TITLE = "sa_title"
        private const val KEY_SUBTITLE = "sa_sub"
        private const val KEY_TRIGGER = "sa_trigger"
        private const val KEY_STOP_MODE = "sa_stop"
        private const val KEY_FIXED_SEC = "sa_fixed"
        private const val KEY_SKIP_SHARE = "sa_skip_share"

        private val SEND_URL_RE = Regex("^(https?://[^/\\s]+/send/[A-Za-z0-9]+)")
    }

    private enum class ArmPhase { IDLE, CALIBRATING, RECORDING, RENDERING, COOLDOWN }
    private enum class CalStep { STILL, SPIN }
    private enum class LensChoice(val id: String, val label: String) {
        ULTRAWIDE("ultrawide", "0.5×"),
        WIDE("wide", "1×"),
        FRONT("front", "Front")
    }

    private data class ArmConfig(
        var trigger: String = "arm",
        var stopMode: String = "follow",
        var fixedSec: Double = 10.0,
        var tailSec: Double = 1.5,
        var maxSec: Double = 30.0,
        var cooldownSec: Double = 4.0,
        var fps: Int = 60
    )

    private data class CamCandidate(val id: String, val facing: Int, val minFocal: Float)

    private val mainHandler = Handler(Looper.getMainLooper())
    private var camThread: HandlerThread? = null
    private var camHandler: Handler? = null

    private lateinit var store: PBLocal
    private lateinit var sensorManager: SensorManager
    private var gyroSensor: Sensor? = null
    private var hasGyro: Boolean = false

    // Config & State
    private var isStandaloneMode: Boolean = true
    private var saMotion: SpinRenderer.MotionPreset = SpinRenderer.MotionPreset.SLOW_MO
    private var saAspect: SpinRenderer.OutputAspect = SpinRenderer.OutputAspect.PORTRAIT_9X16
    private var saLook: SpinRenderer.ColorLook = SpinRenderer.ColorLook.NATURAL
    private var saOverlayFilename: String = ""
    private var saOverlayBitmap: Bitmap? = null
    private var saMusicFilename: String = ""
    private var saTitleText: String = ""
    private var saSubText: String = ""
    private var saTrigger: String = "manual"
    private var saStopMode: String = "follow"
    private var saFixedSec: Double = 8.0
    private var skipQuickSharePopup: Boolean = false
    private var saveToGallery: Boolean = false

    private var sendUrl: String = ""
    private var deskConnected: Boolean = false
    private var deskLaptopName: String = ""
    private var armConfig = ArmConfig()
    private var lastConfigSig: String = ""

    private var lensChoice: LensChoice = LensChoice.ULTRAWIDE
    private var ultrawideId: String? = null
    private var wideId: String? = null
    private var frontId: String? = null
    private var targetFps: Int = 60
    private var activeFps: Int = 30

    private var phase: ArmPhase = ArmPhase.IDLE
    private var isSettingsOpen: Boolean = false
    private var isScreenLocked: Boolean = false
    private var aeAfLocked: Boolean = false
    private var renderProgress: Float = 0f
    private var sentCount: Int = 0

    // Motion state
    private var startThresholdDps: Double = 25.0
    private var stopThresholdDps: Double = 11.0
    private var isThresholdCalibrated: Boolean = false
    private var hasSeenCalibrationIntro: Boolean = false
    private var smoothedDps: Double = 0.0
    private var aboveThresholdSince: Long = 0L
    private var recordingStartedAt: Long = 0L
    private var belowStopSince: Long = 0L
    private var tailStartAt: Long = 0L
    private var cooldownStartedAt: Long = 0L
    private var stillSince: Long = 0L

    private var calStep: CalStep = CalStep.STILL
    private var calStepStartedAt: Long = 0L
    private val calStillSamples = mutableListOf<Double>()
    private val calSpinSamples = mutableListOf<Double>()

    // Upload queue for Laptop Desk mode
    private val uploadQueue = ArrayDeque<File>()
    private var isUploadingNow: Boolean = false
    private var activeUploadPct: Int = 0
    private var currentUploadFile: File? = null
    private var currentUploadRetries: Int = 0

    // Camera2 & Recorder
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var mediaRecorder: MediaRecorder? = null
    private var currentRecordingFile: File? = null
    private var videoSize: Size = Size(1920, 1080)
    private var activeCamId: String = ""
    private var sensorOrientation: Int = 90
    private var activeIsFront: Boolean = false
    private var supportsVideoStab: Boolean = false
    private var previewFpsRange: Range<Int> = Range(30, 30)
    private var activeFpsRange: Range<Int> = Range(30, 30)
    private var activeIsHighSpeed: Boolean = false
    private var activePreviewSurface: Surface? = null
    private var activeRecorderSurface: Surface? = null
    private var hasAudioPermission: Boolean = false
    private var toneGen: ToneGenerator? = null

    // UI Elements
    private lateinit var previewTex: TextureView
    private lateinit var overlayPreviewImg: ImageView
    private lateinit var connPill: TextView
    private lateinit var lensBtns: MutableMap<LensChoice, Button>
    private lateinit var fpsBadge: TextView
    private lateinit var aeLockBtn: Button
    private lateinit var stateBanner: TextView
    private lateinit var meterTrack: FrameLayout
    private lateinit var meterFill: View
    private lateinit var meterThreshMark: View
    private lateinit var meterValueLabel: TextView
    private lateinit var calBtn: Button
    private lateinit var recBtn: Button
    private lateinit var lockBtn: Button
    private lateinit var pairBtn: Button
    private lateinit var lookQuickBtn: Button
    private lateinit var pendingBtn: Button
    private lateinit var toastLabel: TextView

    private lateinit var centerOverlay: LinearLayout
    private lateinit var centerIconLabel: TextView
    private lateinit var centerTitleLabel: TextView
    private lateinit var centerSubLabel: TextView
    private lateinit var centerProg: ProgressBar
    private lateinit var centerCancelBtn: Button

    // Settings UI
    private lateinit var settingsOverlay: FrameLayout
    private lateinit var modeSaBtn: Button
    private lateinit var modeDeskBtn: Button
    private lateinit var standaloneSettingsBox: LinearLayout
    private lateinit var deskSettingsBox: LinearLayout
    private lateinit var motionBtn: Button
    private lateinit var aspectButtons: MutableList<Pair<SpinRenderer.OutputAspect, Button>>
    private lateinit var lookBtn: Button
    private lateinit var overlayStatusLabel: TextView
    private lateinit var musicStatusLabel: TextView
    private lateinit var titleField: EditText
    private lateinit var subField: EditText
    private lateinit var trigAutoBtn: Button
    private lateinit var trigManualBtn: Button
    private lateinit var stopFollowBtn: Button
    private lateinit var stop8Btn: Button
    private lateinit var stop12Btn: Button
    private lateinit var fps60Btn: Button
    private lateinit var fps120Btn: Button
    private lateinit var skipShareSwitch: Switch
    private lateinit var threshSeek: SeekBar
    private lateinit var threshReadoutLabel: TextView
    private lateinit var liveGyroLabel: TextView
    private lateinit var saveGallerySwitch: Switch
    private lateinit var deskSummaryLabel: TextView
    private lateinit var settingsPendingBtn: Button

    // Station QR Modal & Shield
    private lateinit var stationOverlay: FrameLayout
    private lateinit var stationQrImg: ImageView
    private lateinit var stationUrlLabel: TextView
    private lateinit var lockOverlay: FrameLayout
    private lateinit var lockStatusLabel: TextView
    private lateinit var calIntroOverlay: FrameLayout

    private var heartbeatRunnable: Runnable? = null
    private var recClockRunnable: Runnable? = null
    private var toastHideRunnable: Runnable? = null

    // Pickers & Permissions
    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        bootCameraAndSensors()
    }

    private val qrLauncher = registerForActivityResult(ScanContract()) { res ->
        val raw = res?.contents ?: return@registerForActivityResult
        val norm = normalizeSendUrl(raw)
        if (norm == null) {
            showToast("Not a valid 360 Desk pairing QR.")
            return@registerForActivityResult
        }
        verifyPairAndFetchConfig(norm, silent = false)
    }

    private val overlayPickerLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) handlePickedOverlay(uri)
    }

    private val musicPickerLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) handlePickedMusic(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        store = PBLocal.ensureActive(applicationContext)
        PBLocal.ensureShareServer(applicationContext)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        gyroSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        hasGyro = gyroSensor != null
        try { toneGen = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 85) } catch (_: Throwable) { }

        discoverCameras()
        loadPreferences()
        buildUI()
        refreshPendingQueueFromDisk()
        updateUIState()
        requestPermissionsAndBoot()
    }

    override fun onResume() {
        super.onResume()
        if (hasGyro && gyroSensor != null) {
            sensorManager.registerListener(this, gyroSensor, SensorManager.SENSOR_DELAY_GAME)
        }
        startHeartbeatIfNeeded()
        if (previewTex.isAvailable && hasCameraPermission() && cameraDevice == null) {
            openSelectedCamera()
        }
    }

    override fun onPause() {
        super.onPause()
        sensorManager.unregisterListener(this)
        stopHeartbeat()
        if (phase == ArmPhase.RECORDING) stopRecording("background")
        closeCamera()
    }

    override fun onDestroy() {
        stopHeartbeat()
        recClockRunnable?.let { mainHandler.removeCallbacks(it) }
        toastHideRunnable?.let { mainHandler.removeCallbacks(it) }
        closeCamera()
        stopCamThread()
        try { toneGen?.release() } catch (_: Exception) { }
        super.onDestroy()
    }

    // MARK: - Helpers

    private fun px(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun pillBg(hex: String, radiusDp: Int = 12, strokeHex: String? = null): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = px(radiusDp).toFloat()
            setColor(Color.parseColor(hex))
            if (strokeHex != null) setStroke(px(1), Color.parseColor(strokeHex))
        }
    }

    private fun playTone(tone: Int = ToneGenerator.TONE_PROP_BEEP) {
        try { toneGen?.startTone(tone, 130) } catch (_: Exception) { }
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun requestPermissionsAndBoot() {
        hasAudioPermission = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (hasCameraPermission()) {
            bootCameraAndSensors()
        } else {
            val need = mutableListOf(Manifest.permission.CAMERA)
            if (!hasAudioPermission) need.add(Manifest.permission.RECORD_AUDIO)
            permLauncher.launch(need.toTypedArray())
        }
    }

    private fun bootCameraAndSensors() {
        hasAudioPermission = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!hasCameraPermission()) {
            showToast("Camera permission needed for 360 Video.")
            return
        }
        if (hasGyro && gyroSensor != null) {
            sensorManager.registerListener(this, gyroSensor, SensorManager.SENSOR_DELAY_GAME)
        }
        if (previewTex.isAvailable) openSelectedCamera()
        if (!isStandaloneMode && sendUrl.isNotEmpty()) {
            verifyPairAndFetchConfig(sendUrl, silent = true)
            startHeartbeatIfNeeded()
        }
        showCalibrationIntroIfNeeded()
    }

    // MARK: - Preferences

    private fun loadPreferences() {
        val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        sendUrl = normalizeSendUrl(sp.getString(KEY_SEND_URL, "") ?: "") ?: ""
        isThresholdCalibrated = if (sp.contains(KEY_THRESH_CALIBRATED)) {
            sp.getBoolean(KEY_THRESH_CALIBRATED, false)
        } else {
            sp.contains(KEY_START_THRESH)
        }
        hasSeenCalibrationIntro = sp.getBoolean(KEY_CAL_INTRO_SEEN, false) || isThresholdCalibrated
        startThresholdDps = sp.getFloat(KEY_START_THRESH, 25f).toDouble().coerceIn(10.0, 120.0)
        val rawStop = sp.getFloat(KEY_STOP_THRESH, (startThresholdDps * 0.45).toFloat()).toDouble()
        stopThresholdDps = if (rawStop >= 4.0 && rawStop < startThresholdDps) rawStop else max(5.0, startThresholdDps * 0.45)

        val rawLens = sp.getString(KEY_LENS, LensChoice.ULTRAWIDE.id) ?: LensChoice.ULTRAWIDE.id
        lensChoice = LensChoice.values().firstOrNull { it.id == rawLens } ?: LensChoice.ULTRAWIDE
        if (lensChoice == LensChoice.ULTRAWIDE && ultrawideId == null) lensChoice = LensChoice.WIDE
        if (lensChoice == LensChoice.WIDE && wideId == null && frontId != null) lensChoice = LensChoice.FRONT

        targetFps = sp.getInt(KEY_FPS, 60)
        if (targetFps !in listOf(30, 60, 120)) targetFps = 60
        saveToGallery = sp.getBoolean(KEY_SAVE_GALLERY, false)

        isStandaloneMode = if (!PBLocal.spinContext.standaloneAllowed) {
            false
        } else if (sp.contains(KEY_STANDALONE)) {
            sp.getBoolean(KEY_STANDALONE, true)
        } else {
            sendUrl.isEmpty()
        }
        saMotion = SpinRenderer.MotionPreset.fromId(sp.getString(KEY_MOTION, "slow"))
        saAspect = SpinRenderer.OutputAspect.fromId(sp.getString(KEY_ASPECT, "portrait"))
        saLook = SpinRenderer.ColorLook.fromId(sp.getString(KEY_LOOK, "natural"))

        saOverlayFilename = sp.getString(KEY_OVERLAY_FILE, "") ?: ""
        if (saOverlayFilename.isNotEmpty()) {
            val f = File(store.overlaysDirectory(), saOverlayFilename)
            if (f.isFile) saOverlayBitmap = BitmapFactory.decodeFile(f.absolutePath)
            if (saOverlayBitmap == null) saOverlayFilename = ""
        }
        saMusicFilename = sp.getString(KEY_MUSIC_FILE, "") ?: ""
        if (saMusicFilename.isNotEmpty() && !File(store.overlaysDirectory(), saMusicFilename).isFile) {
            saMusicFilename = ""
        }
        saTitleText = sp.getString(KEY_TITLE, "") ?: ""
        if (saTitleText.isEmpty()) saTitleText = PBLocal.spinContext.eventName
        saSubText = sp.getString(KEY_SUBTITLE, "") ?: ""
        val trig = sp.getString(KEY_TRIGGER, "manual") ?: "manual"
        saTrigger = if (trig == "arm" && hasGyro && isThresholdCalibrated) "arm" else "manual"
        val stop = sp.getString(KEY_STOP_MODE, "follow") ?: "follow"
        saStopMode = if (stop in listOf("follow", "fixed")) stop else "follow"
        saFixedSec = sp.getFloat(KEY_FIXED_SEC, 8f).toDouble().coerceIn(4.0, 30.0)
        skipQuickSharePopup = sp.getBoolean(KEY_SKIP_SHARE, false)

        if (isStandaloneMode) {
            armConfig.trigger = saTrigger
            armConfig.stopMode = saStopMode
            armConfig.fixedSec = saFixedSec
        }
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun normalizeSendUrl(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://", ignoreCase = true) && !s.startsWith("https://", ignoreCase = true)) {
            s = "http://$s"
        }
        val m = SEND_URL_RE.find(s) ?: return null
        return m.groupValues[1]
    }

    private fun pendingDirectory(): File {
        val d = File(filesDir, "pb360_pending")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun refreshPendingQueueFromDisk() {
        val files = pendingDirectory().listFiles()
            ?.filter { it.isFile && PBLocal.VIDEO_RE.containsMatchIn(it.name) }
            ?.sortedBy { it.name } ?: emptyList()
        for (f in files) {
            if (f != currentUploadFile && !uploadQueue.contains(f)) uploadQueue.addLast(f)
        }
    }

    // MARK: - Camera Discovery & Capture2

    private fun discoverCameras() {
        val cm = getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        val backs = mutableListOf<CamCandidate>()
        try {
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: continue
                if (!caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE)) continue
                val facing = chars.get(CameraCharacteristics.LENS_FACING) ?: continue
                val focals = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                val minF = focals?.minOrNull() ?: 4.0f
                if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                    backs.add(CamCandidate(id, facing, minF))
                } else if (facing == CameraCharacteristics.LENS_FACING_FRONT && frontId == null) {
                    frontId = id
                }
            }
        } catch (_: Throwable) { }

        if (backs.size >= 2) {
            val sorted = backs.sortedBy { it.minFocal }
            // Widest back lens is 0.5x when noticeably wider than standard wide lens
            if (sorted.first().minFocal < sorted.last().minFocal * 0.78f) {
                ultrawideId = sorted.first().id
                wideId = sorted[1].id
            } else {
                wideId = sorted.first().id
            }
        } else if (backs.size == 1) {
            wideId = backs[0].id
        }
    }

    private fun ensureCamThread() {
        if (camThread != null) return
        val t = HandlerThread("pb-spin-cam").apply { start() }
        camThread = t
        camHandler = Handler(t.looper)
    }

    private fun stopCamThread() {
        try { camThread?.quitSafely() } catch (_: Exception) { }
        camThread = null
        camHandler = null
    }

    private fun selectActiveCameraId(): String? {
        return when (lensChoice) {
            LensChoice.ULTRAWIDE -> ultrawideId ?: wideId ?: frontId
            LensChoice.WIDE -> wideId ?: ultrawideId ?: frontId
            LensChoice.FRONT -> frontId ?: wideId ?: ultrawideId
        }
    }

    private fun closeCamera() {
        try { captureSession?.close() } catch (_: Exception) { }
        captureSession = null
        try { cameraDevice?.close() } catch (_: Exception) { }
        cameraDevice = null
        try { mediaRecorder?.release() } catch (_: Exception) { }
        mediaRecorder = null
        try { activePreviewSurface?.release() } catch (_: Exception) { }
        activePreviewSurface = null
        activeRecorderSurface = null
    }

    @SuppressLint("MissingPermission")
    private fun openSelectedCamera() {
        if (!hasCameraPermission() || !previewTex.isAvailable) return
        val cm = getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        val camId = selectActiveCameraId() ?: return
        closeCamera()
        activeCamId = camId
        ensureCamThread()

        try {
            val chars = cm.getCameraCharacteristics(camId)
            sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
            activeIsFront = (chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT)
            val stabModes = chars.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES) ?: intArrayOf()
            supportsVideoStab = stabModes.contains(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON)
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            if (map != null) {
                val recSizes = map.getOutputSizes(MediaRecorder::class.java) ?: arrayOf(Size(1920, 1080))
                // Pick 1920x1080 or closest 16:9 HD/FHD size so encoding/rendering is crisp & fast
                videoSize = recSizes
                    .filter { it.width <= 1920 && it.height <= 1080 && it.width >= 720 }
                    .minWithOrNull(compareBy<Size> {
                        abs(it.width.toDouble() / max(1, it.height) - (16.0 / 9.0))
                    }.thenByDescending { it.width * it.height })
                    ?: Size(1920, 1080)

                val fpsList = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: emptyArray()
                val pvWant = targetFps.coerceIn(30, 60)
                previewFpsRange = fpsList.firstOrNull { it.upper == pvWant && it.lower >= 30 }
                    ?: fpsList.filter { it.upper in 30..pvWant }.maxByOrNull { it.upper * 100 + it.lower }
                    ?: Range(30, 30)

                val highRanges = try { map.highSpeedVideoFpsRanges } catch (_: Throwable) { emptyArray<Range<Int>>() }
                val hsMatch = if (targetFps >= 120) {
                    highRanges.firstOrNull { it.upper >= 120 && it.lower >= 60 }
                } else null
                if (hsMatch != null) {
                    val hsSizes = map.getHighSpeedVideoSizesFor(hsMatch)
                    val bestHs = hsSizes?.firstOrNull { it.width <= 1920 && it.height <= 1080 } ?: hsSizes?.firstOrNull()
                    if (bestHs != null) {
                        videoSize = bestHs
                        activeFpsRange = hsMatch
                        activeFps = hsMatch.upper
                        activeIsHighSpeed = true
                    } else {
                        activeIsHighSpeed = false
                    }
                } else {
                    activeIsHighSpeed = false
                }
                if (!activeIsHighSpeed) {
                    activeFpsRange = previewFpsRange
                    activeFps = activeFpsRange.upper
                }
            }

            cm.openCamera(camId, object : CameraDevice.StateCallback() {
                override fun onOpened(dev: CameraDevice) {
                    if (isFinishing || isDestroyed) { dev.close(); return }
                    cameraDevice = dev
                    startPreviewSession(forRecording = false)
                }
                override fun onDisconnected(dev: CameraDevice) { dev.close(); if (cameraDevice == dev) cameraDevice = null }
                override fun onError(dev: CameraDevice, err: Int) { dev.close(); if (cameraDevice == dev) cameraDevice = null }
            }, camHandler)
        } catch (e: Exception) {
            Log.e(TAG, "openSelectedCamera error", e)
            showToast("Camera error: ${e.message}")
        }
    }

    private fun startPreviewSession(forRecording: Boolean) {
        val dev = cameraDevice ?: return
        val st = previewTex.surfaceTexture ?: return
        st.setDefaultBufferSize(videoSize.width, videoSize.height)
        val previewSurface = Surface(st)
        try { captureSession?.close() } catch (_: Exception) { }
        try { activePreviewSurface?.release() } catch (_: Exception) { }
        activePreviewSurface = previewSurface
        mainHandler.post { configurePreviewTransform(previewTex.width, previewTex.height) }

        val targets = mutableListOf(previewSurface)
        if (forRecording) {
            activeRecorderSurface?.let { targets.add(it) }
        }

        val useHighSpeed = forRecording && activeIsHighSpeed
        val tmpl = if (forRecording) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW
        val builder = dev.createCaptureRequest(tmpl).apply {
            addTarget(previewSurface)
            if (forRecording) activeRecorderSurface?.let { addTarget(it) }
            set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
            set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, if (useHighSpeed) activeFpsRange else previewFpsRange)
            if (aeAfLocked) {
                set(CaptureRequest.CONTROL_AE_LOCK, true)
                set(CaptureRequest.CONTROL_AWB_LOCK, true)
            } else {
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                set(CaptureRequest.CONTROL_AE_LOCK, false)
                set(CaptureRequest.CONTROL_AWB_LOCK, false)
            }
            if (supportsVideoStab && !useHighSpeed) {
                set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON)
            }
        }
        try {
            if (useHighSpeed) {
                @Suppress("DEPRECATION")
                dev.createConstrainedHighSpeedCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        val hs = session as? CameraConstrainedHighSpeedCaptureSession
                        try {
                            if (hs != null) {
                                hs.setRepeatingBurst(hs.createHighSpeedRequestList(builder.build()), null, camHandler)
                            } else {
                                session.setRepeatingRequest(builder.build(), null, camHandler)
                            }
                        } catch (_: Exception) { }
                        if (forRecording) beginMediaRecorderStart()
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        activeIsHighSpeed = false
                        startPreviewSession(forRecording)
                    }
                }, camHandler)
            } else {
                @Suppress("DEPRECATION")
                dev.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        try { session.setRepeatingRequest(builder.build(), null, camHandler) } catch (_: Exception) { }
                        if (forRecording) beginMediaRecorderStart()
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        if (forRecording) {
                            mainHandler.post {
                                phase = ArmPhase.IDLE
                                updateUIState()
                                showToast("Could not start video recorder.")
                            }
                        }
                    }
                }, camHandler)
            }
        } catch (e: Exception) {
            Log.e(TAG, "createCaptureSession failed", e)
        }
    }

    private fun configurePreviewTransform(viewW: Int, viewH: Int) {
        if (viewW <= 0 || viewH <= 0) return
        val matrix = Matrix()
        val viewRect = RectF(0f, 0f, viewW.toFloat(), viewH.toFloat())
        val cx = viewRect.centerX()
        val cy = viewRect.centerY()

        val displayRot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display?.rotation ?: Surface.ROTATION_0
        else @Suppress("DEPRECATION") windowManager.defaultDisplay.rotation
        val rotDeg = when (displayRot) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }

        // Aspect-fill scaling so preview always covers full screen without stretching
        val swap = (sensorOrientation == 90 || sensorOrientation == 270) xor (rotDeg == 90 || rotDeg == 270)
        val bufW = (if (swap) videoSize.height else videoSize.width).toFloat()
        val bufH = (if (swap) videoSize.width else videoSize.height).toFloat()
        val bufRatio = bufW / max(1f, bufH)
        val viewRatio = viewW.toFloat() / max(1f, viewH.toFloat())

        if (rotDeg == 90 || rotDeg == 270) {
            val bufRect = RectF(0f, 0f, videoSize.height.toFloat(), videoSize.width.toFloat())
            bufRect.offset(cx - bufRect.centerX(), cy - bufRect.centerY())
            matrix.setRectToRect(viewRect, bufRect, Matrix.ScaleToFit.FILL)
            val scale = max(viewH.toFloat() / max(1f, videoSize.height.toFloat()), viewW.toFloat() / max(1f, videoSize.width.toFloat()))
            matrix.postScale(scale, scale, cx, cy)
            matrix.postRotate(90f * (rotDeg / 90 - 2), cx, cy)
        } else {
            val sx = if (bufRatio > viewRatio) bufRatio / viewRatio else 1f
            val sy = if (bufRatio < viewRatio) viewRatio / bufRatio else 1f
            matrix.setScale(sx, sy, cx, cy)
            if (rotDeg == 180) matrix.postRotate(180f, cx, cy)
        }
        previewTex.setTransform(matrix)
        mainHandler.post { fpsBadge.text = "${activeFps} fps" }
    }

    private fun computeVideoOrientationHint(): Int {
        val displayRot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display?.rotation ?: Surface.ROTATION_0
        else @Suppress("DEPRECATION") windowManager.defaultDisplay.rotation
        val deg = when (displayRot) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
        return if (activeIsFront) {
            (sensorOrientation + deg) % 360
        } else {
            (sensorOrientation - deg + 360) % 360
        }
    }

    private fun beginRecording(reason: String) {
        if (phase == ArmPhase.RECORDING || phase == ArmPhase.CALIBRATING || phase == ArmPhase.RENDERING) return
        if (!isStandaloneMode && sendUrl.isEmpty() && !PBLocal.spinContext.standaloneAllowed) {
            showToast("Tap 📷 Pair QR to connect to Laptop 360 Desk first.")
            return
        }
        if (cameraDevice == null) {
            showToast("Camera not ready yet.")
            return
        }

        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val target = if (isStandaloneMode) {
            File(cacheDir, "raw_360_$stamp.mp4")
        } else {
            val fKey = PBLocal.spinContext.folderKey.ifEmpty { "360" }.replace(Regex("[^A-Za-z0-9_-]"), "_")
            File(pendingDirectory(), "${stamp}_${fKey}.mp4")
        }
        try { if (target.exists()) target.delete() } catch (_: Exception) { }
        currentRecordingFile = target

        try {
            mediaRecorder?.release()
        } catch (_: Exception) { }

        val mr = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        mr.apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setOutputFile(target.absolutePath)
            setVideoEncodingBitRate(if (activeFps >= 60) 18_000_000 else 12_000_000)
            setVideoFrameRate(activeFps)
            setVideoSize(videoSize.width, videoSize.height)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setOrientationHint(computeVideoOrientationHint())
            prepare()
        }
        mediaRecorder = mr
        activeRecorderSurface = mr.surface

        phase = ArmPhase.RECORDING
        recordingStartedAt = System.currentTimeMillis()
        belowStopSince = 0L
        tailStartAt = 0L
        aboveThresholdSince = 0L
        playTone(ToneGenerator.TONE_PROP_BEEP)
        updateUIState()
        startRecClock()

        val ch = camHandler
        if (ch != null) ch.post { startPreviewSession(forRecording = true) }
        else startPreviewSession(forRecording = true)
    }

    private fun beginMediaRecorderStart() {
        try {
            mediaRecorder?.start()
        } catch (e: Exception) {
            Log.e(TAG, "MediaRecorder start failed", e)
            mainHandler.post {
                phase = ArmPhase.IDLE
                stopRecClock()
                updateUIState()
                showToast("Could not start recording: ${e.message}")
            }
        }
    }

    private fun stopRecording(reason: String) {
        if (phase != ArmPhase.RECORDING) return
        stopRecClock()
        playTone(ToneGenerator.TONE_PROP_BEEP2)

        val out = currentRecordingFile
        currentRecordingFile = null

        val mr = mediaRecorder
        mediaRecorder = null
        activeRecorderSurface = null
        var recordedOk = false
        try {
            mr?.stop()
            recordedOk = (out != null && out.exists() && out.length() > 1024L)
        } catch (e: Exception) {
            Log.w(TAG, "MediaRecorder stop err: ${e.message}")
        } finally {
            try { mr?.release() } catch (_: Exception) { }
        }

        camHandler?.post { startPreviewSession(forRecording = false) }

        if (!recordedOk || out == null) {
            try { out?.delete() } catch (_: Exception) { }
            phase = ArmPhase.IDLE
            updateUIState()
            showToast("Recording too short — skipped.")
            return
        }

        if (isStandaloneMode) {
            renderAndSaveStandaloneClip(out)
        } else {
            sentCount++
            phase = ArmPhase.COOLDOWN
            cooldownStartedAt = System.currentTimeMillis()
            stillSince = 0L
            uploadQueue.addLast(out)
            updateUIState()
            processNextUploadIfNeeded()
        }
    }

    private fun renderAndSaveStandaloneClip(rawFile: File) {
        phase = ArmPhase.RENDERING
        renderProgress = 0f
        updateUIState()

        val music = if (saMusicFilename.isNotEmpty()) File(store.overlaysDirectory(), saMusicFilename).takeIf { it.isFile } else null
        val opts = SpinRenderer.Options(
            motion = saMotion,
            aspect = saAspect,
            colorLook = saLook,
            overlayBitmap = saOverlayBitmap,
            titleText = saTitleText,
            subtitleText = saSubText,
            musicFile = music
        )

        SpinRenderer.render(applicationContext, rawFile, opts, onProgress = { p ->
            if (phase == ArmPhase.RENDERING) {
                renderProgress = p
                centerProg.progress = (p * 100f).roundToInt()
                centerTitleLabel.text = "Rendering ${(p * 100f).roundToInt()}%"
            }
        }) { res ->
            val cleanupList = mutableListOf(rawFile)
            val finalSrc = res.getOrElse { err ->
                showToast("Render fallback (raw saved): ${err.message}")
                rawFile
            }
            if (res.isSuccess) {
                cleanupList.add(finalSrc)
            }
            finishSaveAndShare(finalSrc, cleanupList)
        }
    }

    private fun finishSaveAndShare(source: File, cleanupFiles: List<File>) {
        val ctx = PBLocal.spinContext
        val saved = store.saveVideoFile(source, ctx.folderKey.ifEmpty { null }, null, null, saveToGallery)
        for (f in cleanupFiles) { try { f.delete() } catch (_: Exception) { } }

        if (!saved.ok || saved.destFile == null) {
            phase = ArmPhase.IDLE
            updateUIState()
            showToast("Could not save 360 video: ${saved.error ?: "error"}")
            return
        }

        PBLocal.ensureShareServer(applicationContext)
        sentCount++
        phase = ArmPhase.COOLDOWN
        cooldownStartedAt = System.currentTimeMillis()
        stillSince = 0L
        updateUIState()

        val lanBase = store.lanBase()
        val localPage = if (lanBase.isNotEmpty()) "$lanBase${saved.pageUrl}" else ""
        val stUrl = store.stationUrl()

        if (skipQuickSharePopup || isFinishing || isDestroyed) {
            if (!isFinishing && !isDestroyed) {
                showToast("✓ 360 video ready on Sharing Station ($sentCount)")
            }
            SpinQuickShareActivity.uploadClipInBackground(applicationContext, saved.destFile, saved.slug, saved.filename)
            return
        }

        if (isScreenLocked) {
            isScreenLocked = false
            lockOverlay.visibility = View.GONE
        }

        val i = Intent(this, SpinQuickShareActivity::class.java).apply {
            putExtra(SpinQuickShareActivity.EXTRA_VIDEO_PATH, saved.destFile.absolutePath)
            putExtra(SpinQuickShareActivity.EXTRA_LOCAL_PAGE_URL, localPage)
            putExtra(SpinQuickShareActivity.EXTRA_STATION_URL, stUrl)
            putExtra(SpinQuickShareActivity.EXTRA_EVENT_TITLE, saved.eventTitle)
            putExtra(SpinQuickShareActivity.EXTRA_SLUG, saved.slug)
            putExtra(SpinQuickShareActivity.EXTRA_FILENAME, saved.filename)
            putExtra(SpinQuickShareActivity.EXTRA_ONLINE_URL, PBLocal.onlineShareUrl(saved.slug, saved.filename))
        }
        startActivity(i)
    }

    // MARK: - Gyroscope Listener & State Machine (~50 Hz)

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || event.sensor.type != Sensor.TYPE_GYROSCOPE) return
        val rx = event.values[0].toDouble()
        val ry = event.values[1].toDouble()
        val rz = event.values[2].toDouble()
        val instDps = sqrt(rx * rx + ry * ry + rz * rz) * (180.0 / PI)
        smoothedDps = smoothedDps * 0.72 + instDps * 0.28
        mainHandler.post { processGyroSample(smoothedDps) }
    }

    private fun processGyroSample(dps: Double) {
        val now = System.currentTimeMillis()
        updateMeterUI()
        if (isSettingsOpen) {
            liveGyroLabel.text = if (isThresholdCalibrated) {
                String.format(Locale.US, "Live gyro: %.1f°/s (trigger %.0f°/s)", dps, startThresholdDps)
            } else {
                String.format(Locale.US, "Live gyro: %.1f°/s (trigger not set)", dps)
            }
        }

        when (phase) {
            ArmPhase.CALIBRATING -> {
                val elapsed = (now - calStepStartedAt) / 1000.0
                if (calStep == CalStep.STILL) {
                    calStillSamples.add(dps)
                    centerProg.progress = ((elapsed / 1.8).coerceIn(0.0, 1.0) * 100).roundToInt()
                    if (elapsed >= 1.8) {
                        calStep = CalStep.SPIN
                        calStepStartedAt = now
                        playTone(ToneGenerator.TONE_PROP_BEEP)
                        updateUIState()
                    }
                } else {
                    calSpinSamples.add(dps)
                    centerProg.progress = ((elapsed / 3.2).coerceIn(0.0, 1.0) * 100).roundToInt()
                    if (elapsed >= 3.2) finishCalibration()
                }
            }
            ArmPhase.IDLE -> {
                if (!isThresholdCalibrated || isSettingsOpen || stationOverlay.visibility == View.VISIBLE || calIntroOverlay.visibility == View.VISIBLE || armConfig.trigger != "arm") {
                    aboveThresholdSince = 0L
                    return
                }
                if (dps >= startThresholdDps) {
                    if (aboveThresholdSince == 0L) aboveThresholdSince = now
                    else if (now - aboveThresholdSince >= 180L) beginRecording("motion")
                } else {
                    aboveThresholdSince = 0L
                }
            }
            ArmPhase.RECORDING -> {
                val recElapsed = (now - recordingStartedAt) / 1000.0
                if (recElapsed >= armConfig.maxSec) {
                    stopRecording("max_duration")
                    return
                }
                if (armConfig.stopMode == "fixed") {
                    if (recElapsed >= armConfig.fixedSec) stopRecording("fixed_timer")
                    return
                }
                if (recElapsed < 1.8) return
                if (dps <= stopThresholdDps) {
                    if (belowStopSince == 0L) belowStopSince = now
                    else if (now - belowStopSince >= 750L) {
                        if (tailStartAt == 0L) tailStartAt = now
                        else if ((now - tailStartAt) / 1000.0 >= armConfig.tailSec) stopRecording("motion_stopped")
                    }
                } else {
                    belowStopSince = 0L
                    tailStartAt = 0L
                }
            }
            ArmPhase.RENDERING -> { /* rendering asynchronously */ }
            ArmPhase.COOLDOWN -> {
                val coolElapsed = (now - cooldownStartedAt) / 1000.0
                if (dps <= stopThresholdDps) {
                    if (stillSince == 0L) stillSince = now
                } else {
                    stillSince = 0L
                }
                if (coolElapsed >= armConfig.cooldownSec && stillSince != 0L && (now - stillSince) >= 800L) {
                    phase = ArmPhase.IDLE
                    updateUIState()
                } else if (coolElapsed >= 12.0) {
                    phase = ArmPhase.IDLE
                    updateUIState()
                }
            }
        }
    }

    private fun startCalibration() {
        if (!hasGyro) { showToast("This phone has no hardware gyroscope sensor."); return }
        if (phase == ArmPhase.RECORDING || phase == ArmPhase.RENDERING) return
        if (isSettingsOpen) closeSettings()
        calIntroOverlay.visibility = View.GONE
        if (!hasSeenCalibrationIntro) {
            hasSeenCalibrationIntro = true
            prefs().edit().putBoolean(KEY_CAL_INTRO_SEEN, true).apply()
        }
        calStillSamples.clear()
        calSpinSamples.clear()
        calStep = CalStep.STILL
        calStepStartedAt = System.currentTimeMillis()
        phase = ArmPhase.CALIBRATING
        updateUIState()
    }

    private fun finishCalibration() {
        val noise = if (calStillSamples.isEmpty()) 2.0 else (calStillSamples.sorted()[(calStillSamples.size * 0.90).toInt().coerceAtMost(calStillSamples.lastIndex)])
        val topSpin = calSpinSamples.sortedDescending()
        val spinPeak = if (topSpin.isEmpty()) 45.0 else topSpin.take(max(1, topSpin.size / 4)).average()

        if (spinPeak <= noise + 8.0) {
            phase = ArmPhase.IDLE
            updateUIState()
            val msg = if (isThresholdCalibrated) {
                "Did not feel enough spin motion — keeping trigger at ${startThresholdDps.roundToInt()}°/s."
            } else {
                "No spin detected — clamp phone on the 360 arm, tap Calibrate, and spin."
            }
            showToast(msg)
            return
        }
        val mid = noise + (spinPeak - noise) * 0.35
        startThresholdDps = mid.coerceIn(12.0, 90.0)
        stopThresholdDps = max(6.0, min(startThresholdDps * 0.45, noise + (startThresholdDps - noise) * 0.30))
        isThresholdCalibrated = true
        hasSeenCalibrationIntro = true
        val ed = prefs().edit()
            .putFloat(KEY_START_THRESH, startThresholdDps.toFloat())
            .putFloat(KEY_STOP_THRESH, stopThresholdDps.toFloat())
            .putBoolean(KEY_THRESH_CALIBRATED, true)
            .putBoolean(KEY_CAL_INTRO_SEEN, true)
        if (isStandaloneMode) {
            saTrigger = "arm"
            armConfig.trigger = "arm"
            ed.putString(KEY_TRIGGER, "arm")
        }
        ed.apply()
        threshSeek.progress = (startThresholdDps.roundToInt() - 10).coerceIn(0, 90)
        threshReadoutLabel.text = "Trigger threshold: ${startThresholdDps.roundToInt()}°/s"
        syncSettingsUI()
        playTone(ToneGenerator.TONE_PROP_ACK)
        phase = ArmPhase.IDLE
        updateUIState()
        val autoNow = isStandaloneMode || armConfig.trigger == "arm"
        val msg = if (autoNow) {
            "✓ Calibrated & Auto-Spin ON! Triggers at ${startThresholdDps.roundToInt()}°/s."
        } else {
            "✓ Calibrated! Trigger set to ${startThresholdDps.roundToInt()}°/s."
        }
        showToast(msg)
    }

    // MARK: - Laptop 360 Desk Networking (Arm Telemetry + Remote Commands)

    private fun readBatteryPct(): Int {
        return try {
            val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            val pct = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (pct in 0..100) pct else -1
        } catch (_: Throwable) { -1 }
    }

    private fun deviceLabel(): String {
        val mfg = (Build.MANUFACTURER ?: "").trim()
        val mdl = (Build.MODEL ?: "Android").trim()
        return (if (mfg.isNotEmpty() && !mdl.startsWith(mfg, ignoreCase = true)) "$mfg $mdl" else mdl).take(48)
    }

    private fun armStateString(): String = when {
        isUploadingNow -> "uploading"
        phase == ArmPhase.CALIBRATING -> "calibrating"
        phase == ArmPhase.RECORDING -> "recording"
        phase == ArmPhase.COOLDOWN -> "cooldown"
        else -> "idle"
    }

    private fun verifyPairAndFetchConfig(baseSendUrl: String, silent: Boolean) {
        val recSec = if (phase == ArmPhase.RECORDING) max(0.0, (System.currentTimeMillis() - recordingStartedAt) / 1000.0) else 0.0
        val payload = JSONObject()
            .put("device", deviceLabel())
            .put("state", armStateString())
            .put("gyroDps", (smoothedDps * 10.0).roundToInt() / 10.0)
            .put("thresholdDps", startThresholdDps.roundToInt())
            .put("battery", readBatteryPct())
            .put("fps", activeFps)
            .put("recSec", (recSec * 10.0).roundToInt() / 10.0)
            .put("uploadPct", activeUploadPct)
            .put("lens", lensChoice.label)
            .toString()

        Thread({
            var ok = false
            var obj: JSONObject? = null
            var conn: HttpURLConnection? = null
            try {
                conn = (URL("$baseSendUrl/arm-state").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 4500
                    readTimeout = 4500
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code == 200) {
                    val txt = conn.inputStream.bufferedReader().readText()
                    val j = JSONObject(txt)
                    if (j.optBoolean("ok", false)) {
                        ok = true
                        obj = j
                    }
                } else if (code == 404 || code == 405) {
                    try { conn.disconnect() } catch (_: Exception) { }
                    conn = (URL("$baseSendUrl/hello?r=1").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 4500
                        readTimeout = 4500
                    }
                    if (conn.responseCode == 200) {
                        val j = JSONObject(conn.inputStream.bufferedReader().readText())
                        if (j.optBoolean("ok", false)) {
                            ok = true
                            obj = j
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { conn?.disconnect() } catch (_: Exception) { }
            }

            val parsedObj = obj
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                if (ok && parsedObj != null) {
                    val urlChanged = sendUrl != baseSendUrl
                    sendUrl = baseSendUrl
                    deskConnected = true
                    val cfg = parsedObj.optJSONObject("config")
                    val rawName = cfg?.optString("laptop", "")?.ifBlank { null }
                        ?: parsedObj.optString("name", "").ifBlank { null }
                    deskLaptopName = rawName ?: "Laptop 360 Desk"
                    prefs().edit().putString(KEY_SEND_URL, baseSendUrl).apply()
                    if (urlChanged) {
                        isStandaloneMode = false
                        prefs().edit().putBoolean(KEY_STANDALONE, false).apply()
                    }
                    if (!isStandaloneMode) {
                        val armObj = cfg?.optJSONObject("arm") ?: parsedObj.optJSONObject("arm")
                        armObj?.let { applyDeskConfig(it) }
                        handleDeskCommands(parsedObj.optJSONArray("cmds"))
                    }
                    if (!silent) {
                        playTone(ToneGenerator.TONE_PROP_ACK)
                        showToast("✓ Paired with $deskLaptopName")
                        showCalibrationIntroIfNeeded()
                    }
                    startHeartbeatIfNeeded()
                    processNextUploadIfNeeded()
                } else {
                    deskConnected = false
                    if (!silent) showToast("Cannot reach Laptop 360 Desk — check Wi-Fi.")
                }
                updateUIState()
            }
        }, "pb-arm-hello").start()
    }

    private fun handleDeskCommands(cmds: JSONArray?) {
        if (cmds == null || cmds.length() == 0) return
        for (i in 0 until cmds.length()) {
            val cObj = cmds.optJSONObject(i) ?: continue
            when (cObj.optString("cmd", "")) {
                "start" -> {
                    if (phase == ArmPhase.IDLE || phase == ArmPhase.COOLDOWN) {
                        if (phase == ArmPhase.COOLDOWN) phase = ArmPhase.IDLE
                        beginRecording("desk")
                    }
                }
                "stop" -> {
                    if (phase == ArmPhase.RECORDING) stopRecording("desk")
                }
                "calibrate" -> {
                    if (hasGyro && (phase == ArmPhase.IDLE || phase == ArmPhase.COOLDOWN)) {
                        if (phase == ArmPhase.COOLDOWN) phase = ArmPhase.IDLE
                        startCalibration()
                    }
                }
            }
        }
    }

    private fun applyDeskConfig(arm: JSONObject) {
        val prevFps = armConfig.fps
        armConfig.trigger = arm.optString("trigger", armConfig.trigger)
        armConfig.stopMode = arm.optString("stopMode", armConfig.stopMode)
        armConfig.fixedSec = arm.optDouble("fixedSec", armConfig.fixedSec).coerceIn(3.0, 30.0)
        armConfig.tailSec = arm.optDouble("tailSec", armConfig.tailSec).coerceIn(0.5, 5.0)
        armConfig.maxSec = arm.optDouble("maxSec", armConfig.maxSec).coerceIn(5.0, 30.0)
        armConfig.cooldownSec = arm.optDouble("cooldownSec", armConfig.cooldownSec).coerceIn(2.0, 10.0)
        val newFps = arm.optInt("fps", armConfig.fps)
        armConfig.fps = if (newFps in listOf(30, 60, 120)) newFps else armConfig.fps

        val sig = "${armConfig.trigger}|${armConfig.stopMode}|${armConfig.fixedSec}|${armConfig.fps}"
        if (sig != lastConfigSig) {
            lastConfigSig = sig
            if (armConfig.fps != prevFps && phase == ArmPhase.IDLE) {
                targetFps = armConfig.fps
                openSelectedCamera()
            }
            updateUIState()
        }
    }

    private fun startHeartbeatIfNeeded() {
        stopHeartbeat()
        if (isStandaloneMode || sendUrl.isEmpty()) return
        val r = object : Runnable {
            override fun run() {
                if (isFinishing || isDestroyed || isStandaloneMode || sendUrl.isEmpty()) return
                verifyPairAndFetchConfig(sendUrl, silent = true)
                mainHandler.postDelayed(this, 1500L)
            }
        }
        heartbeatRunnable = r
        mainHandler.postDelayed(r, 1500L)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    private fun processNextUploadIfNeeded() {
        if (isUploadingNow || sendUrl.isEmpty()) {
            updateUIState()
            return
        }
        val next = uploadQueue.removeFirstOrNull()
        if (next == null) {
            updateUIState()
            return
        }
        if (!next.isFile) {
            processNextUploadIfNeeded()
            return
        }
        currentUploadFile = next
        isUploadingNow = true
        activeUploadPct = 0
        updateUIState()

        Thread({
            var ok = false
            var conn: HttpURLConnection? = null
            try {
                val u = URL("$sendUrl/upload?name=${Uri.encode(next.name)}")
                conn = (u.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 120000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/octet-stream")
                    setFixedLengthStreamingMode(next.length())
                }
                val total = max(1L, next.length())
                var sent = 0L
                val buf = ByteArray(65536)
                FileInputStream(next).use { fis ->
                    conn.outputStream.use { os ->
                        while (true) {
                            val n = fis.read(buf)
                            if (n <= 0) break
                            os.write(buf, 0, n)
                            sent += n
                            val pct = ((sent * 100L) / total).toInt().coerceIn(0, 100)
                            if (pct != activeUploadPct) {
                                activeUploadPct = pct
                                mainHandler.post { updatePendingUI() }
                            }
                        }
                    }
                }
                ok = conn.responseCode in 200..299
            } catch (_: Exception) {
            } finally {
                try { conn?.disconnect() } catch (_: Exception) { }
            }

            mainHandler.post {
                isUploadingNow = false
                if (ok) {
                    try { next.delete() } catch (_: Exception) { }
                    currentUploadFile = null
                    currentUploadRetries = 0
                    showToast("✓ Clip delivered to Laptop 360 Desk")
                    processNextUploadIfNeeded()
                } else {
                    currentUploadRetries++
                    uploadQueue.addFirst(next)
                    currentUploadFile = null
                    updateUIState()
                    if (currentUploadRetries <= 4) {
                        mainHandler.postDelayed({ processNextUploadIfNeeded() }, 2000L)
                    }
                }
            }
        }, "pb-arm-upload").start()
    }

    // MARK: - Pickers (Overlay PNG & Music Audio)

    private fun handlePickedOverlay(uri: Uri) {
        try {
            val raw = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
            if (raw == null) { showToast("Could not read PNG overlay."); return }
            val safeName = "ov_${System.currentTimeMillis()}.png"
            val dest = File(store.overlaysDirectory(), safeName)
            dest.outputStream().use { raw.compress(Bitmap.CompressFormat.PNG, 100, it) }
            saOverlayFilename = safeName
            saOverlayBitmap = raw
            prefs().edit().putString(KEY_OVERLAY_FILE, safeName).apply()
            refreshOverlayPreview()
            syncSettingsUI()
            updateUIState()
            showToast("✓ PNG Overlay active")
        } catch (e: Exception) {
            showToast("Overlay error: ${e.message}")
        }
    }

    private fun handlePickedMusic(uri: Uri) {
        try {
            val name = queryDisplayName(uri) ?: "track_${System.currentTimeMillis()}.mp3"
            val clean = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val safeName = "mus_${System.currentTimeMillis()}_$clean"
            val dest = File(store.overlaysDirectory(), safeName)
            contentResolver.openInputStream(uri)?.use { ins ->
                dest.outputStream().use { outs -> ins.copyTo(outs, 65536) }
            } ?: run { showToast("Could not read audio file."); return }
            saMusicFilename = safeName
            prefs().edit().putString(KEY_MUSIC_FILE, safeName).apply()
            syncSettingsUI()
            showToast("✓ Music attached: $name")
        } catch (e: Exception) {
            showToast("Music error: ${e.message}")
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (_: Exception) { null }
    }

    // MARK: - UI Construction

    private fun buildUI() {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }
        setContentView(root)

        previewTex = TextureView(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                    if (hasCameraPermission()) openSelectedCamera()
                }
                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
                    configurePreviewTransform(width, height)
                }
                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean = true
                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) { }
            }
        }
        root.addView(previewTex)

        // Tap-to-focus gesture on preview
        val detector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                handleTapFocus(e.x, e.y)
                return true
            }
        })
        previewTex.setOnTouchListener { _, ev -> detector.onTouchEvent(ev) }

        overlayPreviewImg = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_XY
            alpha = 0.85f
            visibility = View.GONE
        }
        root.addView(overlayPreviewImg, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))

        // Top Bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pillBg("#AA0D0C10", 16)
            setPadding(px(10), px(8), px(10), px(8))
        }
        val topLp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            topMargin = px(12); leftMargin = px(12); rightMargin = px(12)
        }
        root.addView(topBar, topLp)

        connPill = TextView(this).apply {
            textSize = 11.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            setPadding(px(10), px(5), px(10), px(5))
            setOnClickListener { openSettings() }
        }
        topBar.addView(connPill)

        val lensWrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = px(6) }
            gravity = Gravity.CENTER
        }
        lensBtns = linkedMapOf()
        for (lc in LensChoice.values()) {
            val b = Button(this).apply {
                text = lc.label
                textSize = 11f
                isAllCaps = false
                setPadding(px(8), px(3), px(8), px(3))
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(30)).apply { rightMargin = px(4) }
                setOnClickListener { switchLens(lc) }
            }
            lensBtns[lc] = b
            lensWrap.addView(b)
        }
        topBar.addView(lensWrap)

        fpsBadge = TextView(this).apply {
            text = "30 fps"
            textSize = 11f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#6CE6A4"))
            background = pillBg("#26FFFFFF", 10)
            setPadding(px(8), px(4), px(8), px(4))
        }
        topBar.addView(fpsBadge)

        aeLockBtn = Button(this).apply {
            text = "AE/AF"
            textSize = 10.5f
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = pillBg("#26FFFFFF", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(30)).apply { leftMargin = px(5) }
            setPadding(px(8), 0, px(8), 0)
            setOnClickListener {
                aeAfLocked = !aeAfLocked
                aeLockBtn.background = pillBg(if (aeAfLocked) "#C93D27" else "#26FFFFFF", 10)
                startPreviewSession(phase == ArmPhase.RECORDING)
                showToast(if (aeAfLocked) "AE/AF Locked" else "Auto Focus/Exposure")
            }
        }
        topBar.addView(aeLockBtn)

        val gearBtn = Button(this).apply {
            text = "⚙"
            textSize = 14f
            setTextColor(Color.WHITE)
            background = pillBg("#26FFFFFF", 14)
            layoutParams = LinearLayout.LayoutParams(px(32), px(32)).apply { leftMargin = px(5) }
            setOnClickListener { openSettings() }
        }
        topBar.addView(gearBtn)

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 14f
            setTextColor(Color.WHITE)
            background = pillBg("#26FFFFFF", 14)
            layoutParams = LinearLayout.LayoutParams(px(32), px(32)).apply { leftMargin = px(5) }
            setOnClickListener { finish() }
        }
        topBar.addView(closeBtn)

        // Center Status / Calibration / Render Card
        centerOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = pillBg("#D9121018", 20, "#33FFFFFF")
            setPadding(px(22), px(18), px(22), px(18))
            visibility = View.GONE
        }
        centerIconLabel = TextView(this).apply { textSize = 30f; gravity = Gravity.CENTER }
        centerTitleLabel = TextView(this).apply {
            textSize = 19f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE); gravity = Gravity.CENTER
        }
        centerSubLabel = TextView(this).apply {
            textSize = 13f; setTextColor(Color.parseColor("#C7C2CC")); gravity = Gravity.CENTER
            setPadding(0, px(4), 0, px(10))
        }
        centerProg = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            layoutParams = LinearLayout.LayoutParams(px(220), LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        centerCancelBtn = Button(this).apply {
            text = "Cancel"
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = pillBg("#33FFFFFF", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(36)).apply { topMargin = px(10) }
            setOnClickListener {
                if (phase == ArmPhase.CALIBRATING) { phase = ArmPhase.IDLE; updateUIState() }
            }
        }
        centerOverlay.addView(centerIconLabel)
        centerOverlay.addView(centerTitleLabel)
        centerOverlay.addView(centerSubLabel)
        centerOverlay.addView(centerProg)
        centerOverlay.addView(centerCancelBtn)
        root.addView(centerOverlay, FrameLayout.LayoutParams(px(310), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        // Toast label
        toastLabel = TextView(this).apply {
            textSize = 12.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            background = pillBg("#CC16141C", 14)
            setPadding(px(14), px(7), px(14), px(7))
            visibility = View.GONE
        }
        root.addView(toastLabel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = px(68)
        })

        // Bottom HUD
        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = pillBg("#CC0D0C10", 18)
            setPadding(px(12), px(10), px(12), px(12))
        }
        val botLp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            bottomMargin = px(12); leftMargin = px(12); rightMargin = px(12)
        }
        root.addView(bottomBar, botLp)

        pendingBtn = Button(this).apply {
            textSize = 12f
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = pillBg("#99C96827", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(34)).apply { bottomMargin = px(6) }
            visibility = View.GONE
            setOnClickListener { currentUploadRetries = 0; processNextUploadIfNeeded() }
        }
        bottomBar.addView(pendingBtn)

        lookQuickBtn = Button(this).apply {
            textSize = 12f
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = pillBg("#29FFFFFF", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(34)).apply { bottomMargin = px(6) }
            setOnClickListener { openSettings() }
        }
        bottomBar.addView(lookQuickBtn)

        stateBanner = TextView(this).apply {
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, px(6))
        }
        bottomBar.addView(stateBanner)

        meterTrack = FrameLayout(this).apply {
            background = pillBg("#29FFFFFF", 5)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(10))
        }
        meterFill = View(this).apply {
            background = pillBg("#5AC8FA", 5)
            layoutParams = FrameLayout.LayoutParams(px(4), FrameLayout.LayoutParams.MATCH_PARENT)
        }
        meterThreshMark = View(this).apply {
            setBackgroundColor(Color.parseColor("#FFD60A"))
            layoutParams = FrameLayout.LayoutParams(px(3), FrameLayout.LayoutParams.MATCH_PARENT)
        }
        meterTrack.addView(meterFill)
        meterTrack.addView(meterThreshMark)
        bottomBar.addView(meterTrack)

        meterValueLabel = TextView(this).apply {
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.parseColor("#B8B4BE"))
            gravity = Gravity.CENTER
            setPadding(0, px(4), 0, px(8))
        }
        bottomBar.addView(meterValueLabel)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        calBtn = hudBtn("🎯 Calibrate", "#29FFFFFF") { startCalibration() }
        recBtn = hudBtn("● Record", "#C93D27") {
            when (phase) {
                ArmPhase.RENDERING -> {}
                ArmPhase.RECORDING -> stopRecording("manual")
                else -> {
                    if (phase == ArmPhase.COOLDOWN) phase = ArmPhase.IDLE
                    beginRecording("manual")
                }
            }
        }
        lockBtn = hudBtn("🔒 Lock", "#29FFFFFF") {
            isScreenLocked = true
            lockOverlay.visibility = View.VISIBLE
            val autoArmed = isThresholdCalibrated && armConfig.trigger == "arm"
            lockStatusLabel.text = if (phase == ArmPhase.RECORDING) centerTitleLabel.text else if (autoArmed) "● ARMED (MOTION)" else "READY (MANUAL)"
        }
        pairBtn = hudBtn("📱 Station", "#29FFFFFF") {
            if (isStandaloneMode) openStationModal()
            else promptPairMethod()
        }
        for (b in listOf(calBtn, recBtn, lockBtn, pairBtn)) {
            b.layoutParams = LinearLayout.LayoutParams(0, px(42), 1f).apply { leftMargin = px(3); rightMargin = px(3) }
            btnRow.addView(b)
        }
        bottomBar.addView(btnRow)

        buildSettingsOverlay(root)
        buildStationOverlay(root)
        buildCalibrationIntroOverlay(root)
        buildLockOverlay(root)
    }

    private fun hudBtn(label: String, bgHex: String, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = 12f
        isAllCaps = false
        setTypeface(null, Typeface.BOLD)
        setTextColor(Color.WHITE)
        background = pillBg(bgHex, 12)
        setPadding(px(4), 0, px(4), 0)
        setOnClickListener { onClick() }
    }

    private fun buildSettingsOverlay(root: FrameLayout) {
        settingsOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#B3000000"))
            visibility = View.GONE
            setOnClickListener { closeSettings() }
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = pillBg("#18161E", 20, "#24FFFFFF")
            setPadding(px(16), px(14), px(16), px(14))
            setOnClickListener { /* absorb backdrop tap */ }
        }
        val hdr = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val hTitle = TextView(this).apply {
            text = "360 Booth Settings"
            textSize = 17f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val hDone = Button(this).apply {
            text = "Done"
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = pillBg("#C93D27", 10)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, px(34))
            setOnClickListener { closeSettings() }
        }
        hdr.addView(hTitle); hdr.addView(hDone)
        card.addView(hdr)

        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = px(10) }
        }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(body)
        card.addView(scroll)

        // Mode Switcher
        val modeRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        modeSaBtn = hudBtn("Standalone 360", "#C93D27") { setMode(true) }
        modeDeskBtn = hudBtn("Laptop Desk", "#26FFFFFF") { setMode(false) }
        modeSaBtn.layoutParams = LinearLayout.LayoutParams(0, px(38), 1f).apply { rightMargin = px(4) }
        modeDeskBtn.layoutParams = LinearLayout.LayoutParams(0, px(38), 1f).apply { leftMargin = px(4) }
        modeRow.addView(modeSaBtn); modeRow.addView(modeDeskBtn)
        body.addView(modeRow)

        // Standalone Section
        standaloneSettingsBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, px(10), 0, 0)
        }
        motionBtn = hudBtn("Motion: ${saMotion.label}", "#26FFFFFF") { cycleMotionPreset() }
        motionBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40)).apply { bottomMargin = px(8) }
        standaloneSettingsBox.addView(motionBtn)

        val aspRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = px(8) }
        }
        aspectButtons = mutableListOf()
        for (a in SpinRenderer.OutputAspect.values()) {
            val b = hudBtn(a.id.uppercase(Locale.US), "#26FFFFFF") {
                saAspect = a
                prefs().edit().putString(KEY_ASPECT, a.id).apply()
                refreshOverlayPreview()
                syncSettingsUI()
                updateUIState()
            }
            b.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f).apply { rightMargin = px(4) }
            aspectButtons.add(Pair(a, b))
            aspRow.addView(b)
        }
        standaloneSettingsBox.addView(aspRow)

        lookBtn = hudBtn("Color Look: ${saLook.label}", "#26FFFFFF") { cycleColorLook() }
        lookBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40)).apply { bottomMargin = px(8) }
        standaloneSettingsBox.addView(lookBtn)

        // Overlay picker row
        overlayStatusLabel = TextView(this).apply { textSize = 12f; setTextColor(Color.parseColor("#B8B4BE")) }
        standaloneSettingsBox.addView(overlayStatusLabel)
        val ovRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(4); bottomMargin = px(8) }
        }
        val pickOv = hudBtn("Pick PNG Overlay", "#1F8E4D") { overlayPickerLauncher.launch("image/*") }
        val clrOv = hudBtn("Clear", "#33FFFFFF") {
            saOverlayFilename = ""; saOverlayBitmap = null
            prefs().edit().remove(KEY_OVERLAY_FILE).apply()
            refreshOverlayPreview(); syncSettingsUI(); updateUIState()
        }
        pickOv.layoutParams = LinearLayout.LayoutParams(0, px(38), 2f).apply { rightMargin = px(6) }
        clrOv.layoutParams = LinearLayout.LayoutParams(0, px(38), 1f)
        ovRow.addView(pickOv); ovRow.addView(clrOv)
        standaloneSettingsBox.addView(ovRow)

        // Music picker row
        musicStatusLabel = TextView(this).apply { textSize = 12f; setTextColor(Color.parseColor("#B8B4BE")) }
        standaloneSettingsBox.addView(musicStatusLabel)
        val musRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(4); bottomMargin = px(8) }
        }
        val pickMus = hudBtn("Pick Music (.mp3/.m4a)", "#26FFFFFF") { musicPickerLauncher.launch("audio/*") }
        val clrMus = hudBtn("Clear", "#33FFFFFF") {
            saMusicFilename = ""; prefs().edit().remove(KEY_MUSIC_FILE).apply(); syncSettingsUI()
        }
        pickMus.layoutParams = LinearLayout.LayoutParams(0, px(38), 2f).apply { rightMargin = px(6) }
        clrMus.layoutParams = LinearLayout.LayoutParams(0, px(38), 1f)
        musRow.addView(pickMus); musRow.addView(clrMus)
        standaloneSettingsBox.addView(musRow)

        // Event title + subtitle inputs
        titleField = EditText(this).apply {
            hint = "Event Title on video (optional)"
            setText(saTitleText)
            setHintTextColor(Color.parseColor("#8D8994")); setTextColor(Color.WHITE)
            background = pillBg("#18FFFFFF", 8); setPadding(px(10), px(8), px(10), px(8))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
                override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    saTitleText = s?.toString() ?: ""
                    prefs().edit().putString(KEY_TITLE, saTitleText).apply()
                }
            })
        }
        subField = EditText(this).apply {
            hint = "Subtitle / Date (optional)"
            setText(saSubText)
            setHintTextColor(Color.parseColor("#8D8994")); setTextColor(Color.WHITE)
            background = pillBg("#18FFFFFF", 8); setPadding(px(10), px(8), px(10), px(8))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
                override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    saSubText = s?.toString() ?: ""
                    prefs().edit().putString(KEY_SUBTITLE, saSubText).apply()
                }
            })
        }
        titleField.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40)).apply { bottomMargin = px(6) }
        subField.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40)).apply { bottomMargin = px(8) }
        standaloneSettingsBox.addView(titleField); standaloneSettingsBox.addView(subField)

        // Trigger row
        val trigRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = px(6) }
        }
        trigAutoBtn = hudBtn("Auto Spin", "#C93D27") {
            if (!hasGyro) { showToast("No gyro sensor on this phone"); return@hudBtn }
            if (!isThresholdCalibrated) {
                AlertDialog.Builder(this)
                    .setTitle("Calibrate 360 Arm First")
                    .setMessage("Auto-Spin needs your 360 arm's rotation speed so normal bumps won't trigger recording.\n\nClamp your phone on the 360 arm and run the 5-second calibration, or enable it now with the default 25°/s threshold.")
                    .setPositiveButton("🎯 Calibrate Now") { _, _ -> startCalibration() }
                    .setNeutralButton("Use 25°/s Default") { _, _ ->
                        isThresholdCalibrated = true
                        hasSeenCalibrationIntro = true
                        saTrigger = "arm"; armConfig.trigger = "arm"
                        prefs().edit()
                            .putFloat(KEY_START_THRESH, startThresholdDps.toFloat())
                            .putFloat(KEY_STOP_THRESH, stopThresholdDps.toFloat())
                            .putBoolean(KEY_THRESH_CALIBRATED, true)
                            .putBoolean(KEY_CAL_INTRO_SEEN, true)
                            .putString(KEY_TRIGGER, "arm")
                            .apply()
                        syncSettingsUI(); updateUIState()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
                return@hudBtn
            }
            saTrigger = "arm"; armConfig.trigger = "arm"
            prefs().edit().putString(KEY_TRIGGER, "arm").apply(); syncSettingsUI(); updateUIState()
        }
        trigManualBtn = hudBtn("Manual", "#26FFFFFF") {
            saTrigger = "manual"; armConfig.trigger = "manual"
            prefs().edit().putString(KEY_TRIGGER, "manual").apply(); syncSettingsUI(); updateUIState()
        }
        trigAutoBtn.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f).apply { rightMargin = px(4) }
        trigManualBtn.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f)
        trigRow.addView(trigAutoBtn); trigRow.addView(trigManualBtn)
        standaloneSettingsBox.addView(trigRow)

        // Stop mode row
        val stopRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = px(6) }
        }
        stopFollowBtn = hudBtn("Follow Arm", "#C93D27") { setStandaloneStop("follow", 8.0) }
        stop8Btn = hudBtn("Fixed 8s", "#26FFFFFF") { setStandaloneStop("fixed", 8.0) }
        stop12Btn = hudBtn("Fixed 12s", "#26FFFFFF") { setStandaloneStop("fixed", 12.0) }
        for (b in listOf(stopFollowBtn, stop8Btn, stop12Btn)) {
            b.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f).apply { rightMargin = px(4) }
            stopRow.addView(b)
        }
        standaloneSettingsBox.addView(stopRow)

        // FPS row
        val fpsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = px(8) }
        }
        fps60Btn = hudBtn("60 FPS", "#C93D27") { setTargetFps(60) }
        fps120Btn = hudBtn("120 FPS", "#26FFFFFF") { setTargetFps(120) }
        fps60Btn.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f).apply { rightMargin = px(4) }
        fps120Btn.layoutParams = LinearLayout.LayoutParams(0, px(36), 1f)
        fpsRow.addView(fps60Btn); fpsRow.addView(fps120Btn)
        standaloneSettingsBox.addView(fpsRow)

        skipShareSwitch = Switch(this).apply {
            text = "Skip Quick Share popup (send straight to Sharing Station)"
            setTextColor(Color.WHITE)
            isChecked = skipQuickSharePopup
            setOnCheckedChangeListener { _, checked ->
                skipQuickSharePopup = checked
                prefs().edit().putBoolean(KEY_SKIP_SHARE, checked).apply()
            }
        }
        standaloneSettingsBox.addView(skipShareSwitch)
        body.addView(standaloneSettingsBox)

        // Desk Section
        deskSettingsBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, px(10), 0, 0)
        }
        deskSummaryLabel = TextView(this).apply { textSize = 12.5f; setTextColor(Color.parseColor("#C7C2CC")) }
        val pairBtns = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(8) }
        }
        val scanB = hudBtn("📷 Scan Desk QR", "#C93D27") { closeSettings(); launchQrScanner() }
        val typeB = hudBtn("Type URL", "#26FFFFFF") { promptManualUrl() }
        scanB.layoutParams = LinearLayout.LayoutParams(0, px(40), 1f).apply { rightMargin = px(6) }
        typeB.layoutParams = LinearLayout.LayoutParams(0, px(40), 1f)
        pairBtns.addView(scanB); pairBtns.addView(typeB)

        settingsPendingBtn = hudBtn("Retry Pending Uploads", "#99C96827") { currentUploadRetries = 0; processNextUploadIfNeeded() }
        settingsPendingBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(38)).apply { topMargin = px(8) }
        deskSettingsBox.addView(deskSummaryLabel); deskSettingsBox.addView(pairBtns); deskSettingsBox.addView(settingsPendingBtn)
        body.addView(deskSettingsBox)

        // Shared Gyro Sensitivity + Save Gallery
        threshReadoutLabel = TextView(this).apply {
            text = if (isThresholdCalibrated) "Trigger threshold: ${startThresholdDps.roundToInt()}°/s" else "Trigger threshold: Not set (calibrate or drag slider)"
            setTextColor(Color.WHITE)
            setPadding(0, px(12), 0, px(4))
        }
        threshSeek = SeekBar(this).apply {
            max = 90
            progress = (startThresholdDps.roundToInt() - 10).coerceIn(0, 90)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    startThresholdDps = (p + 10).toDouble()
                    stopThresholdDps = max(5.0, startThresholdDps * 0.45)
                    isThresholdCalibrated = true
                    hasSeenCalibrationIntro = true
                    threshReadoutLabel.text = "Trigger threshold: ${startThresholdDps.roundToInt()}°/s"
                    prefs().edit()
                        .putFloat(KEY_START_THRESH, startThresholdDps.toFloat())
                        .putFloat(KEY_STOP_THRESH, stopThresholdDps.toFloat())
                        .putBoolean(KEY_THRESH_CALIBRATED, true)
                        .putBoolean(KEY_CAL_INTRO_SEEN, true)
                        .apply()
                    updateUIState()
                }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) {}
            })
        }
        liveGyroLabel = TextView(this).apply { textSize = 11.5f; setTextColor(Color.parseColor("#A49FA9")) }
        val calInSettingsBtn = hudBtn("🎯 Run Calibration Wizard", "#1E3B52") { startCalibration() }
        calInSettingsBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40)).apply { topMargin = px(8); bottomMargin = px(8) }
        saveGallerySwitch = Switch(this).apply {
            text = "Save rendered clips to Phone Gallery"
            setTextColor(Color.WHITE)
            isChecked = saveToGallery
            setOnCheckedChangeListener { _, c ->
                saveToGallery = c
                prefs().edit().putBoolean(KEY_SAVE_GALLERY, c).apply()
            }
        }
        body.addView(threshReadoutLabel); body.addView(threshSeek); body.addView(liveGyroLabel); body.addView(calInSettingsBtn); body.addView(saveGallerySwitch)

        val cardW = min(px(390), max(px(280), resources.displayMetrics.widthPixels - px(24)))
        val cardH = min(px(560), max(px(260), resources.displayMetrics.heightPixels - px(24)))
        val cardLp = FrameLayout.LayoutParams(cardW, cardH, Gravity.CENTER)
        settingsOverlay.addView(card, cardLp)
        root.addView(settingsOverlay)
    }

    private fun buildStationOverlay(root: FrameLayout) {
        stationOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#CC000000"))
            visibility = View.GONE
            setOnClickListener { stationOverlay.visibility = View.GONE }
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = pillBg("#18161E", 20, "#24FFFFFF")
            setPadding(px(20), px(20), px(20), px(18))
            setOnClickListener { }
        }
        val title = TextView(this).apply {
            text = "Sharing Station"; textSize = 19f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE)
        }
        val sub = TextView(this).apply {
            text = "Open on any iPad, tablet or laptop on the same Wi-Fi to auto-show finished 360 clips with QR, WhatsApp & Email."
            textSize = 12.5f; setTextColor(Color.parseColor("#B8B4BE")); gravity = Gravity.CENTER
            setPadding(0, px(4), 0, px(12))
        }
        val qrWrap = FrameLayout(this).apply { background = pillBg("#FFFFFF", 14); setPadding(px(10), px(10), px(10), px(10)) }
        stationQrImg = ImageView(this).apply { layoutParams = FrameLayout.LayoutParams(px(180), px(180)) }
        qrWrap.addView(stationQrImg)
        stationUrlLabel = TextView(this).apply {
            textSize = 11.5f; typeface = Typeface.MONOSPACE; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            setPadding(0, px(10), 0, px(10))
        }
        val copyBtn = hudBtn("📋 Copy URL", "#C93D27") {
            val url = store.stationUrl()
            if (url.isNotEmpty()) {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Station", url))
                showToast("✓ Sharing Station URL copied!")
            }
        }
        val closeBtn = hudBtn("Close", "#26FFFFFF") { stationOverlay.visibility = View.GONE }
        copyBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(42)).apply { bottomMargin = px(8) }
        closeBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(40))
        card.addView(title); card.addView(sub); card.addView(qrWrap); card.addView(stationUrlLabel); card.addView(copyBtn); card.addView(closeBtn)
        val stCardW = min(px(340), max(px(260), resources.displayMetrics.widthPixels - px(24)))
        stationOverlay.addView(card, FrameLayout.LayoutParams(stCardW, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        root.addView(stationOverlay)
    }

    private fun buildCalibrationIntroOverlay(root: FrameLayout) {
        calIntroOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#B8000000"))
            visibility = View.GONE
            setOnClickListener { /* keep modal deliberate */ }
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = pillBg("#1C1A1E", 20, "#3A3540")
            setPadding(px(20), px(20), px(20), px(18))
            setOnClickListener { }
        }
        val icon = TextView(this).apply {
            text = "🎯"
            textSize = 34f
            gravity = Gravity.CENTER
        }
        val title = TextView(this).apply {
            text = "Calibrate Your 360 Arm"
            textSize = 20f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#F5F1EA"))
            gravity = Gravity.CENTER
            setPadding(0, px(6), 0, px(8))
        }
        val body = TextView(this).apply {
            text = "Auto-Spin is OFF right now so moving your phone won't accidentally start recording.\n\n" +
                "Run a 5-second calibration once your phone is clamped on the 360 arm:\n" +
                "• Step 1 (Hold Still): checks resting vibration so bumps won't trigger it.\n" +
                "• Step 2 (Spin Arm): measures your arm's speed and sets the trigger threshold automatically.\n\n" +
                "Or start in Manual Mode now and tap 🎯 Calibrate anytime later."
            textSize = 13.5f
            setTextColor(Color.parseColor("#D4CEC8"))
            setLineSpacing(px(2).toFloat(), 1.15f)
            setPadding(0, 0, 0, px(16))
        }
        val startCalBtn = hudBtn("🎯 Start Calibration", "#C93D27") {
            hasSeenCalibrationIntro = true
            prefs().edit().putBoolean(KEY_CAL_INTRO_SEEN, true).apply()
            calIntroOverlay.visibility = View.GONE
            startCalibration()
        }
        startCalBtn.textSize = 14.5f
        startCalBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(46)).apply { bottomMargin = px(8) }

        val manualBtn = hudBtn("Start in Manual Mode", "#26FFFFFF") {
            hasSeenCalibrationIntro = true
            prefs().edit().putBoolean(KEY_CAL_INTRO_SEEN, true).apply()
            calIntroOverlay.visibility = View.GONE
            updateUIState()
            showToast("Manual Mode ready — tap ● Record or 🎯 Calibrate anytime.")
        }
        manualBtn.textSize = 13.5f
        manualBtn.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(42))

        card.addView(icon)
        card.addView(title)
        card.addView(body)
        card.addView(startCalBtn)
        card.addView(manualBtn)

        val cardW = min(px(360), max(px(270), resources.displayMetrics.widthPixels - px(28)))
        val scroll = ScrollView(this).apply {
            isFillViewport = false
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            addView(card, FrameLayout.LayoutParams(cardW, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        val scrollLp = FrameLayout.LayoutParams(cardW, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
            topMargin = px(16)
            bottomMargin = px(16)
        }
        calIntroOverlay.addView(scroll, scrollLp)
        root.addView(calIntroOverlay)
    }

    private fun showCalibrationIntroIfNeeded() {
        if (!hasGyro || hasSeenCalibrationIntro || isThresholdCalibrated) return
        if (!isStandaloneMode && sendUrl.isEmpty()) return
        if (phase != ArmPhase.IDLE || isSettingsOpen || stationOverlay.visibility == View.VISIBLE) return
        calIntroOverlay.visibility = View.VISIBLE
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            isScreenLocked -> showToast("Long-press the lock screen to unlock.")
            phase == ArmPhase.RECORDING -> showToast("Tap ■ Stop before closing.")
            calIntroOverlay.visibility == View.VISIBLE -> {
                hasSeenCalibrationIntro = true
                prefs().edit().putBoolean(KEY_CAL_INTRO_SEEN, true).apply()
                calIntroOverlay.visibility = View.GONE
                updateUIState()
            }
            isSettingsOpen -> closeSettings()
            stationOverlay.visibility == View.VISIBLE -> stationOverlay.visibility = View.GONE
            else -> super.onBackPressed()
        }
    }

    private fun buildLockOverlay(root: FrameLayout) {
        lockOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F008070B"))
            visibility = View.GONE
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
        lockStatusLabel = TextView(this).apply { text = "● ARMED"; textSize = 24f; setTypeface(null, Typeface.BOLD); setTextColor(Color.WHITE) }
        val hint = TextView(this).apply {
            text = "Touch Shield active — Press & hold for 1.5s to unlock"
            textSize = 13f; setTextColor(Color.parseColor("#A49FA9")); setPadding(0, px(8), 0, 0)
        }
        col.addView(lockStatusLabel); col.addView(hint)
        lockOverlay.addView(col, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        lockOverlay.setOnLongClickListener {
            playTone(ToneGenerator.TONE_PROP_ACK)
            isScreenLocked = false
            lockOverlay.visibility = View.GONE
            showToast("Screen unlocked")
            true
        }
        root.addView(lockOverlay)
    }

    // MARK: - UI Actions & Updates

    private fun setMode(standalone: Boolean) {
        if (standalone && !PBLocal.spinContext.standaloneAllowed) {
            showToast("Standalone 360 is off by default — enable 360 on this code in Admin.")
            isStandaloneMode = false
            syncSettingsUI()
            updateUIState()
            return
        }
        isStandaloneMode = standalone
        prefs().edit().putBoolean(KEY_STANDALONE, standalone).apply()
        if (standalone) {
            stopHeartbeat()
            armConfig.trigger = saTrigger
            armConfig.stopMode = saStopMode
            armConfig.fixedSec = saFixedSec
        } else {
            startHeartbeatIfNeeded()
        }
        refreshOverlayPreview()
        syncSettingsUI()
        updateUIState()
    }

    private fun cycleMotionPreset() {
        val all = SpinRenderer.MotionPreset.values()
        saMotion = all[(all.indexOf(saMotion) + 1) % all.size]
        prefs().edit().putString(KEY_MOTION, saMotion.id).apply()
        syncSettingsUI(); updateUIState()
    }

    private fun cycleColorLook() {
        val all = SpinRenderer.ColorLook.values()
        saLook = all[(all.indexOf(saLook) + 1) % all.size]
        prefs().edit().putString(KEY_LOOK, saLook.id).apply()
        syncSettingsUI(); updateUIState()
    }

    private fun setStandaloneStop(mode: String, fixed: Double) {
        saStopMode = mode; saFixedSec = fixed
        armConfig.stopMode = mode; armConfig.fixedSec = fixed
        prefs().edit().putString(KEY_STOP_MODE, mode).putFloat(KEY_FIXED_SEC, fixed.toFloat()).apply()
        syncSettingsUI(); updateUIState()
    }

    private fun setTargetFps(fps: Int) {
        targetFps = fps
        prefs().edit().putInt(KEY_FPS, fps).apply()
        syncSettingsUI()
        openSelectedCamera()
    }

    private fun switchLens(lc: LensChoice) {
        if (phase == ArmPhase.RECORDING) { showToast("Stop recording first."); return }
        if (lc == LensChoice.ULTRAWIDE && ultrawideId == null) return
        if (lc == LensChoice.WIDE && wideId == null) return
        if (lc == LensChoice.FRONT && frontId == null) return
        lensChoice = lc
        prefs().edit().putString(KEY_LENS, lc.id).apply()
        updateUIState()
        openSelectedCamera()
    }

    private fun handleTapFocus(x: Float, y: Float) {
        val sess = captureSession ?: return
        val dev = cameraDevice ?: return
        val pvSurf = activePreviewSurface ?: return
        if (phase == ArmPhase.RECORDING && activeIsHighSpeed) return
        if (previewTex.width <= 0 || previewTex.height <= 0) return
        val nx = (x / previewTex.width).coerceIn(0f, 1f)
        val ny = (y / previewTex.height).coerceIn(0f, 1f)
        val cm = getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
        try {
            val rect = cm.getCameraCharacteristics(activeCamId).get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return
            if (rect.width() <= 140 || rect.height() <= 140) return
            val fx = (ny * rect.width()).toInt().coerceIn(0, rect.width() - 121)
            val fy = ((1f - nx) * rect.height()).toInt().coerceIn(0, rect.height() - 121)
            val region = MeteringRectangle(fx, fy, 120, 120, MeteringRectangle.METERING_WEIGHT_MAX - 1)
            val useRec = (phase == ArmPhase.RECORDING)
            val b = dev.createCaptureRequest(if (useRec) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW)
            b.addTarget(pvSurf)
            if (useRec) activeRecorderSurface?.let { b.addTarget(it) }
            b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, previewFpsRange)
            b.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(region))
            b.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(region))
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
            b.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START)
            sess.capture(b.build(), null, camHandler)
        } catch (_: Exception) { }
    }

    private fun openSettings() { isSettingsOpen = true; syncSettingsUI(); settingsOverlay.visibility = View.VISIBLE }
    private fun closeSettings() { isSettingsOpen = false; settingsOverlay.visibility = View.GONE }

    private fun promptPairMethod() {
        AlertDialog.Builder(this)
            .setTitle("Pair with Laptop 360 Desk")
            .setItems(arrayOf("📷 Scan Laptop QR Code", "⌨️ Type / Paste Laptop URL")) { _, which ->
                if (which == 0) launchQrScanner() else promptManualUrl()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun launchQrScanner() {
        val opts = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Scan the QR code on your Laptop's 360 Desk")
            setBeepEnabled(true)
            setOrientationLocked(false)
        }
        qrLauncher.launch(opts)
    }

    private fun promptManualUrl() {
        val input = EditText(this).apply {
            hint = "192.168.1.50:47777/send/xxxx"
            setText(sendUrl)
            isSingleLine = true
        }
        AlertDialog.Builder(this)
            .setTitle("Enter Laptop 360 Desk URL")
            .setMessage("Type or paste the Send URL shown on your laptop's 360 Desk.")
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val norm = normalizeSendUrl(input.text?.toString() ?: "")
                if (norm == null) {
                    showToast("Invalid URL — copy from 360 Desk.")
                } else {
                    if (isSettingsOpen) closeSettings()
                    verifyPairAndFetchConfig(norm, silent = false)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun openStationModal() {
        PBLocal.ensureShareServer(applicationContext)
        val url = store.stationUrl()
        if (url.isEmpty()) {
            stationUrlLabel.text = "Connect this phone to Wi-Fi or Hotspot first, then open Sharing Station on any tablet or laptop."
            stationQrImg.setImageBitmap(null)
        } else {
            stationUrlLabel.text = url
            stationQrImg.setImageBitmap(SpinQuickShareActivity.generateQrBitmap(url, 480))
        }
        stationOverlay.visibility = View.VISIBLE
    }

    private fun refreshOverlayPreview() {
        if (isStandaloneMode && saOverlayBitmap != null) {
            overlayPreviewImg.setImageBitmap(saOverlayBitmap)
            overlayPreviewImg.visibility = View.VISIBLE
        } else {
            overlayPreviewImg.visibility = View.GONE
        }
    }

    private fun syncSettingsUI() {
        modeSaBtn.background = pillBg(if (isStandaloneMode) "#C93D27" else "#26FFFFFF", 10)
        modeSaBtn.alpha = if (PBLocal.spinContext.standaloneAllowed) 1.0f else 0.45f
        modeDeskBtn.background = pillBg(if (!isStandaloneMode) "#C93D27" else "#26FFFFFF", 10)
        standaloneSettingsBox.visibility = if (isStandaloneMode) View.VISIBLE else View.GONE
        deskSettingsBox.visibility = if (isStandaloneMode) View.GONE else View.VISIBLE

        motionBtn.text = "Motion: ${saMotion.label}"
        lookBtn.text = "Color Look: ${saLook.label}"
        for ((a, b) in aspectButtons) {
            b.background = pillBg(if (a == saAspect) "#C93D27" else "#26FFFFFF", 10)
        }
        overlayStatusLabel.text = if (saOverlayFilename.isEmpty()) "Frame Overlay: None (clear PNG)" else "Frame Overlay: Active ✓"
        musicStatusLabel.text = if (saMusicFilename.isEmpty()) "Background Music: None" else "Background Music: $saMusicFilename"
        trigAutoBtn.background = pillBg(if (saTrigger == "arm" && isThresholdCalibrated) "#C93D27" else "#26FFFFFF", 10)
        trigManualBtn.background = pillBg(if (saTrigger == "manual" || !isThresholdCalibrated) "#C93D27" else "#26FFFFFF", 10)
        threshReadoutLabel.text = if (isThresholdCalibrated) {
            "Trigger threshold: ${startThresholdDps.roundToInt()}°/s"
        } else {
            "Trigger threshold: Not set (calibrate or drag slider)"
        }
        stopFollowBtn.background = pillBg(if (saStopMode == "follow") "#C93D27" else "#26FFFFFF", 10)
        stop8Btn.background = pillBg(if (saStopMode == "fixed" && abs(saFixedSec - 8.0) < 1.0) "#C93D27" else "#26FFFFFF", 10)
        stop12Btn.background = pillBg(if (saStopMode == "fixed" && saFixedSec >= 10.0) "#C93D27" else "#26FFFFFF", 10)
        fps60Btn.background = pillBg(if (targetFps == 60) "#C93D27" else "#26FFFFFF", 10)
        fps120Btn.background = pillBg(if (targetFps == 120) "#C93D27" else "#26FFFFFF", 10)
        deskSummaryLabel.text = if (sendUrl.isEmpty()) "Not paired with Laptop 360 Desk yet."
        else if (deskConnected) "Connected to $deskLaptopName\n$sendUrl" else "Paired ($sendUrl) — Offline / waiting"
    }

    private fun updateMeterUI() {
        val w = meterTrack.width
        val autoArmed = isThresholdCalibrated && armConfig.trigger == "arm"
        meterThreshMark.visibility = if (isThresholdCalibrated) View.VISIBLE else View.GONE
        if (w > 10) {
            val maxDps = 120.0
            val flp = meterFill.layoutParams
            flp.width = max(4, ((smoothedDps / maxDps).coerceIn(0.0, 1.0) * w).roundToInt())
            meterFill.layoutParams = flp
            if (isThresholdCalibrated) {
                val tlp = meterThreshMark.layoutParams as FrameLayout.LayoutParams
                tlp.leftMargin = ((startThresholdDps / maxDps).coerceIn(0.0, 1.0) * (w - px(4))).roundToInt()
                meterThreshMark.layoutParams = tlp
            }
        }
        meterFill.background = pillBg(if (autoArmed && smoothedDps >= startThresholdDps) "#2EA66B" else "#5AC8FA", 5)
        val lbl = if (isStandaloneMode) "Clips" else "Sent"
        val gyroTxt = if (!hasGyro) {
            "No gyro"
        } else if (!isThresholdCalibrated) {
            String.format(Locale.US, "%.0f°/s · Trigger: Not set", smoothedDps)
        } else if (armConfig.trigger != "arm") {
            String.format(Locale.US, "%.0f°/s · Auto-Spin: Off (%.0f°/s)", smoothedDps, startThresholdDps)
        } else {
            String.format(Locale.US, "%.0f°/s · Trigger: %.0f°/s", smoothedDps, startThresholdDps)
        }
        meterValueLabel.text = "$gyroTxt  ·  $lbl: $sentCount"
    }

    private fun updatePendingUI() {
        val count = uploadQueue.size + if (isUploadingNow) 1 else 0
        if (isStandaloneMode || count == 0) {
            pendingBtn.visibility = View.GONE
            settingsPendingBtn.visibility = View.GONE
            return
        }
        pendingBtn.visibility = View.VISIBLE
        settingsPendingBtn.visibility = View.VISIBLE
        if (isUploadingNow) {
            pendingBtn.text = "⬆ Uploading $activeUploadPct% (${uploadQueue.size} queued)"
            settingsPendingBtn.text = "Uploading $activeUploadPct%…"
        } else {
            pendingBtn.text = "↻ Retry pending ($count)"
            settingsPendingBtn.text = "Retry pending ($count)"
        }
    }

    private fun updateUIState() {
        connPill.text = if (isStandaloneMode) "● Standalone 360" else if (deskConnected) "● $deskLaptopName" else if (sendUrl.isEmpty()) "○ Not paired" else "○ Reconnecting…"
        connPill.background = pillBg(if (isStandaloneMode) "#333A8EFA" else if (deskConnected) "#332EA66B" else "#33C96827", 10)

        for ((lc, b) in lensBtns) {
            val avail = when (lc) {
                LensChoice.ULTRAWIDE -> ultrawideId != null
                LensChoice.WIDE -> wideId != null
                LensChoice.FRONT -> frontId != null
            }
            b.visibility = if (avail) View.VISIBLE else View.GONE
            b.background = pillBg(if (lc == lensChoice) "#C93D27" else "#26FFFFFF", 8)
            b.setTextColor(Color.WHITE)
        }

        lookQuickBtn.visibility = if (isStandaloneMode) View.VISIBLE else View.GONE
        if (isStandaloneMode) {
            val aspTag = when (saAspect) {
                SpinRenderer.OutputAspect.PORTRAIT_9X16 -> "9:16"
                SpinRenderer.OutputAspect.SQUARE_1X1 -> "1:1"
                SpinRenderer.OutputAspect.LANDSCAPE_16X9 -> "16:9"
            }
            val ovTag = if (saOverlayBitmap != null) " · Overlay ✓" else ""
            lookQuickBtn.text = "🎨 ${saMotion.shortLabel} · $aspTag$ovTag · Edit"
            pairBtn.text = "📱 Station"
        } else {
            pairBtn.text = "📷 Pair QR"
        }

        refreshOverlayPreview()
        updatePendingUI()
        updateMeterUI()

        when (phase) {
            ArmPhase.CALIBRATING -> {
                centerOverlay.visibility = View.VISIBLE; centerCancelBtn.visibility = View.VISIBLE; centerProg.visibility = View.VISIBLE
                centerIconLabel.text = if (calStep == CalStep.STILL) "🎯" else "🔄"
                centerTitleLabel.text = if (calStep == CalStep.STILL) "Step 1 of 2: Hold Still" else "Step 2 of 2: Spin Arm Now!"
                centerSubLabel.text = if (calStep == CalStep.STILL) "Measuring idle vibration…" else "Spin your 360 arm at event speed."
                stateBanner.text = "Calibrating sensitivity…"
                recBtn.isEnabled = false; calBtn.isEnabled = false
            }
            ArmPhase.RECORDING -> {
                centerOverlay.visibility = View.VISIBLE; centerCancelBtn.visibility = View.GONE; centerProg.visibility = View.GONE
                centerIconLabel.text = "🎥"
                val el = max(0L, System.currentTimeMillis() - recordingStartedAt)
                val sec = el / 1000
                val tenth = (el % 1000) / 100
                centerTitleLabel.text = String.format(Locale.US, "● REC %02d:%02d.%d", sec / 60, sec % 60, tenth)
                centerSubLabel.text = if (armConfig.stopMode == "fixed") "Fixed ${armConfig.fixedSec.toInt()}s · $activeFps fps"
                else "Auto-stops when arm stops + ${armConfig.tailSec}s tail"
                stateBanner.text = "Recording 360 spin…"
                recBtn.text = "■ Stop"; recBtn.background = pillBg("#D92E1F", 12)
                recBtn.isEnabled = true; calBtn.isEnabled = false
                if (isScreenLocked) lockStatusLabel.text = centerTitleLabel.text
            }
            ArmPhase.RENDERING -> {
                centerOverlay.visibility = View.VISIBLE; centerCancelBtn.visibility = View.GONE; centerProg.visibility = View.VISIBLE
                centerIconLabel.text = "✨"
                centerTitleLabel.text = "Rendering ${(renderProgress * 100f).roundToInt()}%"
                centerSubLabel.text = "Applying ${saMotion.shortLabel} & overlay…"
                stateBanner.text = "Rendering 360 video…"
                recBtn.text = "● Record"; recBtn.background = pillBg("#C93D27", 12)
                recBtn.isEnabled = false; calBtn.isEnabled = false
                if (isScreenLocked) lockStatusLabel.text = "RENDERING 360…"
            }
            ArmPhase.COOLDOWN -> {
                centerOverlay.visibility = View.VISIBLE; centerCancelBtn.visibility = View.GONE; centerProg.visibility = View.GONE
                centerIconLabel.text = "⏳"; centerTitleLabel.text = "Cooldown"
                centerSubLabel.text = "Waiting for arm to stop…"
                stateBanner.text = "Cooldown — waiting for arm to stop"
                recBtn.text = "● Record"; recBtn.background = pillBg("#C93D27", 12)
                recBtn.isEnabled = true; calBtn.isEnabled = true
            }
            ArmPhase.IDLE -> {
                centerOverlay.visibility = View.GONE
                recBtn.text = "● Record"; recBtn.background = pillBg("#C93D27", 12)
                recBtn.isEnabled = true; calBtn.isEnabled = hasGyro
                val autoArmed = isThresholdCalibrated && armConfig.trigger == "arm"
                stateBanner.text = if (isStandaloneMode) {
                    if (autoArmed) "● Standalone Armed — spin arm to auto-record"
                    else if (!isThresholdCalibrated && hasGyro) "Auto-Spin OFF — tap 🎯 Calibrate to set trigger, or tap ● Record"
                    else "Standalone Ready — tap ● Record"
                } else {
                    if (autoArmed) "● Armed — auto-starts on spin"
                    else if (armConfig.trigger == "arm" && !isThresholdCalibrated && hasGyro) "Not calibrated — tap 🎯 Calibrate for Auto-Spin, or tap ● Record"
                    else "Ready — tap ● Record or start on Laptop"
                }
                if (isScreenLocked) lockStatusLabel.text = if (autoArmed) "● ARMED (MOTION)" else "READY"
            }
        }
    }

    private fun startRecClock() {
        stopRecClock()
        val r = object : Runnable {
            override fun run() {
                if (phase != ArmPhase.RECORDING || isFinishing || isDestroyed) return
                updateUIState()
                mainHandler.postDelayed(this, 100L)
            }
        }
        recClockRunnable = r
        mainHandler.postDelayed(r, 100L)
    }

    private fun stopRecClock() {
        recClockRunnable?.let { mainHandler.removeCallbacks(it) }
        recClockRunnable = null
    }

    private fun showToast(text: String) {
        toastHideRunnable?.let { mainHandler.removeCallbacks(it) }
        toastLabel.text = "  $text  "
        toastLabel.visibility = View.VISIBLE
        val r = Runnable { toastLabel.visibility = View.GONE }
        toastHideRunnable = r
        mainHandler.postDelayed(r, 2800L)
    }
}
