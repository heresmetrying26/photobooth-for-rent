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
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

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
        private const val SCAN_MIN_MS = 8_000L        // the Bonjour answers need this long even when the sweep is quick
        private const val SCAN_MAX_MS = 45_000L
        private const val PROBE_MS = 900              // a sleeping or busy Wi-Fi printer can take over half a second to answer
        private const val RESOLVE_MS = 4L             // seconds to wait for one Bonjour name to resolve
    }

    /** One local IPv4 network the tablet is on. [network] is set when Android knows it, so sockets can be bound to it. */
    private class LocalNet(val network: Network?, val addr: Inet4Address, val prefix: Int)

    private class Entry(val ip: String) {
        @Volatile var name: String = ""
        @Volatile var ippPort: Int = 0
        @Volatile var ippPath: String = ""
        @Volatile var rawPort: Int = 0
        @Volatile var model: String = ""                       // "EPSON L3250 Series", from the printer itself
        @Volatile var formats: List<String> = emptyList()      // document formats it says it can print
        @Volatile var attrsTried = false
        @Volatile var attrsAttempts = 0
        @Volatile var qualities: List<Int> = emptyList()       // print-quality-supported: 3 draft, 4 normal, 5 high
        @Volatile var colorModes: List<String> = emptyList()   // print-color-mode-supported: color, monochrome...
        @Volatile var mediaTypes: List<String> = emptyList()   // media-type-supported: stationery, photographic-glossy...
        @Volatile var mediaReady: List<String> = emptyList()   // media-ready: the paper loaded now, e.g. "jpn_hagaki_100x148mm"
        @Volatile var mediaSupported: List<String> = emptyList() // media-supported: every paper size it names
        @Volatile var pwgRes: List<Int> = emptyList()          // pwg-raster-document-resolution-supported (dpi)
        @Volatile var pwgTypes: List<String> = emptyList()     // pwg-raster-document-type-supported: srgb_8, sgray_8...
        @Volatile var usbDev: UsbDevice? = null                // set for a printer on the USB port
    }

    private val found = ConcurrentHashMap<String, Entry>()
    private val nsd: NsdManager? = activity.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val pool = Executors.newFixedThreadPool(48)
    private val listeners = ArrayList<NsdManager.DiscoveryListener>()
    private val resolveLock = Any()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var resolveToken = 0
    private val resolveTimer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "pbnet-resolve").also { it.isDaemon = true } }
    // The address sweep gets its own threads so it never holds up a print job waiting in `pool`.
    private val scanPool = Executors.newFixedThreadPool(64) { r -> Thread(r, "pbnet-scan").also { it.isDaemon = true } }
    private val cm: ConnectivityManager? = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    @Volatile private var nets: List<LocalNet> = emptyList()
    @Volatile private var netsAt = 0L
    private var multicastLock: WifiManager.MulticastLock? = null
    @Volatile private var scanning = false
    @Volatile private var scanId = 0
    @Volatile private var scanNote = ""
    @Volatile private var addNote = ""
    private val probed = AtomicInteger(0)
    @Volatile private var probeTotal = 0
    private var usbReceiver: BroadcastReceiver? = null

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    fun shutdown() {
        stopDiscovery()
        holdMulticast(false)
        try { usbReceiver?.let { activity.unregisterReceiver(it) } } catch (_: Exception) {}
        usbReceiver = null
        try { pool.shutdownNow() } catch (_: Exception) {}
        try { scanPool.shutdownNow() } catch (_: Exception) {}
        try { resolveTimer.shutdownNow() } catch (_: Exception) {}
    }

    /** Starts a fresh search; the page then polls list() for what turned up. */
    @JavascriptInterface
    fun scan(): String {
        stopDiscovery()
        found.clear()
        synchronized(usbAsked) { usbAsked.clear() }
        synchronized(resolveLock) { resolveQueue.clear() }
        val id = ++scanId
        probed.set(0)
        probeTotal = 0
        scanNote = ""
        addNote = ""
        scanning = true
        holdMulticast(true)
        startDiscovery()
        pool.execute { try { sweepSubnet(id) } catch (e: Exception) { Log.w(TAG, "sweep", e) } }
        Thread {
            val t0 = System.currentTimeMillis()
            // Done when every address was tried (and Bonjour had a fair chance), or after the cap.
            while (scanId == id) {
                val ms = System.currentTimeMillis() - t0
                if (ms >= SCAN_MAX_MS || (ms >= SCAN_MIN_MS && probeTotal > 0 && probed.get() >= probeTotal)) break
                try { Thread.sleep(250) } catch (_: InterruptedException) {}
            }
            if (scanId == id) { stopDiscovery(); scanning = false; holdMulticast(false) }
        }.start()
        return "ok"
    }

    /** Some tablets drop Bonjour (multicast) packets unless an app asks for them; this asks while the search runs. */
    private fun holdMulticast(on: Boolean) {
        try {
            if (on) {
                if (multicastLock == null) {
                    val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                    multicastLock = wm?.createMulticastLock("pbnet")?.also { it.setReferenceCounted(false) }
                }
                multicastLock?.takeIf { !it.isHeld }?.acquire()
            } else multicastLock?.takeIf { it.isHeld }?.release()
        } catch (e: Exception) { Log.w(TAG, "multicast lock", e) }
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
                    .put("raw", it.rawPort > 0)
                    .put("qualities", JSONArray(it.qualities))
                    .put("colorModes", JSONArray(it.colorModes))
                    .put("mediaTypes", JSONArray(it.mediaTypes)))
            }
        usbListInto(arr)
        return JSONObject().put("scanning", scanning).put("printers", arr)
            .put("note", scanNote).put("checked", probed.get()).put("total", probeTotal).put("addNote", addNote).toString()
    }

    /** Adds a printer by its address when the search can't see it (different subnet, mDNS blocked…). */
    @JavascriptInterface
    fun addByIp(ip: String): String {
        val clean = ip.trim()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(clean)) return "bad"
        addNote = ""
        pool.execute {
            val e = Entry(clean)
            probeInto(e, 2500)
            if (e.ippPort > 0 || e.rawPort > 0) {
                val cur = found.getOrPut(clean) { e }
                if (cur !== e) { if (cur.ippPort == 0) cur.ippPort = e.ippPort; if (cur.rawPort == 0) cur.rawPort = e.rawPort }
                fetchAttrs(cur)
            } else addNote = "Nothing at $clean answered on the printing ports (631, 9100). Check the address, and that the tablet and printer are on the same Wi-Fi."
        }
        return "ok"
    }

    /**
     * Prints JPEG pages over IPP. Result arrives later as window.__PBNetResult({job, ok, error}).
     * pagesJson: JSON array of base64 JPEGs, one per sheet; copies repeats the whole set.
     */
    @JavascriptInterface
    fun printIpp(job: String, ip: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val o = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val opts = Opts(o.optString("quality"), o.optString("color"), o.optString("media"), o.optBoolean("borderless"))
                val adj = PrintColorAdj.from(o)
                val e = if (ip.startsWith("usb:")) usbEntry(ip) else found[ip] ?: Entry(ip).also { probeInto(it) }
                if (e.ippPort <= 0) throw IllegalStateException("This printer cannot receive photo print jobs.")
                val arr = JSONArray(pagesJson)
                val pages = ArrayList<ByteArray>()
                for (i in 0 until arr.length()) {
                    var data = decode(arr.getString(i))
                    if (!adj.isNoop) {
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(data, 0, data.size)
                        if (bmp != null) {
                            try {
                                val adjBmp = bmp.applyColorAdj(adj)
                                try {
                                    val bos = ByteArrayOutputStream()
                                    adjBmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 95, bos)
                                    data = bos.toByteArray()
                                } finally {
                                    if (adjBmp !== bmp) {
                                        try { adjBmp.recycle() } catch (_: Exception) {}
                                    }
                                }
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    pages.add(data)
                }
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (p in pages) sendIppJob(e, job, p, widthMm, heightMm, opts)
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
                else newSocket(ip).use { s ->
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
        val token: Int
        synchronized(resolveLock) {
            if (resolving) return
            next = resolveQueue.removeFirstOrNull() ?: return
            resolving = true
            token = ++resolveToken
        }
        // Android sometimes never answers a resolve; without this the whole line behind it would wait forever.
        val done = {
            var go = false
            synchronized(resolveLock) { if (resolving && resolveToken == token) { resolving = false; go = true } }
            if (go) resolveNext()
        }
        try { resolveTimer.schedule(Runnable { done() }, RESOLVE_MS, TimeUnit.SECONDS) } catch (_: Exception) {}
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
        // Keep to IPv4: that's what the sweep and sockets use. A printer announces both kinds of address, and
        // Android 14+ lists them all, so take the IPv4 one instead of dropping the printer when the first is IPv6.
        val addr = (if (Build.VERSION.SDK_INT >= 34) i.hostAddresses.firstOrNull { it is Inet4Address } else null)
            as? Inet4Address ?: i.host as? Inet4Address ?: return
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

    private fun ipLong(a: Inet4Address): Long = a.address.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }
    private fun ipText(v: Long) = "${(v shr 24) and 0xFF}.${(v shr 16) and 0xFF}.${(v shr 8) and 0xFF}.${v and 0xFF}"

    /**
     * The IPv4 networks the tablet is on right now. Wi-Fi and Ethernet come from Android's own network list (with their
     * real prefix length, and so that sockets can be tied to that network); anything else with a private address, like the
     * booth's own hotspot, is added from the interface list. Mobile-data interfaces are left out.
     */
    @Suppress("DEPRECATION")
    private fun localNets(): List<LocalNet> {
        val out = ArrayList<LocalNet>()
        try {
            val mgr = cm
            if (mgr != null) for (n in mgr.allNetworks) {
                val caps = mgr.getNetworkCapabilities(n) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
                if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) continue
                val lp = mgr.getLinkProperties(n) ?: continue
                for (la in lp.linkAddresses) {
                    val a = la.address
                    if (a is Inet4Address && !a.isLoopbackAddress && !a.isLinkLocalAddress) out.add(LocalNet(n, a, la.prefixLength))
                }
            }
        } catch (e: Exception) { Log.w(TAG, "networks", e) }
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                val nm = ni.name.lowercase()
                if (nm.startsWith("rmnet") || nm.startsWith("ccmni") || nm.startsWith("pdp") || nm.startsWith("tun") || nm.startsWith("ppp") || nm.startsWith("v4-") || nm.startsWith("dummy")) continue
                for (ia in ni.interfaceAddresses) {
                    val a = ia.address
                    if (a is Inet4Address && a.isSiteLocalAddress && out.none { it.addr == a }) out.add(LocalNet(null, a, ia.networkPrefixLength.toInt()))
                }
            }
        } catch (e: Exception) { Log.w(TAG, "interfaces", e) }
        return out
    }

    private fun currentNets(): List<LocalNet> {
        val now = System.currentTimeMillis()
        if (nets.isEmpty() || now - netsAt > 5_000) { nets = localNets(); netsAt = now }
        return nets
    }

    /** A socket that goes out over the Wi-Fi the printer is on, even when Android prefers mobile data because that Wi-Fi has no internet. */
    private fun newSocket(ip: String): Socket {
        try {
            val a = InetAddress.getByName(ip) as? Inet4Address
            if (a != null) {
                val v = ipLong(a)
                for (n in currentNets()) {
                    val net = n.network ?: continue
                    val mask = if (n.prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - n.prefix.coerceAtMost(32))) and 0xFFFFFFFFL
                    if ((ipLong(n.addr) and mask) == (v and mask)) return net.socketFactory.createSocket()
                }
            }
        } catch (e: Exception) { Log.w(TAG, "bound socket", e) }
        return Socket()
    }

    /**
     * Looks for printer ports on the networks the tablet is on: first the tablet's own /24 (where the printer nearly
     * always is), then the rest of a larger subnet (up to a /22, 1,022 addresses).
     */
    private fun sweepSubnet(id: Int) {
        nets = localNets(); netsAt = System.currentTimeMillis()
        val list = nets
        val targets = LinkedHashSet<Long>()
        val mine = HashSet<Long>()
        for (n in list) {
            mine.add(ipLong(n.addr))
            val base = ipLong(n.addr) and 0xFFFFFF00L
            for (h in 1L..254L) targets.add(base or h)
        }
        for (n in list) {
            if (n.prefix >= 24 || n.prefix <= 0) continue
            val p = n.prefix.coerceAtLeast(22)
            val size = 1L shl (32 - p)
            val start = ipLong(n.addr) and ((0xFFFFFFFFL shl (32 - p)) and 0xFFFFFFFFL)
            for (h in 1L until size - 1) targets.add(start + h)
        }
        targets.removeAll(mine)
        scanNote = if (list.isEmpty()) "The tablet has no Wi-Fi address, so there is nothing to search. Connect it to the printer's Wi-Fi."
        else "Searched " + targets.size + " addresses on " + list.joinToString(", ") { it.addr.hostAddress + "/" + it.prefix }
        probeTotal = targets.size
        for (v in targets) {
            val ip = ipText(v)
            scanPool.execute {
                try { if (scanning && scanId == id) probe(ip) } finally { probed.incrementAndGet() }
            }
        }
    }

    private fun open(ip: String, port: Int, timeoutMs: Int = PROBE_MS): Boolean = try {
        newSocket(ip).use { it.connect(InetSocketAddress(ip, port), timeoutMs); true }
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

    private fun probeInto(e: Entry, timeoutMs: Int = PROBE_MS) {
        if (e.ippPort == 0 && open(e.ip, 631, timeoutMs)) e.ippPort = 631
        if (e.rawPort == 0 && open(e.ip, 9100, timeoutMs)) e.rawPort = 9100
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
    private val usbDeviceLocks = ConcurrentHashMap<String, Any>()
    private fun usbLockFor(id: String): Any = usbDeviceLocks.getOrPut(id) { Any() }
    private val usbPermAction = "com.photobooth4u.booth.USB_PRINTER_PERMISSION"
    // USB Vendor IDs of known thermal/receipt printer chipsets.
    // 0x0519 = Star Micronics (TSP143IIIU, mC-Print series)
    // 0x28e9 = GigaDevice (used by Xprinter XP-T80Q, XP-P300, and many generic POS printers)
    // 0x04b8 = Seiko Epson (TM-T82X-II, EU-m30 — handled separately by epsonReceiptModels below)
    private val thermalVendors = setOf(0x0519, 0x1504, 0x1d90, 0x0dd4, 0x0483, 0x0416, 0x28e9, 0x4b43, 0x0fe6, 0x1fc9, 0x6868)

    /**
     * Hardcoded Epson TM / EU receipt printer USB models (VID 0x04B8).
     * These use raw ESC/POS over USB bulk-OUT, NOT ESC/P-R (the ink-tank L-series language).
     *
     * PID notes:
     *   TM-T82X / TM-T82X-II ship in two USB classes depending on firmware setting:
     *     0x0202 — Vendor-Defined class (default on some firmware; still ESC/POS)
     *     0x0E27 — USB Printer Class (preferred; set via Epson TM Utility → USB descriptor)
     *   EU-m30 kiosk module:
     *     0x0202 — Vendor-Defined (common default)
     *     0x0E2E — USB Printer Class (when configured via Epson EU-m30 utility)
     *
     * ⚠ Star TSP143IIIU (VID 0x0519, PID 0x0003) is in thermalVendors above but ships in
     *   Star Line / Raster mode. Enable ESC/POS routing via the Star futurePRNT
     *   Configuration Utility on Windows before using with this app.
     */
    private object EpsonReceiptModels {
        const val VENDOR_ID = 0x04B8

        // Map of USB Product ID → friendly model name
        val MODELS: Map<Int, String> = mapOf(
            // Epson TM-T82X / TM-T82X-II (printer-class firmware)
            0x0E27 to "TM-T82X",
            // Epson TM-T82X / TM-T82X-II (vendor-defined firmware, same ESC/POS)
            0x0202 to "TM series",
            // Epson EU-m30 kiosk module (printer-class firmware)
            0x0E2E to "EU-m30",
        )

        fun match(d: android.hardware.usb.UsbDevice): String? =
            if (d.vendorId == VENDOR_ID) MODELS[d.productId] else null

        fun isKnown(d: android.hardware.usb.UsbDevice): Boolean = match(d) != null
    }

    /**
     * Hardcoded Star Micronics receipt printer USB models (VID 0x0519).
     * ⚠ These printers MUST have ESC/POS routing enabled via Star futurePRNT utility.
     */
    private object StarReceiptModels {
        const val VENDOR_ID = 0x0519

        val MODELS: Map<Int, String> = mapOf(
            // TSP143IIIU / TSP100IIIU family
            0x0003 to "TSP143IIIU",
            // mC-Print2 / mC-Print3 USB
            0x0007 to "mC-Print",
        )

        fun match(d: android.hardware.usb.UsbDevice): String? =
            if (d.vendorId == VENDOR_ID) MODELS[d.productId] else null

        fun isKnown(d: android.hardware.usb.UsbDevice): Boolean = match(d) != null
    }

    /**
     * Hardcoded Xprinter receipt printer USB models (VID 0x28e9 / GigaDevice).
     * Covers XP-T80Q, XP-P300, and most Xprinter USB thermal receipt printers.
     * All speak standard ESC/POS over USB bulk-OUT.
     */
    private object XprinterModels {
        const val VENDOR_ID = 0x28e9

        // Xprinter PIDs vary by batch/firmware; the VID alone is sufficient for detection
        // because all GigaDevice-based Xprinter units use ESC/POS over bulk-OUT.
        fun isKnown(d: android.hardware.usb.UsbDevice): Boolean = d.vendorId == VENDOR_ID
    }

    /**
     * Hardcoded VOZY receipt printer USB models (ESC/POS, all models confirmed compatible).
     *
     * VOZY is a Philippine white-label POS brand built on standard ESC/POS chipsets:
     *   G80  — 80mm, USB + BT, auto-cutter (VID typically 0x28e9 or 0x0416)
     *   P50  — 58mm portable, USB + BT          (VID typically 0x28e9 or 0x0416)
     *   MP210 — 58mm mini mobile, USB + BT       (VID typically 0x0416 or 0x6868)
     *
     * All three VIDs (0x28e9, 0x0416, 0x6868) are already in thermalVendors, so VOZY printers
     * are detected automatically as ESC/POS receipt printers without needing a dedicated PID map.
     * This object exists solely for accurate display naming in the printer list.
     */
    private object VozyReceiptModels {
        // VIDs VOZY units are known to use (may vary by batch)
        private val VENDOR_IDS = setOf(0x28e9, 0x0416, 0x6868)

        fun isKnown(d: android.hardware.usb.UsbDevice): Boolean {
            if (d.vendorId !in VENDOR_IDS) return false
            // Match on product name containing VOZY model identifiers
            val name = (d.productName ?: "").uppercase()
            return name.contains("VOZY") || name.contains("G80") ||
                   name.contains("P50") || name.contains("MP210")
        }

        fun modelName(d: android.hardware.usb.UsbDevice): String {
            val name = (d.productName ?: "").uppercase()
            return when {
                name.contains("G80")  -> "VOZY G80"
                name.contains("P50")  -> "VOZY P50"
                name.contains("MP210") -> "VOZY MP210"
                else -> "VOZY printer"
            }
        }
    }

    init {
        val rx = object : BroadcastReceiver() {
            @Suppress("DEPRECATION")
            override fun onReceive(c: Context?, i: Intent?) {
                val d = i?.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE) ?: return
                usbWaiters.remove(d.deviceName)?.countDown()
            }
        }
        usbReceiver = rx
        val f = IntentFilter(usbPermAction)
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(rx, f, Context.RECEIVER_NOT_EXPORTED)
        else activity.registerReceiver(rx, f)
    }

    private fun usbIfaces(d: UsbDevice): List<UsbInterface> = (0 until d.interfaceCount).map { d.getInterface(it) }
    private fun usbIsPrinter(d: UsbDevice) = usbIfaces(d).any { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER } ||
        (d.vendorId == CanonSelphyJob.VENDOR_ID && (d.productId in CanonSelphyJob.PRODUCT_IDS || (d.productName ?: "").contains("SELPHY", true))) ||
        DnpJob.isKnown(d)
    /** True when this interface (alternate setting) has both a bulk OUT and a bulk IN endpoint. */
    private fun hasBulkPair(i: UsbInterface): Boolean {
        var out = false
        var inn = false
        for (k in 0 until i.endpointCount) {
            val ep = i.getEndpoint(k)
            if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
            if (ep.direction == UsbConstants.USB_DIR_OUT) out = true else inn = true
        }
        return out && inn
    }

    /**
     * IPP-over-USB interface (class 7, subclass 1, protocol 4). A printer lists several alternate settings of it and
     * only one has the data endpoints, so take that one (the way OpenPrinting's ipp-usb does). Some HP printers use
     * a vendor-specific form of it (class 255, subclass 9, protocol 1).
     */
    private fun usbIppIface(d: UsbDevice): UsbInterface? =
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol == 4 && hasBulkPair(it) }
            ?: usbIfaces(d).firstOrNull { d.vendorId == 0x03f0 && it.interfaceClass == 255 && it.interfaceSubclass == 9 && it.interfaceProtocol == 1 && hasBulkPair(it) }
    private fun usbRawIface(d: UsbDevice) =
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol in 1..2 }

    private fun usbProduct(d: UsbDevice): String? =
        if (usb?.hasPermission(d) == true) try { d.productName?.trim()?.takeIf { it.isNotEmpty() } } catch (_: Exception) { null } else null

    // ── Hardcoded Epson L-series USB models ──────────────────────────────────
    // VID 0x04B8 = Seiko Epson Corp.  All three models speak ESC/P-R over USB.
    //
    //  Model    PID (hex)  PID (dec)  Notes
    //  ───────────────────────────────────────────────────────────────────────
    //  L8050    0x0866     2150       6-ink photo printer, ESC/P-R, borderless
    //  L3210    0xE671     58993      4-ink all-in-one, ESC/P-R
    //  L3276    0x445A     17498      4-ink Wi-Fi AIO (L3270-family USB PID)
    //
    // These are the exact PIDs from the Windows INF files installed on the
    // operator's laptop (e1wf1b0e.inf for L8050, e_wf1yxe.inf for L3210/L3276).
    object EpsonLModels {
        const val VENDOR_ID = 0x04B8

        // Map of USB Product ID → friendly model name
        val MODELS: Map<Int, String> = mapOf(
            0x0866 to "L8050",
            0xE671 to "L3210",
            0x445A to "L3276"   // L3270-series PID; L3276 is the Wi-Fi variant
        )

        fun match(d: UsbDevice): String? =
            if (d.vendorId == VENDOR_ID) MODELS[d.productId] else null

        /** True when this is one of the three hardcoded Epson photo/AIO printers. */
        fun isKnown(d: UsbDevice): Boolean = match(d) != null

        /** True for models that support borderless photo printing (L8050, L3210, L3276). */
        fun isBorderless(d: UsbDevice): Boolean =
            d.vendorId == VENDOR_ID && (d.productId == 0x0866 || d.productId == 0xE671 || d.productId == 0x445A)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Hardcoded Epson ESC/P2 printers (L120, L121) ─────────────────────────
    // VID 0x04B8 = Seiko Epson Corp.
    // L120 / L121 speak ESC/P2 (CMD:ESCPL2) raster, not ESC/P-R.
    // They print in color via EscP2Job.
    object EpsonEscp2Models {
        const val VENDOR_ID = 0x04B8

        val MODELS: Map<Int, String> = mapOf(
            0x005E to "L120",   // Epson L120 / L121 USB PID (94)
            0x005F to "L121"
        )

        fun match(d: UsbDevice): String? {
            if (d.vendorId != VENDOR_ID) return null
            MODELS[d.productId]?.let { return it }
            val prod = (d.productName ?: "")
            if (prod.contains("L121", ignoreCase = true)) return "L121"
            if (prod.contains("L120", ignoreCase = true)) return "L120"
            return null
        }

        fun isKnown(d: UsbDevice): Boolean = match(d) != null
    }

    // ── Hardcoded Canon PIXMA G-series printers (G1010, G3030, etc.) ─────────
    // VID 0x04A9 = Canon Inc.
    // G-series ink-tank models speak Canon IVEC XML + BJRaster raster over USB.
    object CanonGModels {
        const val VENDOR_ID = 0x04A9

        val MODELS: Map<Int, String> = mapOf(
            0x183C to "G1010",
            0x1793 to "G1000",
            0x183D to "G2010",
            0x1795 to "G2000",
            0x183B to "G3010",
            0x1794 to "G3000",
            0x18BF to "G3020",
            0x18C0 to "G3060",
            0x1908 to "G3070",
            0x196E to "G3030"
        )

        fun match(d: UsbDevice): String? {
            if (d.vendorId != VENDOR_ID) return null
            MODELS[d.productId]?.let { return it }
            val prod = (d.productName ?: "")
            val m = Regex("""(?i)\b(G[1-4]\d{3})\b""").find(prod)
            if (m != null) return m.groupValues[1].uppercase()
            return null
        }

        fun isKnown(d: UsbDevice): Boolean = match(d) != null
    }
    // ─────────────────────────────────────────────────────────────────────────

    private val escprCache = ConcurrentHashMap<String, Boolean>()
    private val escprLogged: MutableSet<String> = ConcurrentHashMap.newKeySet()

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

    /**
     * Epson ink-tank models that speak ESC/P-R over USB: the L120 / L210 era (L1xx, L2xx, L3xx, L5xx) and the newer
     * four-digit names (L3210, L3250, L3276, L4260, L5290, L8050…), plus the A3+ L18050 (sold as ET-18100 elsewhere),
     * which shares the L8050's 6-ink ESC/P-R platform. Other five-digit A3 models (L14150) are not matched.
     * Only a name fallback: its USB product id is not hardcoded in [EpsonLModels] yet (read it from the
     * "epson usb 04b8:xxxx" PBNet log line with the printer plugged in).
     */
    private fun epsonLSeries(name: String?): Boolean =
        name != null && Regex("""(?i)\b(L\s?(1\d\d|2\d\d|3\d\d|5\d\d|[1-8]\d{3}|18050)|ET-?18100)\b""").containsMatchIn(name)

    /** True when the printer says it speaks Epson's ESC/P-R language (the family the L120 / L210 belong to). */
    private fun usbIsEscpr(d: UsbDevice): Boolean {
        if (usb?.hasPermission(d) != true) return false
        if (d.vendorId != 0x04b8) return false
        // Never treat hardcoded ESC/P2 printers (L120, L121) as ESC/P-R:
        if (EpsonEscp2Models.isKnown(d)) return false
        escprCache[d.deviceName]?.let { return it }
        // Fast-path: the three hardcoded models are known ESC/P-R printers; skip the USB control transfer
        // so the printer is usable even before it answers the IEEE-1284 device-ID request.
        if (EpsonLModels.isKnown(d)) {
            Log.i(TAG, "epson usb %04x:%04x hardcoded model=%s escpr=true".format(d.vendorId, d.productId, EpsonLModels.match(d)))
            escprCache[d.deviceName] = true
            return true
        }
        val id = try { usbDeviceId(d) } catch (e: Exception) { Log.w(TAG, "device id", e); null }
        if (id != null) usbIds[d.deviceName] = id
        // Say it speaks ESC/P-R when its own ID says so, or (like PrinterShare / PrintHand) when the model is a
        // known Epson L-series name and the ID could not be read or does not list another language to use.
        val byId = id != null && Regex("CMD:[^;]*ESCPR", RegexOption.IGNORE_CASE).containsMatchIn(id)
        val byModel = epsonLSeries(usbProduct(d)) || (id != null && epsonLSeries(id))
        // When the printer's own ID can be read, trust only what it says; the model name is only the fallback
        // for an ID that cannot be read. (Sending ESC/P-R data to a printer that does not speak it prints text.)
        val ok = if (id != null) byId else byModel
        // Logged once per printer (adb logcat, tag PBNet) so a printer that won't print can be diagnosed.
        if (escprLogged.add(d.deviceName + (id ?: "")))
            Log.i(TAG, "epson usb %04x:%04x product=%s id=%s escpr=%s".format(d.vendorId, d.productId, usbProduct(d), id ?: "(unreadable)", ok))
        if (id != null) escprCache[d.deviceName] = ok
        return ok
    }

    /**
     * True for a Canon PIXMA G-series style USB printer: Canon's vendor id, and either its own ID lists the IVEC / BJRaster
     * languages or (when the ID can't be read) its name is a G1000 / G2000 / G3000 / G4000 family model.
     */
    private fun usbIsCanon(d: UsbDevice): Boolean {
        if (d.vendorId != 0x04a9 || usb?.hasPermission(d) != true) return false
        if (usbIsSelphy(d)) return false // Handled separately by CanonSelphyJob
        if (CanonGModels.isKnown(d)) return true
        var id = usbIds[d.deviceName]
        if (id == null) {
            id = try { usbDeviceId(d) } catch (e: Exception) { Log.w(TAG, "canon id", e); null }
            if (id != null) usbIds[d.deviceName] = id
        }
        if (id != null && Regex("CMD:[^;]*(IVEC|BJRaster)", RegexOption.IGNORE_CASE).containsMatchIn(id)) return true
        val name = (usbProduct(d) ?: "") + " " + (id ?: "")
        return Regex("""(?i)\bG[1-4]\d{3}\b""").containsMatchIn(name)
    }

    /** True for Canon SELPHY compact dye-sub photo printers (CP820 / CP910 / CP1000 / CP1200 / CP1300 / CP1500). */
    private fun usbIsSelphy(d: UsbDevice): Boolean {
        if (d.vendorId != CanonSelphyJob.VENDOR_ID) return false
        if (d.productId in CanonSelphyJob.PRODUCT_IDS) return true
        val name = ((usbProduct(d) ?: "") + " " + (d.productName ?: "") + " " + (usbIds[d.deviceName] ?: "")).uppercase()
        return name.contains("SELPHY") || name.contains("CP1300") || name.contains("CP1500") || name.contains("CP1200") ||
            name.contains("CP1000") || name.contains("CP910") || name.contains("CP820")
    }

    /**
     * Prints photos directly to Canon SELPHY dye-sub photo printers (CP820 / CP910 / CP1000 / CP1200 / CP1300 / CP1500) over USB.
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printSelphy(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                if (!usbIsSelphy(d)) throw IllegalStateException("This device is not a recognized dye-sub photo printer.")

                val iface = usbRawIface(d) ?: usbIfaces(d).firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER && hasBulkPair(it) }
                    ?: usbIfaces(d).firstOrNull { hasBulkPair(it) }
                    ?: throw IllegalStateException("This USB device has no printer data interface.")

                val optJson = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val adj = PrintColorAdj.from(optJson)

                val arr = JSONArray(pagesJson)
                val pageJobs = ArrayList<ByteArray>()
                for (i in 0 until arr.length()) {
                    val jpeg = decode(arr.getString(i))
                    val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                        ?: throw IllegalStateException("Couldn't decode photo for printing.")
                    try {
                        pageJobs.add(CanonSelphyJob.build(bmp, widthMm, heightMm, adj))
                    } finally {
                        try { bmp.recycle() } catch (_: Exception) {}
                    }
                }

                usbSession(d, iface) { conn, out, inn ->
                    if (inn == null) throw IllegalStateException("The SELPHY printer has no status reply port.")

                    val rd = ByteArray(12)
                    // Initial query to clear/check status
                    val ret = conn.bulkTransfer(inn, rd, rd.size, 3000)
                    if (ret > 0 && rd[2].toInt() != 0) {
                        conn.bulkTransfer(inn, rd, rd.size, 1000)
                    }

                    for (c in 0 until copies.coerceIn(1, 20)) {
                        for (jobData in pageJobs) {
                            // Wait for printer to be Idle (status 0x01)
                            val waitStart = System.currentTimeMillis()
                            while (System.currentTimeMillis() - waitStart < 45_000) {
                                val n = conn.bulkTransfer(inn, rd, rd.size, 2000)
                                if (n >= 12) {
                                    val status = rd[0].toInt() and 0xFF
                                    val err = rd[2].toInt() and 0xFF
                                    if (err != 0) {
                                        val errDesc = CanonSelphyJob.errorDescription(err)
                                        throw IllegalStateException("Canon SELPHY error: $errDesc")
                                    }
                                    if (status == 0x01) break
                                }
                                Thread.sleep(500)
                            }

                            // Write data to printer over bulk OUT
                            usbWrite(conn, out, jobData)

                            // Wait for printing cycle to start and finish
                            // Status cycle: 0x02 (Feeding paper) -> 0x04 (Yellow) -> 0x08 (Magenta) -> 0x10 (Cyan) -> 0x20 (Laminate) -> 0x01 (Idle)
                            val printStart = System.currentTimeMillis()
                            var printingSeen = false
                            while (System.currentTimeMillis() - printStart < 120_000) {
                                val n = conn.bulkTransfer(inn, rd, rd.size, 3000)
                                if (n >= 12) {
                                    val status = rd[0].toInt() and 0xFF
                                    val err = rd[2].toInt() and 0xFF
                                    if (err != 0) {
                                        val errDesc = CanonSelphyJob.errorDescription(err)
                                        throw IllegalStateException("Canon SELPHY error during print: $errDesc")
                                    }
                                    if (status in listOf(0x02, 0x04, 0x08, 0x10, 0x20)) {
                                        printingSeen = true
                                    }
                                    if (printingSeen && status == 0x01) {
                                        break // Print completed successfully!
                                    }
                                }
                                Thread.sleep(500)
                            }
                        }
                    }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "canon selphy print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print to Canon SELPHY.")
            }
            deliver(r)
        }
        return "started"
    }

    /** DNP dye-sub photo printers (DS-RX1 / RX1HS, DS620 / DS620A, DS40), found by USB vendor + product id. */
    private fun usbDnpModel(d: UsbDevice): String? = DnpJob.match(d, usbProduct(d))

    /** Interface for a DNP: the printer-class one with a bulk pair, else any bulk pair. */
    private fun usbDnpIface(d: UsbDevice): UsbInterface =
        usbIfaces(d).firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER && hasBulkPair(it) }
            ?: usbRawIface(d)
            ?: usbIfaces(d).firstOrNull { hasBulkPair(it) }
            ?: throw IllegalStateException("This DNP printer has no USB data interface.")

    /** Builds and sends DNP jobs for JPEG pages (base64 or data URLs). Blocks until the last sheet is printed. */
    private fun dnpPrint(d: UsbDevice, widthMm: Double, heightMm: Double, copies: Int, pages: JSONArray, opt: JSONObject) {
        val model = usbDnpModel(d) ?: throw IllegalStateException("This device is not a recognized DNP photo printer.")
        DnpJob.unsupportedReason(model)?.let { throw IllegalStateException(it) }
        val matte = opt.optString("media", "") == "matte"
        val stripCut = opt.optBoolean("stripCut", false)
        val adj = PrintColorAdj.from(opt)
        val jobs = ArrayList<ByteArray>()
        for (i in 0 until pages.length()) {
            val jpeg = decode(pages.getString(i))
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                ?: throw IllegalStateException("Couldn't decode photo for printing.")
            try {
                jobs.add(DnpJob.build(bmp, widthMm, heightMm, copies, matte, stripCut, adj))
            } finally {
                try { bmp.recycle() } catch (_: Exception) {}
            }
        }
        Log.i(TAG, "dnp print model=$model pages=${jobs.size} %04x:%04x".format(d.vendorId, d.productId))
        usbSession(d, usbDnpIface(d)) { conn, out, inn ->
            DnpJob.send(conn, out, inn, jobs) { usbWrite(conn, out, it) }
        }
    }

    /**
     * Prints photos straight to a DNP dye-sub printer over USB (no driver). Options: media "matte" (else glossy),
     * stripCut true = the page is two 2x6 strips side by side, so the sheet is cut in half.
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printDnp(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                val opt = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                dnpPrint(d, widthMm, heightMm, copies, JSONArray(pagesJson), opt)
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "dnp print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print to the DNP printer.")
            }
            deliver(r)
        }
        return "started"
    }

    /**
     * EXPERIMENTAL: prints JPEG pages to a Canon PIXMA G-series USB printer (G1000 / G1010 family), 300 dpi.
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printCanon(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                if (!usbIsCanon(d)) throw IllegalStateException("Printer model is not supported for direct USB rendering.")
                val copt = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val mono = copt.optString("color") == "mono"
                val cq = when (copt.optString("quality")) { "draft" -> 0; "high" -> 2; else -> 1 }
                val cm = when (copt.optString("media")) { "photo" -> 1; "matte" -> 2; else -> 0 }
                val adj = PrintColorAdj.from(copt)
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        try {
                            usbRaw(id, CanonJob.build(bmp, widthMm, heightMm, mono, cq, cm, adj))
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
                    }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "canon print failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print.")
            }
            deliver(r)
        }
        return "started"
    }

    /** True when the printer's own ID lists Epson's ESC/P2 language (CMD:ESCPL2) but not ESC/P-R: Epson L120 and kin. */
    private fun usbIsEscp2(d: UsbDevice): Boolean {
        if (d.vendorId != 0x04b8 || usb?.hasPermission(d) != true) return false
        if (EpsonEscp2Models.isKnown(d)) return true
        val id = usbIds[d.deviceName] ?: return false
        return Regex("CMD:[^;]*ESCPL2", RegexOption.IGNORE_CASE).containsMatchIn(id) &&
            !Regex("CMD:[^;]*ESCPR", RegexOption.IGNORE_CASE).containsMatchIn(id)
    }

    private fun calOf(j: JSONObject?): EscP2Job.Cal =
        if (j == null) EscP2Job.Cal()
        else EscP2Job.Cal(j.optInt("m", 120), j.optInt("c", 240), j.optInt("k", 240), j.optInt("n", 59), j.optDouble("g", 1.6))

    /** DIAGNOSTIC: prints one small colour test strip (see EscP2Job.diagnostic). Result arrives as window.__PBNetResult. */
    @JavascriptInterface
    fun printEscp2Diag(job: String, id: String, widthMm: Double, heightMm: Double, step: Int, kMode: Int, calJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                usbIsEscpr(d)
                if (!usbIsEscp2(d)) throw IllegalStateException("Printer does not support ESC/P2 raster commands.")
                usbRaw(id, EscP2Job.diagnostic(step, kMode, widthMm, heightMm, calOf(try { JSONObject(calJson) } catch (_: Exception) { null })))
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "escp2 diag failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print.")
            }
            deliver(r)
        }
        return "started"
    }

    /**
     * EXPERIMENTAL: prints JPEG pages in black and white to an Epson ESC/P2 USB printer (Epson L120 family).
     * Result arrives as window.__PBNetResult.
     */
    @JavascriptInterface
    fun printEscp2(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val optJson = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val colour = optJson.optString("color") == "color"
                val cal = calOf(optJson.optJSONObject("cal"))
                val media = optJson.optString("media")
                val feed = when (media) { "photo" -> 8; "matte" -> 7; else -> 0 }
                // The 720 dpi mode (Best, and photo paper before) made the L120 eject blank sheets on a real printer, so every
                // quality except Draft prints at the 360 dpi mode that is known to work. Photo paper only adds its feed sequence.
                val quality = if (optJson.optString("quality") == "draft") 0 else 1
                val adj = PrintColorAdj.from(optJson)
                val d = usbFind(id)
                usbEnsure(d)
                usbIsEscpr(d)                              // reads the printer's ID into the cache
                if (!usbIsEscp2(d)) throw IllegalStateException("Printer does not support ESC/P2 raster commands.")
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        try {
                            usbRaw(id, EscP2Job.build(bmp, widthMm, heightMm, colour, cal, quality, feed, adj))
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
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
     *
     * optionsJson keys (all optional):
     *   brightness — integer -100 … +100  (default: 0; negative = darker, positive = lighter)
     */
    @JavascriptInterface
    fun printEscpr(job: String, id: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String = "{}"): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                if (!usbIsEscpr(d)) throw IllegalStateException("Printer does not support ESC/P-R raster commands.")
                val optJson = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val adj = PrintColorAdj.from(optJson)
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        try {
                            usbRaw(id, EscprJob.build(bmp, widthMm, heightMm, false, adj = adj))
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
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

    /**
     * Prints JPEG pages to a hardcoded Epson L-series USB printer via ESC/P-R:
     *   • Epson L8050  (PID 0x0866) — 6-ink photo printer, supports borderless
     *   • Epson L3210  (PID 0xE671) — 4-ink all-in-one, supports borderless (up to 4R)
     *   • Epson L3276  (PID 0x445A) — 4-ink Wi-Fi AIO, supports borderless (up to 4R)
     *
     * The printer is identified by USB VID/PID without reading the IEEE-1284 device ID,
     * so it is available the instant the USB permission is granted.
     *
     * optionsJson keys:
     *   color      — "color" | "mono"               (default: color)
     *   quality    — "draft" | "normal" | "high"     (default: normal → 360 dpi)
     *   media      — "photo" | "matte" | "plain"     (default: plain)
     *   borderless — true | false                    (L8050, L3210, L3276 supported)
     *   brightness — integer -100 … +100             (default: 0; negative = darker, positive = lighter)
     *
     * Result arrives as window.__PBNetResult({job, ok, error}).
     */
    @JavascriptInterface
    fun printEpsonL(job: String, id: String, widthMm: Double, heightMm: Double,
                    copies: Int, pagesJson: String, optionsJson: String): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val d = usbFind(id)
                usbEnsure(d)
                val model = EpsonLModels.match(d)
                    ?: throw IllegalStateException(
                        "This printer (VID=%04x PID=%04x) is not one of the hardcoded Epson L-series models."
                            .format(d.vendorId, d.productId))
                Log.i(TAG, "printEpsonL: model=$model id=$id")

                val optJson = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val colour  = optJson.optString("color", "color") != "mono"
                val borderless = (optJson.optBoolean("borderless", false) || optJson.optBoolean("bl", false)) && EpsonLModels.isBorderless(d)
                val photoMedia = optJson.optString("media", "") == "photo" || borderless
                val draft = optJson.optString("quality", "") == "draft"
                val adj = PrintColorAdj.from(optJson)

                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        val bmp  = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't decode photo for printing.")
                        try {
                            usbRaw(id, EscprJob.build(bmp, widthMm, heightMm, !colour, borderless, photoMedia, draft, adj))
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
                    }
                }
                r.put("ok", true)
            } catch (ex: Exception) {
                Log.w(TAG, "printEpsonL failed", ex)
                r.put("ok", false).put("error", ex.message ?: "Couldn't print to Epson L-series printer.")
            }
            deliver(r)
        }
        return "started"
    }

    private fun usbName(d: UsbDevice): String {
        // DNP dye-sub photo printers (DS-RX1, DS620, DS40).
        usbDnpModel(d)?.let { return "DNP $it" }
        // Hardcoded Epson L-series inkjet: return the exact marketing name immediately.
        EpsonLModels.match(d)?.let { return "Epson $it" }
        // Hardcoded Epson ESC/P2 inkjet (L120, L121).
        EpsonEscp2Models.match(d)?.let { return "Epson $it" }
        // Hardcoded Canon PIXMA G-series inkjet (G1010, G3030, etc.).
        CanonGModels.match(d)?.let { return "Canon PIXMA $it" }
        // Hardcoded Epson TM / EU receipt printers.
        EpsonReceiptModels.match(d)?.let { return "Epson $it" }
        // Hardcoded Star receipt printers (need ESC/POS mode enabled).
        StarReceiptModels.match(d)?.let { return "Star $it" }
        // VOZY receipt printers (G80, P50, MP210) — name from product descriptor when available.
        if (VozyReceiptModels.isKnown(d)) return VozyReceiptModels.modelName(d)
        // Rongta RP / RPP series (RP30, RPP30, RP326, RP80 ...) — any vendor ID, recognised by the name in the USB descriptor.
        usbProduct(d)?.let { p -> if (rongtaNameRx.containsMatchIn(p)) return if (p.contains("rongta", true)) p else "Rongta $p" }
        // Xprinter (GigaDevice VID) — model name from USB descriptor when available.
        if (XprinterModels.isKnown(d)) {
            val prod = usbProduct(d)
            return if (!prod.isNullOrBlank()) "Xprinter $prod" else "Xprinter printer"
        }
        val maker = when (d.vendorId) {
            0x04b8 -> "Epson"; 0x03f0 -> "HP"; 0x04a9 -> "Canon"; 0x04f9 -> "Brother"
            0x0519 -> "Star"; 0x1504 -> "Bixolon"; 0x1d90 -> "Citizen"; else -> ""
        }
        val prod = usbProduct(d) ?: return (if (maker.isEmpty()) "USB" else maker) + " printer"
        return if (maker.isNotEmpty() && !prod.contains(maker, true)) "$maker $prod" else prod
    }

    /**
     * Receipt printers recognised by the name in their USB descriptor (works for any vendor ID once USB access is allowed):
     * Rongta RP / RPP series (RP30, RPP30, RP326, RP80, RPP300 ...), HPRT, Gprinter, iDPRT, Zjiang, Goojprt, Munbyn, Netum.
     */
    private val receiptNameRx = Regex("(?i)(^|[^a-z])rpp?[- ]?\\d|rongta|hprt|gprinter|idprt|zjiang|goojprt|munbyn|netum|arcticbreeze")
    // Many white-label 80 mm POS printers (ArcticBreeze RP30 and others) only call themselves "USB Printer Port" over USB.
    // Treated as a receipt printer unless the maker is a known inkjet / laser brand (Epson, Canon, HP, Brother), which have their own paths.
    private val genericPortNameRx = Regex("(?i)^usb[ -]?printer[ -]?port$")
    private val inkjetVendors = setOf(0x04b8, 0x04a9, 0x03f0, 0x04f9)
    private val rongtaNameRx = Regex("(?i)(^|[^a-z])rpp?[- ]?\\d|rongta")

    private fun usbLooksLikeReceipt(d: UsbDevice): Boolean =
        d.vendorId in thermalVendors ||
        EpsonReceiptModels.isKnown(d) ||
        StarReceiptModels.isKnown(d) ||
        XprinterModels.isKnown(d) ||
            (usbProduct(d)?.let { Regex("(?i)(^|[^a-z])tm[- ]?[a-z]?\\d|pos|receipt|thermal").containsMatchIn(it) || receiptNameRx.containsMatchIn(it) ||
                (d.vendorId !in inkjetVendors && genericPortNameRx.containsMatchIn(it.trim())) } ?: false)

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
            // DNP dye-sub printers are known by vendor + product id, so they need no USB access to be listed.
            val dnpModel = usbDnpModel(d)
            val dnp = dnpModel != null
            val ipp = !dnp && usbIppIface(d) != null
            val raw = !dnp && !ipp && usbRawIface(d) != null && usbLooksLikeReceipt(d)
            // Hardcoded Epson L-series check first — no USB control transfer required,
            // so the printer appears in the list the moment permission is granted.
            val epsonL = !ipp && !raw && EpsonLModels.isKnown(d)
            val escpr = !ipp && !raw && !epsonL && usbIsEscpr(d)
            val perm = m.hasPermission(d)
            val ippEntry = if (ipp && perm) {
                usbEntries.getOrPut("usb:" + d.deviceName) { Entry("usb:" + d.deviceName) }.also {
                    it.usbDev = d; it.ippPort = 1
                    if (!it.attrsTried) pool.execute { try { fetchAttrs(it) } catch (_: Exception) {} }
                }
            } else null
            val escp2 = !ipp && !raw && !epsonL && !escpr && usbIsEscp2(d)
            val selphy = !ipp && !raw && !epsonL && !escpr && !escp2 && usbIsSelphy(d)
            val canon = !ipp && !raw && !epsonL && !escpr && !escp2 && !selphy && usbIsCanon(d)
            val id = "usb:" + d.deviceName
            val epsonModelName = if (epsonL) (EpsonLModels.match(d) ?: "")
                else if (escp2) (EpsonEscp2Models.match(d) ?: "")
                else ""
            val canonModelName = if (canon) (CanonGModels.match(d) ?: "") else ""
            arr.put(JSONObject()
                .put("id", id).put("ip", id).put("name", usbName(d) + " (USB)")
                .put("ipp", ipp).put("raw", raw).put("escpr", escpr || epsonL).put("usb", true)
                .put("epsonL", epsonL)
                .put("epsonModel", epsonModelName)
                .put("borderless", epsonL && EpsonLModels.isBorderless(d))
                .put("escp2", escp2)
                .put("canon", canon)
                .put("canonModel", canonModelName)
                .put("selphy", selphy)
                .put("dnp", dnp)
                .put("dnpModel", dnpModel ?: "")
                .put("noDriver", perm && !dnp && !ipp && !raw && !epsonL && !escpr && !escp2 && !canon && !selphy)
                .put("needsPermission", !perm && !dnp && !ipp && !raw && !selphy)
                .put("qualities", JSONArray(ippEntry?.qualities ?: emptyList<Int>()))
                .put("colorModes", JSONArray(ippEntry?.colorModes ?: emptyList<String>()))
                .put("mediaTypes", JSONArray(ippEntry?.mediaTypes ?: emptyList<String>()))
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
            ?: throw IllegalStateException("The USB printer was disconnected. Reconnect and select it again.")

    /** Blocks (up to 30 s) until Android's "allow this app to use the USB device?" prompt has been answered. */
    private fun usbEnsure(d: UsbDevice) {
        val m = usb ?: throw IllegalStateException("This tablet does not support USB host mode.")
        if (m.hasPermission(d)) return
        val latch = CountDownLatch(1)
        usbWaiters[d.deviceName] = latch
        activity.runOnUiThread { try { m.requestPermission(d, usbPermIntent()) } catch (_: Exception) { latch.countDown() } }
        latch.await(30, TimeUnit.SECONDS)
        if (!m.hasPermission(d)) throw IllegalStateException("USB permission not granted. Reconnect the printer and tap Allow.")
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
        val conn = usb?.openDevice(d) ?: throw IllegalStateException("Could not open USB printer connection.")
        try {
            if (!conn.claimInterface(iface, true)) throw IllegalStateException("The USB printer is busy. Reconnect and retry.")
            // a printer's data endpoints exist only in a non-zero alternate setting: switch it on before using them
            if (iface.alternateSetting != 0 && !conn.setInterface(iface)) {
                throw IllegalStateException("Could not initialize printer USB data interface.")
            }
            var out: UsbEndpoint? = null
            var inn: UsbEndpoint? = null
            for (i in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(i)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_OUT) { if (out == null) out = ep } else if (inn == null) inn = ep
            }
            if (out == null) throw IllegalStateException("No compatible USB printer data endpoint found.")
            return block(conn, out, inn)
        } finally {
            try { conn.releaseInterface(iface) } catch (_: Exception) {}
            conn.close()
        }
    }

    private fun usbWrite(conn: UsbDeviceConnection, ep: UsbEndpoint, data: ByteArray) {
        var off = 0
        while (off < data.size) {
            // Never resend after a timeout: the printer may already hold part of the chunk, and a repeated piece
            // of a print job is read as text. Wait up to a minute for the printer to take each chunk instead.
            val r = conn.bulkTransfer(ep, data, off, minOf(16384, data.size - off), 60_000)
            if (r < 0) throw IllegalStateException("Printer communication timed out. Power cycle the printer and retry.")
            off += r
        }
    }

    /** Receipt printers on USB: the ESC/POS bytes go straight to the printer. */
    private fun usbRaw(id: String, data: ByteArray) {
        synchronized(usbLockFor(id)) {
            val d = usbFind(id)
            usbEnsure(d)
            val iface = usbRawIface(d) ?: usbIfaces(d).firstOrNull { it.interfaceClass == 7 }
                ?: throw IllegalStateException("Connected USB device is not a supported printer.")
            usbSession(d, iface) { conn, out, inn ->
                // A bidirectional printer can send status back; read and drop it while we write so it never waits on us.
                val stop = java.util.concurrent.atomic.AtomicBoolean(false)
                val reader = if (inn == null) null else Thread {
                    val b = ByteArray(1024)
                    while (!stop.get()) { try { conn.bulkTransfer(inn, b, b.size, 200) } catch (_: Exception) {} }
                }.also { it.isDaemon = true; it.start() }
                try {
                    // Paced write for thermal receipt printers: small chunks (256 bytes) with pacing delay
                    // so small RAM buffers (2-4 KB) on cheap mobile thermal printers never overflow or wrap around.
                    var off = 0
                    val chunkSize = 256
                    while (off < data.size) {
                        val len = minOf(chunkSize, data.size - off)
                        val r = conn.bulkTransfer(out, data, off, len, 30_000)
                        if (r < 0) throw IllegalStateException("Printer communication timed out. Power cycle the printer and retry.")
                        off += r
                        if (off < data.size) {
                            try { Thread.sleep(8) } catch (_: InterruptedException) {}
                        }
                    }
                    // Allow the printer mechanism to finish burning the final lines and feeding before closing connection.
                    // 58mm has ~48 image bytes/row, 8 rows/mm, and prints at ~50-60 mm/s (16-20 ms/mm).
                    val rows = data.size / 52.0
                    val mm = rows / 8.0
                    val drainMs = (mm * 18.0).toLong().coerceIn(1500L, 5000L)
                    try { Thread.sleep(drainMs) } catch (_: InterruptedException) {}
                } finally {
                    stop.set(true)
                    reader?.join(1000)
                }
            }
            // Give USB interface and printer controller a short pause to settle before releasing lock
            try { Thread.sleep(250) } catch (_: InterruptedException) {}
        }
    }

    /** One IPP request/response over IPP-over-USB: HTTP carried on the printer's bulk endpoints. */
    private fun usbPost(d: UsbDevice, path: String, body: ByteArray): Reply {
        val iface = usbIppIface(d) ?: throw IllegalStateException("This USB printer requires a dedicated driver or print station.")
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
            if (buf.size() == 0) throw IllegalStateException("Printer did not respond to status request.")
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
        synchronized(e) {
            if (e.attrsTried) return
            e.attrsAttempts++
            // A Wi-Fi printer gets two tries (the second is at print time); a USB printer may still be waking up, so it gets up to three
            if (e.attrsAttempts >= (if (e.usbDev == null) 2 else 3)) e.attrsTried = true
            fetchAttrsOnce(e)
        }
    }

    private fun fetchAttrsOnce(e: Entry) {
        for (path in ippPaths(e)) {
            try {
                val r = doPost(e, path, ippGetAttributes(ippUri(e, path)))
                if (r.http != 200 || r.ipp !in 0..2) continue
                val formats = ArrayList<String>()
                val qualities = ArrayList<Int>()
                val colorModes = ArrayList<String>()
                val mediaTypes = ArrayList<String>()
                val pwgRes = ArrayList<Int>()
                val pwgTypes = ArrayList<String>()
                val mediaReady = ArrayList<String>()
                val mediaSupported = ArrayList<String>()
                var model = ""
                parseIpp(r.body) { name, tag, raw ->
                    val value = String(raw, Charsets.UTF_8)
                    if (name == "document-format-supported" && tag == 0x49) formats.add(value.lowercase())
                    if (name == "printer-make-and-model" && (tag == 0x41 || tag == 0x42) && model.isEmpty()) model = value
                    if (name == "print-quality-supported" && tag == 0x23 && raw.size == 4) qualities.add(raw[3].toInt() and 0xFF)
                    if (name == "print-color-mode-supported" && tag == 0x44) colorModes.add(value)
                    if (name == "media-type-supported" && tag == 0x44) mediaTypes.add(value)
                    if (name == "pwg-raster-document-type-supported" && tag == 0x44) pwgTypes.add(value)
                    if (name == "media-ready" && (tag == 0x44 || tag == 0x42)) mediaReady.add(value)
                    if (name == "media-supported" && (tag == 0x44 || tag == 0x42)) mediaSupported.add(value)
                    // resolution value: 4 bytes across, 4 bytes down, 1 byte units (3 = dots per inch)
                    if (name == "pwg-raster-document-resolution-supported" && tag == 0x32 && raw.size == 9 && raw[8].toInt() == 3) {
                        pwgRes.add(((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF))
                    }
                }
                e.formats = formats
                e.qualities = qualities
                e.colorModes = colorModes
                e.mediaTypes = mediaTypes
                e.pwgRes = pwgRes
                e.pwgTypes = pwgTypes
                e.mediaReady = mediaReady
                e.mediaSupported = mediaSupported
                if (model.isNotBlank()) { e.model = model; if (e.name.isBlank()) e.name = model }
                e.ippPath = path
                e.attrsTried = true
                return
            } catch (_: Exception) { return }
        }
    }

    /** Walks an IPP response and hands every attribute value to the callback. */
    private fun parseIpp(b: ByteArray, cb: (name: String, tag: Int, value: ByteArray) -> Unit) {
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
            cb(last, tag, b.copyOfRange(p, p + vl))
            p += vl
        }
    }

    private class Opts(val quality: String, val color: String, val media: String, val borderless: Boolean = false)

    private fun sendIppJob(e: Entry, job: String, jpeg: ByteArray, wMm: Double, hMm: Double, opts: Opts) {
        fetchAttrs(e)
        // Only ask for settings this printer says it supports (quality, colour mode, paper type).
        val q = when (opts.quality) { "draft" -> 3; "normal" -> 4; "high" -> 5; else -> 0 }
        val qv = if (q != 0 && q in e.qualities) q else 0
        val cm = when {
            opts.color == "mono" && "monochrome" in e.colorModes -> "monochrome"
            opts.color == "color" && "color" in e.colorModes -> "color"
            else -> ""
        }
        val mt = when (opts.media) {
            "plain" -> e.mediaTypes.firstOrNull { it == "stationery" } ?: e.mediaTypes.firstOrNull { it.startsWith("stationery") } ?: ""
            "photo" -> e.mediaTypes.firstOrNull { it == "photographic-glossy" } ?: e.mediaTypes.firstOrNull { it.startsWith("photographic") } ?: ""
            else -> ""
        }
        val hasOpts = qv != 0 || cm.isNotEmpty() || mt.isNotEmpty()
        val formats = e.formats
        // Formats to try, in order: the photo as-is when the printer takes JPEG (or won't say), then PDF, then PWG raster.
        val candidates = ArrayList<Pair<String, () -> ByteArray>>()
        if (formats.isEmpty() || "image/jpeg" in formats) candidates.add("image/jpeg" to { jpeg })
        if ("application/pdf" in formats) candidates.add("application/pdf" to { jpegToPdf(jpeg, wMm, hMm) })
        if ("image/pwg-raster" in formats) candidates.add("image/pwg-raster" to { pwgPage(e, jpeg, wMm, hMm, opts) })
        if (candidates.isEmpty()) {
            throw IllegalStateException(
                (e.model.ifBlank { "This printer" }) + " can't take photos from the tablet (it accepts: " +
                    formats.filter { it.startsWith("image/") || it.startsWith("application/") }.take(5).joinToString(", ") + ")."
            )
        }
        var lastErr = "The printer didn't accept the job."
        // Try with the page size and settings first, then drop them one at a time if the printer refuses.
        val base = if (hasOpts) listOf(true to true, false to true, true to false, false to false) else listOf(true to false, false to false)
        // A Canon SELPHY has only a few fixed papers (postcard, L, card) and often refuses a custom size such as 101.6 x 152.4 mm,
        // so name the loaded paper itself first ("jpn_hagaki_100x148mm") and fall back to the custom size after that.
        val named = if (isSelphy(e)) selphyMedia(e, wMm, hMm) else null
        val attempts = (if (named != null) listOf(Triple(true, true, named), Triple(true, false, named)) else emptyList()) +
            base.map { Triple(it.first, it.second, "") }
        for ((format, make) in candidates) {
            val data = try { make() } catch (ex: Exception) { lastErr = ex.message ?: lastErr; continue }
            for ((withMedia, withOpts, mediaName) in attempts) {
                for (path in ippPaths(e)) {
                    val body = ippPrintJob(ippUri(e, path), job, format, data, if (withMedia) wMm else 0.0, hMm,
                        if (withOpts) qv else 0, if (withOpts) cm else "", if (withOpts) mt else "", if (opts.borderless) "none" else "fill", mediaName)
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
        }
        throw IllegalStateException(lastErr)
    }

    private fun isSelphy(e: Entry) = (e.model + " " + e.name).contains("selphy", true)

    /**
     * The paper the SELPHY names (loaded paper first, then everything it supports) that is closest to the sheet asked for,
     * or null when none is within 6 mm. Names carry their own size: "jpn_hagaki_100x148mm", "na_index-4x6_4x6in".
     */
    private fun selphyMedia(e: Entry, wMm: Double, hMm: Double): String? {
        if (wMm <= 0 || hMm <= 0) return null
        val want = listOf(minOf(wMm, hMm), maxOf(wMm, hMm))
        val re = Regex("_(\\d+(?:\\.\\d+)?)x(\\d+(?:\\.\\d+)?)(mm|in)$")
        fun pick(names: List<String>): String? {
            var best: String? = null
            var bestDiff = 6.0
            for (n in names) {
                val m = re.find(n) ?: continue
                val k = if (m.groupValues[3] == "in") 25.4 else 1.0
                val a = m.groupValues[1].toDouble() * k
                val b = m.groupValues[2].toDouble() * k
                val d = maxOf(Math.abs(minOf(a, b) - want[0]), Math.abs(maxOf(a, b) - want[1]))
                if (d <= bestDiff) { bestDiff = d; best = n }
            }
            return best
        }
        return pick(e.mediaReady) ?: pick(e.mediaSupported)
    }

    /** One PWG Raster page for printers that list image/pwg-raster: 300 dpi when offered, colour unless grey is asked for or all they list. */
    private fun pwgPage(e: Entry, jpeg: ByteArray, wMm: Double, hMm: Double, opts: Opts): ByteArray {
        val types = e.pwgTypes
        if (types.isNotEmpty() && "srgb_8" !in types && "sgray_8" !in types) {
            throw IllegalStateException("This printer's raster mode (" + types.take(3).joinToString(", ") + ") isn't supported yet.")
        }
        val gray = types.isNotEmpty() && "sgray_8" in types && ("srgb_8" !in types || opts.color == "mono")
        val avail = if (e.pwgRes.isNotEmpty()) e.pwgRes else listOf(300)
        val want = when (opts.quality) { "draft" -> 150; "high" -> 600; else -> 300 }
        fun pixelsAt(d: Int) = Math.round(minOf(wMm, hMm) / 25.4 * d).toLong() * Math.round(maxOf(wMm, hMm) / 25.4 * d)
        val fits = avail.filter { pixelsAt(it) <= 26_000_000L }
        val dpi = (if (fits.isNotEmpty()) fits else avail).minByOrNull { Math.abs(it - want) } ?: 300
        return PwgRaster.fromJpeg(jpeg, wMm, hMm, dpi, gray)
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
        for (n in listOf("document-format-supported", "print-quality-supported", "print-color-mode-supported", "media-type-supported",
            "pwg-raster-document-resolution-supported", "pwg-raster-document-type-supported", "media-ready", "media-supported")) {
            u8(0x44); u16(0); str(n)
        }
        u8(0x03)
        return o.toByteArray()
    }

    private class Reply(val http: Int, val ipp: Int, val body: ByteArray = ByteArray(0))

    private fun post(ip: String, port: Int, path: String, body: ByteArray): Reply {
        try {
            newSocket(ip).use { s ->
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
            throw IllegalStateException("Could not reach printer at $ip. Verify it is powered on and connected to the same network.")
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

    private fun ippPrintJob(uri: String, job: String, format: String, doc: ByteArray, wMm: Double, hMm: Double,
                            quality: Int = 0, colorMode: String = "", mediaType: String = "", scaling: String = "fill",
                            mediaName: String = ""): ByteArray {
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
        if (mediaName.isNotEmpty()) {
            attr(0x44, "media", mediaName)                      // a paper the printer itself lists
        } else if (wMm > 0) {
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
        attr(0x44, "print-scaling", scaling)                    // "none" for borderless: the printer must not scale or trim
        if (quality != 0) { u8(0x23); str("print-quality"); u16(4); u32(quality) }          // enum
        if (colorMode.isNotEmpty()) attr(0x44, "print-color-mode", colorMode)
        if (mediaType.isNotEmpty()) attr(0x44, "media-type", mediaType)
        u8(0x03)                                                // end of attributes
        o.write(doc)
        return o.toByteArray()
    }

    /** Lists printer names available via USB and Wi-Fi for 127.0.0.1:17321 /status and /printers */
    fun getPrinterNames(): List<String> {
        val list = mutableListOf<String>()
        val arr = JSONArray()
        usbListInto(arr)
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val name = o.optString("name")
            if (name.isNotBlank() && !list.contains(name)) list.add(name)
        }
        for (e in found.values) {
            if (e.ippPort > 0 || e.rawPort > 0) {
                val n = e.name.ifBlank { "Printer at ${e.ip}" }
                if (!list.contains(n)) list.add(n)
            }
        }
        return list
    }

    /**
     * Synchronous printing call used by the 127.0.0.1:17321 HTTP server.
     * Blocks the HTTP worker thread until data is dispatched to the printer.
     */
    fun printFromHelper(
        printerName: String,
        widthMm: Double,
        heightMm: Double,
        pagesArr: JSONArray,
        fit: String?,
        receipt: JSONObject? = null
    ): String? {
        try {
            val m = usb ?: throw IllegalStateException("USB service unavailable.")
            // Optional receipt tuning (dithering, bands, slow print). Absent: the receipt bytes are what they always were.
            val receiptOpt = ReceiptRaster.Options.fromJson(receipt)
            val cleanName = printerName.trim()

            // 1. Check if matching USB printer exists
            val usbPrinters = m.deviceList.values.filter { usbIsPrinter(it) }
            val matchedUsb = usbPrinters.firstOrNull { d ->
                val fullName = usbName(d) + " (USB)"
                fullName.equals(cleanName, ignoreCase = true) ||
                usbName(d).equals(cleanName, ignoreCase = true) ||
                ("usb:" + d.deviceName).equals(cleanName, ignoreCase = true)
            } ?: (if (usbPrinters.size == 1) usbPrinters[0] else null)

            if (matchedUsb != null) {
                val d = matchedUsb
                val id = "usb:" + d.deviceName
                usbEnsure(d)

                if (usbDnpModel(d) != null) {
                    dnpPrint(d, widthMm, heightMm, 1, pagesArr, JSONObject())
                    return null
                }

                val ipp = usbIppIface(d) != null
                val raw = !ipp && usbRawIface(d) != null && usbLooksLikeReceipt(d)
                val epsonL = !ipp && !raw && EpsonLModels.isKnown(d)
                val escpr = !ipp && !raw && !epsonL && usbIsEscpr(d)
                val escp2 = !ipp && !raw && !epsonL && !escpr && usbIsEscp2(d)
                val selphy = !ipp && !raw && !epsonL && !escpr && !escp2 && usbIsSelphy(d)
                val canon = !ipp && !raw && !epsonL && !escpr && !escp2 && !selphy && usbIsCanon(d)

                when {
                    epsonL || escpr -> {
                        val borderless = (epsonL && EpsonLModels.isBorderless(d)) || escpr
                        val photoMedia = true
                        val adj = PrintColorAdj()
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                val bytes = EscprJob.build(bmp, widthMm, heightMm, mono = false, borderless = borderless, photoMedia = photoMedia, draft = false, adj = adj)
                                usbRaw(id, bytes)
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    selphy -> {
                        val adj = PrintColorAdj()
                        val iface = usbRawIface(d)
                            ?: usbIfaces(d).firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER && hasBulkPair(it) }
                            ?: usbIfaces(d).firstOrNull { hasBulkPair(it) }
                            ?: throw IllegalStateException("No bulk interface for Canon SELPHY.")
                        val pageJobs = ArrayList<ByteArray>()
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                pageJobs.add(CanonSelphyJob.build(bmp, widthMm, heightMm, adj))
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                        usbSession(d, iface) { conn, out, inn ->
                            if (inn == null) throw IllegalStateException("The SELPHY printer has no status reply port.")
                            val rd = ByteArray(12)
                            val ret = conn.bulkTransfer(inn, rd, rd.size, 3000)
                            if (ret > 0 && rd[2].toInt() != 0) {
                                conn.bulkTransfer(inn, rd, rd.size, 1000)
                            }
                            for (jobData in pageJobs) {
                                val waitStart = System.currentTimeMillis()
                                while (System.currentTimeMillis() - waitStart < 45_000) {
                                    val n = conn.bulkTransfer(inn, rd, rd.size, 2000)
                                    if (n >= 12) {
                                        val status = rd[0].toInt() and 0xFF
                                        val err = rd[2].toInt() and 0xFF
                                        if (status == 1 && err == 0) break
                                        if (err != 0) throw IllegalStateException("SELPHY error code $err (check ink/paper)")
                                    }
                                    try { Thread.sleep(500) } catch (_: Exception) {}
                                }
                                usbWrite(conn, out, jobData)
                            }
                        }
                    }
                    escp2 -> {
                        val adj = PrintColorAdj()
                        val cal = EscP2Job.Cal()
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                val bytes = EscP2Job.build(bmp, widthMm, heightMm, color = true, cal = cal, quality = 1, feed = 0, adj = adj)
                                usbRaw(id, bytes)
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    canon -> {
                        val adj = PrintColorAdj()
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                val bytes = CanonJob.build(bmp, widthMm, heightMm, mono = false, quality = 1, media = 1, adj = adj)
                                usbRaw(id, bytes)
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    raw -> {
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                val rollW = if (widthMm <= 55.0) 384 else 576
                                val escpos = ReceiptRaster.build(bmp, rollW, receiptOpt)
                                usbRaw(id, escpos)
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    ipp -> {
                        val opts = Opts("", "", "", true)
                        val e = usbEntry(id)
                        for (i in 0 until pagesArr.length()) {
                            val data = decode(pagesArr.getString(i))
                            sendIppJob(e, "helper_" + System.currentTimeMillis(), data, widthMm, heightMm, opts)
                        }
                    }
                    else -> {
                        throw IllegalStateException("Unsupported USB printer model: VID=${d.vendorId} PID=${d.productId}")
                    }
                }
                return null
            }

            // 2. If not USB, check Wi-Fi printers
            val netMatch = found.values.firstOrNull {
                it.ip == cleanName || it.name.equals(cleanName, ignoreCase = true)
            }
            if (netMatch != null) {
                if (netMatch.rawPort > 0 && fit == "width") {
                    for (i in 0 until pagesArr.length()) {
                        val jpeg = decode(pagesArr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't decode photo for printing.")
                        try {
                            val rollW = if (widthMm <= 55.0) 384 else 576
                            val escpos = ReceiptRaster.build(bmp, rollW, receiptOpt)
                            newSocket(netMatch.ip).use { s ->
                                s.connect(InetSocketAddress(netMatch.ip, netMatch.rawPort), 5000)
                                s.soTimeout = 15000
                                s.getOutputStream().apply { write(escpos); flush() }
                            }
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
                    }
                } else {
                    val opts = Opts("", "", "", true)
                    for (i in 0 until pagesArr.length()) {
                        val data = decode(pagesArr.getString(i))
                        sendIppJob(netMatch, "helper_" + System.currentTimeMillis(), data, widthMm, heightMm, opts)
                    }
                }
                return null
            }

            return "No printer found matching '$cleanName'."
        } catch (e: Exception) {
            Log.e(TAG, "printFromHelper failed", e)
            return e.message ?: "Printing failed"
        }
    }
}
