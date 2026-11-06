package com.photobooth4u.booth

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
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

    // Common thermal printer name prefixes (NOTE: NEVER include "Bluetooth" here because keyboards/speakers start with "Bluetooth")
    private val PRINTER_PREFIXES = arrayOf(
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
    private var connectedDeviceName: String? = null
    private var connectedDeviceAddress: String? = null

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

    /**
     * Checks if runtime Bluetooth permissions are granted.
     */
    private fun hasBluetoothPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
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

        if (bondedDevices.isEmpty()) {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "No paired Bluetooth devices found. Pair your thermal printer in tablet Bluetooth Settings first.")
            return res.toString()
        }

        // 1. If explicit address given, connect directly
        if (!targetAddress.isNullOrBlank()) {
            val device = bondedDevices.find { it.address.equals(targetAddress, ignoreCase = true) }
            return if (device != null) {
                connectToDevice(device)
            } else {
                val res = JSONObject()
                res.put("ok", false)
                res.put("error", "Device with address $targetAddress is not paired.")
                res.toString()
            }
        }

        // 2. Check if a previously selected printer is saved and still paired
        val prefs = try { activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE) } catch (_: Exception) { null }
        val lastAddr = prefs?.getString("last_printer_address", null)
        if (!lastAddr.isNullOrBlank()) {
            val savedDevice = bondedDevices.find { it.address.equals(lastAddr, ignoreCase = true) }
            if (savedDevice != null && !isNonPrinter(savedDevice)) {
                val connRes = connectToDevice(savedDevice)
                val isOk = try { JSONObject(connRes).optBoolean("ok", false) } catch (_: Exception) { false }
                if (isOk) return connRes
                // The saved printer did not answer (probably switched off). Keep it remembered and show the picker,
                // so another printer can be chosen; the booth reconnects to the saved one by itself when it is back.
            }
        }

        // 3. Likely printers first; keyboards, headphones and the like never show up
        val likely = bondedDevices.filter { isLikelyPrinter(it) }
        val others = bondedDevices.filter { !isNonPrinter(it) && !isLikelyPrinter(it) }

        // Exactly one likely printer: connect straight away
        if (likely.size == 1) {
            return connectToDevice(likely.first())
        }

        // 4. Otherwise show a picker. Unrecognised devices sit behind "Other paired devices" so a printer
        //    with an odd name can still be chosen. If nothing is recognised, the list is those devices.
        val latch = CountDownLatch(1)
        var selectedDevice: BluetoothDevice? = null

        fun label(d: BluetoothDevice): String {
            val n = try { d.name ?: "Unknown" } catch (_: SecurityException) { "Unknown" }
            return "$n (${d.address})"
        }

        fun showPicker(devices: List<BluetoothDevice>, withOthers: Boolean) {
            val items = devices.map { label(it) } + (if (withOthers) listOf("Other paired devices…") else emptyList())
            AlertDialog.Builder(activity)
                .setTitle(if (withOthers || devices === likely) "Select Bluetooth Thermal Printer" else "Other paired devices")
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
            connectToDevice(selectedDevice!!)
        } else {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "No printer selected.")
            res.toString()
        }
    }

    private fun connectToDevice(device: BluetoothDevice): String {
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
            connectedDeviceName = try { device.name ?: "Bluetooth Printer" } catch (_: SecurityException) { "Bluetooth Printer" }
            connectedDeviceAddress = device.address

            // Save last successful printer address
            try {
                activity.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putString("last_printer_address", device.address)
                    .apply()
            } catch (_: Exception) {}

            val res = JSONObject()
            res.put("ok", true)
            res.put("name", connectedDeviceName)
            res.put("address", connectedDeviceAddress)
            return res.toString()
        } else {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Could not connect to ${device.name ?: device.address}: ${lastErr?.message ?: "timeout"}")
            return res.toString()
        }
    }

    /**
     * Writes raw bytes (encoded as Base64 string from JavaScript) to the thermal printer.
     */
    @JavascriptInterface
    fun write(base64Data: String): String {
        val out = activeOutputStream ?: run {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Printer not connected.")
            return res.toString()
        }

        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            out.write(bytes)
            out.flush()

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
        val out = activeOutputStream ?: run {
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", "Printer not connected.")
            return res.toString()
        }

        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val piece = chunkSize.coerceIn(16, 4096)
            val pause = delayMs.coerceIn(0, 500).toLong()
            var off = 0
            while (off < bytes.size) {
                val n = minOf(piece, bytes.size - off)
                out.write(bytes, off, n)
                out.flush()
                off += n
                if (pause > 0 && off < bytes.size) Thread.sleep(pause)
            }
            // Let the printer finish taking the last piece before the page asks for anything else.
            if (pause > 0) Thread.sleep(pause * 4)

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
        try {
            activeOutputStream?.close()
        } catch (_: Exception) {}
        try {
            activeSocket?.close()
        } catch (_: Exception) {}

        activeOutputStream = null
        activeSocket = null
        connectedDeviceName = null
        connectedDeviceAddress = null
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
    fun isConnected(): Boolean = activeSocket?.isConnected == true && activeOutputStream != null

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
            return JSONObject().put("ok", true).put("connected", true).put("name", connectedDeviceName ?: "").put("address", addr).toString()
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
        val device = try { adapter.bondedDevices?.find { it.address.equals(addr, true) } } catch (_: SecurityException) { null }
            ?: return JSONObject().put("ok", false).put("unpaired", true).put("error", "The printer is no longer paired")
        return try { JSONObject(connectToDevice(device)) } catch (_: Exception) { JSONObject().put("ok", false).put("error", "Could not connect") }
    }

    /** App closing: close the link and stop listening, but keep the chosen printer for next time. */
    fun shutdown() {
        closeConnection()
        try { linkReceiver?.let { activity.unregisterReceiver(it) } } catch (_: Exception) {}
        linkReceiver = null
        try { worker.shutdownNow() } catch (_: Exception) {}
    }
}
