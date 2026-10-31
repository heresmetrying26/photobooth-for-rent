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
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * NetPrintBridge — injected into the WebView as window.__PBNet.
 *
 * Finds printers on the booth Wi-Fi by itself (Bonjour/mDNS plus a quick sweep of the local network) and
 * prints to them directly, with no Android print dialog and no print-service app:
 *   - IPP (port 631): Epson, Canon, HP, Brother and other AirPrint / "IPP Everywhere" printers get the photo
 *     as a JPEG print job.
 *   - Raw (port 9100): receipt printers on the network (Epson TM etc.) get ESC/POS bytes the booth page builds.
 */
class NetPrintBridge(private val activity: Activity, private val webView: WebView) {

    companion object {
        private const val TAG = "PBNet"
        private val SERVICE_TYPES = arrayOf("_ipp._tcp.", "_printer._tcp.", "_pdl-datastream._tcp.")
        private const val SCAN_MS = 12_000L
    }

    private class Entry(val ip: String) {
        @Volatile var name: String = ""
        @Volatile var ippPort: Int = 0
        @Volatile var ippPath: String = ""
        @Volatile var rawPort: Int = 0
        @Volatile var model: String = ""                       // "EPSON L3250 Series", from the printer itself
        @Volatile var formats: List<String> = emptyList()      // document formats it says it can print
        @Volatile var attrsTried = false
        @Volatile var usbDev: UsbDevice? = null                // set for a printer on the USB port
    }

    private val found = ConcurrentHashMap<String, Entry>()
    private val nsd: NsdManager? = activity.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val pool = Executors.newFixedThreadPool(48)
    private val listeners = ArrayList<NsdManager.DiscoveryListener>()
    private val resolveLock = Any()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    @Volatile private var scanning = false
    @Volatile private var scanId = 0

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    /** Starts a fresh search; the page then polls list() for what turned up. */
    @JavascriptInterface
    fun scan(): String {
        stopDiscovery()
        found.clear()
        val id = ++scanId
        scanning = true
        startDiscovery()
        pool.execute { sweepSubnet() }
        Thread {
            try { Thread.sleep(SCAN_MS) } catch (_: InterruptedException) {}
            if (scanId == id) { stopDiscovery(); scanning = false }
        }.start()
        return "ok"
    }

    @JavascriptInterface
    fun list(): String {
        val arr = JSONArray()
        found.values
            .filter { it.ippPort > 0 || it.rawPort > 0 }
            .sortedWith(compareByDescending<Entry> { it.name.isNotBlank() }.thenBy { it.ip })
            .forEach {
                arr.put(JSONObject()
                    .put("id", it.ip)
                    .put("name", it.name.ifBlank { "Printer at ${it.ip}" })
                    .put("ip", it.ip)
                    .put("ipp", it.ippPort > 0)
                    .put("raw", it.rawPort > 0))
            }
        usbListInto(arr)
        return JSONObject().put("scanning", scanning).put("printers", arr).toString()
    }

