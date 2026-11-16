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
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * InstaxBridge: injected into the WebView as window.__InstaxBridge.
 *
 * Fujifilm INSTAX Link printers (WIDE, mini, SQUARE) talk Bluetooth Low Energy. Android's WebView has no Web Bluetooth,
 * so the booth page (protected/src/printer/instax.js) uses this class as its Bluetooth link. This class only moves bytes:
 * the printer's protocol (framing, chunks, status) is all in the page.
 *
 * Page -> app:   isAvailable(), pick(), connect(address), write(address, base64), disconnect(address)
 * App -> page:   window.__InstaxEvent({ type: 'picked' | 'connected' | 'data' | 'closed' | 'error', address, ... })
 *
 * pick() and connect() return at once ({"ok":true}); their result arrives as an event, so the page never freezes while
 * the tablet searches or links up. write() returns when every byte has been handed to the printer.
 *
 * Not yet tried on a real printer. This file was written without an Android build on hand.
 */
@SuppressLint("MissingPermission")
class InstaxBridge(
    private val activity: Activity,
    private val webView: WebView
) {
    private val svcUuid: UUID = UUID.fromString("70954782-2d83-473d-9e5f-81e1d02d5273")
    private val writeUuid: UUID = UUID.fromString("70954783-2d83-473d-9e5f-81e1d02d5273")
    private val notifyUuid: UUID = UUID.fromString("70954784-2d83-473d-9e5f-81e1d02d5273")
    private val cccdUuid: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter?
        get() = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private class Link(val address: String) {
        @Volatile var gatt: BluetoothGatt? = null
        @Volatile var writeCh: BluetoothGattCharacteristic? = null
        @Volatile var notifyCh: BluetoothGattCharacteristic? = null
        @Volatile var chunk: Int = 20
        @Volatile var ready: Boolean = false
        val writeDone = Semaphore(0)
        val lock = Any()
    }

    private val links = ConcurrentHashMap<String, Link>()
    private val writeExec: ExecutorService = Executors.newCachedThreadPool()

    // ---- helpers ----
    private fun emit(o: JSONObject) {
        val js = "window.__InstaxEvent && window.__InstaxEvent(" + o.toString() + ");"
        try { activity.runOnUiThread { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} } } catch (_: Exception) {}
    }

    private fun err(address: String, message: String) {
        emit(JSONObject().put("type", "error").put("address", address).put("message", message))
    }

    private fun ok(): String = JSONObject().put("ok", true).toString()

    private fun fail(message: String): String = JSONObject().put("ok", false).put("error", message).toString()

    private fun granted(p: String): Boolean =
        ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

    private fun hasPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            granted(Manifest.permission.BLUETOOTH_CONNECT) && granted(Manifest.permission.BLUETOOTH_SCAN)
        else
            granted(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun askPermission() {
        val p = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        else
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        activity.runOnUiThread { ActivityCompat.requestPermissions(activity, p, 1002) }
    }

    private fun picked(address: String, name: String): JSONObject =
        JSONObject().put("type", "picked").put("address", address).put("name", name)

    // ---- page -> app ----
    @JavascriptInterface
    fun isAvailable(): Boolean =
        adapter != null && activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)

    /** Looks for INSTAX printers for 5 seconds, then reports the one (or lets the operator choose between several). */
    @JavascriptInterface
    fun pick(): String = startPick(false)

    /** The same, but lists every Bluetooth device that has a name (for a printer that is not called INSTAX...). */
    @JavascriptInterface
    fun pickAll(): String = startPick(true)

    private fun startPick(all: Boolean): String {
        val ad = adapter ?: return fail("This tablet has no Bluetooth.")
        if (!hasPermission()) {
            askPermission()
            return fail("Allow Nearby devices (Bluetooth) for photobooth4u, then tap Connect again.")
        }
        if (!ad.isEnabled) return fail("Bluetooth is switched off. Switch it on, then tap Connect again.")
        val scanner = ad.bluetoothLeScanner ?: return fail("Bluetooth is not ready. Try again in a moment.")
        val found = LinkedHashMap<String, String>()   // address -> name
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val n: String = (try { result.device.name ?: result.scanRecord?.deviceName } catch (_: Exception) { null }) ?: return
                // An Instax is known by its name (INSTAX-...) or by the service it advertises; "all" lists anything with a name.
                val hasSvc = try { result.scanRecord?.serviceUuids?.any { it.uuid == svcUuid } == true } catch (_: Exception) { false }
                if (all || n.contains("instax", ignoreCase = true) || hasSvc) synchronized(found) { found[result.device.address] = n }
            }

            override fun onScanFailed(errorCode: Int) {
                err("", "The Bluetooth search failed (code $errorCode).")
            }
        }
        try {
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
        } catch (e: Exception) {
            return fail("Could not search for printers: " + (e.message ?: "unknown error"))
        }
        main.postDelayed({
            try { scanner.stopScan(cb) } catch (_: Exception) {}
            val list: List<Pair<String, String>> = synchronized(found) { found.entries.map { Pair(it.key, it.value) } }
            when {
                list.isEmpty() -> err("", if (all) "No Bluetooth devices found." else "No Instax printer found. Switch it on, keep it close, then try again. If it still is not found, use Show all Bluetooth devices.")
                list.size == 1 && !all -> emit(picked(list[0].first, list[0].second))
                else -> {
                    val items = list.map { it.second + " (" + it.first + ")" }.toTypedArray()
                    AlertDialog.Builder(activity)
                        .setTitle(if (all) "Which one is the Instax printer?" else "Which Instax printer?")
                        .setItems(items) { _, which -> emit(picked(list[which].first, list[which].second)) }
                        .setNegativeButton("Cancel") { _, _ -> err("", "Cancelled.") }
                        .setCancelable(true)
                        .show()
                }
            }
        }, 5000)
        return ok()
    }

    /** Links to a printer. The result arrives as a 'connected' (or 'error') event. */
    @JavascriptInterface
    fun connect(address: String): String {
        val ad = adapter ?: return fail("This tablet has no Bluetooth.")
        if (!hasPermission()) {
            askPermission()
            return fail("Allow Nearby devices (Bluetooth) for photobooth4u, then try again.")
        }
        if (!ad.isEnabled) return fail("Bluetooth is switched off. Switch it on, then try again.")
        val dev: BluetoothDevice = try { ad.getRemoteDevice(address) } catch (e: Exception) { return fail("That is not a Bluetooth address.") }
        closeLink(address)
        val link = Link(address)
        links[address] = link
        activity.runOnUiThread {
            try {
                link.gatt = dev.connectGatt(activity, false, callbackFor(link), BluetoothDevice.TRANSPORT_LE)
            } catch (e: Exception) {
                links.remove(address)
                err(address, "Could not connect: " + (e.message ?: "unknown error"))
            }
        }
        return ok()
    }

    /** Sends bytes to the printer, in pieces that fit one Bluetooth write. Returns when all of them are out. */
    @JavascriptInterface
    fun write(address: String, base64Data: String): String {
        val data: ByteArray = try { Base64.decode(base64Data, Base64.DEFAULT) } catch (e: Exception) { return fail("Bad data.") }
        val errMsg = writeBytes(address, data)
        return if (errMsg == null) ok() else fail(errMsg)
    }

    /** Non-blocking version of write(): returns at once and emits a 'written' event when finished. */
    @JavascriptInterface
    fun writeAsync(address: String, base64Data: String, reqId: String): String {
        val data: ByteArray = try { Base64.decode(base64Data, Base64.DEFAULT) } catch (e: Exception) { return fail("Bad data.") }
        val link = links[address] ?: return fail("The Instax printer is not connected.")
        if (!link.ready || link.writeCh == null || link.gatt == null) return fail("The Instax printer is not connected.")
        writeExec.execute {
            val errMsg = writeBytes(address, data)
            emit(
                JSONObject().put("type", "written").put("address", address).put("id", reqId)
                    .put("ok", errMsg == null).apply { if (errMsg != null) put("error", errMsg) }
            )
        }
        return ok()
    }

    private fun writeBytes(address: String, data: ByteArray): String? {
        val link = links[address] ?: return "The Instax printer is not connected."
        val ch = link.writeCh
        val g = link.gatt
        if (!link.ready || ch == null || g == null) return "The Instax printer is not connected."
        synchronized(link.lock) {
            var off = 0
            while (off < data.size) {
                val end = minOf(off + link.chunk, data.size)
                val part = data.copyOfRange(off, end)
                link.writeDone.drainPermits()
                var sent = false
                var tries = 0
                while (!sent && tries < 300) {
                    sent = writeOnce(g, ch, part)
                    if (!sent) {
                        tries++
                        try { Thread.sleep(5) } catch (_: InterruptedException) {}
                    }
                }
                if (!sent) return "Could not send to the Instax printer."
                if (!link.writeDone.tryAcquire(2, TimeUnit.SECONDS)) return "The Instax printer stopped answering."
                if (!link.ready) return "The Instax printer disconnected."
                off = end
            }
        }
        return null
    }

    @JavascriptInterface
    fun disconnect(address: String): String {
        closeLink(address)
        return ok()
    }

    // ---- inside ----
    private fun writeOnce(g: BluetoothGatt, ch: BluetoothGattCharacteristic, part: ByteArray): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, part, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                    ch.value = part
                    g.writeCharacteristic(ch)
                }
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun closeLink(address: String) {
        val link = links.remove(address) ?: return
        link.ready = false
        link.writeDone.release()
        val g = link.gatt ?: return
        try { g.disconnect() } catch (_: Exception) {}
        try { g.close() } catch (_: Exception) {}
    }

    private fun connected(link: Link) {
        link.ready = true
        emit(JSONObject().put("type", "connected").put("address", link.address).put("chunk", link.chunk))
    }

    private fun callbackFor(link: Link) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                // A bigger packet size makes the picture go over faster; the printer takes 182 data bytes per write.
                if (!g.requestMtu(185)) g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                val wasReady = link.ready
                link.ready = false
                try { g.close() } catch (_: Exception) {}
                if (links[link.address] === link) links.remove(link.address)
                link.writeDone.release()          // lets a write that is waiting give up
                if (wasReady) emit(JSONObject().put("type", "closed").put("address", link.address))
                else err(link.address, "Could not connect to the Instax printer (status $status). Switch it off and on, then try again.")
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            link.chunk = maxOf(20, minOf(182, mtu - 3))
            g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val svc = g.getService(svcUuid)
            val w = svc?.getCharacteristic(writeUuid)
            val n = svc?.getCharacteristic(notifyUuid)
            if (status != BluetoothGatt.GATT_SUCCESS || w == null || n == null) {
                err(link.address, "This Bluetooth device is not an Instax Link printer.")
                try { g.disconnect() } catch (_: Exception) {}
                return
            }
            link.writeCh = w
            link.notifyCh = n
            g.setCharacteristicNotification(n, true)
            val d = n.getDescriptor(cccdUuid)
            if (d == null) {
                connected(link)
                return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                run {
                    d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    g.writeDescriptor(d)
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) connected(link)
            else err(link.address, "Could not start listening to the Instax printer (status $status).")
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            link.writeDone.release()
        }

        // Android 13 and newer call this one ...
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            push(link, value)
        }

        // ... older Android calls this one.
        @Deprecated("Used on Android 12 and older")
        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                val v = characteristic.value ?: return
                push(link, v)
            }
        }
    }

    private fun push(link: Link, value: ByteArray) {
        emit(
            JSONObject().put("type", "data").put("address", link.address)
                .put("b64", Base64.encodeToString(value, Base64.NO_WRAP))
        )
    }

    fun shutdown() {
        for (a in links.keys.toList()) closeLink(a)
        try { writeExec.shutdownNow() } catch (_: Exception) {}
    }
}
