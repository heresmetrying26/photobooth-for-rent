package com.photobooth4u.booth

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * WebUSB for the tablet's WebView (window.__PBUsb).
 *
 * Android's WebView has no navigator.usb, so the booth's USB camera mode (Canon / Nikon / Sony over USB,
 * driven by the gPhoto2 WASM library) could not run in the app. This class is the native half: it talks to the
 * camera with UsbManager. assets/usb-shim.js is the page half: it builds navigator.usb on top of call().
 *
 * One entry point, call(callbackId, op, argsJson), keeps the transport swappable: the shim only knows
 * "send op + JSON, get a JSON answer back", so moving bulk data to the local web server later changes
 * this file and the shim's transport, not the booth. Answers go back through window.__pbUsbCb(id, ok, json).
 *
 * Device ids are UsbDevice.deviceName ("/dev/bus/usb/001/002"). Blocking USB calls run on a thread pool,
 * never on the WebView's JavaScript thread or the UI thread.
 */
class UsbBridge(private val activity: Activity, private val webView: WebView) {

    private val usb = activity.getSystemService(Context.USB_SERVICE) as UsbManager
    private val pool = Executors.newCachedThreadPool()
    private val connections = ConcurrentHashMap<String, UsbDeviceConnection>()
    private val claimed = ConcurrentHashMap<String, MutableSet<Int>>()
    private val pendingPermission = ConcurrentHashMap<String, (Boolean) -> Unit>()
    private var started = false