    /** Adds a printer by its address when the search can't see it (different subnet, mDNS blocked…). */
    @JavascriptInterface
    fun addByIp(ip: String): String {
        val clean = ip.trim()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(clean)) return "bad"
        pool.execute { probe(clean) }
        return "ok"
    }

    /**
     * Prints JPEG pages over IPP. Result arrives later as window.__PBNetResult({job, ok, error}).
     * pagesJson: JSON array of base64 JPEGs, one per sheet; copies repeats the whole set.
     */
    @JavascriptInterface
    fun printIpp(job: String, ip: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val e = if (ip.startsWith("usb:")) usbEntry(ip) else found[ip] ?: Entry(ip).also { probeInto(it) }
                if (e.ippPort <= 0) throw IllegalStateException("This printer can't take photo print jobs from the tablet.")
                val arr = JSONArray(pagesJson)
                val pages = ArrayList<ByteArray>()
                for (i in 0 until arr.length()) pages.add(decode(arr.getString(i)))
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (p in pages) sendIppJob(e, job, p, widthMm, heightMm)
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "ipp print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't reach the printer.")
            }
            deliver(r)
        }
        return "started"
    }

    /** Sends raw bytes (ESC/POS) to port 9100. Result arrives as window.__PBNetResult. */
    @JavascriptInterface
    fun printRaw(job: String, ip: String, base64Data: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val data = Base64.decode(base64Data, Base64.DEFAULT)
                if (ip.startsWith("usb:")) usbRaw(ip, data)
                else Socket().use { s ->
                    s.connect(InetSocketAddress(ip, found[ip]?.rawPort?.takeIf { it > 0 } ?: 9100), 4000)
                    s.soTimeout = 15000
                    s.getOutputStream().apply { write(data); flush() }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "raw print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't reach the printer.")
            }
            deliver(r)
        }
        return "started"
    }

    private fun deliver(r: JSONObject) {
        val js = "window.__PBNetResult&&window.__PBNetResult(" + r.toString() + ")"
        activity.runOnUiThread { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
    }

    private fun decode(s0: String): ByteArray {
        var s = s0
        val comma = s.indexOf(',')
        if (s.startsWith("data:") && comma >= 0) s = s.substring(comma + 1)
        return Base64.decode(s, Base64.DEFAULT)
    }

    // ── Discovery ────────────────────────────────────────────────────────────

    private fun startDiscovery() {
        val mgr = nsd ?: return
        for (type in SERVICE_TYPES) {
            val l = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(t: String?) {}
                override fun onDiscoveryStopped(t: String?) {}
                override fun onStartDiscoveryFailed(t: String?, code: Int) { Log.w(TAG, "discovery start failed $t $code") }
                override fun onStopDiscoveryFailed(t: String?, code: Int) {}
                override fun onServiceLost(info: NsdServiceInfo?) {}
                override fun onServiceFound(info: NsdServiceInfo) { enqueueResolve(info) }
            }
            try {
                mgr.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l)
                synchronized(listeners) { listeners.add(l) }
            } catch (e: Exception) { Log.w(TAG, "discoverServices", e) }
        }
    }

    private fun stopDiscovery() {
        val mgr = nsd ?: return
        val copy = synchronized(listeners) { ArrayList(listeners).also { listeners.clear() } }
        for (l in copy) try { mgr.stopServiceDiscovery(l) } catch (_: Exception) {}
    }

    // NsdManager can only resolve one service at a time, so they wait in line.
    private fun enqueueResolve(info: NsdServiceInfo) {
        synchronized(resolveLock) { resolveQueue.addLast(info) }
        resolveNext()
    }

    @Suppress("DEPRECATION")
    private fun resolveNext() {
        val mgr = nsd ?: return
        val next: NsdServiceInfo
        synchronized(resolveLock) {
            if (resolving) return
            next = resolveQueue.removeFirstOrNull() ?: return
            resolving = true
        }
        val done = { synchronized(resolveLock) { resolving = false }; resolveNext() }
        try {
            mgr.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(i: NsdServiceInfo?, code: Int) { done() }
                override fun onServiceResolved(i: NsdServiceInfo) {
                    try { addResolved(i) } catch (e: Exception) { Log.w(TAG, "resolved", e) }
                    done()
                }
            })
        } catch (e: Exception) { done() }
    }

    @Suppress("DEPRECATION")
    private fun addResolved(i: NsdServiceInfo) {
        val addr = i.host as? Inet4Address ?: return        // keep to IPv4: that's what the sweep and sockets use
        val ip = addr.hostAddress ?: return
        val e = found.getOrPut(ip) { Entry(ip) }
        fun attr(k: String): String = try { String(i.attributes[k] ?: ByteArray(0)) } catch (_: Exception) { "" }
        val label = attr("ty").ifBlank { attr("product").trim('(', ')') }.ifBlank { i.serviceName ?: "" }
        if (label.isNotBlank()) e.name = label
        val type = i.serviceType ?: ""
        when {
            type.startsWith("_ipp") -> {
                e.ippPort = if (i.port > 0) i.port else 631
                val rp = attr("rp")
                if (rp.isNotBlank()) e.ippPath = "/" + rp.trimStart('/')
            }
            type.startsWith("_pdl-datastream") -> e.rawPort = if (i.port > 0) i.port else 9100
        }
        if (e.ippPort > 0) pool.execute { fetchAttrs(e) }
    }

    /** Looks for printer ports on every address of this tablet's local /24 networks. */
    private fun sweepSubnet() {
        val prefixes = HashSet<String>()
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in ni.inetAddresses) {
                    if (a is Inet4Address && a.isSiteLocalAddress) {
                        val p = a.hostAddress!!.substringBeforeLast('.')
                        prefixes.add(p)
                    }
                }
            }
        } catch (e: Exception) { Log.w(TAG, "interfaces", e) }
        for (p in prefixes) for (n in 1..254) {
            val ip = "$p.$n"
            pool.execute { if (scanning) probe(ip) }
        }
    }

    private fun open(ip: String, port: Int, timeoutMs: Int = 300): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(ip, port), timeoutMs); true }
    } catch (_: Exception) { false }

    private fun probe(ip: String) {
        val e = Entry(ip)
        probeInto(e)
        if (e.ippPort > 0 || e.rawPort > 0) {
            val cur = found.getOrPut(ip) { e }
            if (cur !== e) {
                if (cur.ippPort == 0) cur.ippPort = e.ippPort
                if (cur.rawPort == 0) cur.rawPort = e.rawPort
            }
            fetchAttrs(cur)
        }
    }

    private fun probeInto(e: Entry) {
        if (e.ippPort == 0 && open(e.ip, 631)) e.ippPort = 631
        if (e.rawPort == 0 && open(e.ip, 9100)) e.rawPort = 9100
    }

    // ── USB printers ─────────────────────────────────────────────────────────
    // A printer on the tablet's USB port shows up in list() as "usb:<device>". Two kinds can be printed to:
    //   - IPP-over-USB printers (class 7 / protocol 4, many newer Epson, Canon, HP, Brother): the same IPP job
    //     as over Wi-Fi, carried over the cable.
    //   - Receipt printers (Epson TM, Star, Bixolon, Xprinter…): ESC/POS bytes straight to the USB endpoint.
    // Anything else (e.g. Epson L120 / L210) is listed as "detected" but flagged noDriver: it needs a
    // per-model driver the app doesn't have.

    private val usb: UsbManager? = activity.getSystemService(Context.USB_SERVICE) as? UsbManager
    private val usbAsked = HashSet<String>()
    private val usbWaiters = ConcurrentHashMap<String, CountDownLatch>()
    private val usbEntries = ConcurrentHashMap<String, Entry>()
    private val usbPermAction = "com.photobooth4u.booth.USB_PRINTER_PERMISSION"
    private val thermalVendors = setOf(0x0519, 0x1504, 0x1d90, 0x0dd4, 0x0483, 0x0416, 0x28e9, 0x4b43, 0x0fe6, 0x1fc9, 0x6868)

    init {
        val rx = object : BroadcastReceiver() {
            @Suppress("DEPRECATION")
            override fun onReceive(c: Context?, i: Intent?) {
                val d = i?.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE) ?: return
                usbWaiters.remove(d.deviceName)?.countDown()
            }
        }
        val f = IntentFilter(usbPermAction)
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED)
        else activity.registerReceiver(rx, f)
    }

    private fun usbIfaces(d: UsbDevice): List<UsbInterface> = (0 until d.interfaceCount).map { d.getInterface(it) }
    private fun usbIsPrinter(d: UsbDevice) = usbIfaces(d).any { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER }
    private fun usbIppIface(d: UsbDevice) =
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol == 4 }
    private fun usbRawIface(d: UsbDevice) =
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol in 1..2 }

    private fun usbProduct(d: UsbDevice): String? =
        if (usb?.hasPermission(d) == true) try { d.productName?.trim()?.takeIf { it.isNotEmpty() } } catch (_: Exception) { null } else null

    private val escprCache = ConcurrentHashMap<String, Boolean>()

    /** The printer's IEEE-1284 device ID (e.g. "MFG:EPSON;CMD:ESCPL2,ESCPR1,...;MDL:L210 Series;"), asked over USB. */
    private fun usbDeviceId(d: UsbDevice): String? {
        val iface = usbRawIface(d) ?: return null
        val conn = usb?.openDevice(d) ?: return null
        try {
            // some printers only answer once the interface is claimed
            try { conn.claimInterface(iface, true) } catch (_: Exception) {}
            val buf = ByteArray(1024)
            // GET_DEVICE_ID: class request to the interface; wIndex = interface number << 8 | alternate setting.
            // wValue is the configuration index; try 0 first, then the usual 1-based forms.
            for (value in intArrayOf(0, 1)) {
                val n = conn.controlTransfer(0xA1, 0, value, (iface.id shl 8) or iface.alternateSetting, buf, buf.size, 2000)
                if (n > 2) return String(buf, 2, n - 2, Charsets.ISO_8859_1)
            }
            return null
        } finally {
            try { conn.releaseInterface(iface) } catch (_: Exception) {}
            conn.close()
        }
    }

    private val usbIds = ConcurrentHashMap<String, String>()

    /** Epson ink-tank models of the L120 / L210 era (L1xx, L2xx, L3xx, L5xx): they speak ESC/P-R over USB. */
    private fun epsonLSeries(name: String?): Boolean =
        name != null && Regex("""(?i)\bL\s?(1\d\d|2\d\d|3\d\d|5\d\d)\b""").containsMatchIn(name)

    /** True when the printer says it speaks Epson's ESC/P-R language (the family the L120 / L210 belong to). */
    private fun usbIsEscpr(d: UsbDevice): Boolean {
        if (usb?.hasPermission(d) != true) return false
        if (d.vendorId != 0x04b8) return false
        escprCache[d.deviceName]?.let { return it }
        val id = try { usbDeviceId(d) } catch (e: Exception) { Log.w(TAG, "device id", e); null }
        if (id != null) usbIds[d.deviceName] = id
        // Say it speaks ESC/P-R when its own ID says so, or (like PrinterShare / PrintHand) when the model is a
        // known Epson L-series name and the ID could not be read or does not list another language to use.
        val byId = id != null && Regex("CMD:[^;]*ESCPR", RegexOption.IGNORE_CASE).containsMatchIn(id)
        val byModel = epsonLSeries(usbProduct(d)) || (id != null && epsonLSeries(id))
        // When the printer's own ID can be read, trust only what it says; the model name is only the fallback
        // for an ID that cannot be read. (Sending ESC/P-R data to a printer that does not speak it prints text.)
        val ok = if (id != null) byId else byModel
        if (id != null) escprCache[d.deviceName] = ok
        return ok
    }

    /** True when the printer's own ID lists Epson's ESC/P2 language (CMD:ESCPL2) but not ESC/P-R: Epson L120 and kin. */
    private fun usbIsEscp2(d: UsbDevice): Boolean {
        if (d.vendorId != 0x04b8 || usb?.hasPermission(d) != true) return false
        val id = usbIds[d.deviceName] ?: return false
        return Regex("CMD:[^;]*ESCPL2", RegexOption.IGNORE_CASE).containsMatchIn(id) &&
            !Regex("CMD:[^;]*ESCPR", RegexOption.IGNORE_CASE).containsMatchIn(id)
    }

    /**
     * EXPERIMENTAL: prints JPEG pages in black and white to an Epson ESC/P2 USB printer (Epson L120 family).
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printEscp2(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                usbIsEscpr(d)                              // reads the printer's ID into the cache
                if (!usbIsEscp2(d)) throw IllegalStateException("This printer doesn't list Epson's ESC/P2 language, so the app won't send it that data.")
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        usbRaw(id, EscP2Job.build(bmp, widthMm, heightMm))
                    }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "escp2 print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print.")
            }
            deliver(r)
        }
        return "started"
    }

    /**
     * EXPERIMENTAL: prints JPEG pages to an Epson ESC/P-R USB printer (Epson L120 / L210 and similar).
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printEscpr(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                if (!usbIsEscpr(d)) throw IllegalStateException("This printer doesn't report Epson's ESC/P-R language, so the app won't send it that data.")
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        usbRaw(id, EscprJob.build(bmp, widthMm, heightMm, false))
                    }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "escpr print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print.")
            }
            deliver(r)
        }
        return "started"
    }

    private fun usbName(d: UsbDevice): String {
        val maker = when (d.vendorId) {
            0x04b8 -> "Epson"; 0x03f0 -> "HP"; 0x04a9 -> "Canon"; 0x04f9 -> "Brother"
            0x0519 -> "Star"; 0x1504 -> "Bixolon"; 0x1d90 -> "Citizen"; else -> ""
        }
        val prod = usbProduct(d) ?: return (if (maker.isEmpty()) "USB" else maker) + " printer"
        return if (maker.isNotEmpty() && !prod.contains(maker, true)) "$maker $prod" else prod
    }

    private fun usbLooksLikeReceipt(d: UsbDevice): Boolean =
        d.vendorId in thermalVendors ||
            (usbProduct(d)?.let { Regex("(?i)(^|[^a-z])tm[- ]?[a-z]?\\d|pos|receipt|thermal").containsMatchIn(it) } ?: false)

    private fun usbPermIntent(): PendingIntent = PendingIntent.getBroadcast(
        activity, 0, Intent(usbPermAction).setPackage(activity.packageName),
        if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    )

    private fun usbAsk(d: UsbDevice) {
        val m = usb ?: return
        if (!synchronized(usbAsked) { usbAsked.add(d.deviceName) }) return
        activity.runOnUiThread { try { m.requestPermission(d, usbPermIntent()) } catch (e: Exception) { Log.w(TAG, "usb permission", e) } }
    }

    /** Adds every plugged-in USB printer to the list (and asks Android for access the first time we see it). */
    private fun usbListInto(arr: JSONArray) {
        val m = usb ?: return
        for (d in m.deviceList.values) {
            if (!usbIsPrinter(d)) continue
            if (!m.hasPermission(d)) usbAsk(d)
            val ipp = usbIppIface(d) != null
            val raw = !ipp && usbRawIface(d) != null && usbLooksLikeReceipt(d)
            val escpr = !ipp && !raw && usbIsEscpr(d)
            val perm = m.hasPermission(d)
            val escp2 = !ipp && !raw && !escpr && usbIsEscp2(d)
            val id = "usb:" + d.deviceName
            arr.put(JSONObject()
                .put("id", id).put("ip", id).put("name", usbName(d) + " (USB)")
                .put("ipp", ipp).put("raw", raw).put("escpr", escpr).put("usb", true)
                .put("escp2", escp2)
                .put("noDriver", perm && !ipp && !raw && !escpr && !escp2)
                .put("needsPermission", !perm && !ipp && !raw)
                .put("info", (usbIds[d.deviceName] ?: "").take(300))
                .put("vid", d.vendorId).put("pid", d.productId))
        }
    }

    /** Asks Android for USB access again (the first prompt may have been dismissed or missed). */
    @JavascriptInterface
    fun usbAllow(id: String): String {
        val m = usb ?: return "none"
        val d = try { usbFind(id) } catch (e: Exception) { return "gone" }
        if (m.hasPermission(d)) return "granted"
        activity.runOnUiThread { try { m.requestPermission(d, usbPermIntent()) } catch (e: Exception) { Log.w(TAG, "usb permission", e) } }
        return "asked"
    }

    private fun usbFind(id: String): UsbDevice =
        usb?.deviceList?.values?.firstOrNull { "usb:" + it.deviceName == id }
            ?: throw IllegalStateException("The USB printer was unplugged. Plug it in and pick it again.")

    /** Blocks (up to 30 s) until Android's "allow this app to use the USB device?" prompt has been answered. */
    private fun usbEnsure(d: UsbDevice) {
        val m = usb ?: throw IllegalStateException("This tablet has no USB host support.")
        if (m.hasPermission(d)) return
        val latch = CountDownLatch(1)
        usbWaiters[d.deviceName] = latch
        activity.runOnUiThread { try { m.requestPermission(d, usbPermIntent()) } catch (_: Exception) { latch.countDown() } }
        latch.await(30, TimeUnit.SECONDS)
        if (!m.hasPermission(d)) throw IllegalStateException("USB access wasn't allowed. Unplug the printer, plug it in again and tap Allow.")
    }

    private fun usbEntry(id: String): Entry {
        val d = usbFind(id)
        usbEnsure(d)
        return usbEntries.getOrPut(id) { Entry(id) }.also {
            it.usbDev = d
            it.ippPort = if (usbIppIface(d) != null) 1 else 0
            if (it.name.isBlank()) it.name = usbName(d)
        }
    }

    private fun <T> usbSession(d: UsbDevice, iface: UsbInterface, block: (UsbDeviceConnection, UsbEndpoint, UsbEndpoint?) -> T): T {
        val conn = usb?.openDevice(d) ?: throw IllegalStateException("Couldn't open the USB printer.")
        try {
            if (!conn.claimInterface(iface, true)) throw IllegalStateException("The USB printer is busy. Unplug it, plug it in again and retry.")
            var out: UsbEndpoint? = null
            var inn: UsbEndpoint? = null
            for (i in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(i)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_OUT) { if (out == null) out = ep } else if (inn == null) inn = ep
            }
            if (out == null) throw IllegalStateException("The USB printer has no data port the app can use.")
            return block(conn, out, inn)
        } finally {
            try { conn.releaseInterface(iface) } catch (_: Exception) {}
            conn.close()
        }
    }

    private fun usbWrite(conn: UsbDeviceConnection, ep: UsbEndpoint, data: ByteArray) {
        var off = 0
        var stalls = 0
        while (off < data.size) {
            val r = conn.bulkTransfer(ep, data, off, minOf(16384, data.size - off), 20_000)
            if (r < 0) {
                // an inkjet's buffer fills while it prints: wait and retry a few times before giving up
                if (++stalls > 6) throw IllegalStateException("The USB printer stopped answering.")
                continue
            }
            stalls = 0
            off += r
        }
    }

    /** Receipt printers on USB: the ESC/POS bytes go straight to the printer. */
    private fun usbRaw(id: String, data: ByteArray) {
        val d = usbFind(id)
        usbEnsure(d)
        val iface = usbRawIface(d) ?: usbIfaces(d).firstOrNull { it.interfaceClass == 7 }
            ?: throw IllegalStateException("This USB device isn't a printer.")
        usbSession(d, iface) { conn, out, _ -> usbWrite(conn, out, data) }
    }

    /** One IPP request/response over IPP-over-USB: HTTP carried on the printer's bulk endpoints. */
    private fun usbPost(d: UsbDevice, path: String, body: ByteArray): Reply {
        val iface = usbIppIface(d) ?: throw IllegalStateException("This USB printer needs its own driver; the app can't print to it.")
        return usbSession(d, iface) { conn, out, inn ->
            if (inn == null) throw IllegalStateException("The USB printer has no reply port.")
            val head = "POST $path HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/ipp\r\nContent-Length: ${body.size}\r\n\r\n"
            usbWrite(conn, out, head.toByteArray(Charsets.ISO_8859_1) + body)
            val buf = ByteArrayOutputStream()
            val tmp = ByteArray(16384)
            val deadline = System.currentTimeMillis() + 90_000
            while (System.currentTimeMillis() < deadline) {
                val n = conn.bulkTransfer(inn, tmp, tmp.size, 3000)
                if (n > 0) buf.write(tmp, 0, n)
                if (buf.size() > 0 && httpComplete(buf.toByteArray())) break
            }
            if (buf.size() == 0) throw IllegalStateException("The USB printer didn't answer.")
            parseReply(buf.toByteArray())
        }
    }

    private fun httpComplete(b: ByteArray): Boolean {
        val t = String(b, Charsets.ISO_8859_1)
        val s = t.indexOf("\r\n\r\n")
        if (s < 0) return false
        val head = t.substring(0, s)
        val len = Regex("(?i)content-length:\\s*(\\d+)").find(head)?.groupValues?.get(1)?.toIntOrNull()
        if (len != null) return b.size - (s + 4) >= len
        if (head.contains("chunked", true)) return t.endsWith("0\r\n\r\n")
        return b.size - (s + 4) >= 4
    }

    // ── IPP ──────────────────────────────────────────────────────────────────

    private fun ippPaths(e: Entry): Set<String> {
        val paths = LinkedHashSet<String>()
        if (e.ippPath.isNotBlank()) paths.add(e.ippPath)
        paths.addAll(listOf("/ipp/print", "/ipp", "/"))
        return paths
    }

    /** Asks the printer who it is and which document formats it can print (IPP Get-Printer-Attributes). */
    private fun fetchAttrs(e: Entry) {
        if (e.attrsTried || e.ippPort <= 0) return
        e.attrsTried = true
        for (path in ippPaths(e)) {
            try {
                val r = doPost(e, path, ippGetAttributes(ippUri(e, path)))
                if (r.http != 200 || r.ipp !in 0..2) continue
                val formats = ArrayList<String>()
                var model = ""
                parseIpp(r.body) { name, tag, value ->
                    if (name == "document-format-supported" && tag == 0x49) formats.add(value.lowercase())
                    if (name == "printer-make-and-model" && (tag == 0x41 || tag == 0x42) && model.isEmpty()) model = value
                }
                e.formats = formats
                if (model.isNotBlank()) { e.model = model; if (e.name.isBlank()) e.name = model }
                e.ippPath = path
                return
            } catch (_: Exception) { return }
        }
    }

    /** Walks an IPP response and hands every attribute value to the callback. */
    private fun parseIpp(b: ByteArray, cb: (name: String, tag: Int, value: String) -> Unit) {
        var p = 8
        var last = ""
        fun u16(i: Int) = ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)
        while (p < b.size) {
            val tag = b[p++].toInt() and 0xFF
            if (tag == 0x03) return
            if (tag <= 0x05) continue                              // group delimiter
            if (p + 2 > b.size) return
            val nl = u16(p); p += 2
            if (p + nl + 2 > b.size) return
            if (nl > 0) { last = String(b, p, nl, Charsets.ISO_8859_1); p += nl }
            val vl = u16(p); p += 2
            if (p + vl > b.size) return
            cb(last, tag, String(b, p, vl, Charsets.UTF_8))
            p += vl
        }
    }

    private fun sendIppJob(e: Entry, job: String, jpeg: ByteArray, wMm: Double, hMm: Double) {
        fetchAttrs(e)
        val formats = e.formats
        // Photo as-is when the printer takes JPEG (or won't say); otherwise wrap it in a PDF.
        val (format, data) = when {
            formats.isEmpty() || "image/jpeg" in formats -> "image/jpeg" to jpeg
            "application/pdf" in formats -> "application/pdf" to jpegToPdf(jpeg, wMm, hMm)
            else -> throw IllegalStateException(
                (e.model.ifBlank { "This printer" }) + " can't take photos from the tablet over Wi-Fi (it accepts: " +
                    formats.filter { it.startsWith("image/") || it.startsWith("application/") }.take(5).joinToString(", ") + ")."
            )
        }
        var lastErr = "The printer didn't accept the job."
        for (withMedia in listOf(true, false)) {
            for (path in ippPaths(e)) {
                val body = ippPrintJob(ippUri(e, path), job, format, data, if (withMedia) wMm else 0.0, hMm)
                val r = doPost(e, path, body)
                when {
                    r.http == 200 && r.ipp in 0..2 -> return
                    r.http == 200 -> lastErr = "The printer refused the photo (code 0x" + Integer.toHexString(r.ipp) + ")."
                    r.http == 426 || r.http == 301 || r.http == 302 -> lastErr = "This printer only accepts secure printing, which the app doesn't support yet."
                    r.http == 404 -> {}
                    else -> if (r.http > 0) lastErr = "The printer answered with HTTP ${r.http}."
                }
            }
        }
        throw IllegalStateException(lastErr)
    }

    /** A one-page PDF holding the JPEG at the sheet size, for printers that take PDF but not JPEG. */
    private fun jpegToPdf(jpeg: ByteArray, wMm: Double, hMm: Double): ByteArray {
        val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts)
        val wPt = Math.round(wMm / 25.4 * 72).toInt().coerceAtLeast(1)
        val hPt = Math.round(hMm / 25.4 * 72).toInt().coerceAtLeast(1)
        val out = ByteArrayOutputStream()
        val offs = IntArray(6)
        fun w(s: String) = out.write(s.toByteArray(Charsets.ISO_8859_1))
        w("%PDF-1.4\n")
        offs[1] = out.size(); w("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        offs[2] = out.size(); w("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
        offs[3] = out.size()
        w("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 $wPt $hPt] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n")
        val content = "q $wPt 0 0 $hPt 0 0 cm /Im0 Do Q"
        offs[4] = out.size(); w("4 0 obj\n<< /Length ${content.length} >>\nstream\n$content\nendstream\nendobj\n")
        offs[5] = out.size()
        w("5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${opts.outWidth} /Height ${opts.outHeight} " +
            "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.size} >>\nstream\n")
        out.write(jpeg)
        w("\nendstream\nendobj\n")
        val xref = out.size()
        w("xref\n0 6\n0000000000 65535 f \n")
        for (i in 1..5) w(String.format("%010d 00000 n \n", offs[i]))
        w("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        return out.toByteArray()
    }

    private fun ippGetAttributes(uri: String): ByteArray {
        val o = ByteArrayOutputStream()
        fun u8(v: Int) = o.write(v and 0xFF)
        fun u16(v: Int) { u8(v shr 8); u8(v) }
        fun str(s: String) { val b = s.toByteArray(Charsets.UTF_8); u16(b.size); o.write(b) }
        fun attr(tag: Int, name: String, value: String) { u8(tag); str(name); str(value) }
        u16(0x0200); u16(0x000B); u16(0); u16(1)               // IPP 2.0, Get-Printer-Attributes, request id 1
        u8(0x01)
        attr(0x47, "attributes-charset", "utf-8")
        attr(0x48, "attributes-natural-language", "en")
        attr(0x45, "printer-uri", uri)
        attr(0x44, "requested-attributes", "printer-make-and-model")
        u8(0x44); u16(0); str("document-format-supported")
        u8(0x03)
        return o.toByteArray()
    }

    private class Reply(val http: Int, val ipp: Int, val body: ByteArray = ByteArray(0))

    private fun post(ip: String, port: Int, path: String, body: ByteArray): Reply {
        try {
            Socket().use { s ->
                s.connect(InetSocketAddress(ip, port), 5000)
                s.soTimeout = 90_000
                val out = s.getOutputStream()
                val head = "POST $path HTTP/1.1\r\nHost: $ip:$port\r\nContent-Type: application/ipp\r\n" +
                    "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.ISO_8859_1))
                out.write(body)
                out.flush()
                val buf = ByteArrayOutputStream()
                val tmp = ByteArray(4096)
                while (buf.size() < 65536) {
                    val n = s.getInputStream().read(tmp)
                    if (n < 0) break
                    buf.write(tmp, 0, n)
                }
                return parseReply(buf.toByteArray())
            }
        } catch (ex: Exception) {
            Log.w(TAG, "post $ip:$port$path", ex)
            throw IllegalStateException("Couldn't reach the printer at $ip. Check it is on and on the same Wi-Fi.")
        }
    }

    /** Splits an HTTP reply into its status code, the IPP status and the IPP body. */
    private fun parseReply(bytes: ByteArray): Reply {
        val text = String(bytes, Charsets.ISO_8859_1)
        val http = Regex("^HTTP/1\\.[01] (\\d{3})").find(text)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val split = text.indexOf("\r\n\r\n")
        if (http != 200 || split < 0) return Reply(http, -1)
        var start = split + 4
        if (text.substring(0, split).contains("chunked", true)) {
            val nl = text.indexOf("\r\n", start)
            if (nl > 0) start = nl + 2
        }
        if (bytes.size < start + 4) return Reply(http, -1)
        return Reply(
            http, ((bytes[start + 2].toInt() and 0xFF) shl 8) or (bytes[start + 3].toInt() and 0xFF),
            bytes.copyOfRange(start, bytes.size)
        )
    }

    private fun ippUri(e: Entry, path: String) = if (e.usbDev != null) "ipp://localhost$path" else "ipp://${e.ip}:${e.ippPort}$path"

    private fun doPost(e: Entry, path: String, body: ByteArray): Reply =
        if (e.usbDev != null) usbPost(e.usbDev!!, path, body) else post(e.ip, e.ippPort, path, body)

    private fun ippPrintJob(uri: String, job: String, format: String, doc: ByteArray, wMm: Double, hMm: Double): ByteArray {
        val o = ByteArrayOutputStream()
        fun u8(v: Int) = o.write(v and 0xFF)
        fun u16(v: Int) { u8(v shr 8); u8(v) }
        fun u32(v: Int) { u16(v ushr 16); u16(v) }
        fun str(s: String) { val b = s.toByteArray(Charsets.UTF_8); u16(b.size); o.write(b) }
        fun attr(tag: Int, name: String, value: String) { u8(tag); str(name); str(value) }
        fun intAttr(name: String, v: Int) { u8(0x21); str(name); u16(4); u32(v) }
        fun member(name: String) { u8(0x4a); u16(0); str(name) }
        fun memberInt(name: String, v: Int) { member(name); u8(0x21); u16(0); u16(4); u32(v) }

        u16(0x0200); u16(0x0002); u32(1)                       // IPP 2.0, Print-Job, request id 1
        u8(0x01)                                                // operation attributes
        attr(0x47, "attributes-charset", "utf-8")
        attr(0x48, "attributes-natural-language", "en")
        attr(0x45, "printer-uri", uri)
        attr(0x42, "requesting-user-name", "photobooth")
        attr(0x42, "job-name", job)
        attr(0x49, "document-format", format)
        u8(0x02)                                                // job attributes
        if (wMm > 0) {
            u8(0x34); str("media-col"); u16(0)                  // begCollection
            member("media-size")
            u8(0x34); u16(0); u16(0)                            // nested begCollection
            memberInt("x-dimension", Math.round(minOf(wMm, hMm) * 100).toInt())
            memberInt("y-dimension", Math.round(maxOf(wMm, hMm) * 100).toInt())
            u8(0x37); u16(0); u16(0)                            // end media-size
            memberInt("media-top-margin", 0)
            memberInt("media-bottom-margin", 0)
            memberInt("media-left-margin", 0)
            memberInt("media-right-margin", 0)
            u8(0x37); u16(0); u16(0)                            // end media-col
        }
        attr(0x44, "print-scaling", "fill")
        u8(0x03)                                                // end of attributes
        o.write(doc)
        return o.toByteArray()
    }
}
