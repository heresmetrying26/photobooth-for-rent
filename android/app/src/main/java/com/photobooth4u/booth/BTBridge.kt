package com.photobooth4u.booth

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
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
 * (Xprinter, Epson, Star, Goojprt, Bixolon, Munbyn, etc.).
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

    // Common thermal printer name prefixes
    private val PRINTER_PREFIXES = arrayOf(
        "XP", "Xprinter", "TM", "Epson", "EPSON", "POS", "Receipt",
        "Thermal", "RPP", "Bixolon", "BIXOLON", "Star", "MP", "BP",
        "Printer", "MTP", "BlueTooth", "Inner", "Qsprinter"
    )

    private var activeSocket: BluetoothSocket? = null
    private var activeOutputStream: OutputStream? = null
    private var connectedDeviceName: String? = null
    private var connectedDeviceAddress: String? = null

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
     * Returns JSON list of all paired devices.
     */
    @JavascriptInterface
    fun listDevices(): String {
        if (!hasBluetoothPermission()) {
            activity.runOnUiThread { requestBluetoothPermission() }
            return "[]"
        }
        val list = JSONArray()
        try {
            val bonded = bluetoothAdapter?.bondedDevices ?: emptySet()
            for (device in bonded) {
                val obj = JSONObject()
                obj.put("name", device.name ?: "Unknown")
                obj.put("address", device.address)
                list.put(obj)
            }
        } catch (e: SecurityException) {
            // Permission missing
        }
        return list.toString()
    }

    /**
     * Connects to a Bluetooth thermal printer.
     * If address is null or blank, auto-connects to the single paired printer
     * or prompts user on the UI thread.
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
            res.put("error", "Bluetooth is disabled. Please turn on Bluetooth in Android Settings.")
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
            res.put("error", "No paired Bluetooth devices found. Pair the printer in Android Settings first.")
            return res.toString()
        }

        // 1. If explicit address given, connect to it
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

        // 2. Filter for devices that match known printer name prefixes
        val matchingPrinters = bondedDevices.filter { device ->
            val name = try { device.name ?: "" } catch (_: SecurityException) { "" }
            PRINTER_PREFIXES.any { prefix -> name.startsWith(prefix, ignoreCase = true) }
        }

        // If exactly one printer matches, auto-connect immediately
        if (matchingPrinters.size == 1) {
            return connectToDevice(matchingPrinters.first())
        }

        // 3. If multiple devices or no prefix matches, show picker on UI thread
        val candidates = if (matchingPrinters.isNotEmpty()) matchingPrinters else bondedDevices.toList()
        val latch = CountDownLatch(1)
        var selectedDevice: BluetoothDevice? = null

        activity.runOnUiThread {
            val names = candidates.map {
                val n = try { it.name ?: "Unknown" } catch (_: SecurityException) { "Unknown" }
                "$n (${it.address})"
            }.toTypedArray()

            AlertDialog.Builder(activity)
                .setTitle("Select Bluetooth Thermal Printer")
                .setItems(names) { _, which ->
                    selectedDevice = candidates[which]
                    latch.countDown()
                }
                .setNegativeButton("Cancel") { _, _ ->
                    latch.countDown()
                }
                .setCancelable(false)
                .show()
        }

        try {
            latch.await(30, TimeUnit.SECONDS)
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

        var socket: BluetoothSocket? = null
        var lastErr: Exception? = null

        // Try standard SPP UUID first
        try {
            socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
            socket.connect()
        } catch (e: Exception) {
            lastErr = e
            // Fallback: reflection on createRfcommSocket(channel 1)
            // Fixes older Chinese thermal printers whose SDP records don't report SPP
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

        if (socket != null && socket.isConnected) {
            activeSocket = socket
            activeOutputStream = socket.outputStream
            connectedDeviceName = try { device.name ?: "Bluetooth Printer" } catch (_: SecurityException) { "Bluetooth Printer" }
            connectedDeviceAddress = device.address

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

        val res = JSONObject()
        res.put("ok", true)
        return res.toString()
    }

    @JavascriptInterface
    fun getConnectedDeviceName(): String? {
        return connectedDeviceName
    }
}
