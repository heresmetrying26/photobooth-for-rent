package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BTBridge — Injected into WebView as window.__BTBridge.
 *
 * Provides direct Bluetooth RFCOMM SPP communication for thermal receipt printers.
 * Hardcoded-compatible models (all via ESC/POS over SPP):
 *   Bluetooth:
 *     - Xprinter XP-T80Q, XP-P300 (BT name starts with "XP")
 *     - Epson TM-T82X-II           (BT name starts with "TM" or "Epson")
 *     - Star TSP143IIIBi           (BT name starts with "TSP" or "Star")
 *     - VOZY G80                   (BT name starts with "VOZY" or "G80")
 *     - VOZY P50                   (BT name starts with "VOZY" or "P50")
 *     - VOZY MP210                 (BT name starts with "MP" — already covered — or "VOZY")
 *     - Rongta RP30 / RPP30 / RP326 / RP80 / RPP300 / RPP02N (BT name starts with "RP" or "Rongta")
 *     - HPRT, Gprinter, iDPRT      (BT name starts with "HPRT", "Gprinter" / "GP-", "iDPRT")
 *   USB (handled by NetPrintBridge / raw ESC/POS):
 *     - Xprinter XP-T80Q, XP-P300 (VID 0x28e9)
 *     - Epson TM-T82X-II           (VID 0x04B8, PID 0x0E27 printer-class / 0x0202 vendor-class)
 *     - Epson EU-m30               (VID 0x04B8, PID 0x0202 / 0x0E2E)
 *     - Star TSP143IIIU            (VID 0x0519, PID 0x0003 — must be in ESC/POS routing mode)
 *     - VOZY G80 / P50             (VID 0x28e9 or 0x0416 — both already in thermalVendors)
 *     - VOZY MP210                 (VID 0x0416 or 0x6868 — both already in thermalVendors)
 *
 * ⚠ Star TSP143III note: ships in Star Line / Raster mode. Enable ESC/POS routing via the
 *   Star futurePRNT Configuration Utility (Windows) → "Enable ESC/POS Routing", then save.
 */