    // Camera log: the last LOG_MAX events as JSON lines, the same shape as the website's "photobooth4u camera log"
    // ({"t": ISO time, "kind": ..., ...}), with the raw error text so a failure says what Android actually returned.
    // Identical back-to-back entries (a frame retry loop) are folded into one with a count ("n").
    private val ring = ArrayDeque<JSONObject>()
    private var lastSig = ""
    private var lastRepeat = 1
    private val isoFormat = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }

    fun log(kind: String, vararg kv: Pair<String, Any?>) {
        val e = JSONObject()
        e.put("t", synchronized(isoFormat) { isoFormat.format(java.util.Date()) })
        e.put("kind", kind)
        for ((k, v) in kv) if (v != null) e.put(k, v)
        val sig = kind + "|" + kv.joinToString("|") { it.first + "=" + it.second }
        synchronized(ring) {
            if (sig == lastSig && ring.isNotEmpty()) {
                lastRepeat++
                ring.last().put("n", lastRepeat).put("lastT", e.getString("t"))
            } else {
                lastSig = sig
                lastRepeat = 1
                ring.addLast(e)
                while (ring.size > LOG_MAX) ring.removeFirst()
            }
        }
        Log.i(TAG, e.toString())
    }

    // The whole log, one JSON line per event, oldest first.
    fun logText(): String = synchronized(ring) { ring.joinToString("\n") { it.toString() } }

    // From the page (usb-shim.js): events only the page can see, such as calls its own checks refused.
    @JavascriptInterface
    fun logFromPage(kind: String, json: String) {
        try {
            val o = JSONObject(if (json.isEmpty()) "{}" else json)
            val kv = o.keys().asSequence().map { it to o.opt(it) }.toList().toTypedArray()
            log(kind, *kv)
        } catch (e: Exception) {
            log(kind, "raw" to json.take(300))
        }
    }

    private fun devInfo(d: UsbDevice) = arrayOf<Pair<String, Any?>>(
        "id" to d.deviceName, "vid" to hex(d.vendorId), "pid" to hex(d.productId), "name" to (d.productName ?: "")
    )

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val dev = deviceOf(i) ?: return
            when (i.action) {
                ACTION_PERMISSION -> {
                    val granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    log(if (granted) "usb-permission-granted" else "usb-permission-denied", *devInfo(dev))
                    pendingPermission.remove(dev.deviceName)?.invoke(granted)
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    log("usb-detach", *devInfo(dev))
                    closeDevice(dev.deviceName)
                    emit("disconnect", dev)
                }
            }
        }
    }

    // Registers the permission and unplug receivers. Safe to call more than once.
    fun start() {
        if (started) return
        started = true
        log("bridge-start", "android" to Build.VERSION.RELEASE, "sdk" to Build.VERSION.SDK_INT, "model" to Build.MODEL,
            "usbHost" to activity.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_USB_HOST))
        val f = IntentFilter().apply {
            addAction(ACTION_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(activity, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun shutdown() {
        if (started) {
            started = false
            try { activity.unregisterReceiver(receiver) } catch (e: Exception) { }
        }
        for (k in connections.keys.toList()) closeDevice(k)
        pool.shutdownNow()
    }

    // The activity was launched (or brought forward) by "camera plugged in": Android has already granted this app
    // access to that device, so tell the page the same way Chrome does.
    fun onAttachedIntent(i: Intent?) {
        if (i?.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return
        val dev = deviceOf(i) ?: return
        log("usb-attach", *devInfo(dev), "permission" to usb.hasPermission(dev))
        emit("connect", dev)
    }

    // ── JavaScript entry point ───────────────────────────────────────────────────────────────

    @JavascriptInterface
    fun call(cb: Int, op: String, argsJson: String) {
        pool.execute {
            try {
                val a = JSONObject(if (argsJson.isEmpty()) "{}" else argsJson)
                val out = when (op) {
                    "list" -> {
                        val all = usb.deviceList.values
                        val permitted = describeAll(onlyPermitted = true)
                        log("usb-list", "attached" to all.size, "permitted" to permitted.length(),
                            "devices" to all.joinToString(",") { hex(it.vendorId) + ":" + hex(it.productId) + (if (usb.hasPermission(it)) "+" else "-") })
                        JSONObject().put("devices", permitted)
                    }
                    "request" -> { request(cb, a.optJSONArray("filters")); return@execute }
                    "open" -> open(a.getString("id"))
                    "close" -> { closeDevice(a.getString("id")); JSONObject() }
                    "selectConfiguration" -> selectConfiguration(a.getString("id"), a.getInt("value"))
                    "claimInterface" -> claim(a.getString("id"), a.getInt("number"))
                    "releaseInterface" -> release(a.getString("id"), a.getInt("number"))
                    "selectAlternateInterface" -> selectAlt(a.getString("id"), a.getInt("number"), a.getInt("alt"))
                    "clearHalt" -> clearHalt(a.getString("id"), a.getString("direction"), a.getInt("endpoint"))
                    "reset" -> reset(a.getString("id"))
                    "transferIn" -> transferIn(a.getString("id"), a.getInt("endpoint"), a.getInt("length"))
                    "transferOut" -> transferOut(a.getString("id"), a.getInt("endpoint"), a.getString("data"))
                    "controlIn" -> control(a, true)
                    "controlOut" -> control(a, false)
                    else -> throw UsbErr("NotSupportedError", "Unknown USB operation: $op")
                }
                reply(cb, true, out)
            } catch (e: UsbErr) {
                log("usb-op-fail", "op" to op, "args" to briefArgs(argsJson), "errName" to e.name, "error" to (e.message ?: ""))
                reply(cb, false, JSONObject().put("name", e.name).put("message", e.message ?: ""))
            } catch (e: SecurityException) {
                log("usb-op-fail", "op" to op, "args" to briefArgs(argsJson), "errName" to "SecurityError", "error" to (e.message ?: ""), "exception" to e.javaClass.name)
                reply(cb, false, JSONObject().put("name", "SecurityError").put("message", e.message ?: "USB permission denied"))
            } catch (e: Exception) {
                Log.e(TAG, "$op failed", e)
                log("usb-op-fail", "op" to op, "args" to briefArgs(argsJson), "errName" to "NetworkError", "error" to (e.message ?: ""), "exception" to e.javaClass.name)
                reply(cb, false, JSONObject().put("name", "NetworkError").put("message", e.message ?: e.javaClass.simpleName))
            }
        }
    }

    // The call's arguments for the log, without the (possibly large) data payload.
    private fun briefArgs(argsJson: String): String = try {
        val o = JSONObject(argsJson)
        o.remove("data")
        o.toString().take(200)
    } catch (e: Exception) { "" }

    // ── Device list and permission ───────────────────────────────────────────────────────────

    // getDevices() only returns devices this app may already use, like Chrome's "already allowed" list.
    private fun describeAll(onlyPermitted: Boolean): JSONArray {
        val arr = JSONArray()
        for (d in usb.deviceList.values) {
            if (onlyPermitted && !usb.hasPermission(d)) continue
            arr.put(describe(d))
        }
        return arr
    }

    private fun request(cb: Int, filters: JSONArray?) {
        val matches = usb.deviceList.values.filter { matches(it, filters) }
        log("usb-request", "filters" to (filters?.toString() ?: ""), "attached" to usb.deviceList.size, "matching" to matches.size)
        if (matches.isEmpty()) {
            reply(cb, false, JSONObject().put("name", "NotFoundError").put("message", "No device selected."))
            return
        }
        if (matches.size == 1) {
            askPermission(cb, matches[0])
            return
        }
        // More than one camera or matching device: let the operator pick.
        val names = matches.map { (it.productName ?: "USB device") + " (" + hex(it.vendorId) + ":" + hex(it.productId) + ")" }.toTypedArray()
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Choose the USB camera")
                .setItems(names) { _, which -> pool.execute { askPermission(cb, matches[which]) } }
                .setOnCancelListener { reply(cb, false, JSONObject().put("name", "NotFoundError").put("message", "No device selected.")) }
                .show()
        }
    }

    private fun askPermission(cb: Int, d: UsbDevice) {
        if (usb.hasPermission(d)) {
            reply(cb, true, JSONObject().put("device", describe(d)))
            return
        }
        log("usb-permission-asked", *devInfo(d))
        pendingPermission[d.deviceName] = { granted ->
            if (granted) reply(cb, true, JSONObject().put("device", describe(d)))
            else reply(cb, false, JSONObject().put("name", "NotFoundError").put("message", "No device selected."))
        }
        // The system fills EXTRA_DEVICE and EXTRA_PERMISSION_GRANTED into this intent, so it has to be mutable.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(activity, 0, Intent(ACTION_PERMISSION).setPackage(activity.packageName), flags)
        usb.requestPermission(d, pi)
    }

    // WebUSB filter semantics: any filter that matches wins; within a filter every given field must match.
    private fun matches(d: UsbDevice, filters: JSONArray?): Boolean {
        if (filters == null || filters.length() == 0) return true
        for (i in 0 until filters.length()) {
            val f = filters.optJSONObject(i) ?: continue
            if (f.has("vendorId") && f.getInt("vendorId") != d.vendorId) continue
            if (f.has("productId") && f.getInt("productId") != d.productId) continue
            if (f.has("serialNumber") && f.getString("serialNumber") != safeSerial(d)) continue
            if (f.has("classCode") || f.has("subclassCode") || f.has("protocolCode")) {
                val ok = (d.deviceClass != 0 && classMatches(f, d.deviceClass, d.deviceSubclass, d.deviceProtocol)) ||
                    (0 until d.interfaceCount).any { n ->
                        val itf = d.getInterface(n)
                        classMatches(f, itf.interfaceClass, itf.interfaceSubclass, itf.interfaceProtocol)
                    }
                if (!ok) continue
            }
            return true
        }
        return false
    }

    private fun classMatches(f: JSONObject, c: Int, s: Int, p: Int): Boolean {
        if (f.has("classCode") && f.getInt("classCode") != c) return false
        if (f.has("subclassCode") && f.getInt("subclassCode") != s) return false
        if (f.has("protocolCode") && f.getInt("protocolCode") != p) return false
        return true
    }

    // ── Descriptors (what navigator.usb's USBDevice shows) ───────────────────────────────────

    private fun describe(d: UsbDevice): JSONObject {
        val o = JSONObject()
        o.put("id", d.deviceName)
        o.put("vendorId", d.vendorId)
        o.put("productId", d.productId)
        o.put("deviceClass", d.deviceClass)
        o.put("deviceSubclass", d.deviceSubclass)
        o.put("deviceProtocol", d.deviceProtocol)
        o.put("productName", d.productName ?: "")
        o.put("manufacturerName", d.manufacturerName ?: "")
        o.put("serialNumber", safeSerial(d))
        // Android does not expose bcdUSB; every camera we care about is USB 2.0 or newer.
        o.put("usbVersionMajor", 2); o.put("usbVersionMinor", 0); o.put("usbVersionSubminor", 0)
        val ver = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) d.version else "").split('.')
        o.put("deviceVersionMajor", ver.getOrNull(0)?.toIntOrNull() ?: 0)
        o.put("deviceVersionMinor", ver.getOrNull(1)?.toIntOrNull() ?: 0)
        o.put("deviceVersionSubminor", 0)
        val cfgs = JSONArray()
        for (ci in 0 until d.configurationCount) {
            val c = d.getConfiguration(ci)
            val byNumber = LinkedHashMap<Int, JSONArray>()
            for (ii in 0 until c.interfaceCount) {
                val itf = c.getInterface(ii)
                val alt = JSONObject()
                alt.put("alternateSetting", itf.alternateSetting)
                alt.put("interfaceClass", itf.interfaceClass)
                alt.put("interfaceSubclass", itf.interfaceSubclass)
                alt.put("interfaceProtocol", itf.interfaceProtocol)
                alt.put("interfaceName", itf.name ?: "")
                val eps = JSONArray()
                for (ei in 0 until itf.endpointCount) {
                    val e = itf.getEndpoint(ei)
                    eps.put(
                        JSONObject()
                            .put("endpointNumber", e.address and 0x0F)
                            .put("direction", if (e.direction == UsbConstants.USB_DIR_IN) "in" else "out")
                            .put("type", when (e.type) {
                                UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"
                                UsbConstants.USB_ENDPOINT_XFER_INT -> "interrupt"
                                UsbConstants.USB_ENDPOINT_XFER_ISOC -> "isochronous"
                                else -> "bulk"
                            })
                            .put("packetSize", e.maxPacketSize)
                    )
                }
                alt.put("endpoints", eps)
                byNumber.getOrPut(itf.id) { JSONArray() }.put(alt)
            }
            val interfaces = JSONArray()
            for ((num, alts) in byNumber) interfaces.put(JSONObject().put("interfaceNumber", num).put("alternates", alts))
            cfgs.put(
                JSONObject()
                    .put("configurationValue", c.id)
                    .put("configurationName", c.name ?: "")
                    .put("interfaces", interfaces)
            )
        }
        o.put("configurations", cfgs)
        return o
    }

    // Reading the serial needs permission on Android 10+; without it the device just has no serial.
    private fun safeSerial(d: UsbDevice): String =
        try { d.serialNumber ?: "" } catch (e: SecurityException) { "" }

    // ── Opening, claiming, resetting ─────────────────────────────────────────────────────────

    private fun find(id: String): UsbDevice =
        usb.deviceList[id] ?: throw UsbErr("NotFoundError", "The device was unplugged.")

    private fun conn(id: String): UsbDeviceConnection =
        connections[id] ?: throw UsbErr("InvalidStateError", "The device must be opened first.")

    private fun open(id: String): JSONObject {
        if (connections.containsKey(id)) return JSONObject()
        val d = find(id)
        if (!usb.hasPermission(d)) throw UsbErr("SecurityError", "Access denied: USB permission not granted.")
        val c = usb.openDevice(d) ?: throw UsbErr("NetworkError", "Unable to open the USB device.")
        connections[id] = c
        log("usb-open", *devInfo(d))
        return JSONObject()
    }

    private fun closeDevice(id: String) {
        val c = connections.remove(id) ?: return
        log("usb-close", "id" to id)
        val nums = claimed.remove(id)
        val d = usb.deviceList[id]
        if (d != null && nums != null) {
            for (n in nums.toList()) findInterface(d, n, null)?.let { try { c.releaseInterface(it) } catch (e: Exception) { } }
        }
        try { c.close() } catch (e: Exception) { }
    }

    private fun findInterface(d: UsbDevice, number: Int, alt: Int?): UsbInterface? {
        for (ci in 0 until d.configurationCount) {
            val c = d.getConfiguration(ci)
            for (ii in 0 until c.interfaceCount) {
                val itf = c.getInterface(ii)
                if (itf.id == number && (alt == null || itf.alternateSetting == alt)) return itf
            }
        }
        return null
    }

    // Cameras have one configuration and Android has already selected it; only switch when there is a real choice.
    private fun selectConfiguration(id: String, value: Int): JSONObject {
        val c = conn(id)
        val d = find(id)
        if (d.configurationCount <= 1) {
            log("usb-select-config", "id" to id, "value" to value, "skipped" to "only one configuration")
            return JSONObject()
        }
        for (ci in 0 until d.configurationCount) {
            val cfg = d.getConfiguration(ci)
            if (cfg.id == value) {
                if (!c.setConfiguration(cfg)) throw UsbErr("NetworkError", "setConfiguration($value) returned false")
                log("usb-select-config", "id" to id, "value" to value)
                return JSONObject()
            }
        }
        throw UsbErr("NotFoundError", "No such USB configuration: $value")
    }

    private fun claim(id: String, number: Int): JSONObject {
        val c = conn(id)
        val itf = findInterface(find(id), number, null) ?: throw UsbErr("NotFoundError", "No such interface: $number")
        // force = true detaches whatever kernel driver or system app holds the interface (the "another app is using the camera" case)
        val ok = c.claimInterface(itf, true)
        log(if (ok) "usb-claim" else "usb-claim-fail", "id" to id, "interface" to number, "class" to itf.interfaceClass,
            "endpoints" to itf.endpointCount, "permission" to (usb.deviceList[id]?.let { usb.hasPermission(it) }))
        if (!ok) throw UsbErr("NetworkError", "claimInterface($number) returned false (Android refused to hand over the interface: another app or the system may hold it)")
        claimed.getOrPut(id) { ConcurrentHashMap.newKeySet() }.add(number)
        return JSONObject()
    }

    private fun release(id: String, number: Int): JSONObject {
        val c = conn(id)
        val itf = findInterface(find(id), number, null) ?: return JSONObject()
        val ok = c.releaseInterface(itf)
        log("usb-release", "id" to id, "interface" to number, "ok" to ok)
        claimed[id]?.remove(number)
        return JSONObject()
    }

    private fun selectAlt(id: String, number: Int, alt: Int): JSONObject {
        val c = conn(id)
        val itf = findInterface(find(id), number, alt) ?: throw UsbErr("NotFoundError", "No such alternate setting.")
        if (!c.setInterface(itf)) throw UsbErr("NetworkError", "Unable to select alternate setting $alt.")
        return JSONObject()
    }

    // Android has no clearHalt call, so send the standard CLEAR_FEATURE(ENDPOINT_HALT) request ourselves.
    private fun clearHalt(id: String, direction: String, endpoint: Int): JSONObject {
        val addr = endpoint or (if (direction == "in") UsbConstants.USB_DIR_IN else 0)
        val r = conn(id).controlTransfer(0x02, 0x01, 0, addr, null, 0, CONTROL_TIMEOUT_MS)
        if (r < 0) throw UsbErr("NetworkError", "Unable to clear the endpoint halt.")
        return JSONObject()
    }

    private fun reset(id: String): JSONObject {
        val c = conn(id)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw UsbErr("NotSupportedError", "Resetting a USB device needs Android 10 or newer.")
        val ok = c.resetDevice()
        log("usb-reset", "id" to id, "ok" to ok)
        if (!ok) throw UsbErr("NetworkError", "resetDevice() returned false")
        return JSONObject()
    }

    // ── Transfers ────────────────────────────────────────────────────────────────────────────

    private fun endpointOf(id: String, endpoint: Int, dir: Int) =
        findEndpoint(find(id), endpoint, dir) ?: throw UsbErr("NotFoundError", "No such endpoint: $endpoint")

    private fun findEndpoint(d: UsbDevice, number: Int, dir: Int): android.hardware.usb.UsbEndpoint? {
        for (ci in 0 until d.configurationCount) {
            val c = d.getConfiguration(ci)
            for (ii in 0 until c.interfaceCount) {
                val itf = c.getInterface(ii)
                for (ei in 0 until itf.endpointCount) {
                    val e = itf.getEndpoint(ei)
                    if ((e.address and 0x0F) == number && e.direction == dir) return e
                }
            }
        }
        return null
    }

    // Older Android versions cap one bulk transfer at 16 KB, so move big transfers in chunks. Timeout 0 = wait
    // as long as it takes (the camera's event endpoint just sits there until something happens); closing the
    // device or unplugging it makes a waiting call return.
    private fun transferIn(id: String, endpoint: Int, length: Int): JSONObject {
        val c = conn(id)
        val ep = endpointOf(id, endpoint, UsbConstants.USB_DIR_IN)
        val out = ByteArray(length)
        var got = 0
        while (got < length) {
            val want = minOf(CHUNK, length - got)
            val chunk = ByteArray(want)
            val t0 = System.currentTimeMillis()
            val n = c.bulkTransfer(ep, chunk, want, 0)
            if (n < 0) {
                log("usb-transfer-fail", "dir" to "in", "endpoint" to endpoint, "epType" to ep.type, "wanted" to want, "got" to got,
                    "result" to n, "afterMs" to (System.currentTimeMillis() - t0), "stillAttached" to usb.deviceList.containsKey(id))
                if (got > 0) break
                throw UsbErr("NetworkError", "bulkTransfer(in, ep $endpoint) returned $n after ${System.currentTimeMillis() - t0} ms (the camera may have been unplugged or gone to sleep)")
            }
            System.arraycopy(chunk, 0, out, got, n)
            got += n
            // A short packet ends the transfer, like on a real host controller.
            if (n < want || (ep.maxPacketSize > 0 && n % ep.maxPacketSize != 0)) break
        }
        return JSONObject().put("status", "ok").put("data", Base64.encodeToString(out, 0, got, Base64.NO_WRAP))
    }

    private fun transferOut(id: String, endpoint: Int, dataB64: String): JSONObject {
        val c = conn(id)
        val ep = endpointOf(id, endpoint, UsbConstants.USB_DIR_OUT)
        val data = Base64.decode(dataB64, Base64.DEFAULT)
        var sent = 0
        // An empty transfer still has to go out once (a zero-length packet ends a bulk transfer).
        do {
            val want = minOf(CHUNK, data.size - sent)
            val chunk = if (sent == 0 && want == data.size) data else data.copyOfRange(sent, sent + want)
            val t0 = System.currentTimeMillis()
            val n = c.bulkTransfer(ep, chunk, want, OUT_TIMEOUT_MS)
            if (n < 0) {
                log("usb-transfer-fail", "dir" to "out", "endpoint" to endpoint, "epType" to ep.type, "wanted" to want, "sent" to sent,
                    "result" to n, "afterMs" to (System.currentTimeMillis() - t0), "stillAttached" to usb.deviceList.containsKey(id))
                throw UsbErr("NetworkError", "bulkTransfer(out, ep $endpoint) returned $n after ${System.currentTimeMillis() - t0} ms (the camera may have been unplugged or gone to sleep)")
            }
            sent += n
        } while (sent < data.size)
        return JSONObject().put("status", "ok").put("bytesWritten", sent)
    }

    private fun control(a: JSONObject, isIn: Boolean): JSONObject {
        val c = conn(a.getString("id"))
        val type = when (a.getString("requestType")) { "standard" -> 0; "class" -> 1; "vendor" -> 2; else -> throw UsbErr("TypeError", "Bad requestType") }
        val recip = when (a.getString("recipient")) { "device" -> 0; "interface" -> 1; "endpoint" -> 2; "other" -> 3; else -> throw UsbErr("TypeError", "Bad recipient") }
        val reqType = (if (isIn) 0x80 else 0x00) or (type shl 5) or recip
        val request = a.getInt("request"); val value = a.getInt("value"); val index = a.getInt("index")
        if (isIn) {
            val len = a.getInt("length")
            val buf = ByteArray(len)
            val n = c.controlTransfer(reqType, request, value, index, buf, len, CONTROL_TIMEOUT_MS)
            if (n < 0) {
                log("usb-control-fail", "dir" to "in", "type" to type, "request" to request, "value" to value, "index" to index, "result" to n)
                throw UsbErr("NetworkError", "controlTransfer(in, request $request) returned $n")
            }
            return JSONObject().put("status", "ok").put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP))
        }
        val data = if (a.has("data")) Base64.decode(a.getString("data"), Base64.DEFAULT) else ByteArray(0)
        val n = c.controlTransfer(reqType, request, value, index, data, data.size, CONTROL_TIMEOUT_MS)
        if (n < 0) {
            log("usb-control-fail", "dir" to "out", "type" to type, "request" to request, "value" to value, "index" to index, "result" to n)
            throw UsbErr("NetworkError", "controlTransfer(out, request $request) returned $n")
        }
        return JSONObject().put("status", "ok").put("bytesWritten", n)
    }

    // ── Replies and events back to the page ──────────────────────────────────────────────────

    private fun reply(cb: Int, ok: Boolean, payload: JSONObject) {
        post("window.__pbUsbCb&&window.__pbUsbCb($cb,$ok,$payload)")
    }

    private fun emit(kind: String, d: UsbDevice) {
        val dev = try { describe(d) } catch (e: Exception) { JSONObject().put("id", d.deviceName) }
        post("window.__pbUsbEvent&&window.__pbUsbEvent('$kind',$dev)")
    }

    // JSON is valid JavaScript, except that U+2028 and U+2029 are line breaks there; escape them so a
    // device name can never break the script.
    private fun post(js: String) {
        val safe = js.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        webView.post { webView.evaluateJavascript(safe, null) }
    }

    @Suppress("DEPRECATION")
    private fun deviceOf(i: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else i.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private fun hex(v: Int) = String.format("%04x", v)

    private class UsbErr(val name: String, message: String) : Exception(message)

    companion object {
        private const val TAG = "PBUsb"
        private const val LOG_MAX = 500
        private const val ACTION_PERMISSION = "com.photobooth4u.booth.USB_PERMISSION"
        private const val CHUNK = 16384
        private const val OUT_TIMEOUT_MS = 30_000
        private const val CONTROL_TIMEOUT_MS = 5_000
    }
}
