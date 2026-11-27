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
import android.bluetooth.le.BluetoothLeScanner
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
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

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
        private const val MAX_WRITE_QUEUE = 16
        private const val BLE_CONNECT_TIMEOUT_MS = 12_000L
        const val REQ_PERMISSION = 1004
    }

    private data class Candidate(
        val address: String,
        val name: String,
        val mode: String, // "ble" or "spp"
        val recommended: Boolean
    )

    private val main = Handler(Looper.getMainLooper())
    private val bluetoothManager: BluetoothManager? =
        activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter?
        @Suppress("DEPRECATION")
        get() = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()

    private val ioExec: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "pb-esp32-io").also { it.isDaemon = true }
    }
    private val connExec: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "pb-esp32-conn").also { it.isDaemon = true }
    }
    private val writeLock = Any()
    private val writeQueueLock = Any()
    private val writeQueue = ArrayDeque<String>()
    private val writeDrainScheduled = AtomicBoolean(false)
    private val gattWriteDone = Semaphore(0)
    private val rxBuf = StringBuilder()
    private val connectGen = AtomicInteger(0)

    @Volatile private var connected = false
    @Volatile private var currentMode = ""
    @Volatile private var currentAddress = ""
    @Volatile private var currentName = ""
    @Volatile private var consecutiveWriteTimeouts = 0

    // BLE state
    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private var rxChar: BluetoothGattCharacteristic? = null
    @Volatile private var txChar: BluetoothGattCharacteristic? = null
    @Volatile private var bleChunkSize = 20
    @Volatile private var connectTimeoutTask: Runnable? = null

    // Classic SPP state
    @Volatile private var sppSocket: BluetoothSocket? = null
    @Volatile private var sppConnectingSocket: BluetoothSocket? = null
    @Volatile private var sppOut: OutputStream? = null
    @Volatile private var sppReaderThread: Thread? = null
    @Volatile private var sppStopRequested = false

    @Volatile private var scanning = false
    @Volatile private var activeScanner: BluetoothLeScanner? = null
    @Volatile private var activeScanCb: ScanCallback? = null
    @Volatile private var shuttingDown = false
    @Volatile private var pendingPickAfterPerm = false
    private var linkReceiver: BroadcastReceiver? = null

    init {
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (shuttingDown) return
                val i = intent ?: return
                val act = i.action ?: return
                if (act == BluetoothAdapter.ACTION_STATE_CHANGED) {
                    val st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1)
                    if (st == BluetoothAdapter.STATE_OFF || st == BluetoothAdapter.STATE_TURNING_OFF) {
                        handleLinkLost("Bluetooth was turned off.")
                    }
                    return
                }
                if (act == BluetoothDevice.ACTION_ACL_DISCONNECTED) {
                    @Suppress("DEPRECATION")
                    val d: BluetoothDevice = (if (Build.VERSION.SDK_INT >= 33) {
                        i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                    } else {
                        i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                    }) ?: return
                    val addr = d.address ?: return
                    if (connected && addr.equals(currentAddress, ignoreCase = true)) {
                        handleLinkLost("ESP32 Bluetooth connection lost.")
                    }
                }
            }
        }
        try {
            val f = IntentFilter().apply {
                addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
                addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            }
            if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED)
            else activity.registerReceiver(rx, f)
            linkReceiver = rx
        } catch (_: Exception) {}
    }

    private fun emit(obj: JSONObject) {
        if (shuttingDown || activity.isFinishing || activity.isDestroyed) return
        val js = "window.__Esp32Event && window.__Esp32Event(" + JSONObject.quote(obj.toString()) + ");"
        try {
            activity.runOnUiThread {
                if (shuttingDown || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                try { webView.evaluateJavascript(js, null) } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
    }

    private fun emitError(msg: String, silent: Boolean = false) {
        val o = JSONObject().put("type", "error").put("error", msg)
        if (silent) o.put("silent", true)
        emit(o)
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
            try {
                ActivityCompat.requestPermissions(activity, perms, REQ_PERMISSION)
            } catch (_: Exception) {
                pendingPickAfterPerm = false
                emitError("Allow Nearby devices (Bluetooth) for photobooth4u, then tap Connect again.")
            }
        }
    }

    fun onPermissionResult(granted: Boolean) {
        val shouldPick = pendingPickAfterPerm
        pendingPickAfterPerm = false
        if (granted && hasPermission()) {
            if (shouldPick) pick()
        } else {
            emitError("Allow Nearby devices (Bluetooth) for photobooth4u, then tap Connect again.")
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
            pendingPickAfterPerm = true
            askPermission()
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
                val rawName = try { dev.name ?: result.scanRecord?.deviceName } catch (_: Exception) { null }
                val hasNus = try {
                    result.scanRecord?.serviceUuids?.any { it.uuid == NUS_SERVICE_UUID } == true
                } catch (_: Exception) { false }
                if (rawName.isNullOrBlank() && !hasNus) return
                val nm = if (!rawName.isNullOrBlank()) rawName else "ESP32 ($addr)"
                val rec = hasNus || matchesEsp32Name(nm)
                synchronized(bleFound) {
                    val prev = bleFound[addr]
                    if (prev == null || (rec && !prev.recommended) || (prev.name.startsWith("ESP32 (") && !rawName.isNullOrBlank())) {
                        bleFound[addr] = Candidate(addr, nm, "ble", rec)
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                // Keep going so already-paired Classic SPP devices are still offered.
            }
        }

        activeScanner = scanner
        activeScanCb = scanCb
        try {
            scanner.startScan(
                null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                scanCb
            )
        } catch (_: Exception) {
            scanning = false
            activeScanner = null
            activeScanCb = null
            showPickerDialog(pairedList, bleFound)
            return
        }

        main.postDelayed({
            try { scanner.stopScan(scanCb) } catch (_: Exception) {}
            if (activeScanCb === scanCb) {
                activeScanner = null
                activeScanCb = null
            }
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
                    scheduleConnect(picked.address, picked.name, picked.mode, allowFallback = true, silent = false)
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
        scheduleConnect(address, name, mode, allowFallback = true, silent = false)
    }

    @JavascriptInterface
    fun connectSaved(): Boolean {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val addr = prefs.getString(KEY_ADDR, "") ?: ""
        if (addr.isEmpty()) return false
        val ad = adapter ?: return false
        if (!hasPermission() || !ad.isEnabled) return false
        if (connected && addr.equals(currentAddress, ignoreCase = true)) return true
        val name = prefs.getString(KEY_NAME, addr) ?: addr
        val mode = prefs.getString(KEY_MODE, "ble") ?: "ble"
        scheduleConnect(addr, name, mode, allowFallback = true, silent = true)
        return true
    }

    private fun coalesceKey(cmd: String): String? = when {
        cmd.startsWith("credit{") -> "credit"
        cmd.startsWith("price{") -> "price"
        cmd == "session_idle" -> "session_idle"
        else -> null
    }

    @JavascriptInterface
    fun write(line: String): Boolean {
        val trimmed = line.trimEnd('\r', '\n')
        if (trimmed.isEmpty() || !connected || shuttingDown) return false
        if (currentMode != "spp" && currentMode != "ble") return false

        synchronized(writeQueueLock) {
            val key = coalesceKey(trimmed)
            if (key != null && writeQueue.isNotEmpty()) {
                val it = writeQueue.iterator()
                while (it.hasNext()) {
                    if (coalesceKey(it.next()) == key) it.remove()
                }
            }
            while (writeQueue.size >= MAX_WRITE_QUEUE) {
                writeQueue.pollFirst()
            }
            writeQueue.addLast(trimmed)
        }
        scheduleWriteDrain()
        return true
    }

    private fun scheduleWriteDrain() {
        if (shuttingDown) return
        if (!writeDrainScheduled.compareAndSet(false, true)) return
        try {
            ioExec.execute {
                try {
                    drainWriteQueue()
                } finally {
                    writeDrainScheduled.set(false)
                    val hasMore = synchronized(writeQueueLock) { writeQueue.isNotEmpty() }
                    if (hasMore && connected && !shuttingDown) scheduleWriteDrain()
                }
            }
        } catch (_: Exception) {
            writeDrainScheduled.set(false)
        }
    }

    private fun drainWriteQueue() {
        while (connected && !shuttingDown) {
            val nextCmd = synchronized(writeQueueLock) { writeQueue.pollFirst() } ?: return
            val payload = (nextCmd + "\n").toByteArray(StandardCharsets.UTF_8)
            val mode = currentMode
            if (mode == "spp") {
                val out = sppOut ?: return
                synchronized(writeLock) {
                    try {
                        out.write(payload)
                        out.flush()
                    } catch (_: Exception) {
                        handleLinkLost("ESP32 Bluetooth SPP connection lost.")
                        return
                    }
                }
            } else if (mode == "ble") {
                val g = gatt ?: return
                val ch = rxChar ?: return
                writeBleBytes(g, ch, payload)
            } else {
                return
            }
        }
    }

    @JavascriptInterface
    fun disconnect() {
        connectGen.incrementAndGet()
        try {
            connExec.execute {
                closeActiveConnection(emitEvent = true, reason = "Disconnected")
            }
        } catch (_: Exception) {
            closeActiveConnection(emitEvent = true, reason = "Disconnected")
        }
    }

    fun shutdown() {
        shuttingDown = true
        connectGen.incrementAndGet()
        main.removeCallbacksAndMessages(null)
        try {
            val sc = activeScanner
            val cb = activeScanCb
            activeScanner = null
            activeScanCb = null
            scanning = false
            if (sc != null && cb != null) sc.stopScan(cb)
        } catch (_: Exception) {}
        try { linkReceiver?.let { activity.unregisterReceiver(it) } } catch (_: Exception) {}
        linkReceiver = null
        closeActiveConnection(emitEvent = false, reason = "")
        try { connExec.shutdownNow() } catch (_: Exception) {}
        try { ioExec.shutdownNow() } catch (_: Exception) {}
    }

    // ---- Internal Connection Management ----

    private fun scheduleConnect(address: String, name: String, preferredMode: String, allowFallback: Boolean, silent: Boolean) {
        if (shuttingDown) return
        val gen = connectGen.incrementAndGet()
        try {
            connExec.execute {
                if (shuttingDown || gen != connectGen.get()) return@execute
                connectInternal(gen, address, name, preferredMode, allowFallback, silent)
            }
        } catch (_: Exception) {}
    }

    private fun connectInternal(gen: Int, address: String, name: String, preferredMode: String, allowFallback: Boolean, silent: Boolean) {
        val ad = adapter
        if (ad == null) {
            emitError("This tablet does not have Bluetooth.", silent)
            return
        }
        if (!hasPermission()) {
            pendingPickAfterPerm = false
            if (!silent) askPermission()
            return
        }
        if (!ad.isEnabled) {
            emitError("Bluetooth is turned off.", silent)
            return
        }

        val dev: BluetoothDevice = try {
            ad.getRemoteDevice(address)
        } catch (_: Exception) {
            emitError("Invalid Bluetooth address.", silent)
            return
        }

        val hadLink = gatt != null || sppSocket != null || sppConnectingSocket != null
        closeActiveConnection(emitEvent = false, reason = "")
        // Give Android/Huawei Bluetooth stack a brief settle window after closing a prior GATT/SPP handle
        // before opening a new one (prevents immediate GATT_ERROR 133 and client_if leaks).
        if (hadLink) {
            try { Thread.sleep(250) } catch (_: InterruptedException) { return }
        }
        if (shuttingDown || gen != connectGen.get()) return

        val resolvedName = try {
            val dn = dev.name
            if (!dn.isNullOrBlank()) dn else name
        } catch (_: Exception) { name }

        if (preferredMode == "spp") {
            connectSpp(gen, dev, resolvedName, allowFallback, silent)
        } else {
            connectBle(gen, dev, resolvedName, allowFallback, silent)
        }
    }

    private fun cancelConnectTimeout() {
        val t = connectTimeoutTask
        connectTimeoutTask = null
        if (t != null) main.removeCallbacks(t)
    }

    private fun closeActiveConnection(emitEvent: Boolean, reason: String) {
        val wasConnected = connected
        connected = false
        currentMode = ""
        currentAddress = ""
        currentName = ""
        consecutiveWriteTimeouts = 0
        cancelConnectTimeout()
        synchronized(rxBuf) { rxBuf.setLength(0) }
        synchronized(writeQueueLock) { writeQueue.clear() }

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
        val pendingSock = sppConnectingSocket
        sppConnectingSocket = null
        if (pendingSock != null) {
            try { pendingSock.close() } catch (_: Exception) {}
        }
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

    private fun connectBle(gen: Int, dev: BluetoothDevice, devName: String, allowFallback: Boolean, silent: Boolean) {
        activity.runOnUiThread {
            if (shuttingDown || gen != connectGen.get()) return@runOnUiThread
            try {
                bleChunkSize = 20
                consecutiveWriteTimeouts = 0
                cancelConnectTimeout()
                val timeoutRunnable = Runnable {
                    if (shuttingDown || gen != connectGen.get() || connected) return@Runnable
                    val stale = gatt
                    gatt = null
                    rxChar = null
                    txChar = null
                    if (stale != null) {
                        try { stale.disconnect() } catch (_: Exception) {}
                        try { stale.close() } catch (_: Exception) {}
                    }
                    if (allowFallback && isBonded(dev)) {
                        try { connExec.execute { if (!shuttingDown && gen == connectGen.get()) connectSpp(gen, dev, devName, allowFallback = false, silent = silent) } } catch (_: Exception) {}
                    } else {
                        emitError("Connection to $devName timed out.", silent)
                    }
                }
                connectTimeoutTask = timeoutRunnable
                main.postDelayed(timeoutRunnable, BLE_CONNECT_TIMEOUT_MS)

                gatt = dev.connectGatt(activity, false, object : BluetoothGattCallback() {
                    @Volatile private var servicesDiscovered = false
                    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                        if (g !== gatt || gen != connectGen.get()) {
                            try { g.close() } catch (_: Exception) {}
                            return
                        }
                        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                            servicesDiscovered = false
                            val mtuQueued = try { g.requestMtu(247) } catch (_: Exception) { false }
                            if (!mtuQueued) {
                                servicesDiscovered = true
                                g.discoverServices()
                            } else {
                                main.postDelayed({
                                    if (g === gatt && gen == connectGen.get() && !servicesDiscovered) {
                                        servicesDiscovered = true
                                        try { g.discoverServices() } catch (_: Exception) {}
                                    }
                                }, 1200)
                            }
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                            cancelConnectTimeout()
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
                                currentAddress = ""
                                synchronized(writeQueueLock) { writeQueue.clear() }
                                emitDisconnected("Bluetooth connection lost.")
                            } else if (allowFallback && isBonded(dev)) {
                                try { connExec.execute { if (!shuttingDown && gen == connectGen.get()) connectSpp(gen, dev, devName, allowFallback = false, silent = silent) } } catch (_: Exception) {}
                            } else {
                                emitError("Could not connect to $devName over BLE (status $status).", silent)
                            }
                        }
                    }

                    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                        if (g !== gatt || gen != connectGen.get()) return
                        if (status == BluetoothGatt.GATT_SUCCESS && mtu > 23) {
                            bleChunkSize = maxOf(20, minOf(240, mtu - 3))
                        }
                        if (!servicesDiscovered) {
                            servicesDiscovered = true
                            g.discoverServices()
                        }
                    }

                    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                        if (g !== gatt || gen != connectGen.get()) return
                        val svc = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(NUS_SERVICE_UUID) else null
                        val tx = svc?.getCharacteristic(NUS_TX_UUID)
                        val rx = svc?.getCharacteristic(NUS_RX_UUID)
                        if (svc == null || tx == null) {
                            cancelConnectTimeout()
                            try { g.disconnect() } catch (_: Exception) {}
                            try { g.close() } catch (_: Exception) {}
                            gatt = null
                            if (allowFallback && isBonded(dev)) {
                                try { connExec.execute { if (!shuttingDown && gen == connectGen.get()) connectSpp(gen, dev, devName, allowFallback = false, silent = silent) } } catch (_: Exception) {}
                            } else {
                                emitError("This device does not support Nordic UART Serial (NUS).", silent)
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
                        if (g !== gatt || gen != connectGen.get()) return
                        if (status == BluetoothGatt.GATT_SUCCESS) {
                            markBleConnected(dev.address, devName)
                        } else {
                            cancelConnectTimeout()
                            emitError("Connected to $devName, but failed to subscribe to ESP32 messages (status $status).", silent)
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
                cancelConnectTimeout()
                emitError("BLE connect error: " + (e.message ?: "unknown error"), silent)
            }
        }
    }

    private fun isBonded(dev: BluetoothDevice): Boolean = try {
        dev.bondState == BluetoothDevice.BOND_BONDED
    } catch (_: Exception) { false }

    private fun markBleConnected(address: String, name: String) {
        cancelConnectTimeout()
        consecutiveWriteTimeouts = 0
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
        val hasWriteRsp = (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
        val writeType = if (hasWriteRsp) {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        val waitMs = if (hasWriteRsp) 500L else 80L
        var linkFailed = false
        synchronized(writeLock) {
            var off = 0
            while (off < data.size && connected && g === gatt) {
                val end = minOf(off + bleChunkSize, data.size)
                val part = data.copyOfRange(off, end)
                gattWriteDone.drainPermits()
                var sent = false
                var tries = 0
                while (!sent && tries < 20 && connected && g === gatt) {
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
                if (!sent) {
                    consecutiveWriteTimeouts++
                    if (consecutiveWriteTimeouts >= 3) linkFailed = true
                    break
                }
                val acked = try { gattWriteDone.tryAcquire(waitMs, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { false }
                if (acked || !hasWriteRsp) {
                    consecutiveWriteTimeouts = 0
                } else {
                    consecutiveWriteTimeouts++
                    if (consecutiveWriteTimeouts >= 3) {
                        linkFailed = true
                        break
                    }
                }
                off = end
            }
        }
        if (linkFailed && connected && g === gatt) {
            handleLinkLost("ESP32 Bluetooth link stopped responding.")
        }
    }

    // ---- Classic Bluetooth SPP ----

    private fun connectSpp(gen: Int, dev: BluetoothDevice, devName: String, allowFallback: Boolean, silent: Boolean) {
        sppStopRequested = false
        Thread({
            try {
                if (shuttingDown || gen != connectGen.get()) return@Thread
                try { adapter?.cancelDiscovery() } catch (_: Exception) {}
                val sock: BluetoothSocket = try {
                    val s = dev.createRfcommSocketToServiceRecord(SPP_UUID)
                    sppConnectingSocket = s
                    s.connect()
                    s
                } catch (_: Exception) {
                    try { sppConnectingSocket?.close() } catch (_: Exception) {}
                    if (shuttingDown || sppStopRequested || gen != connectGen.get()) return@Thread
                    val s2 = dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                    sppConnectingSocket = s2
                    s2.connect()
                    s2
                } finally {
                    sppConnectingSocket = null
                }

                if (shuttingDown || sppStopRequested || gen != connectGen.get()) {
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
                while (!sppStopRequested && !shuttingDown && gen == connectGen.get() && sock.isConnected) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    feedIncomingBytes(buf, read)
                }
            } catch (e: Exception) {
                if (!connected && !sppStopRequested && gen == connectGen.get() && allowFallback) {
                    connectBle(gen, dev, devName, allowFallback = false, silent = silent)
                    return@Thread
                }
                if (!sppStopRequested && !shuttingDown && gen == connectGen.get()) {
                    if (!connected) {
                        emitError("Could not connect to $devName: " + (e.message ?: "connection failed"), silent)
                    }
                }
            } finally {
                sppConnectingSocket = null
                if (!sppStopRequested && connected && currentMode == "spp" && gen == connectGen.get()) {
                    handleLinkLost("ESP32 Bluetooth SPP disconnected.")
                }
            }
        }, "pb-esp32-spp").also { it.isDaemon = true }.start()
    }
}
