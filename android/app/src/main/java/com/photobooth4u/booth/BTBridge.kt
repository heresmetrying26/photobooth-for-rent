package com.photobooth4u.booth

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
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
import java.util.concurrent.TimeUnit

/**
 * BTBridge — Injected into WebView as window.__BTBridge.
 *
 * Provides direct Bluetooth RFCOMM SPP communication for thermal receipt printers
 * (Xprinter XP-T80A / XP-80C, Epson TM-T82X, Star, Goojprt, Bixolon, Munbyn, etc.).
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
        "HOIN", "Sunmi", "Imin", "Diyep"
    )

    private var activeSocket: BluetoothSocket? = null
    private var activeOutputStream: OutputStream? = null
    private var connectedDeviceName: String? = null
    private var connectedDeviceAddress: String? = null

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
            res.put("error", "No paired Bluetooth devices found. Pair your thermal printer (e.g. T80A) in tablet Bluetooth Settings first.")
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
                // If saved device failed, clear it and fall through to picker
                prefs.edit().remove("last_printer_address").apply()
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
                .setCancelable(false)
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
        disconnect() // Close existing connection first

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
            val res = JSONObject()
            res.put("ok", false)
            res.put("error", e.message ?: "Write failed")
            res.toString()
        }
    }

    /**
     * Closes the Bluetooth connection.
     */
    @JavascriptInterface
    fun disconnect(): String {
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
}