@SuppressLint("MissingPermission")
class BTBridge(
    private val activity: Activity,
    private val webView: WebView
) {
    private val bluetoothManager: BluetoothManager? =
        activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter?
        get() = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()

    // Standard SPP UUID for Serial Port Profile
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // BLE thermal printer service UUIDs (FunPrint / LIOTOG C19, WalkPrint, POS BLE)
    private val BLE_SERVICE_UUIDS = listOf(
        UUID.fromString("0000ae30-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000ae00-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000ff00-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("000018f0-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000e781-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000ffe0-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000fff0-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("49535343-fe7d-4ae5-8fa9-9fafd205e455"),
        UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e"),
        UUID.fromString("e7810a71-73ae-499d-8c15-faa9aef0c3f2")
    )
    private val CAT_SERVICE_UUIDS = setOf(
        "0000ae30-0000-1000-8000-00805f9b34fb",
        "0000ae00-0000-1000-8000-00805f9b34fb"
    )

    // Common thermal printer name prefixes (NOTE: NEVER include "Bluetooth" here because keyboards/speakers start with "Bluetooth")
    private val PRINTER_PREFIXES = arrayOf(
        "C19", "LIOTOG", "MX0", "MX1", "GB0", "GT0", "YT0", "PD01",
        "T80", "T80A", "T58", "T-80", "T-58", "T9",
        "XP", "Xprinter", "TM", "Epson", "EPSON", "POS", "Receipt",
        "Thermal", "RPP", "Bixolon", "BIXOLON", "Star", "MP", "BP",
        "PT", "ZJ", "NT", "Netum", "Printer", "MTP", "MPT",
        "Inner", "Qsprinter", "Goojprt", "GOOJPRT", "Munbyn", "Milestone",
        "HOIN", "Sunmi", "Imin", "Diyep",
        // Rongta RP / RPP series (RP30, RPP30, RP326, RP80, RPP300, RPP02N ...) advertise as "RP..." or "RPP..."; also HPRT, Gprinter, iDPRT
        "RP", "Rongta", "HPRT", "Gprinter", "GP-", "iDPRT", "ArcticBreeze", "Arctic",
        // Star TSP143IIIBi advertises itself as "TSP143III" (no "Star" prefix)
        "TSP",
        // Xprinter XP-P300 sometimes advertises as "P300" on older firmware
        "P300",
        // VOZY receipt printers: G80 (80mm), P50 (58mm portable), MP210 (58mm mini) — all ESC/POS
        // MP210 BT name is usually "MP210" which is already caught by "MP" above,
        // but "VOZY" covers any model that advertises the brand name first.
        "VOZY", "G80", "P50",
        // GZQIANJI GZM5803L-BL mini 58mm printer (advertises as "GZM5803L..." or similar)
        "GZ", "GZM", "GZQIANJI"
    )

    private var activeSocket: BluetoothSocket? = null
    private var activeOutputStream: OutputStream? = null
    private var activeGatt: BluetoothGatt? = null
    private var activeWriteChar: BluetoothGattCharacteristic? = null
    @Volatile private var gattReady: Boolean = false
    @Volatile private var gattChunkSize: Int = 20
    private val gattWriteDone = Semaphore(0)
    private val gattWriteLock = Any()
    private var connectedDeviceName: String? = null
    private var connectedDeviceAddress: String? = null
    private var connectedProto: String = ""

    // Quiet reconnect (the page asks for it in the background): one attempt at a time, off the page's thread.
    private val reconnecting = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    private var linkReceiver: BroadcastReceiver? = null

    init {
        // Tell the page when the printer's link drops or comes back, and when Bluetooth is switched off / on.
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                val i = intent ?: return
                val act = i.action ?: return
                if (act == BluetoothAdapter.ACTION_STATE_CHANGED) {
                    val st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1)
                    if (st == BluetoothAdapter.STATE_OFF || st == BluetoothAdapter.STATE_TURNING_OFF) closeConnection()
                    if (st == BluetoothAdapter.STATE_ON || st == BluetoothAdapter.STATE_OFF) {
                        emit(JSONObject().put("type", "adapter").put("on", st == BluetoothAdapter.STATE_ON))
                    }
                    return
                }
                @Suppress("DEPRECATION")
                val d: BluetoothDevice = (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                    else i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)) ?: return
                val addr = d.address ?: return
                val mine = addr.equals(connectedDeviceAddress, true) || addr.equals(savedAddress(), true)
                if (!mine) return
                if (act == BluetoothDevice.ACTION_ACL_DISCONNECTED) {
                    if (addr.equals(connectedDeviceAddress, true)) closeConnection()       // the printer stays remembered
                    emit(JSONObject().put("type", "link").put("on", false).put("address", addr))
                } else if (act == BluetoothDevice.ACTION_ACL_CONNECTED) {
                    emit(JSONObject().put("type", "link").put("on", true).put("address", addr))
                }
            }
        }
        try {
            val f = IntentFilter().apply {
                addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
                addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
                addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
            }
            if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED)
            else activity.registerReceiver(rx, f)
            linkReceiver = rx
        } catch (_: Exception) {}
    }

    private fun savedAddress(): String? = try {
        activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE).getString("last_printer_address", null)
    } catch (_: Exception) { null }

    /** Sends an event to the page: window.__BTEvent({ type: ..., ... }). */
    private fun emit(o: JSONObject) {
        val js = "window.__BTEvent && window.__BTEvent(" + o.toString() + ");"
        try { activity.runOnUiThread { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} } } catch (_: Exception) {}
    }

    /**
     * Identifies devices that are clearly NOT thermal printers (keyboards, mice, headphones, etc.).
     */
    private fun isNonPrinter(device: BluetoothDevice): Boolean {
        val name = try { device.name ?: "" } catch (_: SecurityException) { "" }.lowercase()

        // Name checks for common non-printer peripherals
        if (name.contains("keyboard") || name.contains("mouse") || name.contains("headset") ||
            name.contains("headphone") || name.contains("earbud") || name.contains("airpod") ||
            name.contains("speaker") || name.contains("audio") || name.contains("watch") ||
            name.contains("band") || name.contains("remote") || name.contains("controller")) {
            return true
        }

        val btClass = try { device.bluetoothClass } catch (_: SecurityException) { null } ?: return false
        val major = btClass.majorDeviceClass

        // Exclude audio/video, phone, computer, wearable
        if (major == BluetoothClass.Device.Major.AUDIO_VIDEO ||
            major == BluetoothClass.Device.Major.PHONE ||
            major == BluetoothClass.Device.Major.COMPUTER ||
            major == BluetoothClass.Device.Major.WEARABLE) {
            return true
        }

        // Exclude keyboards, mice, pointing devices
        if (major == BluetoothClass.Device.Major.PERIPHERAL) {
            val dev = btClass.deviceClass
            if (dev == BluetoothClass.Device.PERIPHERAL_KEYBOARD ||
                dev == BluetoothClass.Device.PERIPHERAL_POINTING ||
                dev == BluetoothClass.Device.PERIPHERAL_KEYBOARD_POINTING) {
                return true
            }
        }

        return false
    }

    /**
     * True when the device looks like a receipt printer: it reports itself as an imaging/printer device,
     * or its name starts with a known thermal-printer prefix. Anything obviously not a printer is out.
     */
    private fun isLikelyPrinter(device: BluetoothDevice): Boolean {
        if (isNonPrinter(device)) return false
        val btClass = try { device.bluetoothClass } catch (_: SecurityException) { null }
        if (btClass != null && btClass.majorDeviceClass == BluetoothClass.Device.Major.IMAGING) return true
        val name = try { device.name ?: "" } catch (_: SecurityException) { "" }
        return name.isNotBlank() && PRINTER_PREFIXES.any { name.startsWith(it, ignoreCase = true) }
    }

    /**
     * Called by JavaScript: window.__BTBridge.isAvailable()
     */
    @JavascriptInterface
    fun isAvailable(): Boolean {
        return bluetoothAdapter != null
    }

    /**
     * Called by JavaScript: window.__BTBridge.isEnabled()
     * Returns true if Bluetooth is currently turned on.
     */
    @JavascriptInterface
    fun isEnabled(): Boolean {
        return try {
            bluetoothAdapter?.isEnabled == true
        } catch (_: SecurityException) {
            false
        }
    }

    /**
     * Opens Android's Bluetooth Settings so the user can turn on BT and pair their thermal printer.
     */
    @JavascriptInterface
    fun openBluetoothSettings(): Boolean = try {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                // Ignore
            }
        }
        true
    } catch (_: Exception) {
        false
    }

    private fun isCatPrinterName(name: String?): Boolean {
        if (name.isNullOrBlank()) return false
        val n = name.trim()
        return n.startsWith("C19", ignoreCase = true) ||
            n.startsWith("LIOTOG", ignoreCase = true) ||
            n.startsWith("MX0", ignoreCase = true) ||
            n.startsWith("MX1", ignoreCase = true) ||
            n.startsWith("GB0", ignoreCase = true) ||
            n.startsWith("GT0", ignoreCase = true) ||
            n.startsWith("YT0", ignoreCase = true) ||
            n.startsWith("PD01", ignoreCase = true)
    }

    /**
     * Checks if runtime Bluetooth permissions are granted.
     */
    private fun hasBluetoothPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasBleScanPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    /**
     * Request permissions if needed.
     */
    private fun requestBluetoothPermission() {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            arrayOf(Manifest.permission.BLUETOOTH, Manifest.permission.BLUETOOTH_ADMIN, Manifest.permission.ACCESS_FINE_LOCATION)
        }
        ActivityCompat.requestPermissions(activity, permissions, 1001)
    }

    /**
     * Returns JSON list of paired devices, likely printers first. Each entry has "printer": true when it
     * looks like a receipt printer, false for anything else (so the page can hide or group those).
     */
    @JavascriptInterface
    fun listDevices(): String {
        if (!hasBluetoothPermission()) {
            activity.runOnUiThread { requestBluetoothPermission() }
            return "[]"
        }
        val list = JSONArray()
        try {
            val bonded = (bluetoothAdapter?.bondedDevices ?: emptySet())
                .filter { !isNonPrinter(it) }
                .sortedByDescending { isLikelyPrinter(it) }
            for (device in bonded) {
                val obj = JSONObject()
                obj.put("name", device.name ?: "Unknown")
                obj.put("address", device.address)
                obj.put("printer", isLikelyPrinter(device))
                list.put(obj)
            }
        } catch (e: SecurityException) {
            // Permission missing
        }
        return list.toString()
    }

    /**
     * Connects to a Bluetooth thermal printer.
     * If targetAddress is null or blank:
     *   - Reconnects to the last used printer if still paired.
     *   - If exactly one printer candidate is paired, auto-connects.
     *   - If multiple candidates exist, displays a selection dialog on the UI thread.
     */
    @JavascriptInterface
    fun connect(): String {
        return connect(null)
    }

    private fun scanBlePrinters(ms: Long = 3000L): Pair<Map<String, Pair<BluetoothDevice, String>>, Map<String, Pair<BluetoothDevice, String>>> {
        val likely = LinkedHashMap<String, Pair<BluetoothDevice, String>>()
        val others = LinkedHashMap<String, Pair<BluetoothDevice, String>>()
        val ad = bluetoothAdapter ?: return Pair(likely, others)
        if (!hasBleScanPermission()) return Pair(likely, others)
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return Pair(likely, others)
        val scanner = try { ad.bluetoothLeScanner } catch (_: Exception) { null } ?: return Pair(likely, others)

        val latch = CountDownLatch(1)
        val mainHandler = Handler(Looper.getMainLooper())
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val dev = result.device ?: return
                val addr = dev.address ?: return
                val n = (try { dev.name ?: result.scanRecord?.deviceName } catch (_: Exception) { null })?.trim() ?: ""
                if (isNonPrinter(dev)) return
                val hasSvc = try { result.scanRecord?.serviceUuids?.any { BLE_SERVICE_UUIDS.contains(it.uuid) } == true } catch (_: Exception) { false }
                val nameMatch = n.isNotBlank() && PRINTER_PREFIXES.any { n.startsWith(it, ignoreCase = true) }
                if (hasSvc || nameMatch) {
                    val label = if (n.isNotBlank()) n else "BLE Printer"
                    synchronized(likely) { likely[addr] = Pair(dev, label) }
                } else if (n.isNotBlank()) {
                    synchronized(others) { others[addr] = Pair(dev, n) }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                latch.countDown()
            }
        }
        try {
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
            mainHandler.postDelayed({
                try { scanner.stopScan(cb) } catch (_: Exception) {}
                latch.countDown()
            }, ms)
            latch.await(ms + 1000L, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            try { scanner.stopScan(cb) } catch (_: Exception) {}
        }
        return Pair(likely, others)
    }

    @JavascriptInterface
    fun connect(targetAddress: String?): String {
        if (!hasBluetoothPermission()) {
            activity.runOnUiThread { requestBluetoothPermission() }
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Bluetooth permissions required. Grant permission and try again.")
            return res.toString()
        }

        val adapter = bluetoothAdapter ?: run {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Bluetooth adapter not found on this device.")
            return res.toString()
        }

        if (!adapter.isEnabled) {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Bluetooth is turned off. Please turn on Bluetooth in Android Settings.")
            return res.toString()
        }

        val bondedDevices: Set<BluetoothDevice> = try {
            adapter.bondedDevices ?: emptySet()
        } catch (e: SecurityException) {
            emptySet()
        }

        val prefs = try { activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE) } catch (_: Exception) { null }

        // 1. If explicit address given, connect directly (paired or BLE remote address)
        if (!targetAddress.isNullOrBlank()) {
            val device = bondedDevices.find { it.address.equals(targetAddress, ignoreCase = true) }
                ?: try {
                    val norm = targetAddress.trim().uppercase()
                    if (BluetoothAdapter.checkBluetoothAddress(norm)) adapter.getRemoteDevice(norm) else null
                } catch (_: Exception) { null }
            return if (device != null) {
                connectToDevice(device)
            } else {
                val res = JSONObject()
                res.put("ok", false)
                res.put("error", "Invalid or unpaired Bluetooth address: $targetAddress.")
                res.toString()
            }
        }

        // 2. Check if a previously selected printer is saved (paired Classic or remembered BLE)
        val lastAddr = prefs?.getString("last_printer_address", null)
        val lastBle = prefs?.getBoolean("last_printer_ble", false) == true
        val lastName = prefs?.getString("last_printer_name", null)
        if (!lastAddr.isNullOrBlank()) {
            val savedDevice = bondedDevices.find { it.address.equals(lastAddr, ignoreCase = true) }
                ?: if (lastBle && BluetoothAdapter.checkBluetoothAddress(lastAddr)) {
                    try { adapter.getRemoteDevice(lastAddr) } catch (_: Exception) { null }
                } else null
            if (savedDevice != null && !isNonPrinter(savedDevice)) {
                val connRes = connectToDevice(savedDevice, lastName)
                val isOk = try { JSONObject(connRes).optBoolean("ok", false) } catch (_: Exception) { false }
                if (isOk) return connRes
                // The saved printer did not answer (probably switched off). Keep it remembered and show the picker,
                // so another printer can be chosen; the booth reconnects to the saved one by itself when it is back.
            }
        }

        // 3. Likely classic paired printers first
        val likelyClassic = bondedDevices.filter { isLikelyPrinter(it) }
        val otherClassic = bondedDevices.filter { !isNonPrinter(it) && !isLikelyPrinter(it) }

        if (likelyClassic.size == 1 && !lastBle) {
            val singleRes = connectToDevice(likelyClassic.first())
            val singleOk = try { JSONObject(singleRes).optBoolean("ok", false) } catch (_: Exception) { false }
            if (singleOk) return singleRes
            // If that single paired printer is off and BLE scan is available, continue to BLE discovery.
        }

        // 4. Also scan nearby BLE thermal printers (e.g. LIOTOG C19 / FunPrint, which do not use Android PIN pairing)
        val bleNames = HashMap<String, String>()
        val bleLikely = ArrayList<BluetoothDevice>()
        val bleOthers = ArrayList<BluetoothDevice>()
        if (hasBleScanPermission()) {
            val (bLikely, bOthers) = scanBlePrinters(3000L)
            for ((addr, pair) in bLikely) {
                bleNames[addr] = pair.second
                if (likelyClassic.none { it.address.equals(addr, ignoreCase = true) }) bleLikely.add(pair.first)
            }
            for ((addr, pair) in bOthers) {
                bleNames[addr] = pair.second
                if (bondedDevices.none { it.address.equals(addr, ignoreCase = true) } && bLikely[addr] == null) bleOthers.add(pair.first)
            }
        } else if (likelyClassic.isEmpty()) {
            activity.runOnUiThread { requestBluetoothPermission() }
        }

        val likely = likelyClassic + bleLikely
        val others = otherClassic + bleOthers.filter { o -> likely.none { it.address.equals(o.address, ignoreCase = true) } }

        if (likely.isEmpty() && others.isEmpty()) {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "No Bluetooth printers found. Turn on your thermal printer (for Classic BT, pair in tablet Bluetooth Settings first) and try again.")
            return res.toString()
        }

        if (likely.size == 1 && bleLikely.size == 1 && likelyClassic.isEmpty()) {
            val d = likely.first()
            return connectToDevice(d, bleNames[d.address])
        }

        // 5. Show a picker with likely printers first and other devices behind "Other devices…"
        val latch = CountDownLatch(1)
        var selectedDevice: BluetoothDevice? = null

        fun label(d: BluetoothDevice): String {
            val n = bleNames[d.address] ?: (try { d.name ?: "Unknown" } catch (_: SecurityException) { "Unknown" })
            return "$n (${d.address})"
        }

        fun showPicker(devices: List<BluetoothDevice>, withOthers: Boolean) {
            val items = devices.map { label(it) } + (if (withOthers) listOf("Other devices…") else emptyList())
            AlertDialog.Builder(activity)
                .setTitle(if (withOthers || devices === likely) "Select Bluetooth Thermal Printer" else "Other Bluetooth devices")
                .setItems(items.toTypedArray()) { _, which ->
                    if (which < devices.size) {
                        selectedDevice = devices[which]
                        latch.countDown()
                    } else {
                        showPicker(others, false)
                    }
                }
                .setNegativeButton("Cancel") { _, _ -> latch.countDown() }
                .setOnDismissListener { latch.countDown() }
                .setCancelable(true)
                .show()
        }

        activity.runOnUiThread {
            when {
                likely.isNotEmpty() -> showPicker(likely, others.isNotEmpty())
                others.isNotEmpty() -> showPicker(others, false)
                else -> showPicker(bondedDevices.toList(), false)
            }
        }

        try {
            latch.await(60, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {}

        return if (selectedDevice != null) {
            val d = selectedDevice!!
            connectToDevice(d, bleNames[d.address])
        } else {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "No printer selected.")
            res.toString()
        }
    }

    private fun connectToDevice(device: BluetoothDevice, hintName: String? = null): String {
        val devName = hintName?.takeIf { it.isNotBlank() }
            ?: (try { device.name } catch (_: SecurityException) { null })
            ?: "Bluetooth Printer"
        val devType = try { device.type } catch (_: SecurityException) { BluetoothDevice.DEVICE_TYPE_UNKNOWN }
        val preferBle = devType == BluetoothDevice.DEVICE_TYPE_LE || isCatPrinterName(devName)

        if (preferBle) {
            val bleErr = connectGattDevice(device, devName)
            if (bleErr == null) return connectedJson()
            if (devType == BluetoothDevice.DEVICE_TYPE_DUAL) {
                val sppErr = connectSppDevice(device, devName)
                if (sppErr == null) return connectedJson()
            }
            return JSONObject().put("ok", false).put("error", "Could not connect to $devName: $bleErr").toString()
        }

        val sppErr = connectSppDevice(device, devName)
        if (sppErr == null) return connectedJson()

        if (devType == BluetoothDevice.DEVICE_TYPE_DUAL || devType == BluetoothDevice.DEVICE_TYPE_UNKNOWN) {
            val bleErr = connectGattDevice(device, devName)
            if (bleErr == null) return connectedJson()
        }
        return JSONObject().put("ok", false).put("error", "Could not connect to $devName: $sppErr").toString()
    }

    private fun connectedJson(): String {
        return JSONObject()
            .put("ok", true)
            .put("name", connectedDeviceName)
            .put("address", connectedDeviceAddress)
            .put("proto", connectedProto)
            .toString()
    }

    private fun saveConnectedPrefs(address: String, name: String, isBle: Boolean) {
        try {
            activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE)
                .edit()
                .putString("last_printer_address", address)
                .putString("last_printer_name", name)
                .putBoolean("last_printer_ble", isBle)
                .apply()
        } catch (_: Exception) {}
    }

    private fun connectSppDevice(device: BluetoothDevice, devName: String): String? {
        closeConnection() // Close existing connection first (the saved printer stays remembered)

        // Always cancel discovery before connecting (critical for RFCOMM SPP reliability)
        try {
            bluetoothAdapter?.cancelDiscovery()
        } catch (_: SecurityException) {}

        var socket: BluetoothSocket? = null
        var lastErr: Exception? = null

        // Try standard SPP UUID first
        try {
            socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
            socket.connect()
        } catch (e: Exception) {
            lastErr = e
            try { socket?.close() } catch (_: Exception) {}
            socket = null

            // Fallback 1: Insecure RFCOMM socket (many thermal printers don't implement secure encryption)
            try {
                socket = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                socket.connect()
            } catch (insecureEx: Exception) {
                lastErr = insecureEx
                try { socket?.close() } catch (_: Exception) {}
                socket = null

                // Fallback 2: Reflection on createRfcommSocket(channel 1)
                // Fixes POS printers whose SDP records don't report standard SPP
                try {
                    val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                    socket = method.invoke(device, 1) as? BluetoothSocket
                    socket?.connect()
                } catch (fallbackEx: Exception) {
                    lastErr = fallbackEx
                    try { socket?.close() } catch (_: Exception) {}
                    socket = null
                }
            }
        }

        if (socket != null && socket.isConnected) {
            activeSocket = socket
            activeOutputStream = socket.outputStream
            connectedDeviceName = devName
            connectedDeviceAddress = device.address
            connectedProto = ""
            saveConnectedPrefs(device.address, devName, false)
            return null
        }
        return lastErr?.message ?: "timeout"
    }

    private fun connectGattDevice(device: BluetoothDevice, devName: String): String? {
        closeConnection()
        try { bluetoothAdapter?.cancelDiscovery() } catch (_: SecurityException) {}

        val latch = CountDownLatch(1)
        var errMsg: String? = null
        gattReady = false
        gattChunkSize = 20

        val cb = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!g.requestMtu(185)) g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    if (!gattReady) {
                        errMsg = "BLE connection failed (status $status)"
                        try { g.close() } catch (_: Exception) {}
                        if (activeGatt === g) activeGatt = null
                        latch.countDown()
                    } else {
                        val addr = device.address
                        closeConnection()
                        if (addr != null) emit(JSONObject().put("type", "link").put("on", false).put("address", addr))
                    }
                }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS && mtu > 23) {
                    gattChunkSize = maxOf(20, minOf(182, mtu - 3))
                }
                g.discoverServices()
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    errMsg = "BLE service discovery failed ($status)"
                    try { g.disconnect() } catch (_: Exception) {}
                    latch.countDown()
                    return
                }
                var writeChar: BluetoothGattCharacteristic? = null
                var notifyChar: BluetoothGattCharacteristic? = null
                var matchedSvcUuid = ""

                fun pickFromService(svc: android.bluetooth.BluetoothGattService): Boolean {
                    var w: BluetoothGattCharacteristic? = null
                    var n: BluetoothGattCharacteristic? = null
                    for (c in svc.characteristics) {
                        val u = c.uuid.toString().lowercase()
                        val props = c.properties
                        if ((props and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0 &&
                            (u.contains("ae02") || u.contains("ff01") || u.contains("ff03"))
                        ) {
                            n = c
                        }
                        if ((props and (BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_WRITE)) != 0) {
                            if (w == null || u.contains("ae01") || u.contains("ff02")) {
                                w = c
                            }
                        }
                    }
                    if (w != null) {
                        writeChar = w
                        notifyChar = n
                        matchedSvcUuid = svc.uuid.toString().lowercase()
                        return true
                    }
                    return false
                }

                var found = false
                for (u in BLE_SERVICE_UUIDS) {
                    val svc = g.getService(u) ?: continue
                    if (pickFromService(svc)) { found = true; break }
                }
                if (!found) {
                    for (svc in g.services) {
                        if (pickFromService(svc)) { found = true; break }
                    }
                }

                if (!found || writeChar == null) {
                    errMsg = "No writable BLE characteristic found"
                    try { g.disconnect() } catch (_: Exception) {}
                    latch.countDown()
                    return
                }

                activeWriteChar = writeChar
                connectedProto = if (matchedSvcUuid in CAT_SERVICE_UUIDS || isCatPrinterName(devName)) "cat" else ""

                val nc = notifyChar
                val desc = nc?.getDescriptor(CCCD_UUID)
                if (nc != null && desc != null) {
                    g.setCharacteristicNotification(nc, true)
                    val okDesc = try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            g.writeDescriptor(desc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                        } else {
                            @Suppress("DEPRECATION")
                            run {
                                desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                g.writeDescriptor(desc)
                            }
                        }
                    } catch (_: Exception) { false }
                    if (!okDesc) {
                        gattReady = true
                        latch.countDown()
                    }
                } else {
                    gattReady = true
                    latch.countDown()
                }
            }

            override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                gattReady = true
                latch.countDown()
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                gattWriteDone.release()
            }
        }

        activity.runOnUiThread {
            try {
                activeGatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    device.connectGatt(activity, false, cb, BluetoothDevice.TRANSPORT_LE)
                } else {
                    device.connectGatt(activity, false, cb)
                }
            } catch (e: Exception) {
                errMsg = e.message ?: "Could not open BLE link"
                latch.countDown()
            }
        }

        try {
            latch.await(12, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {}

        if (!gattReady || activeGatt == null || activeWriteChar == null) {
            closeConnection()
            return errMsg ?: "BLE timeout"
        }

        connectedDeviceName = devName
        connectedDeviceAddress = device.address
        saveConnectedPrefs(device.address, devName, true)
        return null
    }

    private fun writeOnceGatt(g: BluetoothGatt, ch: BluetoothGattCharacteristic, part: ByteArray, writeType: Int): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, part, writeType) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    ch.writeType = writeType
                    ch.value = part
                    g.writeCharacteristic(ch)
                }
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun writeGattBytes(bytes: ByteArray, chunkLimit: Int, delayMs: Long) {
        val g = activeGatt ?: throw IOException("Printer not connected.")
        val ch = activeWriteChar ?: throw IOException("Printer not connected.")
        if (!gattReady) throw IOException("Printer not connected.")
        val writeType = if ((ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        synchronized(gattWriteLock) {
            var off = 0
            var sincePause = 0
            while (off < bytes.size) {
                val step = minOf(gattChunkSize, chunkLimit.coerceAtLeast(20), bytes.size - off)
                val part = bytes.copyOfRange(off, off + step)
                gattWriteDone.drainPermits()
                var sent = false
                var tries = 0
                while (!sent && tries < 300) {
                    sent = writeOnceGatt(g, ch, part, writeType)
                    if (!sent) {
                        tries++
                        try { Thread.sleep(5) } catch (_: InterruptedException) {}
                    }
                }
                if (!sent) throw IOException("Could not send to BLE printer.")
                if (!gattWriteDone.tryAcquire(2, TimeUnit.SECONDS)) throw IOException("BLE printer stopped answering.")
                if (!gattReady) throw IOException("BLE printer disconnected.")
                off += step
                sincePause += step
                if (delayMs > 0 && off < bytes.size && sincePause >= chunkLimit) {
                    Thread.sleep(delayMs)
                    sincePause = 0
                }
            }
            if (delayMs > 0) Thread.sleep(delayMs * 4)
        }
    }

    /**
     * Writes raw bytes (encoded as Base64 string from JavaScript) to the thermal printer.
     */
    @JavascriptInterface
    fun write(base64Data: String): String {
        val out = activeOutputStream
        val useGatt = gattReady && activeGatt != null && activeWriteChar != null
        if (out == null && !useGatt) {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Printer not connected.")
            return res.toString()
        }

        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            if (useGatt) {
                writeGattBytes(bytes, gattChunkSize, 0)
            } else {
                out!!.write(bytes)
                out.flush()
            }

            val res = JSONObject()
            res.put("ok", true)
            res.toString()
        } catch (e: Exception) {
            closeConnection()          // keep the chosen printer remembered
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", e.message ?: "Write failed")
            res.toString()
        }
    }

    /**
     * Writes raw bytes in small pieces with a short pause after each one.
     * Small mobile printers (58mm) have a tiny buffer and no flow control over Bluetooth serial: a job sent in one
     * burst overruns them, bytes go missing and the rest of the picture is printed as text (a hex dump / gibberish).
     * chunkSize is bytes per piece, delayMs the pause after each piece. The call returns when the last piece is out.
     */
    @JavascriptInterface
    fun writePaced(base64Data: String, chunkSize: Int, delayMs: Int): String {
        val out = activeOutputStream
        val useGatt = gattReady && activeGatt != null && activeWriteChar != null
        if (out == null && !useGatt) {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Printer not connected.")
            return res.toString()
        }

        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val piece = chunkSize.coerceIn(16, 4096)
            val pause = delayMs.coerceIn(0, 500).toLong()
            if (useGatt) {
                writeGattBytes(bytes, piece, pause)
            } else {
                var off = 0
                while (off < bytes.size) {
                    val n = minOf(piece, bytes.size - off)
                    out!!.write(bytes, off, n)
                    out.flush()
                    off += n
                    if (pause > 0 && off < bytes.size) Thread.sleep(pause)
                }
                // Let the printer finish taking the last piece before the page asks for anything else.
                if (pause > 0) Thread.sleep(pause * 4)
            }

            val res = JSONObject()
            res.put("ok", true)
            res.toString()
        } catch (e: Exception) {
            closeConnection()          // a failed write ends the link, but the chosen printer is remembered
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", e.message ?: "Write failed")
            res.toString()
        }
    }

    /**
     * Closes the link but keeps the chosen printer remembered (used after a failed print).
     */
    @JavascriptInterface
    fun release(): String {
        closeConnection()
        val res = JSONObject()
        res.put("ok", true)
        return res.toString()
    }

    private fun closeConnection() {
        gattReady = false
        gattWriteDone.release()
        try {
            activeOutputStream?.close()
        } catch (_: Exception) {}
        try {
            activeSocket?.close()
        } catch (_: Exception) {}
        try {
            activeGatt?.disconnect()
        } catch (_: Exception) {}
        try {
            activeGatt?.close()
        } catch (_: Exception) {}

        activeOutputStream = null
        activeSocket = null
        activeGatt = null
        activeWriteChar = null
        connectedDeviceName = null
        connectedDeviceAddress = null
        connectedProto = ""
    }

    /**
     * Closes the Bluetooth connection.
     */
    @JavascriptInterface
    fun disconnect(): String {
        closeConnection()

        // Clear saved printer preference so user can choose a different device next time
        try {
            activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE)
                .edit()
                .remove("last_printer_address")
                .remove("last_printer_name")
                .remove("last_printer_ble")
                .apply()
        } catch (_: Exception) {}

        val res = JSONObject()
        res.put("ok", true)
        return res.toString()
    }

    @JavascriptInterface
    fun getConnectedDeviceName(): String? {
        return connectedDeviceName
    }

    /** True while a link to the printer is open. */
    @JavascriptInterface
    fun isConnected(): Boolean =
        (activeSocket?.isConnected == true && activeOutputStream != null) ||
            (gattReady && activeGatt != null && activeWriteChar != null)

    /** The remembered printer: { address, name, connected } (address is "" when none was chosen yet). */
    @JavascriptInterface
    fun savedPrinter(): String {
        val addr = savedAddress() ?: ""
        var name = ""
        if (addr.isNotEmpty()) {
            try {
                val d = bluetoothAdapter?.bondedDevices?.find { it.address.equals(addr, true) }
                name = d?.name ?: ""
            } catch (_: SecurityException) {}
            if (name.isEmpty()) {
                name = try {
                    activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE).getString("last_printer_name", "") ?: ""
                } catch (_: Exception) { "" }
            }
        }
        return JSONObject().put("address", addr).put("name", name)
            .put("connected", isConnected() && addr.equals(connectedDeviceAddress, true)).toString()
    }

    /**
     * Reconnects to the remembered printer without asking anything: no picker, and the printer is never forgotten.
     * Runs off the page's thread; the result arrives as window.__BTEvent({ type: "reconnect", ok, name, address, error }).
     * Returns at once: { ok: true, started | busy | connected } or { ok: false, none: true } when no printer was chosen yet.
     */
    @JavascriptInterface
    fun connectSaved(): String {
        val addr = savedAddress()
        if (addr.isNullOrBlank()) return JSONObject().put("ok", false).put("none", true).toString()
        if (isConnected() && addr.equals(connectedDeviceAddress, true)) {
            return JSONObject().put("ok", true).put("connected", true)
                .put("name", connectedDeviceName ?: "")
                .put("address", addr)
                .put("proto", connectedProto)
                .toString()
        }
        if (!reconnecting.compareAndSet(false, true)) return JSONObject().put("ok", true).put("busy", true).toString()
        try {
            worker.execute {
                val res = try { quietConnect(addr) } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "Could not connect")
                } finally { reconnecting.set(false) }
                emit(res.put("type", "reconnect").put("address", addr))
            }
        } catch (e: Exception) {
            reconnecting.set(false)
            return JSONObject().put("ok", false).put("error", e.message ?: "Could not start").toString()
        }
        return JSONObject().put("ok", true).put("started", true).toString()
    }

    private fun quietConnect(addr: String): JSONObject {
        if (!hasBluetoothPermission()) return JSONObject().put("ok", false).put("error", "Bluetooth permission needed")
        val adapter = bluetoothAdapter ?: return JSONObject().put("ok", false).put("error", "No Bluetooth on this device")
        if (!adapter.isEnabled) return JSONObject().put("ok", false).put("adapterOff", true).put("error", "Bluetooth is turned off")
        val prefs = try { activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE) } catch (_: Exception) { null }
        val isBle = prefs?.getBoolean("last_printer_ble", false) == true
        val savedName = prefs?.getString("last_printer_name", null)
        val bonded = try { adapter.bondedDevices?.find { it.address.equals(addr, true) } } catch (_: SecurityException) { null }
        val ble = if (bonded == null && isBle && BluetoothAdapter.checkBluetoothAddress(addr)) {
            try { adapter.getRemoteDevice(addr) } catch (_: Exception) { null }
        } else null
        val device: BluetoothDevice = bonded ?: ble
            ?: return JSONObject().put("ok", false).put("unpaired", true).put("error", "The printer is no longer paired")
        return try { JSONObject(connectToDevice(device, savedName)) } catch (_: Exception) { JSONObject().put("ok", false).put("error", "Could not connect") }
    }

    /** App closing: close the link and stop listening, but keep the chosen printer for next time. */
    fun shutdown() {
        closeConnection()
        try { linkReceiver?.let { activity.unregisterReceiver(it) } } catch (_: Exception) {}
        linkReceiver = null
        try { worker.shutdownNow() } catch (_: Exception) {}
    }
}
