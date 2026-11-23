package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
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
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * Esp32Bridge: injected into WebView as window.__Esp32Bridge.
 *
 * Provides two-way serial communication between photobooth4u on Android Tablets and an ESP32
 * (Cash Acceptor + Relay Module + NeoPixel LEDs) over:
 *   1. BLE Nordic UART Service (6e400001-b5a3-f393-e0a9-e50e24dcca9e)
 *      - RX (App -> ESP32): 6e400002-b5a3-f393-e0a9-e50e24dcca9e
 *      - TX (ESP32 -> App): 6e400003-b5a3-f393-e0a9-e50e24dcca9e
 *   2. Classic Bluetooth SPP (00001101-0000-1000-8000-00805f9b34fb)
 *
 * Runs completely independently of BTBridge (thermal printers) and InstaxBridge so all devices
 * stay connected simultaneously without interference.
 */
@SuppressLint("MissingPermission")
class Esp32Bridge(
    private val activity: Activity,
    private val webView: WebView
) {
    companion object {
        private val NUS_SERVICE_UUID: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val NUS_RX_UUID: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val NUS_TX_UUID: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")

        private const val PREFS = "pb4u_esp32"
        private const val KEY_ADDR = "address"
        private const val KEY_NAME = "name"
        private const val KEY_MODE = "mode" // "ble" | "spp"
    }

    private data class Candidate(
        val address: String,
        val name: String,
        val mode: String, // "ble" or "spp"
        val recommended: Boolean
    )

    private val main = Handler(Looper.getMainLooper())
    private val bluetoothManager: BluetoothManager?
        get() = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter?
        @Suppress("DEPRECATION")
        get() = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()

    private val ioExec: ExecutorService = Executors.newSingleThreadExecutor()
    private val writeLock = Any()
    private val gattWriteDone = Semaphore(0)
    private val rxBuf = StringBuilder()

    @Volatile private var connected = false
    @Volatile private var currentMode = ""
    @Volatile private var currentAddress = ""
    @Volatile private var currentName = ""

    // BLE state
    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private var rxChar: BluetoothGattCharacteristic? = null
    @Volatile private var txChar: BluetoothGattCharacteristic? = null
    @Volatile private var bleChunkSize = 20

    // Classic SPP state
    @Volatile private var sppSocket: BluetoothSocket? = null
    @Volatile private var sppOut: OutputStream? = null
    @Volatile private var sppReaderThread: Thread? = null
    @Volatile private var sppStopRequested = false

    @Volatile private var scanning = false
    @Volatile private var shuttingDown = false

    private fun emit(obj: JSONObject) {
        if (shuttingDown) return
        val js = "window.__Esp32Event && window.__Esp32Event(" + JSONObject.quote(obj.toString()) + ");"
        try {
            activity.runOnUiThread {
                try { webView.evaluateJavascript(js, null) } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
    }

    private fun emitError(msg: String) {
        emit(JSONObject().put("type", "error").put("error", msg))
    }

    private fun emitDisconnected(reason: String) {
        emit(JSONObject().put("type", "disconnected").put("reason", reason))
    }

    private fun granted(p: String): Boolean =
        ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

    private fun hasPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            granted(Manifest.permission.BLUETOOTH_CONNECT) && granted(Manifest.permission.BLUETOOTH_SCAN)
        else
            granted(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun askPermission() {
        val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        else
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        activity.runOnUiThread {
            try { ActivityCompat.requestPermissions(activity, perms, 1004) } catch (_: Exception) {}
        }
    }

    private fun saveDevice(address: String, name: String, mode: String) {
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ADDR, address)
            .putString(KEY_NAME, name)
            .putString(KEY_MODE, mode)
            .apply()
    }

    private fun matchesEsp32Name(name: String): Boolean {
        val n = name.lowercase()
        return n.contains("photobooth") ||
            n.contains("pb4u") ||
            n.contains("pb-cash") ||
            n.contains("pbcash") ||
            n.contains("esp32") ||
            n.contains("cash") ||
            n.contains("relay") ||
            n.contains("neopixel") ||
            n.contains("uart") ||
            n.contains("nus") ||
            n.contains("booth")
    }

    // ---- JavaScript Interface ----

    @JavascriptInterface
    fun isAvailable(): Boolean = adapter != null

    @JavascriptInterface
    fun isEnabled(): Boolean = try { adapter?.isEnabled == true } catch (_: Exception) { false }

    @JavascriptInterface
    fun isConnected(): Boolean = connected

    @JavascriptInterface
    fun savedDevice(): String {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val addr = prefs.getString(KEY_ADDR, "") ?: ""
        if (addr.isEmpty()) return ""
        val name = prefs.getString(KEY_NAME, addr) ?: addr
        val mode = prefs.getString(KEY_MODE, "ble") ?: "ble"
        return JSONObject()
            .put("address", addr)
            .put("name", name)
            .put("mode", mode)
            .toString()
    }

    @JavascriptInterface
    fun pick() {
        val ad = adapter
        if (ad == null) {
            emitError("This tablet does not have Bluetooth.")
            return
        }
        if (!hasPermission()) {
            askPermission()
            emitError("Allow Nearby devices (Bluetooth) for photobooth4u, then tap Connect again.")
            return
        }
        if (!ad.isEnabled) {
            emitError("Bluetooth is turned off. Switch Bluetooth on, then tap Connect again.")
            return
        }
        if (scanning) return

        val pairedList = ArrayList<Candidate>()
        try {
            val bonded = ad.bondedDevices ?: emptySet()
            for (dev in bonded) {
                val nm = try { dev.name } catch (_: Exception) { null } ?: dev.address
                val addr = dev.address ?: continue
                pairedList.add(Candidate(addr, nm, "spp", matchesEsp32Name(nm)))
            }
        } catch (_: Exception) {}

        val bleFound = LinkedHashMap<String, Candidate>()
        val scanner = if (activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            ad.bluetoothLeScanner
        } else null

        if (scanner == null) {
            showPickerDialog(pairedList, bleFound)
            return
        }

        scanning = true
        val scanCb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val dev = result.device ?: return
                val addr = dev.address ?: return
                val nm = (try { dev.name ?: result.scanRecord?.deviceName } catch (_: Exception) { null }) ?: return
                val hasNus = try {
                    result.scanRecord?.serviceUuids?.any { it.uuid == NUS_SERVICE_UUID } == true
                } catch (_: Exception) { false }
                val rec = hasNus || matchesEsp32Name(nm)
                synchronized(bleFound) {
                    val prev = bleFound[addr]
                    if (prev == null || (rec && !prev.recommended)) {
                        bleFound[addr] = Candidate(addr, nm, "ble", rec)
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                // Keep going so already-paired Classic SPP devices are still offered.
            }
        }

        try {
            scanner.startScan(
                null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                scanCb
            )
        } catch (_: Exception) {
            scanning = false
            showPickerDialog(pairedList, bleFound)
            return
        }

        main.postDelayed({
            try { scanner.stopScan(scanCb) } catch (_: Exception) {}
            scanning = false
            showPickerDialog(pairedList, bleFound)
        }, 3500)
    }

    private fun showPickerDialog(pairedList: List<Candidate>, bleFound: Map<String, Candidate>) {
        if (shuttingDown || activity.isFinishing || activity.isDestroyed) return

        val ordered = ArrayList<Candidate>()
        val seen = HashSet<String>()

        // 1. Recommended BLE devices (NUS service or Photobooth/ESP32 name)
        val bleRec = synchronized(bleFound) { bleFound.values.filter { it.recommended } }
        for (c in bleRec) {
            if (seen.add("ble:" + c.address)) ordered.add(c)
        }

        // 2. Recommended Paired Classic BT devices
        for (c in pairedList.filter { it.recommended }) {
            if (seen.add("spp:" + c.address)) ordered.add(c)
        }

        // 3. Remaining paired devices (in case custom ESP32 name was used)
        for (c in pairedList.filter { !it.recommended }) {
            if (seen.add("spp:" + c.address)) ordered.add(c)
        }

        // 4. Other named BLE devices discovered nearby
        val bleOther = synchronized(bleFound) { bleFound.values.filter { !it.recommended } }
        for (c in bleOther) {
            if (seen.add("ble:" + c.address)) ordered.add(c)
        }

        activity.runOnUiThread {
            if (shuttingDown || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
            if (ordered.isEmpty()) {
                emitError("No ESP32 controller found nearby. Power on your ESP32 (Photobooth4u-Cash) and try again.")
                return@runOnUiThread
            }

            val labels = ordered.map { c ->
                val tag = if (c.mode == "ble") "BLE Serial" else "Classic BT"
                val star = if (c.recommended) "★ " else ""
                "$star${c.name} ($tag · ${c.address})"
            }.toTypedArray()

            AlertDialog.Builder(activity)
                .setTitle("Select ESP32 Controller")
                .setItems(labels) { _, idx ->
                    val picked = ordered[idx]
                    saveDevice(picked.address, picked.name, picked.mode)
                    connectInternal(picked.address, picked.name, picked.mode, allowFallback = true)
                }
                .setNegativeButton("Cancel") { _, _ ->
                    emitError("Cancelled.")
                }
                .setCancelable(true)
                .show()
        }
    }

    @JavascriptInterface
    fun connect(address: String) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val savedAddr = prefs.getString(KEY_ADDR, "") ?: ""
        val name = if (savedAddr.equals(address, ignoreCase = true)) {
            prefs.getString(KEY_NAME, address) ?: address
        } else {
            address
        }
        val mode = if (savedAddr.equals(address, ignoreCase = true)) {
            prefs.getString(KEY_MODE, "ble") ?: "ble"
        } else {
            "ble"
        }
        connectInternal(address, name, mode, allowFallback = true)
    }

    @JavascriptInterface
    fun connectSaved(): Boolean {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val addr = prefs.getString(KEY_ADDR, "") ?: ""
        if (addr.isEmpty()) return false
        val ad = adapter ?: return false
        if (!hasPermission() || !ad.isEnabled) return false
        val name = prefs.getString(KEY_NAME, addr) ?: addr
        val mode = prefs.getString(KEY_MODE, "ble") ?: "ble"
        connectInternal(addr, name, mode, allowFallback = true)
        return true
    }

    @JavascriptInterface
    fun write(line: String): Boolean {
        val trimmed = line.trimEnd('\r', '\n')
        if (trimmed.isEmpty()) return false
        val payload = (trimmed + "\n").toByteArray(StandardCharsets.UTF_8)

        if (!connected) return false

        if (currentMode == "spp") {
            val out = sppOut ?: return false
            ioExec.execute {
                synchronized(writeLock) {
                    try {
                        out.write(payload)
                        out.flush()
                    } catch (_: Exception) {
                        handleLinkLost("ESP32 Bluetooth SPP connection lost.")
                    }
                }
            }
            return true
        }

        if (currentMode == "ble") {
            val g = gatt ?: return false
            val ch = rxChar ?: return false
            ioExec.execute {
                writeBleBytes(g, ch, payload)
            }
            return true
        }

        return false
    }

    @JavascriptInterface
    fun disconnect() {
        closeActiveConnection(emitEvent = true, reason = "Disconnected")
    }

    fun shutdown() {
        shuttingDown = true
        closeActiveConnection(emitEvent = false, reason = "")
        try { ioExec.shutdownNow() } catch (_: Exception) {}
    }

    // ---- Internal Connection Management ----

    private fun connectInternal(address: String, name: String, preferredMode: String, allowFallback: Boolean) {
        val ad = adapter
        if (ad == null) {
            emitError("This tablet does not have Bluetooth.")
            return
        }
        if (!hasPermission()) {
            askPermission()
            emitError("Allow Nearby devices (Bluetooth) for photobooth4u, then tap Connect again.")
            return
        }
        if (!ad.isEnabled) {
            emitError("Bluetooth is turned off.")
            return
        }

        val dev: BluetoothDevice = try {
            ad.getRemoteDevice(address)
        } catch (_: Exception) {
            emitError("Invalid Bluetooth address.")
            return
        }

        closeActiveConnection(emitEvent = false, reason = "")

        val resolvedName = try {
            val dn = dev.name
            if (!dn.isNullOrBlank()) dn else name
        } catch (_: Exception) { name }

        if (preferredMode == "spp") {
            connectSpp(dev, resolvedName, allowFallback)
        } else {
            connectBle(dev, resolvedName, allowFallback)
        }
    }

    private fun closeActiveConnection(emitEvent: Boolean, reason: String) {
        val wasConnected = connected
        connected = false
        currentMode = ""
        currentAddress = ""
        currentName = ""
        synchronized(rxBuf) { rxBuf.setLength(0) }

        val g = gatt
        gatt = null
        rxChar = null
        txChar = null
        gattWriteDone.release()
        if (g != null) {
            try { g.disconnect() } catch (_: Exception) {}
            try { g.close() } catch (_: Exception) {}
        }

        sppStopRequested = true
        val sock = sppSocket
        sppSocket = null
        sppOut = null
        val t = sppReaderThread
        sppReaderThread = null
        if (sock != null) {
            try { sock.close() } catch (_: Exception) {}
        }
        try { t?.interrupt() } catch (_: Exception) {}

        if (emitEvent && wasConnected) {
            emitDisconnected(reason.ifEmpty { "Disconnected" })
        }
    }

    private fun handleLinkLost(reason: String) {
        if (!connected) return
        closeActiveConnection(emitEvent = true, reason = reason)
    }

    private fun feedIncomingBytes(bytes: ByteArray, len: Int) {
        val chunk = String(bytes, 0, len, StandardCharsets.UTF_8)
        val completedLines = ArrayList<String>()
        synchronized(rxBuf) {
            for (i in chunk.indices) {
                val c = chunk[i]
                if (c == '\n' || c == '\r' || c == ';') {
                    if (rxBuf.isNotEmpty()) {
                        completedLines.add(rxBuf.toString())
                        rxBuf.setLength(0)
                    }
                } else {
                    rxBuf.append(c)
                    if (rxBuf.length > 256) rxBuf.setLength(0)
                }
            }
        }
        for (line in completedLines) {
            emit(JSONObject().put("type", "line").put("line", line))
        }
    }

    // ---- BLE Nordic UART ----

    private fun connectBle(dev: BluetoothDevice, devName: String, allowFallback: Boolean) {
        activity.runOnUiThread {
            try {
                bleChunkSize = 20
                gatt = dev.connectGatt(activity, false, object : BluetoothGattCallback() {
                    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                        if (g !== gatt) {
                            try { g.close() } catch (_: Exception) {}
                            return
                        }
                        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                            if (!g.requestMtu(247)) {
                                g.discoverServices()
                            }
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                            val wasConnected = connected
                            try { g.close() } catch (_: Exception) {}
                            if (g === gatt) {
                                gatt = null
                                rxChar = null
                                txChar = null
                                connected = false
                                gattWriteDone.release()
                            }
                            if (wasConnected) {
                                currentMode = ""
                                emitDisconnected("Bluetooth connection lost.")
                            } else if (allowFallback && isBonded(dev)) {
                                connectSpp(dev, devName, allowFallback = false)
                            } else {
                                emitError("Could not connect to $devName over BLE (status $status).")
                            }
                        }
                    }

                    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                        if (g !== gatt) return
                        if (status == BluetoothGatt.GATT_SUCCESS && mtu > 23) {
                            bleChunkSize = maxOf(20, minOf(240, mtu - 3))
                        }
                        g.discoverServices()
                    }

                    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                        if (g !== gatt) return
                        val svc = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(NUS_SERVICE_UUID) else null
                        val tx = svc?.getCharacteristic(NUS_TX_UUID)
                        val rx = svc?.getCharacteristic(NUS_RX_UUID)
                        if (svc == null || tx == null) {
                            try { g.disconnect() } catch (_: Exception) {}
                            try { g.close() } catch (_: Exception) {}
                            gatt = null
                            if (allowFallback && isBonded(dev)) {
                                connectSpp(dev, devName, allowFallback = false)
                            } else {
                                emitError("This device does not support Nordic UART Serial (NUS).")
                            }
                            return
                        }
                        txChar = tx
                        rxChar = rx
                        g.setCharacteristicNotification(tx, true)
                        val cccd = tx.getDescriptor(CCCD_UUID)
                        if (cccd == null) {
                            markBleConnected(dev.address, devName)
                            return
                        }
                        val okDesc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                        } else {
                            @Suppress("DEPRECATION")
                            run {
                                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                g.writeDescriptor(cccd)
                            }
                        }
                        if (!okDesc) {
                            markBleConnected(dev.address, devName)
                        }
                    }

                    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                        if (g !== gatt) return
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            markBleConnected(dev.address, devName)
                        } else {
                            emitError("Connected to $devName, but failed to subscribe to ESP32 messages (status $status).")
                        }
                    }

                    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                        gattWriteDone.release()
                    }

                    override fun onCharacteristicChanged(
                        g: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic,
                        value: ByteArray
                    ) {
                        if (g === gatt) feedIncomingBytes(value, value.size)
                    }

                    @Deprecated("Used on Android 12 and older")
                    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
                    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && g === gatt) {
                            val v = characteristic.value ?: return
                            feedIncomingBytes(v, v.size)
                        }
                    }
                }, BluetoothDevice.TRANSPORT_LE)
            } catch (e: Exception) {
                emitError("BLE connect error: " + (e.message ?: "unknown error"))
            }
        }
    }

    private fun isBonded(dev: BluetoothDevice): Boolean = try {
        dev.bondState == BluetoothDevice.BOND_BONDED
    } catch (_: Exception) { false }

    private fun markBleConnected(address: String, name: String) {
        connected = true
        currentMode = "ble"
        currentAddress = address
        currentName = name
        saveDevice(address, name, "ble")
        emit(
            JSONObject()
                .put("type", "connected")
                .put("mode", "ble")
                .put("address", address)
                .put("name", name)
                .put("twoWay", rxChar != null)
        )
    }

    private fun writeBleBytes(g: BluetoothGatt, ch: BluetoothGattCharacteristic, data: ByteArray) {
        val supportsNoRsp = (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
        val writeType = if (supportsNoRsp) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        synchronized(writeLock) {
            var off = 0
            while (off < data.size && connected && g === gatt) {
                val end = minOf(off + bleChunkSize, data.size)
                val part = data.copyOfRange(off, end)
                gattWriteDone.drainPermits()
                var sent = false
                var tries = 0
                while (!sent && tries < 40 && connected && g === gatt) {
                    sent = try {
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
                    if (!sent) {
                        tries++
                        try { Thread.sleep(8) } catch (_: InterruptedException) { break }
                    }
                }
                if (!sent) break
                gattWriteDone.tryAcquire(1200, TimeUnit.MILLISECONDS)
                off = end
            }
        }
    }

    // ---- Classic Bluetooth SPP ----

    private fun connectSpp(dev: BluetoothDevice, devName: String, allowFallback: Boolean) {
        sppStopRequested = false
        Thread {
            try {
                try { adapter?.cancelDiscovery() } catch (_: Exception) {}
                val sock: BluetoothSocket = try {
                    val s = dev.createRfcommSocketToServiceRecord(SPP_UUID)
                    s.connect()
                    s
                } catch (_: Exception) {
                    val s2 = dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                    s2.connect()
                    s2
                }

                if (shuttingDown || sppStopRequested) {
                    try { sock.close() } catch (_: Exception) {}
                    return@Thread
                }

                sppSocket = sock
                sppOut = sock.outputStream
                connected = true
                currentMode = "spp"
                currentAddress = dev.address
                currentName = devName
                saveDevice(dev.address, devName, "spp")

                emit(
                    JSONObject()
                        .put("type", "connected")
                        .put("mode", "spp")
                        .put("address", dev.address)
                        .put("name", devName)
                        .put("twoWay", true)
                )

                val input: InputStream = sock.inputStream
                val buf = ByteArray(1024)
                val reader = Thread.currentThread()
                sppReaderThread = reader
                while (!sppStopRequested && !shuttingDown && sock.isConnected) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    feedIncomingBytes(buf, read)
                }
            } catch (e: Exception) {
                if (!connected && !sppStopRequested && allowFallback) {
                    connectBle(dev, devName, allowFallback = false)
                    return@Thread
                }
                if (!sppStopRequested && !shuttingDown) {
                    if (!connected) {
                        emitError("Could not connect to $devName: " + (e.message ?: "connection failed"))
                    }
                }
            } finally {
                if (!sppStopRequested && connected && currentMode == "spp") {
                    handleLinkLost("ESP32 Bluetooth SPP disconnected.")
                }
            }
        }.start()
    }
}
