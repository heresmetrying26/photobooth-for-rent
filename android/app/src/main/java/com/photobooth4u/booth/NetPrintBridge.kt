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
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
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
        private const val SLOW_PROBE_MS = 2_500       // second pass for a printer that was asleep during the quick sweep
        private const val RESOLVE_MS = 4L            // seconds to wait for one Bonjour name to resolve
    }

    /** One local IPv4 network the tablet is on. [network] is set when Android knows it, so sockets can be bound to it. */
    private class LocalNet(val network: Network?, val addr: Inet4Address, val prefix: Int, val ifaceName: String = "")

    private class Entry(val ip: String) {
        @Volatile var name: String = ""
        @Volatile var ippPort: Int = 0
        @Volatile var ippPath: String = ""
        @Volatile var rawPort: Int = 0
        @Volatile var lpdPort: Int = 0
        @Volatile var lpdQueue: String = ""
        @Volatile var model: String = ""                       // "EPSON L3250 Series", from the printer itself
        @Volatile var webTried = false
        @Volatile var webHint: String = ""                     // vendor/model hint from HTTP :80 or SNMP :161
        @Volatile var formats: List<String> = emptyList()      // document formats it says it can print
        @Volatile var attrsTried = false
        @Volatile var attrsAttempts = 0
        @Volatile var qualities: List<Int> = emptyList()       // print-quality-supported: 3 draft, 4 normal, 5 high
        @Volatile var colorModes: List<String> = emptyList()   // print-color-mode-supported: color, monochrome...
        @Volatile var mediaTypes: List<String> = emptyList()   // media-type-supported: stationery, photographic-glossy...
        @Volatile var mediaReady: List<String> = emptyList()   // media-ready: the paper loaded now, e.g. "jpn_hagaki_100x148mm"
        @Volatile var mediaSupported: List<String> = emptyList() // media-supported: every paper size it names
        @Volatile var borderlessCap = false                    // it lists a margin of 0 (media-*-margin-supported) or a borderless paper name: it can print edge to edge
        @Volatile var pwgRes: List<Int> = emptyList()          // pwg-raster-document-resolution-supported (dpi)
        @Volatile var pwgTypes: List<String> = emptyList()     // pwg-raster-document-type-supported: srgb_8, sgray_8...
        @Volatile var stateReasons: List<String> = emptyList() // printer-state-reasons: none, media-empty-error, etc.
        @Volatile var usbDev: UsbDevice? = null                // set for a printer on the USB port
        @Volatile var lastSent: String = ""                    // how the printer last accepted a photo (paper name, scaling), for the printer report
        @Volatile var lastUnsupported: List<String> = emptyList() // group 0x05 unsupported-attributes echoed by printer
        @Volatile var lastAttempts: List<String> = emptyList() // per-attempt trace from the most recent IPP job
        @Volatile var lastJobStatus: String = ""               // post-print Get-Job-Attributes state / reasons
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
    private val lpdJobSeq = AtomicInteger(0)
    @Volatile private var probeTotal = 0
    private var usbReceiver: BroadcastReceiver? = null

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    /** Advertises that this APK supports streaming L8050 720 dpi ESC/P-R (with setm) and dynamic JFIF DPI over IPP. */
    @JavascriptInterface
    fun supportsL8050HiRes(): Boolean = true

    /** Advertises that this APK supports native streaming L3210 720/1440 dpi ESC/P-Raster and streaming 360 dpi ESC/P-R. */
    @JavascriptInterface
    fun supportsL3210HiRes(): Boolean = true

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
            .filter {
                it.ippPort > 0 || it.rawPort > 0 || (it.lpdPort > 0 && (
                    epsonLSeries(it.name) || epsonLSeries(it.model) ||
                        it.model.contains("epson", ignoreCase = true) || it.name.contains("epson", ignoreCase = true) ||
                        it.webHint.contains("epson", ignoreCase = true) || it.webHint == "LPD" ||
                        it.ip == "192.168.223.1"
                ))
            }
            .sortedWith(compareByDescending<Entry> { it.name.isNotBlank() }.thenBy { it.ip })
            .forEach {
                // An Epson ink-tank photo printer with no IPP (L805, L8050 on Wi-Fi Direct with only LPD :515, L120 on a
                // print server…) is not a receipt printer: it takes the same ESC/P-R job over port 9100 or LPD :515 (/PASSTHRU).
                val lpdOnly = it.ippPort == 0 && it.rawPort == 0 && it.lpdPort > 0
                val isHpKnown = it.model.contains("hp", ignoreCase = true) || it.name.contains("hp", ignoreCase = true) ||
                    it.model.contains("hewlett", ignoreCase = true) || it.webHint.contains("hp", ignoreCase = true)
                val isBrotherKnown = it.model.contains("brother", ignoreCase = true) || it.name.contains("brother", ignoreCase = true) ||
                    it.webHint.contains("brother", ignoreCase = true) || it.ip == "192.168.118.1"
                val isEpsonKnown = !isHpKnown && !isBrotherKnown && (epsonLSeries(it.name) || epsonLSeries(it.model) ||
                    it.model.contains("epson", ignoreCase = true) || it.name.contains("epson", ignoreCase = true) ||
                    it.webHint.contains("epson", ignoreCase = true) || it.ip == "192.168.223.1")
                val escprNet = it.ippPort == 0 && !isHpKnown && !isBrotherKnown && ((it.rawPort > 0 && (epsonLSeries(it.name) || epsonLSeries(it.model))) || (lpdOnly && (isEpsonKnown || it.webHint == "LPD")))
                val isL8050 = isL8050Name(it.model + " " + it.name)
                val displayName = it.name.ifBlank { it.model }.ifBlank {
                    when {
                        it.ip == "192.168.118.1" -> "Brother Wi-Fi Direct (${it.ip})"
                        it.ip == "192.168.223.1" -> if (isHpKnown) "HP Wi-Fi Direct (${it.ip})" else if (lpdOnly) "Epson Wi-Fi Direct (${it.ip})" else "Epson / HP Wi-Fi Direct (${it.ip})"
                        else -> "Printer at ${it.ip}"
                    }
                }
                val obj = JSONObject()
                    .put("id", it.ip)
                    .put("name", displayName)
                    .put("ip", it.ip)
                    .put("ipp", it.ippPort > 0)
                    .put("raw", it.rawPort > 0 && !escprNet)
                    .put("escpr", escprNet)
                    .put("lpd", it.lpdPort > 0)
                    .put("lpdPort", it.lpdPort)
                    .put("qualities", JSONArray(it.qualities))
                    .put("colorModes", JSONArray(it.colorModes))
                    .put("mediaTypes", JSONArray(it.mediaTypes))
                    .put("bcap", it.borderlessCap)
                if (isL8050) obj.put("epsonModel", "L8050")
                arr.put(obj)
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
            if (e.ippPort == 0 && e.rawPort == 0 && e.lpdPort == 0) {
                // Sleeping Wi-Fi / Wi-Fi Direct printer often wakes on the first knock and answers on the second.
                try { Thread.sleep(600) } catch (_: InterruptedException) {}
                probeInto(e, 3000)
            }
            if (e.ippPort > 0 || e.rawPort > 0 || e.lpdPort > 0) {
                val cur = found.getOrPut(clean) { e }
                if (cur !== e) {
                    if (cur.ippPort == 0) cur.ippPort = e.ippPort
                    if (cur.rawPort == 0) cur.rawPort = e.rawPort
                    if (cur.lpdPort == 0) cur.lpdPort = e.lpdPort
                }
                if (cur.ippPort > 0) fetchAttrs(cur)
                if (cur.ippPort == 0 && (cur.lpdPort > 0 || cur.rawPort > 0)) {
                    fetchWebModel(cur, force = true)
                    if (cur.lpdPort > 0 && cur.webHint.isBlank()) cur.webHint = "LPD"
                }
            } else {
                val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                val hint = if (active.isNotEmpty() && matchLocalNet(clean) == null) " (Tablet Wi-Fi is $active.)" else ""
                addNote = "Nothing at $clean answered on the printing ports (631, 9100, 515). Check the address, and that the tablet and printer are on the same Wi-Fi.$hint"
            }
        }
        return "ok"
    }

    /**
     * A short text about a Wi-Fi or USB printer for the "Copy printer report" button in Print settings: USB descriptors
     * (when on USB), what formats/resolutions it takes, the paper loaded and supported, and how it last accepted a photo.
     */
    @JavascriptInterface
    fun printerReport(ip: String): String {
        val ver = try { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName } catch (_: Exception) { "?" }
        fun list(l: List<String>) = if (l.isEmpty()) "(none given)" else l.joinToString(", ")
        if (ip.startsWith("usb:")) {
            val d = try { usbFind(ip) } catch (_: Exception) { usbEntries[ip]?.usbDev }
                ?: return "USB printer $ip is not connected right now. Plug it in and try again."
            val sb = StringBuilder()
            sb.append(usbProbeDevice(d))
            val ippIface = usbIppIface(d)
            if (ippIface != null && usb?.hasPermission(d) == true) {
                val e = usbEntries.getOrPut(ip) { Entry(ip) }.also { it.usbDev = d; it.ippPort = 1 }
                fetchAttrs(e)
                sb.append("IPP model: ").append(e.model.ifBlank { "(none)" }).append("\n")
                sb.append("Takes: ").append(list(e.formats)).append("\n")
                sb.append("PWG resolutions: ").append(if (e.pwgRes.isEmpty()) "(none)" else e.pwgRes.joinToString(", ") { "${it}dpi" }).append("\n")
                sb.append("PWG types: ").append(list(e.pwgTypes)).append("\n")
                sb.append("Paper loaded now: ").append(list(e.mediaReady)).append("\n")
                sb.append("Papers it lists: ").append(list(e.mediaSupported)).append("\n")
                sb.append("Paper types: ").append(list(e.mediaTypes)).append("\n")
                sb.append("Last photo accepted as: ").append(if (e.lastSent.isEmpty()) "no photo sent yet since the app opened" else e.lastSent).append("\n")
            }
            sb.append("App: ").append(ver)
            return sb.toString()
        }
        val e = found[ip] ?: return "Printer $ip is not in the list. Choose Find printers, then try again."
        if (e.ippPort > 0) fetchAttrs(e) else fetchWebModel(e)
        val netsText = currentNets().joinToString(", ") {
            "${it.ifaceName.ifEmpty { "net" }}:${it.addr.hostAddress}/${it.prefix}" + if (it.network != null) "[bound]" else "[iface]"
        }.ifEmpty { "(none)" }
        // A Wi-Fi Epson photo printer with no IPP (L805, L8050 on Wi-Fi Direct LPD :515...) takes Epson's own raster job: it lists no papers.
        val raw = when {
            e.ippPort <= 0 && e.rawPort > 0 -> "Sent in Epson's own print language (port " + e.rawPort + "); this printer lists no paper sizes.\n"
            e.ippPort <= 0 && e.lpdPort > 0 -> "Sent in Epson's own print language over LPD (port " + e.lpdPort + ", queue " + e.lpdQueue.ifBlank { "PASSTHRU" } + "); this printer lists no paper sizes.\n"
            else -> ""
        }
        return "Printer: " + e.model.ifBlank { e.name } + " (" + e.ip + ", ports ipp=" + e.ippPort + " raw=" + e.rawPort + " lpd=" + e.lpdPort + ", path=" + e.ippPath.ifBlank { "(none)" } + ")\n" +
            "Tablet nets: " + netsText + " · route: " + routeHintFor(e.ip) + "\n" + raw +
            "Takes: " + list(e.formats) + "\n" +
            "Qualities: " + (if (e.qualities.isEmpty()) "(none)" else e.qualities.joinToString(", ")) +
            " · Borderless cap: " + e.borderlessCap + "\n" +
            (if (e.stateReasons.isNotEmpty()) "State reasons: " + e.stateReasons.joinToString(", ") + "\n" else "") +
            (if (e.pwgRes.isNotEmpty() || e.pwgTypes.isNotEmpty())
                "PWG raster: " + (if (e.pwgRes.isEmpty()) "(default dpi)" else e.pwgRes.joinToString(", ") { "${it}dpi" }) +
                    " · " + list(e.pwgTypes) + "\n" else "") +
            "Paper loaded now: " + list(e.mediaReady) + "\n" +
            "Papers it lists: " + list(e.mediaSupported) + "\n" +
            "Paper types: " + list(e.mediaTypes) + "\n" +
            "Last photo accepted as: " + (if (e.lastSent.isEmpty()) "no photo sent yet since the app opened" else e.lastSent) + "\n" +
            (if (e.lastUnsupported.isNotEmpty()) "Printer ignored/unsupported: " + e.lastUnsupported.joinToString(", ") + "\n" else "") +
            (if (e.lastJobStatus.isNotEmpty()) "Last job status: " + e.lastJobStatus + "\n" else "") +
            (if (e.lastAttempts.isNotEmpty()) "Last attempts:\n  " + e.lastAttempts.takeLast(8).joinToString("\n  ") + "\n" else "") +
            "Device: " + Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")\n" +
            "App: " + ver
    }

    /** Probes every connected USB printer (even ones with no driver) to inspect interfaces (7/1/4 IPP-over-USB vs 7/1/2) and IEEE-1284 ID. */
    @JavascriptInterface
    fun usbProbe(): String {
        val m = usb ?: return "This tablet does not support USB host mode."
        val ver = try { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName } catch (_: Exception) { "?" }
        val devs = m.deviceList.values.filter { usbIsPrinter(it) || it.vendorId == BrotherUsbModels.VENDOR_ID }
        if (devs.isEmpty()) return "No USB printer detected on this tablet. Check the USB-OTG cable and printer power.\nApp: $ver"
        val sb = StringBuilder()
        for (d in devs) {
            sb.append(usbProbeDevice(d)).append("\n")
        }
        sb.append("App: ").append(ver)
        return sb.toString()
    }

    private fun usbIfacesSummary(d: UsbDevice): String = usbIfaces(d).joinToString("; ") { i ->
        "#${i.id} alt${i.alternateSetting} ${i.interfaceClass}/${i.interfaceSubclass}/${i.interfaceProtocol}" +
            if (hasBulkPair(i)) " bulk" else ""
    }

    private fun usbProbeDevice(d: UsbDevice): String {
        val perm = usb?.hasPermission(d) == true
        val ippIface = usbIppIface(d)
        var devId = usbIds[d.deviceName]
        if (devId == null && perm) {
            devId = try { usbDeviceId(d) } catch (_: Exception) { null }
            if (devId != null) usbIds[d.deviceName] = devId
        }
        val mfg = if (perm) try { d.manufacturerName?.trim() ?: "" } catch (_: Exception) { "" } else ""
        val prod = usbProduct(d) ?: ""
        return buildString {
            append("USB Printer: ").append(usbName(d))
                .append(" [VID=%04x PID=%04x]\n".format(d.vendorId, d.productId))
            if (mfg.isNotEmpty() || prod.isNotEmpty()) append("Descriptor: ").append(listOf(mfg, prod).filter { it.isNotEmpty() }.joinToString(" / ")).append("\n")
            append("Permission: ").append(if (perm) "granted" else "not granted yet").append("\n")
            append("Interfaces: ").append(usbIfacesSummary(d).ifEmpty { "(none)" }).append("\n")
            append("IPP-over-USB (7/1/4): ").append(
                if (ippIface != null) "YES (iface #${ippIface.id} alt${ippIface.alternateSetting})"
                else "NO — only legacy USB interface; use Wi-Fi / Wi-Fi Direct or Android print screen"
            ).append("\n")
            if (!devId.isNullOrBlank()) append("IEEE-1284 ID: ").append(devId.take(300)).append("\n")
        }
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
                val opts = Opts(o.optString("quality"), o.optString("color"), o.optString("media"), o.optBoolean("borderless"), o.optInt("dpi", 0))
                val adj = PrintColorAdj.from(o)
                val e = if (ip.startsWith("usb:")) {
                    usbEntry(ip)
                } else {
                    found[ip] ?: Entry(ip).also {
                        probeInto(it, 3500)
                        if (it.ippPort <= 0) {
                            // A sleeping Wi-Fi / Wi-Fi Direct printer often wakes on the first knock and answers on the second.
                            try { Thread.sleep(800) } catch (_: InterruptedException) {}
                            if (open(ip, 631, 3500)) it.ippPort = 631
                        }
                        if (it.ippPort > 0 || it.rawPort > 0 || it.lpdPort > 0) found.putIfAbsent(ip, it)
                    }
                }
                if (e.ippPort <= 0) {
                    if (e.rawPort <= 0 && !ip.startsWith("usb:")) {
                        if (e.lpdPort > 0) {
                            throw IllegalStateException("Could not reach printer at $ip on port 631 (only LPD port ${e.lpdPort} is open).")
                        }
                        val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                        val hint = if (active.isNotEmpty() && matchLocalNet(ip) == null) " (Tablet Wi-Fi is $active — if you switched between Wi-Fi and Wi-Fi Direct, tap Find printers.)" else ""
                        throw IllegalStateException("Could not reach printer at $ip on port 631. Check it is on and on the same Wi-Fi as the tablet.$hint")
                    }
                    throw IllegalStateException("This printer cannot receive photo print jobs.")
                }
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
                val copyCount = copies.coerceIn(1, 20)
                val totalSheets = copyCount * pages.size
                var sentCount = 0
                for (c in 0 until copyCount) {
                    for (p in pages) {
                        val (jid, jpath) = sendIppJob(e, job, p, widthMm, heightMm, opts)
                        sentCount++
                        // Canon SELPHY (CP1300 / CP1500) can stall mid-Yellow pass or reject with 0x0507 if the next sheet
                        // arrives while the current ~45s 4-pass dye-sub cycle is still running; wait for completion between sheets.
                        if (sentCount < totalSheets && isSelphy(e)) {
                            awaitSelphyIppIdle(e, jpath, jid)
                        }
                    }
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
    fun printRaw(job: String, ip: String, base64Data: String): String = printRawImpl(job, ip, base64Data, false)

    /** Same as printRaw, but over USB the bytes are paced for small-buffer 58 mm printers. */
    @JavascriptInterface
    fun printRawPaced(job: String, ip: String, base64Data: String): String = printRawImpl(job, ip, base64Data, true)

    private fun printRawImpl(job: String, ip: String, base64Data: String, paced: Boolean): String {
        pool.execute {
            val r = JSONObject().put("job", job)
            try {
                val data = Base64.decode(base64Data, Base64.DEFAULT)
                if (ip.startsWith("usb:")) usbRaw(ip, data, paced)
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

    /**
     * Sends one whole photo job to a Wi-Fi printer's port 9100. An inkjet answers with status bytes while it prints;
     * closing with those unread can make Android reset the connection and the printer drop the end of the page, so the
     * sending side is closed first and the answers are read until the printer hangs up (or goes quiet).
     */
    private fun netRawJob(ip: String, data: ByteArray) {
        val port = found[ip]?.rawPort?.takeIf { it > 0 } ?: 9100
        newSocket(ip).use { s ->
            try {
                s.connect(InetSocketAddress(ip, port), 6000)
            } catch (ex: Exception) {
                val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                val hint = if (active.isNotEmpty() && matchLocalNet(ip) == null) " (Tablet Wi-Fi is $active — if you switched between Wi-Fi and Wi-Fi Direct, tap Find printers.)" else ""
                throw IllegalStateException("Could not reach printer at $ip on port $port: ${ex.message ?: ex.javaClass.simpleName}.$hint", ex)
            }
            s.soTimeout = 30_000
            try {
                s.getOutputStream().apply { write(data); flush() }
            } catch (ex: Exception) {
                throw IllegalStateException("Printer at $ip stopped answering while receiving photo (${ex.message ?: ex.javaClass.simpleName}).", ex)
            }
            try {
                s.shutdownOutput()
                s.soTimeout = 3000
                val buf = ByteArray(512)
                val until = System.currentTimeMillis() + 20_000
                val inp = s.getInputStream()
                while (System.currentTimeMillis() < until && inp.read(buf) >= 0) { /* status bytes, not needed */ }
            } catch (_: Exception) {}
        }
    }

    /** Streams one whole photo job directly into port 9100 without buffering the full page in RAM. */
    private fun netRawStream(ip: String, portOverride: Int = 0, stream: ((ByteArray, Int) -> Unit) -> Unit) {
        val port = if (portOverride > 0) portOverride else (found[ip]?.rawPort?.takeIf { it > 0 } ?: 9100)
        newSocket(ip).use { s ->
            try {
                s.connect(InetSocketAddress(ip, port), 6000)
            } catch (ex: Exception) {
                val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                val hint = if (active.isNotEmpty() && matchLocalNet(ip) == null) " (Tablet Wi-Fi is $active — if you switched between Wi-Fi and Wi-Fi Direct, tap Find printers.)" else ""
                throw IllegalStateException("Could not reach printer at $ip on port $port: ${ex.message ?: ex.javaClass.simpleName}.$hint", ex)
            }
            s.soTimeout = 30_000
            val bos = BufferedOutputStream(s.getOutputStream(), 65536)
            try {
                stream { buf, len -> bos.write(buf, 0, len) }
                bos.flush()
            } catch (ex: Exception) {
                throw IllegalStateException("Printer at $ip stopped answering while receiving photo (${ex.message ?: ex.javaClass.simpleName}).", ex)
            }
            try {
                s.shutdownOutput()
                s.soTimeout = 3000
                val buf = ByteArray(512)
                val until = System.currentTimeMillis() + 20_000
                val inp = s.getInputStream()
                while (System.currentTimeMillis() < until && inp.read(buf) >= 0) { /* status bytes, not needed */ }
            } catch (_: Exception) {}
        }
    }

    /**
     * Streams a photo job over RFC 1179 LPD (port 515, default queue "PASSTHRU") without holding the
     * full job in RAM. Epson L8050/L3250/L805 firmware requires the exact byte count in the LPD
     * data-file header (\x03<len> dfA<job><host>\n), so we spool into a temp file in app cacheDir
     * (~0.8 MB bitmap RAM), send the binary control file ("l") first, then stream the data file in
     * 64 KB chunks and delete the temp file in finally.
     */
    private fun netLpdStream(
        ip: String,
        portOverride: Int = 0,
        queueOverride: String = "",
        stream: ((ByteArray, Int) -> Unit) -> Unit
    ): Pair<Long, String> {
        try {
            val cutoff = System.currentTimeMillis() - 600_000L
            activity.cacheDir.listFiles()?.forEach { f ->
                if (f.name.startsWith("pb_lpd_") && f.name.endsWith(".prn") && f.lastModified() < cutoff) {
                    try { f.delete() } catch (_: Exception) {}
                }
            }
        } catch (_: Exception) {}

        val tmp = File.createTempFile("pb_lpd_", ".prn", activity.cacheDir)
        try {
            BufferedOutputStream(FileOutputStream(tmp), 65536).use { fos ->
                stream { buf, len -> if (len > 0) fos.write(buf, 0, len) }
                fos.flush()
            }
            val fileLen = tmp.length()
            if (fileLen <= 0L) throw IllegalStateException("Empty print job (0 bytes).")
            val usedQueue = sendLpdFile(ip, portOverride, queueOverride, tmp, fileLen)
            return fileLen to usedQueue
        } finally {
            try { tmp.delete() } catch (_: Exception) {}
        }
    }

    private fun netLpdBytes(
        ip: String,
        data: ByteArray,
        portOverride: Int = 0,
        queueOverride: String = ""
    ): Pair<Long, String> {
        val usedQueue = sendLpdSource(ip, portOverride, queueOverride, data.size.toLong()) { out ->
            out.write(data)
        }
        return data.size.toLong() to usedQueue
    }

    private fun sendLpdFile(
        ip: String,
        portOverride: Int,
        queueOverride: String,
        file: File,
        fileLen: Long
    ): String = sendLpdSource(ip, portOverride, queueOverride, fileLen) { out ->
        FileInputStream(file).use { fis ->
            val buf = ByteArray(65536)
            var rem = fileLen
            while (rem > 0L) {
                val n = fis.read(buf, 0, minOf(buf.size.toLong(), rem).toInt())
                if (n <= 0) throw IllegalStateException("Unexpected end of LPD spool file.")
                out.write(buf, 0, n)
                rem -= n.toLong()
            }
        }
    }

    private fun sendLpdSource(
        ip: String,
        portOverride: Int,
        queueOverride: String,
        dataLen: Long,
        writeData: (BufferedOutputStream) -> Unit
    ): String {
        val port = if (portOverride > 0) portOverride else (found[ip]?.lpdPort?.takeIf { it > 0 } ?: 515)
        val queues = LinkedHashSet<String>()
        if (queueOverride.isNotBlank()) queues.add(queueOverride.trim())
        found[ip]?.lpdQueue?.takeIf { it.isNotBlank() }?.let { queues.add(it.trim()) }
        queues.add("PASSTHRU")
        queues.add("LPT1")
        queues.add("AUTO")
        queues.add("lp")
        queues.add("raw")

        val tried = LinkedHashSet<String>()
        var lastQueueErr = ""
        // Allow 1 retry after 1.5s if port 515 accepted TCP but NACKed all queues (e.g. briefly busy finishing previous sheet)
        for (attempt in 0..1) {
            if (attempt > 0) {
                try { Thread.sleep(1500) } catch (_: InterruptedException) {}
            }
            for (queue in queues) {
                tried.add(queue)
                var stage = 0 // 0=connect, 1=queue-ack, 2=sending-job, 3=final-ack
                var accepted = false
                try {
                    newSocket(ip).use { s ->
                        try {
                            s.connect(InetSocketAddress(ip, port), 6000)
                        } catch (ex: Exception) {
                            val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                            val hint = if (active.isNotEmpty() && matchLocalNet(ip) == null) " (Tablet Wi-Fi is $active — if you switched between Wi-Fi and Wi-Fi Direct, tap Find printers.)" else ""
                            throw IllegalStateException("Could not reach printer at $ip on LPD port $port: ${ex.message ?: ex.javaClass.simpleName}.$hint", ex)
                        }
                        stage = 1
                        s.soTimeout = 15_000
                        val inp = s.getInputStream()
                        val bos = BufferedOutputStream(s.getOutputStream(), 65536)

                        // RFC 1179 §5.2: Receive a printer job (\x02<queue>\n)
                        bos.write(0x02)
                        bos.write(queue.toByteArray(Charsets.US_ASCII))
                        bos.write(0x0A)
                        bos.flush()
                        val qAck = inp.read()
                        if (qAck != 0) {
                            lastQueueErr = "queue=$queue ack=$qAck"
                            Log.w(TAG, "LPD $ip:$port rejected queue '$queue' (ack=$qAck); trying next")
                        } else {
                            found.getOrPut(ip) { Entry(ip) }.let { entry ->
                                if (entry.lpdPort <= 0) entry.lpdPort = port
                                entry.lpdQueue = queue
                            }

                            stage = 2
                            val jobNum = ((lpdJobSeq.incrementAndGet() and 0x7FFFFFFF) % 999) + 1
                            val job3 = "%03d".format(jobNum)
                            val host = "pb4u"
                            val cfName = "cfA$job3$host"
                            val dfName = "dfA$job3$host"
                            // RFC 1179 §7: lowercase 'l' = binary passthrough (leave control characters untouched!)
                            val cfBytes = ("H$host\nPphotobooth\nJ$host\nl$dfName\nU$dfName\nNpb4u.prn\n").toByteArray(Charsets.US_ASCII)

                            // RFC 1179 §6.2: Receive control file FIRST so Epson streams incoming data directly as binary
                            bos.write(0x02)
                            bos.write("${cfBytes.size} $cfName\n".toByteArray(Charsets.US_ASCII))
                            bos.flush()
                            val cfHdrAck = inp.read()
                            if (cfHdrAck != 0) throw IllegalStateException("LPD control-file header rejected (ack=$cfHdrAck).")

                            bos.write(cfBytes)
                            bos.write(0x00)
                            bos.flush()
                            val cfAck = inp.read()
                            if (cfAck != 0) throw IllegalStateException("LPD control-file body rejected (ack=$cfAck).")

                            // RFC 1179 §6.3: Receive data file with EXACT byte count
                            s.soTimeout = 30_000
                            bos.write(0x03)
                            bos.write("$dataLen $dfName\n".toByteArray(Charsets.US_ASCII))
                            bos.flush()
                            val dfHdrAck = inp.read()
                            if (dfHdrAck != 0) throw IllegalStateException("LPD data-file header rejected for $dataLen bytes (ack=$dfHdrAck).")

                            writeData(bos)
                            bos.write(0x00)
                            bos.flush()

                            stage = 3
                            // Epson may finish feeding/printing before sending the final 0x00 ACK (up to ~45s at 720 dpi)
                            s.soTimeout = 90_000
                            val dfAck = inp.read()
                            if (dfAck == -1) {
                                Log.w(TAG, "LPD $ip:$port/$queue closed cleanly on final ACK after $dataLen bytes; treating as accepted")
                            } else if (dfAck != 0) {
                                throw IllegalStateException("Printer at $ip rejected LPD print data on queue $queue (code $dfAck).")
                            }
                            Log.i(TAG, "LPD $ip:$port/$queue accepted $dataLen bytes (job $job3)")
                            accepted = true
                        }
                    }
                } catch (ex: Exception) {
                    if (stage == 0) throw ex
                    if (stage == 1) {
                        lastQueueErr = "queue=$queue (${ex.message ?: ex.javaClass.simpleName})"
                        continue
                    }
                    if (stage == 3 && ex is java.net.SocketTimeoutException) {
                        throw IllegalStateException("Printer at $ip took too long to answer after receiving LPD photo.", ex)
                    }
                    if (ex is IllegalStateException && ex.message?.startsWith("Printer at ") == true) throw ex
                    throw IllegalStateException("Printer at $ip stopped answering while receiving LPD photo (${ex.message ?: ex.javaClass.simpleName}).", ex)
                }
                if (accepted) return queue
            }
        }
        throw IllegalStateException("Could not reach LPD print queue on $ip:$port (rejected ${tried.joinToString(", ")}; $lastQueueErr).")
    }

    private fun deliver(r: JSONObject) {
        val js = "window.__PBNetResult&&window.__PBNetResult(" + r.toString() + ")"
        activity.runOnUiThread { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
    }

    private fun deliverDiag(r: JSONObject) {
        val js = "window.__PBNetDiagResult&&window.__PBNetDiagResult(" + r.toString() + ")"
        activity.runOnUiThread { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
    }

    private fun emitIppWarn(message: String) {
        val obj = JSONObject().put("message", message)
        val js = "window.__PBIppWarn&&window.__PBIppWarn(" + obj.toString() + ")"
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
            type.startsWith("_printer") -> {
                e.lpdPort = if (i.port > 0) i.port else 515
                val rp = attr("rp")
                if (rp.isNotBlank()) e.lpdQueue = rp.trimStart('/')
            }
        }
        if (e.ippPort > 0) pool.execute { fetchAttrs(e) }
        else if (e.lpdPort > 0 || e.rawPort > 0) pool.execute { fetchWebModel(e) }
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
                val ifName = lp.interfaceName ?: ""
                for (la in lp.linkAddresses) {
                    val a = la.address
                    if (a is Inet4Address && !a.isLoopbackAddress && !a.isLinkLocalAddress) out.add(LocalNet(n, a, la.prefixLength, ifName))
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
                    if (a is Inet4Address && a.isSiteLocalAddress && out.none { it.addr == a }) out.add(LocalNet(null, a, ia.networkPrefixLength.toInt(), ni.name))
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

    private fun matchLocalNet(ip: String): LocalNet? {
        try {
            val a = InetAddress.getByName(ip) as? Inet4Address ?: return null
            val v = ipLong(a)
            fun findIn(list: List<LocalNet>): LocalNet? {
                // Prefer Android-managed Network objects first (socketFactory binding beats mobile data on Wi-Fi Direct).
                for (n in list) {
                    if (n.network == null) continue
                    val mask = if (n.prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - n.prefix.coerceAtMost(32))) and 0xFFFFFFFFL
                    if ((ipLong(n.addr) and mask) == (v and mask)) return n
                }
                for (n in list) {
                    val mask = if (n.prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - n.prefix.coerceAtMost(32))) and 0xFFFFFFFFL
                    if ((ipLong(n.addr) and mask) == (v and mask)) return n
                }
                return null
            }
            findIn(currentNets())?.let { return it }
            // Refresh immediately on a subnet miss (>500 ms old) so switching Router Wi-Fi <-> Wi-Fi Direct (192.168.223.1)
            // binds to the new interface right away instead of leaking sockets onto 4G/5G mobile data.
            if (System.currentTimeMillis() - netsAt > 500) {
                nets = localNets(); netsAt = System.currentTimeMillis()
                return findIn(nets)
            }
        } catch (_: Exception) {}
        return null
    }

    private fun routeHintFor(ip: String): String {
        val n = matchLocalNet(ip)
        if (n == null) {
            val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }.ifEmpty { "none" }
            return "default-route (printer $ip is not on active Wi-Fi subnets: $active)"
        }
        val mode = if (n.network != null) "bound-network" else "bound-local-ip"
        return "$mode:${n.ifaceName.ifEmpty { "wifi" }}(${n.addr.hostAddress}/${n.prefix})"
    }

    /** A socket that goes out over the Wi-Fi or Wi-Fi Direct interface the printer is on, even when Android prefers mobile data because that Wi-Fi has no internet. */
    private fun newSocket(ip: String): Socket {
        try {
            val n = matchLocalNet(ip)
            if (n != null) {
                val net = n.network
                if (net != null) return net.socketFactory.createSocket()
                // Wi-Fi Direct P2P interface (e.g. p2p-wlan0-0) not registered in ConnectivityManager: bind source IP so Linux routes out that interface.
                val s = Socket()
                try { s.bind(InetSocketAddress(n.addr, 0)) } catch (be: Exception) { Log.w(TAG, "local ip bind", be) }
                return s
            }
        } catch (e: Exception) { Log.w(TAG, "bound socket", e) }
        return Socket()
    }

    /**
     * Looks for printer ports on the networks the tablet is on: gateway / Wi-Fi Direct `.1` addresses FIRST
     * (e.g. Epson Wi-Fi Direct `192.168.223.1`), then the rest of the tablet's own /24, then any larger subnet (up to /22).
     */
    private fun sweepSubnet(id: Int) {
        nets = localNets(); netsAt = System.currentTimeMillis()
        val list = nets
        val targets = LinkedHashSet<Long>()
        val mine = HashSet<Long>()
        for (n in list) {
            mine.add(ipLong(n.addr))
            val base = ipLong(n.addr) and 0xFFFFFF00L
            targets.add(base or 1L)                                // Wi-Fi Direct / router gateway first (192.168.223.1 etc.)
        }
        for (n in list) {
            val base = ipLong(n.addr) and 0xFFFFFF00L
            for (h in 2L..254L) targets.add(base or h)
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
        // Second, slower look at the tablet's own /24 for the addresses that stayed silent. A Wi-Fi printer that is
        // asleep (Brother, Epson, HP…) often misses the first quick knock and only answers after being woken by it.
        val ownBases = HashSet<Long>()
        for (n in list) ownBases.add(ipLong(n.addr) and 0xFFFFFF00L)
        val slow = targets.filter { (it and 0xFFFFFF00L) in ownBases }
        probeTotal = targets.size + slow.size
        for (v in targets) {
            val ip = ipText(v)
            scanPool.execute {
                try { if (scanning && scanId == id) probe(ip) } finally { probed.incrementAndGet() }
            }
        }
        for (v in slow) {
            val ip = ipText(v)
            scanPool.execute {
                try { if (scanning && scanId == id) probeSlow(ip) } finally { probed.incrementAndGet() }
            }
        }
    }

    /** Patient retry for an address the quick sweep got no answer from: IPP (631) or LPD (515) with time to wake up. */
    private fun probeSlow(ip: String) {
        if (found[ip]?.let { it.ippPort > 0 || it.rawPort > 0 || it.lpdPort > 0 } == true) return
        val hasIpp = open(ip, 631, SLOW_PROBE_MS)
        val hasLpd = if (hasIpp) false else open(ip, 515, if (ip.endsWith(".1")) SLOW_PROBE_MS else 1000)
        if (!hasIpp && !hasLpd) return
        val e = Entry(ip)
        if (hasIpp) e.ippPort = 631
        if (hasLpd) e.lpdPort = 515
        val cur = found.getOrPut(ip) { e }
        if (hasIpp && cur.ippPort == 0) cur.ippPort = 631
        if (hasLpd && cur.lpdPort == 0) cur.lpdPort = 515
        if (cur.ippPort > 0) fetchAttrs(cur) else fetchWebModel(cur)
    }

    private fun open(ip: String, port: Int, timeoutMs: Int = PROBE_MS): Boolean = try {
        newSocket(ip).use { it.connect(InetSocketAddress(ip, port), timeoutMs); true }
    } catch (_: Exception) { false }

    private fun probe(ip: String) {
        val e = Entry(ip)
        probeInto(e)
        if (e.ippPort > 0 || e.rawPort > 0 || e.lpdPort > 0) {
            if (e.ippPort == 0 && (e.lpdPort > 0 || e.rawPort > 0) && found[ip] == null) {
                fetchWebModel(e)
            }
            val cur = found.getOrPut(ip) { e }
            if (cur !== e) {
                if (cur.ippPort == 0) cur.ippPort = e.ippPort
                if (cur.rawPort == 0) cur.rawPort = e.rawPort
                if (cur.lpdPort == 0) cur.lpdPort = e.lpdPort
                if (cur.model.isBlank() && e.model.isNotBlank()) cur.model = e.model
                if (cur.name.isBlank() && e.name.isNotBlank()) cur.name = e.name
                if (cur.webHint.isBlank() && e.webHint.isNotBlank()) cur.webHint = e.webHint
            }
            if (cur.ippPort > 0) fetchAttrs(cur)
            else if (cur.lpdPort > 0 || cur.rawPort > 0) fetchWebModel(cur)
        }
    }

    private fun probeInto(e: Entry, timeoutMs: Int = PROBE_MS) {
        if (e.ippPort == 0 && open(e.ip, 631, timeoutMs)) e.ippPort = 631
        if (e.rawPort == 0 && open(e.ip, 9100, timeoutMs)) e.rawPort = 9100
        if (e.lpdPort == 0 && open(e.ip, 515, timeoutMs)) e.lpdPort = 515
    }

    private fun newUdpSocket(ip: String): DatagramSocket {
        try {
            val n = matchLocalNet(ip)
            if (n != null) {
                val net = n.network
                if (net != null) {
                    val ds = DatagramSocket()
                    try { net.bindSocket(ds) } catch (be: Exception) { Log.w(TAG, "udp net bind", be) }
                    return ds
                }
                return DatagramSocket(InetSocketAddress(n.addr, 0))
            }
        } catch (e: Exception) { Log.w(TAG, "bound udp socket", e) }
        return DatagramSocket()
    }

    private fun cleanModelName(s: String): String =
        s.replace(Regex("[\\r\\n\\t\\x00-\\x1F]+"), " ").replace(Regex("\\s{2,}"), " ").trim().take(64)

    private fun snmpTlv(tag: Int, body: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(body.size + 4)
        out.write(tag)
        val n = body.size
        when {
            n < 0x80 -> out.write(n)
            n < 0x100 -> { out.write(0x81); out.write(n) }
            else -> { out.write(0x82); out.write((n shr 8) and 0xFF); out.write(n and 0xFF) }
        }
        out.write(body)
        return out.toByteArray()
    }

    private fun snmpEncodeOid(arcs: IntArray): ByteArray {
        val out = ByteArrayOutputStream(24)
        out.write(arcs[0] * 40 + arcs[1])
        for (i in 2 until arcs.size) {
            var v = arcs[i]
            if (v < 0x80) {
                out.write(v)
            } else {
                val tmp = IntArray(5)
                var k = 0
                tmp[k++] = v and 0x7F
                v = v ushr 7
                while (v > 0) {
                    tmp[k++] = (v and 0x7F) or 0x80
                    v = v ushr 7
                }
                for (j in k - 1 downTo 0) out.write(tmp[j])
            }
        }
        return snmpTlv(0x06, out.toByteArray())
    }

    private fun snmpBuildGet(oid: IntArray, reqId: Int): ByteArray {
        val vb = snmpTlv(0x30, snmpEncodeOid(oid) + byteArrayOf(0x05, 0x00))
        val vbl = snmpTlv(0x30, vb)
        val pduBody = byteArrayOf(
            0x02, 0x01, (reqId and 0x7F).toByte(),
            0x02, 0x01, 0x00,
            0x02, 0x01, 0x00
        ) + vbl
        val pdu = snmpTlv(0xA0, pduBody)
        val msgBody = byteArrayOf(
            0x02, 0x01, 0x00,
            0x04, 0x06, 'p'.code.toByte(), 'u'.code.toByte(), 'b'.code.toByte(), 'l'.code.toByte(), 'i'.code.toByte(), 'c'.code.toByte()
        ) + pdu
        return snmpTlv(0x30, msgBody)
    }

    private fun snmpParseOctetString(buf: ByteArray, len: Int): String {
        fun readLen(pos: Int): Pair<Int, Int>? {
            if (pos >= len) return null
            val b = buf[pos].toInt() and 0xFF
            if (b < 0x80) return b to (pos + 1)
            val cnt = b and 0x7F
            if (cnt == 0 || cnt > 2 || pos + 1 + cnt > len) return null
            var v = 0
            for (i in 0 until cnt) v = (v shl 8) or (buf[pos + 1 + i].toInt() and 0xFF)
            return v to (pos + 1 + cnt)
        }
        if (len < 12 || (buf[0].toInt() and 0xFF) != 0x30) return ""
        val top = readLen(1) ?: return ""
        var p = top.second
        val topEnd = minOf(len, p + top.first)
        while (p < topEnd) {
            val tag = buf[p].toInt() and 0xFF
            val lv = readLen(p + 1) ?: return ""
            val vStart = lv.second
            val vEnd = minOf(topEnd, vStart + lv.first)
            if (tag == 0xA2) {
                var q = vStart
                var intsSeen = 0
                while (q < vEnd) {
                    val t2 = buf[q].toInt() and 0xFF
                    val lv2 = readLen(q + 1) ?: return ""
                    val s2 = lv2.second
                    val e2 = minOf(vEnd, s2 + lv2.first)
                    if (t2 == 0x02) {
                        intsSeen++
                        if (intsSeen == 2 && (lv2.first != 1 || s2 >= e2 || (buf[s2].toInt() and 0xFF) != 0)) return ""
                    } else if (t2 == 0x30) {
                        if (s2 < e2 && (buf[s2].toInt() and 0xFF) == 0x30) {
                            val lv3 = readLen(s2 + 1) ?: return ""
                            var r = lv3.second
                            val e3 = minOf(e2, r + lv3.first)
                            while (r < e3) {
                                val t4 = buf[r].toInt() and 0xFF
                                val lv4 = readLen(r + 1) ?: return ""
                                val s4 = lv4.second
                                val e4 = minOf(e3, s4 + lv4.first)
                                if (t4 == 0x04 && e4 > s4) {
                                    return String(buf, s4, e4 - s4, Charsets.UTF_8).trim()
                                }
                                r = e4
                            }
                        }
                    }
                    q = e2
                }
                return ""
            }
            p = vEnd
        }
        return ""
    }

    /** Queries SNMPv1 UDP :161 for printer model (hrDeviceDescr.1, Epson IEEE-1284 Device ID, sysDescr.0). Returns Pair(model, vendorHint). */
    private fun snmpQueryModel(ip: String): Pair<String, String> {
        val target = try { InetAddress.getByName(ip) } catch (_: Exception) { return "" to "" }
        val oids = arrayOf(
            intArrayOf(1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 3, 1),              // hrDeviceDescr.1 -> "EPSON L8050 Series"
            intArrayOf(1, 3, 6, 1, 4, 1, 1248, 1, 2, 2, 1, 1, 1, 2, 1),   // Epson IEEE-1284 Device ID
            intArrayOf(1, 3, 6, 1, 2, 1, 1, 1, 0)                         // sysDescr.0 -> "EPSON Built-in ..."
        )
        var vendorHint = ""
        var genericModel = ""
        val modelDigitRx = Regex("\\d{3,}")
        val ds = try { newUdpSocket(ip) } catch (_: Exception) { return "" to "" }
        try {
            ds.soTimeout = 450
            val rx = ByteArray(1500)
            for (idx in oids.indices) {
                try {
                    val req = snmpBuildGet(oids[idx], idx + 1)
                    ds.send(DatagramPacket(req, req.size, target, 161))
                    val pkt = DatagramPacket(rx, rx.size)
                    ds.receive(pkt)
                    val txt = snmpParseOctetString(pkt.data, pkt.length)
                    if (txt.isBlank()) continue
                    if (txt.contains("epson", ignoreCase = true) && vendorHint.isBlank()) vendorHint = "EPSON"
                    if (idx == 0) {
                        val cleaned = cleanModelName(txt)
                        if (cleaned.isNotBlank()) {
                            if (modelDigitRx.containsMatchIn(cleaned)) {
                                return cleaned to (if (cleaned.contains("epson", ignoreCase = true)) "EPSON" else vendorHint)
                            }
                            genericModel = cleaned
                        }
                    }
                    if (idx == 1) {
                        val des = Regex("(?i)(?:DES|DESCRIPTION):([^;]+)").find(txt)?.groupValues?.get(1)?.trim()
                        val mdl = Regex("(?i)(?:MDL|MODEL):([^;]+)").find(txt)?.groupValues?.get(1)?.trim()
                        val mfg = Regex("(?i)(?:MFG|MANUFACTURER):([^;]+)").find(txt)?.groupValues?.get(1)?.trim()
                        val picked = des?.takeIf { it.isNotBlank() }
                            ?: if (!mdl.isNullOrBlank()) (if (!mfg.isNullOrBlank() && !mdl.startsWith(mfg, ignoreCase = true)) "$mfg $mdl" else mdl) else null
                        if (!picked.isNullOrBlank()) return cleanModelName(picked) to (if (picked.contains("epson", ignoreCase = true)) "EPSON" else vendorHint)
                    }
                    if (idx == 2 && epsonLSeries(txt)) {
                        return cleanModelName(txt) to "EPSON"
                    }
                } catch (_: java.net.SocketTimeoutException) {
                    if (idx == 0) break // SNMP unreachable on this host; skip remaining OIDs
                } catch (_: Exception) {}
            }
        } finally {
            try { ds.close() } catch (_: Exception) {}
        }
        return genericModel to vendorHint
    }

    private fun httpGetSimple(ip: String, path: String): String {
        return try {
            newSocket(ip).use { s ->
                s.connect(InetSocketAddress(ip, 80), 1200)
                s.soTimeout = 1500
                val req = "GET $path HTTP/1.1\r\nHost: $ip\r\nUser-Agent: photobooth4u\r\nConnection: close\r\n\r\n"
                s.getOutputStream().apply { write(req.toByteArray(Charsets.US_ASCII)); flush() }
                val inp = s.getInputStream()
                val buf = ByteArrayOutputStream(8192)
                val tmp = ByteArray(2048)
                while (buf.size() < 32768) {
                    val n = try { inp.read(tmp) } catch (_: Exception) { -1 }
                    if (n <= 0) break
                    buf.write(tmp, 0, n)
                }
                String(buf.toByteArray(), Charsets.ISO_8859_1)
            }
        } catch (_: Exception) { "" }
    }

    /** Probes HTTP port 80 Web Config (e.g. Epson /PRESENTATION/HTML/TOP/INDEX.HTML) for model name and vendor hint. */
    private fun httpProbeModel(ip: String): Pair<String, String> {
        val paths = ArrayList<String>()
        paths.add("/PRESENTATION/HTML/TOP/INDEX.HTML")
        paths.add("/")
        var vendorHint = ""
        val epsonModelRx = Regex("(?i)EPSON\\s+(?:L\\s?\\d{3,5}|ET-?\\d{3,5}|M\\d{3,4}|XP-?\\d{3,4}|WF-?[A-Z0-9-]+|SC-?[A-Z0-9-]+)(?:\\s+Series)?")
        val bareLModelRx = Regex("(?i)\\b(?:L\\s?\\d{3,5}|ET-?\\d{3,5})(?:\\s+Series)?\\b")
        val titleRx = Regex("(?is)<title[^>]*>\\s*([^<]{2,80})\\s*</title>")
        val locRx = Regex("(?im)^Location:\\s*(\\S+)")
        val visited = HashSet<String>()
        var idx = 0
        while (idx < paths.size && visited.size < 3) {
            val path = paths[idx++]
            if (!visited.add(path)) continue
            val raw = httpGetSimple(ip, path)
            if (raw.isBlank()) continue
            val hdrEnd = raw.indexOf("\r\n\r\n").let { if (it >= 0) it else raw.indexOf("\n\n") }
            val hdrs = if (hdrEnd > 0) raw.substring(0, hdrEnd) else raw.take(1024)
            val body = if (hdrEnd > 0) raw.substring(hdrEnd) else raw
            if (hdrs.contains("EPSON", ignoreCase = true) || hdrs.contains("/PRESENTATION/HTML/", ignoreCase = true) || body.contains("EPSON", ignoreCase = true)) {
                vendorHint = "EPSON"
            }
            val title = titleRx.find(body)?.groupValues?.get(1)?.let { cleanModelName(it) } ?: ""
            if (title.isNotBlank() && !title.equals("Web Config", ignoreCase = true) && !title.startsWith("301") && !title.startsWith("302") && !title.startsWith("404") && !title.contains("Moved", ignoreCase = true)) {
                val eHit = epsonModelRx.find(title)?.value
                if (!eHit.isNullOrBlank()) {
                    return cleanModelName(eHit) to "EPSON"
                }
                val bHit = if (vendorHint == "EPSON") bareLModelRx.find(title)?.value else null
                if (!bHit.isNullOrBlank()) {
                    val m = cleanModelName(bHit)
                    return (if (m.startsWith("EPSON", ignoreCase = true)) m else "EPSON $m") to "EPSON"
                }
            }
            val bodyHit = epsonModelRx.find(body)?.value
            if (!bodyHit.isNullOrBlank()) {
                return cleanModelName(bodyHit) to "EPSON"
            }
            // Follow 1 same-host HTTP redirect if present (skip https:// since we never bypass TLS verification)
            val loc = locRx.find(hdrs)?.groupValues?.get(1)?.trim() ?: ""
            if (loc.startsWith("/") && !visited.contains(loc)) {
                paths.add(loc)
            } else if (loc.startsWith("http://$ip/", ignoreCase = true)) {
                val rel = loc.substring("http://$ip".length)
                if (rel.startsWith("/") && !visited.contains(rel)) paths.add(rel)
            }
        }
        return "" to vendorHint
    }

    /** Identifies a printer without IPP (e.g. LPD :515 only) via SNMPv1 :161 and HTTP :80 Web Config. */
    private fun fetchWebModel(e: Entry, force: Boolean = false): String {
        if (e.usbDev != null) return e.model.ifBlank { e.name }
        if (!force && (e.webTried || e.model.isNotBlank())) return e.model.ifBlank { e.name }
        synchronized(e) {
            if (!force && (e.webTried || e.model.isNotBlank())) return e.model.ifBlank { e.name }
            e.webTried = true
            val snmp = snmpQueryModel(e.ip)
            if (snmp.second.isNotBlank() && e.webHint.isBlank()) e.webHint = snmp.second
            if (snmp.first.isNotBlank()) {
                e.model = snmp.first
                if (e.name.isBlank() || e.name.startsWith("Printer at ", ignoreCase = true)) e.name = snmp.first
                e.webHint = snmp.first
                Log.i(TAG, "SNMP model for ${e.ip}: ${snmp.first}")
                return snmp.first
            }
            val web = httpProbeModel(e.ip)
            if (web.second.isNotBlank() && e.webHint.isBlank()) e.webHint = web.second
            if (web.first.isNotBlank()) {
                e.model = web.first
                if (e.name.isBlank() || e.name.startsWith("Printer at ", ignoreCase = true)) e.name = web.first
                e.webHint = web.first
                Log.i(TAG, "HTTP :80 model for ${e.ip}: ${web.first}")
                return web.first
            }
            return e.model.ifBlank { e.name }
        }
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
        // VIDs VOZY / VOXY units are known to use across batches
        private val VENDOR_IDS = setOf(0x28e9, 0x0416, 0x6868, 0x0483, 0x0fe6, 0x1fc9, 0x4b43)
        private val INKJET_VIDS = setOf(0x04b8, 0x04a9, 0x03f0, 0x04f9)
        private val MODEL_CODE_RX = Regex("(?<![A-Z0-9])(?:G80|V80|P50|MP[-_ ]?210)(?![0-9])")

        private fun safeProdUpper(d: android.hardware.usb.UsbDevice): String =
            try { (d.productName ?: "").uppercase() } catch (_: Exception) { "" }

        fun isKnown(d: android.hardware.usb.UsbDevice): Boolean {
            if (d.vendorId in INKJET_VIDS) return false
            val name = safeProdUpper(d)
            if (name.contains("VOZY") || name.contains("VOXY")) return true
            if (d.vendorId !in VENDOR_IDS) return false
            return MODEL_CODE_RX.containsMatchIn(name)
        }

        fun modelName(d: android.hardware.usb.UsbDevice): String {
            val name = safeProdUpper(d)
            return when {
                name.contains("V80")  -> "VOZY V80"
                name.contains("G80")  -> "VOZY G80"
                name.contains("P50")  -> "VOZY P50"
                name.contains("MP210") || name.contains("MP-210") || name.contains("MP 210") -> "VOZY MP210"
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
        (d.vendorId == CanonSelphyJob.VENDOR_ID && (d.productId in CanonSelphyJob.PRODUCT_IDS || (try { d.productName ?: "" } catch (_: Exception) { "" }).contains("SELPHY", true))) ||
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
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol in 1..2 && hasBulkPair(it) }
            ?: usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && it.interfaceProtocol in 1..2 }

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

        // Map of INF-verified USB Product ID → friendly model name (do NOT add unverified PIDs here)
        val MODELS: Map<Int, String> = mapOf(
            0x0866 to "L8050",
            0xE671 to "L3210",
            0x445A to "L3276"   // L3270-series PID; L3276 is the Wi-Fi variant
        )

        fun match(d: UsbDevice): String? {
            if (d.vendorId != VENDOR_ID) return null
            MODELS[d.productId]?.let { return it }
            // Other ESC/P-R models (L805, L3250, L210…) intentionally go through usbIsEscpr -> printEscpr(epsonBorderless=true).
            val prod = try { d.productName ?: "" } catch (_: Exception) { "" }
            return if (Regex("(?i)(?:^|[^A-Za-z0-9])L8050(?![0-9])").containsMatchIn(prod)) "L8050" else null
        }

        /** True when this is one of the three hardcoded Epson photo/AIO printers. */
        fun isKnown(d: UsbDevice): Boolean = match(d) != null

        /** True for models that support borderless photo printing (L8050, L3210, L3276). */
        fun isBorderless(d: UsbDevice): Boolean = isKnown(d)
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Hardcoded Epson ESC/P2 printers (L120, L121) ─────────────────────────
    // VID 0x04B8 = Seiko Epson Corp.
    // Only L120 / L121 are ESC/P2-only (CMD:ESCPL2); L130 / L210 / L220 support ESC/P-R via usbIsEscpr.
    object EpsonEscp2Models {
        const val VENDOR_ID = 0x04B8

        val MODELS: Map<Int, String> = mapOf(
            0x005E to "L120",   // Epson L120 / L121 USB PID (94)
            0x005F to "L121"
        )

        fun match(d: UsbDevice): String? {
            if (d.vendorId != VENDOR_ID) return null
            MODELS[d.productId]?.let { return it }
            val prod = try { d.productName ?: "" } catch (_: Exception) { "" }
            if (prod.contains("L121", ignoreCase = true)) return "L121"
            if (prod.contains("L120", ignoreCase = true)) return "L120"
            return null
        }

        fun isKnown(d: UsbDevice): Boolean = match(d) != null
    }

    // ── Hardcoded Canon PIXMA G-series 4-ink USB printers (G1000–G4000) ──────
    // VID 0x04A9 = Canon Inc.
    // Only 4-ink G1000–G4000 models speak 4-ink IVEC XML + BJRaster over USB (6-ink G570/G620/G650 use IPP-over-USB 7/1/4).
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

    // ── Brother ink-tank USB models (VID 0x04F9) ─────────────────────────────
    // Recognised by USB VID/PID so they display cleanly before USB product descriptor is read
    // and can be probed cleanly for IPP-over-USB (7/1/4) vs legacy HBP/PJL (7/1/2).
    private object BrotherUsbModels {
        const val VENDOR_ID = 0x04F9

        val MODELS: Map<Int, String> = mapOf(
            0x0475 to "DCP-T420W",
            0x0474 to "DCP-T220",
            0x0476 to "DCP-T520W",
            0x0477 to "DCP-T720DW",
            0x0478 to "DCP-T820DW"
        )

        fun match(d: UsbDevice): String? =
            if (d.vendorId == VENDOR_ID) MODELS[d.productId] else null
    }

    private val escprCache = ConcurrentHashMap<String, Boolean>()
    private val escprLogged: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val usbIdProbed: MutableSet<String> = ConcurrentHashMap.newKeySet()

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
     * Epson ink-tank models that speak ESC/P-R over USB: the L120 / L210 era (L1xx, L2xx, L3xx, L5xx), the 6-ink photo
     * L8xx (L800, L805, L810, L850) and the newer
     * four-digit names (L3210, L3250, L3276, L4260, L5290, L8050…), plus the A3+ L18050 (sold as ET-18100 elsewhere),
     * which shares the L8050's 6-ink ESC/P-R platform. Other five-digit A3 models (L14150) are not matched.
     * Only a name fallback: its USB product id is not hardcoded in [EpsonLModels] yet (read it from the
     * "epson usb 04b8:xxxx" PBNet log line with the printer plugged in).
     */
    private fun epsonLSeries(name: String?): Boolean =
        name != null && Regex("""(?i)\b(L\s?(1\d\d|2\d\d|3\d\d|5\d\d|8\d\d|[1-8]\d{3}|18050)|ET-?18100)\b""").containsMatchIn(name)

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
                val cq = when (copt.optString("quality")) { "draft" -> 0; "high" -> 2; "best" -> 3; else -> 1 }
                val cm = when (copt.optString("media")) { "photo" -> 1; "matte" -> 2; else -> 0 }
                val adj = PrintColorAdj.from(copt)
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        val jpeg = decode(arr.getString(i))
                        canonPrintPage(id, jpeg, widthMm, heightMm, mono, cq, cm, copt.optBoolean("borderless", false), adj,
                            copt.optString("canonMode"))
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

    private val l8050NameRx = Regex("(?i)(?:^|[^A-Za-z0-9])L8050(?![0-9])")
    private fun isL8050Name(s: String?): Boolean = !s.isNullOrBlank() && l8050NameRx.containsMatchIn(s)

    /**
     * Best ESC/P-R config for Epson L8050 (USB and Wi-Fi :9100):
     *   - Default "high" / "": 360 dpi RGB dsnd (proven, fast)
     *   - Opt-in "high720": 720 dpi RGB dsnd on 4x6 (2880x4320 sheet, 3032x4400 area, -22/-76, streamed in 64-row strips)
     *   - setq media byte: 0x34 Epson Photo Paper Glossy (default), 0x0C Semi-Gloss, 0x05 Matte, 0x00 Plain
     *   - setq quality byte: 2 High (default), 1 Normal, 0 Draft
     *   - L8050 borderless header (setm + seti + chku) & 4x6 geometry
     */
    private fun l8050EscprConfig(
        optJson: JSONObject,
        borderless: Boolean,
        adj: PrintColorAdj,
        widthMm: Double = 101.6,
        heightMm: Double = 152.4
    ): EscprJob.Config {
        val mono = optJson.optString("color", "color") == "mono"
        val mediaCode = when (optJson.optString("media", "").lowercase()) {
            "plain" -> EscprJob.MEDIA_PLAIN
            "matte" -> EscprJob.MEDIA_MATTE
            "photosg" -> EscprJob.MEDIA_SEMI_GLOSS
            "photopg" -> EscprJob.MEDIA_PREMIUM_GLOSSY
            "photo" -> EscprJob.MEDIA_EPSON_GLOSSY
            else -> EscprJob.MEDIA_EPSON_GLOSSY
        }
        val qStr = optJson.optString("quality", "").lowercase()
        val is4x6 = Math.abs(minOf(widthMm, heightMm) - 101.6) <= 1.5 && Math.abs(maxOf(widthMm, heightMm) - 152.4) <= 1.5
        val useDpi = if (qStr == "high720" && is4x6) 720 else 360
        val qualityCode = when (qStr) {
            "draft" -> 0
            "normal" -> 1
            else -> 2
        }
        return EscprJob.Config(
            dpi = useDpi,
            mediaCode = mediaCode,
            qualityCode = qualityCode,
            borderless = borderless,
            l8050Geo = true,
            sendSetiChku = true,
            mono = mono,
            adj = adj,
            sendSetm = false
        )
    }

    /**
     * Hardcoded Epson L3210 ESC/P-Raster config derived from the installed Windows
     * "EPSON L3210 Series" driver (e_wf1yxe.inf v3.80.05.00). Returns null only when the caller
     * explicitly requests 360 dpi Normal or Draft so those fast modes use streaming 360 dpi ESC/P-R.
     */
    private fun l3210RasterConfig(
        optJson: JSONObject,
        borderless: Boolean,
        adj: PrintColorAdj,
        widthMm: Double = 101.6,
        heightMm: Double = 152.4
    ): EpsonL3210RasterJob.Config? {
        val qStr = optJson.optString("quality", "").lowercase()
        if (qStr == "normal" || qStr == "draft") return null
        val dpiH = if (qStr == "rbest" || qStr == "best1440" || qStr == "1440") 1440 else 720
        val mono = optJson.optString("color", "color") == "mono"
        val mediaStr = optJson.optString("media", "").lowercase()
        val blAllowed = EpsonL3210RasterJob.isBorderlessSize(widthMm, heightMm)
        val effectiveBl = borderless && blAllowed
        val mediaCode = EpsonL3210RasterJob.mediaCodeFor(
            mediaStr,
            photoDefault = effectiveBl || mediaStr != "plain"
        )
        return EpsonL3210RasterJob.Config(
            dpiH = dpiH,
            mediaCode = mediaCode,
            borderless = effectiveBl,
            mono = mono,
            adj = adj
        )
    }

    /**
     * Streaming 360 dpi / Draft ESC/P-R config for L3210 (when Normal/Draft chosen) and L3276,
     * fixing borderless geometry, media byte, and setq[6]=0x00 / sendSetiChku / sendSetm=false.
     */
    private fun epsonL360EscprConfig(
        model: String,
        optJson: JSONObject,
        borderless: Boolean,
        photoMedia: Boolean,
        adj: PrintColorAdj,
        widthMm: Double = 101.6,
        heightMm: Double = 152.4
    ): EscprJob.Config {
        val mono = optJson.optString("color", "color") == "mono"
        val mediaStr = optJson.optString("media", "").lowercase()
        val blAllowed = if (model == "L3210" || model == "L3276") EpsonL3210RasterJob.isBorderlessSize(widthMm, heightMm) else true
        val effectiveBl = borderless && blAllowed
        val mediaCode = when (mediaStr) {
            "plain" -> EscprJob.MEDIA_PLAIN
            "matte" -> EscprJob.MEDIA_MATTE
            "photosg" -> EscprJob.MEDIA_SEMI_GLOSS
            "photopg" -> EscprJob.MEDIA_PREMIUM_GLOSSY
            "photo" -> EscprJob.MEDIA_EPSON_GLOSSY
            else -> if (effectiveBl || photoMedia) EscprJob.MEDIA_EPSON_GLOSSY else EscprJob.MEDIA_PLAIN
        }
        val qStr = optJson.optString("quality", "").lowercase()
        val qualityCode = when (qStr) {
            "draft" -> 0
            "normal" -> 1
            else -> 2
        }
        return EscprJob.Config(
            dpi = 360,
            mediaCode = mediaCode,
            qualityCode = qualityCode,
            borderless = effectiveBl,
            l8050Geo = false,
            sendSetiChku = true,
            mono = mono,
            adj = adj,
            sendSetm = false
        )
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
                // A Wi-Fi printer (an address, not "usb:…") gets the same job over port 9100 or LPD port 515 (/PASSTHRU).
                val net = !id.startsWith("usb:")
                val usbDev = if (!net) {
                    val d = usbFind(id)
                    usbEnsure(d)
                    if (!usbIsEscpr(d)) throw IllegalStateException("Printer does not support ESC/P-R raster commands.")
                    d
                } else null
                val optJson = try { JSONObject(optionsJson) } catch (_: Exception) { JSONObject() }
                val adj = PrintColorAdj.from(optJson)
                // Borderless (L805, L8050, L210 and similar): no 3 mm border, photo paper. The booth page only sets it for a
                // model and paper size the printer can do borderless; otherwise the job stays as before (border, plain).
                val borderless = optJson.optBoolean("borderless", false)
                val netEntry = if (net) found[id] else null
                var probedModel = ""
                if (net &&
                    !optJson.optString("epsonModel", "").equals("L8050", ignoreCase = true) &&
                    !isL8050Name(optJson.optString("printerName", "")) &&
                    (netEntry == null || netEntry.model.isBlank())
                ) {
                    probedModel = fetchWebModel(netEntry ?: Entry(id))
                }
                val isL8050 = (usbDev != null && (EpsonLModels.match(usbDev) == "L8050" || isL8050Name(usbName(usbDev)))) ||
                    optJson.optString("epsonModel", "").equals("L8050", ignoreCase = true) ||
                    isL8050Name(optJson.optString("printerName", "")) ||
                    isL8050Name(probedModel) ||
                    (netEntry != null && isL8050Name(netEntry.model + " " + netEntry.name))
                val l8050Cfg = if (isL8050) l8050EscprConfig(optJson, borderless, adj, widthMm, heightMm) else null
                val useLpdFirst = net && (optJson.optBoolean("lpd", false) || (netEntry != null && netEntry.rawPort == 0 && netEntry.lpdPort > 0))
                val arr = JSONArray(pagesJson)
                for (c in 0 until copies.coerceIn(1, 20)) {
                    for (i in 0 until arr.length()) {
                        if (net && (c > 0 || i > 0)) try { Thread.sleep(400) } catch (_: InterruptedException) {}
                        val jpeg = decode(arr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't read the picture to print.")
                        try {
                            var transportLabel = ":9100"
                            if (l8050Cfg != null) {
                                if (net) {
                                    if (useLpdFirst) {
                                        val (_, usedQ) = netLpdStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                        transportLabel = "LPD :515/$usedQ"
                                    } else {
                                        try {
                                            netRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                        } catch (rawEx: Exception) {
                                            if (rawEx.message?.startsWith("Could not reach") == true && open(id, 515, 1500)) {
                                                found.getOrPut(id) { Entry(id) }.lpdPort = 515
                                                val (_, usedQ) = netLpdStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                                transportLabel = "LPD :515/$usedQ"
                                            } else throw rawEx
                                        }
                                    }
                                } else {
                                    usbRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                }
                            } else {
                                val data = EscprJob.build(bmp, widthMm, heightMm, false, borderless = borderless, photoMedia = borderless, adj = adj, epsonBorderless = true)
                                if (net) {
                                    if (useLpdFirst) {
                                        val (_, usedQ) = netLpdBytes(id, data)
                                        transportLabel = "LPD :515/$usedQ"
                                    } else {
                                        try {
                                            netRawJob(id, data)
                                        } catch (rawEx: Exception) {
                                            if (rawEx.message?.startsWith("Could not reach") == true && open(id, 515, 1500)) {
                                                found.getOrPut(id) { Entry(id) }.lpdPort = 515
                                                val (_, usedQ) = netLpdBytes(id, data)
                                                transportLabel = "LPD :515/$usedQ"
                                            } else throw rawEx
                                        }
                                    }
                                } else {
                                    usbRaw(id, data)
                                }
                            }
                            if (net) {
                                val sizeDesc = Math.round(minOf(widthMm, heightMm)).toString() + "x" + Math.round(maxOf(widthMm, heightMm)) + " mm"
                                found[id]?.lastSent = if (l8050Cfg != null) {
                                    val qName = when (l8050Cfg.qualityCode) { 0 -> "Draft"; 1 -> "Normal"; else -> "High" }
                                    val mName = when (l8050Cfg.mediaCode) {
                                        EscprJob.MEDIA_PLAIN -> "Plain"
                                        EscprJob.MEDIA_MATTE -> "Matte"
                                        EscprJob.MEDIA_SEMI_GLOSS -> "Semi-Gloss"
                                        EscprJob.MEDIA_PREMIUM_GLOSSY -> "Premium Glossy 0x0B"
                                        else -> "Epson Glossy 0x34"
                                    }
                                    val geo = if (l8050Cfg.dpi >= 720) "borderless (-22,-76)" else "borderless (-11,-38)"
                                    "L8050 ESC/P-R $transportLabel ${l8050Cfg.dpi}dpi, " + (if (borderless) geo else "3 mm border") + ", $mName, $qName, $sizeDesc"
                                } else {
                                    "ESC/P-R $transportLabel, " + (if (borderless) "borderless, Premium Glossy photo paper, " else "3 mm border, plain paper, ") + sizeDesc
                                }
                            }
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
     *   • Epson L8050  (PID 0x0866) — 6-ink photo printer, streaming ESC/P-R 360/720 dpi with L8050 geometry, setm & media (0x34)
     *   • Epson L3210  (PID 0xE671) — 4-ink all-in-one, supports borderless (up to 4R)
     *   • Epson L3276  (PID 0x445A) — 4-ink Wi-Fi AIO, supports borderless (up to 4R)
     *
     * The printer is identified by USB VID/PID without reading the IEEE-1284 device ID,
     * so it is available the instant the USB permission is granted.
     *
     * optionsJson keys:
     *   color      — "color" | "mono"               (default: color)
     *   quality    — "draft" | "normal" | "high" | "high720" (L8050 default: high 360 dpi; high720 = 720 dpi on 4x6)
     *   media      — "photo" | "photosg" | "matte" | "plain" (L8050 default: photo 0x34)
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
                val adj = PrintColorAdj.from(optJson)
                val l8050Cfg = if (model == "L8050") l8050EscprConfig(optJson, borderless, adj, widthMm, heightMm) else null
                val l3210Cfg = if (model == "L3210") l3210RasterConfig(optJson, borderless, adj, widthMm, heightMm) else null
                val escprCfg = if (l8050Cfg == null && l3210Cfg == null) epsonL360EscprConfig(model, optJson, borderless, photoMedia, adj, widthMm, heightMm) else null
                if (l8050Cfg != null) {
                    Log.i(TAG, "printEpsonL L8050 cfg: dpi=${l8050Cfg.dpi} bl=${l8050Cfg.borderless} media=0x%02x q=${l8050Cfg.qualityCode} setm=${l8050Cfg.sendSetm} copies=$copies".format(l8050Cfg.mediaCode))
                } else if (l3210Cfg != null) {
                    Log.i(TAG, "printEpsonL L3210 raster cfg: dpiH=${l3210Cfg.dpiH} bl=${l3210Cfg.borderless} media=0x%02x mono=${l3210Cfg.mono} copies=$copies".format(l3210Cfg.mediaCode))
                } else if (escprCfg != null) {
                    Log.i(TAG, "printEpsonL $model 360 cfg: bl=${escprCfg.borderless} media=0x%02x q=${escprCfg.qualityCode} copies=$copies".format(escprCfg.mediaCode))
                }

                val copyCount = copies.coerceIn(1, 20)
                val arr = JSONArray(pagesJson)
                for (i in 0 until arr.length()) {
                    val jpeg = decode(arr.getString(i))
                    val bmp  = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                        ?: throw IllegalStateException("Couldn't decode photo for printing.")
                    try {
                        for (c in 0 until copyCount) {
                            when {
                                l8050Cfg != null ->
                                    usbRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                l3210Cfg != null ->
                                    usbRawStream(id) { writeChunk -> EpsonL3210RasterJob.stream(bmp, widthMm, heightMm, l3210Cfg, writeChunk) }
                                escprCfg != null ->
                                    usbRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, escprCfg, writeChunk) }
                            }
                        }
                    } finally {
                        try { bmp.recycle() } catch (_: Exception) {}
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
        // DNP / Citizen dye-sub photo printers (DS-RX1, DS620, DS40, CX-02, CY-02).
        usbDnpModel(d)?.let { return if (it.startsWith("C", ignoreCase = true)) "Citizen $it" else "DNP $it" }
        // Canon SELPHY compact dye-sub photo printers (CP1500, CP1300, CP1200, CP1000, CP910, CP820) — exact name before USB permission.
        CanonSelphyJob.modelName(d.vendorId, d.productId)?.let { return "Canon SELPHY $it" }
        // Hardcoded Epson L-series inkjet: return the exact marketing name immediately.
        EpsonLModels.match(d)?.let { return "Epson $it" }
        // Hardcoded Epson ESC/P2 inkjet (L120, L121).
        EpsonEscp2Models.match(d)?.let { return "Epson $it" }
        // Hardcoded Canon PIXMA G-series inkjet (G1010, G3030, etc.).
        CanonGModels.match(d)?.let { return "Canon PIXMA $it" }
        // Brother ink-tank models (DCP-T420W etc.).
        BrotherUsbModels.match(d)?.let { return "Brother $it" }
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
    private val receiptNameRx = Regex("(?i)(^|[^a-z])rpp?[- ]?\\d|rongta|hprt|gprinter|idprt|zjiang|goojprt|munbyn|netum|arcticbreeze|vo[zx]y|(?<![a-z0-9])(?:g80|v80|p50|mp[- ]?210)(?![0-9])")
    private val known58mmNameRx = Regex("(?i)(?:^|[^a-z0-9])(?:vo[zx]y[\\s_-]*(?:p50|50)|p50|mp[-_ ]?210|pt[-_ ]?210|mpt[-_ ]?(?:ii|iii|2|3)|rpp[-_ ]?(?:02n?|200)|xp[-_ ]?58[a-z0-9]*|pos[-_ ]?58[a-z0-9]*|t[-_ ]?58[a-z0-9]*|gzm?[-_ ]?58|58\\s*mm)(?![a-z0-9])")
    private fun isKnown58mmName(name: String?): Boolean = !name.isNullOrBlank() && known58mmNameRx.containsMatchIn(name)
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
            // Read IEEE-1284 Device ID once for Brother USB printers (and log its interfaces) so diagnostics and probe reports are accurate.
            if (perm && !ipp && d.vendorId == BrotherUsbModels.VENDOR_ID && usbIdProbed.add(d.deviceName)) {
                val bid = try { usbDeviceId(d) } catch (_: Exception) { null }
                if (bid != null) usbIds[d.deviceName] = bid
                Log.i(TAG, "brother usb %04x:%04x ifaces=[%s] id=%s".format(d.vendorId, d.productId, usbIfacesSummary(d), bid ?: "(unreadable)"))
            }
            val id = "usb:" + d.deviceName
            val epsonModelName = if (epsonL) (EpsonLModels.match(d) ?: "")
                else if (escp2) (EpsonEscp2Models.match(d) ?: "")
                else ""
            val canonModelName = if (canon) (CanonGModels.match(d) ?: "") else ""
            val noDriver = perm && !dnp && !ipp && !raw && !epsonL && !escpr && !escp2 && !canon && !selphy
            arr.put(JSONObject()
                .put("id", id).put("ip", id).put("name", usbName(d) + " (USB)")
                .put("ipp", ipp).put("raw", raw).put("escpr", escpr || epsonL).put("usb", true)
                .put("epsonL", epsonL)
                .put("epsonModel", epsonModelName)
                .put("l3210HiRes", epsonModelName == "L3210")
                .put("borderless", epsonL && EpsonLModels.isBorderless(d))
                .put("escp2", escp2)
                .put("canon", canon)
                .put("canonModel", canonModelName)
                .put("selphy", selphy)
                .put("dnp", dnp)
                .put("dnpModel", dnpModel ?: "")
                .put("noDriver", noDriver)
                .put("brotherNoIpp", noDriver && d.vendorId == BrotherUsbModels.VENDOR_ID)
                .put("needsPermission", !perm && !dnp && !ipp && !raw && !selphy)
                .put("qualities", JSONArray(ippEntry?.qualities ?: emptyList<Int>()))
                .put("colorModes", JSONArray(ippEntry?.colorModes ?: emptyList<String>()))
                .put("mediaTypes", JSONArray(ippEntry?.mediaTypes ?: emptyList<String>()))
                .put("bcap", ippEntry?.borderlessCap ?: false)
                .put("ifaces", usbIfacesSummary(d))
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
            // A printer's IPP-over-USB (7/1/4) and legacy (7/1/2) endpoints may share an interface id as different
            // alternate settings: explicitly select the chosen alternate setting whenever there is more than one.
            val altCount = usbIfaces(d).count { it.id == iface.id }
            if ((iface.alternateSetting != 0 || altCount > 1) && !conn.setInterface(iface)) {
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
        var zeros = 0
        while (off < data.size) {
            // Never resend after a timeout: the printer may already hold part of the chunk, and a repeated piece
            // of a print job is read as text. Wait up to a minute for the printer to take each chunk instead.
            val r = conn.bulkTransfer(ep, data, off, minOf(16384, data.size - off), 60_000)
            if (r < 0) throw IllegalStateException("Printer communication timed out. Power cycle the printer and retry.")
            if (r == 0) {
                if (++zeros >= 10) throw IllegalStateException("Printer stopped accepting USB data. Power cycle the printer and retry.")
                try { Thread.sleep(50) } catch (_: InterruptedException) {}
                continue
            }
            zeros = 0
            off += r
        }
    }

    /** Receipt printers on USB: the ESC/POS bytes go straight to the printer. */
    private fun usbRaw(id: String, data: ByteArray, paced: Boolean = false) {
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
                    if (paced) {
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
                    } else {
                        // 80 mm receipt printers (Xprinter XP-T80Q etc.) and photo printers: full-speed writes. The printer
                        // holds the bus (NAK) when its buffer is full, so no pacing is needed, and pacing starves a fast head
                        // (80 mm at 200 mm/s eats ~115 KB/s; 256 B per 8 ms is under 32 KB/s -> it stops and starts).
                        var off = 0
                        while (off < data.size) {
                            val r = conn.bulkTransfer(out, data, off, minOf(16384, data.size - off), 60_000)
                            if (r < 0) throw IllegalStateException("Printer communication timed out. Power cycle the printer and retry.")
                            off += r
                        }
                        try { Thread.sleep(300) } catch (_: InterruptedException) {}
                    }
                } finally {
                    stop.set(true)
                    reader?.join(1000)
                }
            }
            // Give USB interface and printer controller a short pause to settle before releasing lock
            try { Thread.sleep(250) } catch (_: InterruptedException) {}
        }
    }

    /** Streams one whole photo job straight to USB bulk-OUT without buffering the full page in RAM. */
    private fun usbRawStream(id: String, stream: ((ByteArray, Int) -> Unit) -> Unit) {
        synchronized(usbLockFor(id)) {
            val d = usbFind(id)
            usbEnsure(d)
            val iface = usbRawIface(d) ?: usbIfaces(d).firstOrNull { it.interfaceClass == 7 }
                ?: throw IllegalStateException("Connected USB device is not a supported printer.")
            usbSession(d, iface) { conn, out, inn ->
                // Drain bidirectional printer status while writing so the printer never blocks waiting on bulk-IN.
                val stop = java.util.concurrent.atomic.AtomicBoolean(false)
                val reader = if (inn == null) null else Thread {
                    val b = ByteArray(1024)
                    while (!stop.get()) { try { conn.bulkTransfer(inn, b, b.size, 200) } catch (_: Exception) {} }
                }.also { it.isDaemon = true; it.start() }
                try {
                    stream { buf, len ->
                        var off = 0
                        var zeros = 0
                        while (off < len) {
                            val r = conn.bulkTransfer(out, buf, off, minOf(16384, len - off), 60_000)
                            if (r < 0) throw IllegalStateException("Printer communication timed out. Power cycle the printer and retry.")
                            if (r == 0) {
                                if (++zeros >= 10) throw IllegalStateException("Printer stopped accepting USB data. Power cycle the printer and retry.")
                                try { Thread.sleep(50) } catch (_: InterruptedException) {}
                                continue
                            }
                            zeros = 0
                            off += r
                        }
                    }
                    try { Thread.sleep(300) } catch (_: InterruptedException) {}
                } finally {
                    stop.set(true)
                    reader?.join(1000)
                }
            }
            try { Thread.sleep(250) } catch (_: InterruptedException) {}
        }
    }

    /** The printer answered status checks but never started the job: it did not understand that page language. Nothing was printed. */
    private class CanonIgnoredException(msg: String) : IllegalStateException(msg)

    /** Which page language worked on each Canon USB printer in this run ("ivec" = IVEC + PWG Raster, "legacy" = ESC ( bands). */
    private val canonMode = ConcurrentHashMap<String, String>()

    /**
     * One page on a Canon G-series printer, in one of two page languages: IVEC + PWG Raster (newer, G3010 family) or the
     * native ESC ( stream in the same IVEC wrapper (older; what Canon's Windows driver sends a G1010). Automatic mode asks the
     * printer for its data formats and tries the likelier one first; if the printer stays idle and never starts the page,
     * nothing was printed, so the other is sent. The one that works is remembered until the app restarts. If both are ignored
     * the first error (with the printer's ID) is thrown.
     */
    private fun canonPrintPage(id: String, jpeg: ByteArray, widthMm: Double, heightMm: Double, mono: Boolean, cq: Int, cm: Int,
                               borderless: Boolean, adj: PrintColorAdj, mode: String) {
        // The G1000 / G2000 family (G1010, G2010) printed over USB with the native stream sent as-is, on a real G1010 (client report,
        // 2026-11-19). For those the page goes out exactly that way: no status probing, no soft reset, no second language.
        val nativeKnown = try { CanonGModels.match(usbFind(id)) in setOf("G1010", "G1000", "G2000", "G2010") } catch (_: Exception) { false }
        fun legacy() {
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                ?: throw IllegalStateException("Couldn't read the picture to print.")
            try {
                val bytes = CanonJob.build(bmp, widthMm, heightMm, mono, cq, cm, adj, borderless)
                if (nativeKnown) usbRaw(id, bytes) else usbCanonJob(id, bytes)
            } finally {
                try { bmp.recycle() } catch (_: Exception) {}
            }
        }
        fun ivec() = usbCanonJob(id, CanonJob.buildIvec(jpeg, widthMm, heightMm, mono, cq, cm, borderless, adj))
        // mode: "legacy" / "ivec" = the user picked one in the printer options; anything else = automatic.
        // Automatic asks the printer which data formats it takes (as Canon's Windows driver does): a printer that lists
        // PWG Raster gets the newer page first, any other gets the native ESC ( stream first (the G1010's Windows driver
        // uses that one). Whichever is tried second only runs if the first was ignored, so nothing prints twice.
        val order: List<String> = when {
            mode == "legacy" -> listOf("legacy")
            mode == "ivec" -> listOf("ivec")
            nativeKnown -> listOf("legacy")                                   // proven on a G1010: that language only
            !CanonJob.supportsIvec(widthMm, heightMm) -> listOf("legacy")
            canonMode[id] != null -> if (canonMode[id] == "legacy") listOf("legacy", "ivec") else listOf("ivec", "legacy")
            else -> {
                // other G-series (G3010 family...): the newer page only when the printer says it takes PWG Raster
                val caps = usbCanonCapability(id)
                if (caps != null && caps.contains("pwg", ignoreCase = true)) listOf("ivec", "legacy") else listOf("legacy", "ivec")
            }
        }
        var first: CanonIgnoredException? = null
        for (m in order) {
            try {
                if (m == "legacy") legacy() else ivec()
                canonMode[id] = m
                return
            } catch (e: CanonIgnoredException) {
                if (first == null) first = e
                Log.w(TAG, "canon: $m page ignored" + (if (m != order.last()) ", trying the other language" else ""))
            }
        }
        throw first ?: IllegalStateException("The Canon printer did not start printing.")
    }

    private val canonCaps = ConcurrentHashMap<String, String>()

    /** The interface a Canon G-series printer takes its jobs on: the printer-class one with both bulk endpoints. */
    private fun canonIface(d: UsbDevice): UsbInterface =
        usbIfaces(d).firstOrNull { it.interfaceClass == 7 && it.interfaceSubclass == 1 && hasBulkPair(it) }
            ?: usbRawIface(d) ?: usbIfaces(d).firstOrNull { it.interfaceClass == 7 }
            ?: throw IllegalStateException("Connected USB device is not a supported printer.")

    /**
     * Asks the printer GetCapability(print), the question Canon's own Windows driver opens with; its answer lists the data
     * formats the printer takes. Cached per printer; null when the printer does not answer. The reply is logged (tag PBNet).
     */
    private fun usbCanonCapability(id: String): String? {
        canonCaps[id]?.let { return it }
        return try {
            val text = synchronized(usbLockFor(id)) {
                val d = usbFind(id)
                usbEnsure(d)
                usbSession(d, canonIface(d)) { conn, out, inn ->
                    if (inn == null) return@usbSession null
                    usbWrite(conn, out, CanonJob.GET_CAPABILITY)
                    val buf = ByteArrayOutputStream()
                    val tmp = ByteArray(8192)
                    val end = System.currentTimeMillis() + 4000
                    var got: String? = null
                    while (System.currentTimeMillis() < end && got == null) {
                        val n = conn.bulkTransfer(inn, tmp, tmp.size, 700)
                        if (n > 0) {
                            buf.write(tmp, 0, n)
                            val s = String(buf.toByteArray(), Charsets.ISO_8859_1)
                            if (s.contains("</cmd>")) got = s
                        }
                    }
                    got
                }
            }
            if (text != null) {
                canonCaps[id] = text
                Log.i(TAG, "canon capability: " + text.replace(Regex("\\s+"), " ").take(1500))
            } else Log.i(TAG, "canon capability: no answer")
            text
        } catch (e: Exception) {
            Log.w(TAG, "canon capability", e)
            null
        }
    }

    /**
     * A Canon G-series job over USB: asks the printer for its status first (and soft-resets it when it stays silent),
     * sends the job, then watches the printer's status until it goes idle, so an empty paper tray or a jam comes back as a
     * readable error instead of a silent "printed". Status replies are logged (adb logcat, tag PBNet) to diagnose a model.
     */
    private fun usbCanonJob(id: String, data: ByteArray) {
        fun blocked(s: CanonJob.Status) = s.status == "stopped" ||
            s.detail.lowercase() in setOf("mediaempty", "mediajam", "dooropen", "attentionrequired")
        synchronized(usbLockFor(id)) {
            val d = usbFind(id)
            usbEnsure(d)
            val iface = canonIface(d)
            // the printer's own language list, shown in the error below when it takes a job but never starts it
            val devId = usbIds[d.deviceName] ?: try { usbDeviceId(d) } catch (_: Exception) { null }
            if (devId != null) usbIds[d.deviceName] = devId
            usbSession(d, iface) { conn, out, inn ->
                fun ask(): CanonJob.Status? {
                    if (inn == null) return null
                    usbWrite(conn, out, CanonJob.GET_STATUS)
                    val buf = ByteArrayOutputStream()
                    val tmp = ByteArray(4096)
                    val end = System.currentTimeMillis() + 2100
                    while (System.currentTimeMillis() < end) {
                        val n = conn.bulkTransfer(inn, tmp, tmp.size, 700)
                        if (n > 0) {
                            buf.write(tmp, 0, n)
                            CanonJob.parseStatus(String(buf.toByteArray(), Charsets.ISO_8859_1))?.let { return it }
                        }
                    }
                    return null
                }
                Log.i(TAG, "canon usb %04x:%04x id=%s bytes=%d".format(d.vendorId, d.productId, usbIds[d.deviceName] ?: "(not read)", data.size))
                var st = ask()
                if (st == null) {
                    // silent printer: a class soft-reset (what Canon's own driver does) usually wakes it
                    try { conn.controlTransfer(0x21, 2, 0, iface.id, null, 0, 1000) } catch (_: Exception) {}
                    try { Thread.sleep(400) } catch (_: InterruptedException) {}
                    st = ask()
                }
                Log.i(TAG, "canon status before: " + (st?.let { "${it.status}/${it.detail}/${it.code}" } ?: "no answer"))
                if (st != null && blocked(st)) throw IllegalStateException(CanonJob.statusProblem(st) ?: "The printer needs attention.")

                usbWrite(conn, out, data)

                val t0 = System.currentTimeMillis()
                var sawBusy = false
                var silent = 0
                var answered = st != null
                while (System.currentTimeMillis() - t0 < 150_000) {
                    try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
                    val s = ask()
                    if (s == null) { if (++silent >= 8) break; continue }
                    silent = 0
                    answered = true
                    // answers, stays idle, never starts: the printer did not understand the job (wrong language for this model)
                    if (!sawBusy && s.status == "idle" && System.currentTimeMillis() - t0 > 20_000) {
                        Log.w(TAG, "canon job ignored: status idle, never busy; id=$devId")
                        throw CanonIgnoredException("The Canon printer received the page but never started printing it. " +
                            "Please send this to support: USB %04x:%04x ID ${devId ?: "unreadable"}".format(d.vendorId, d.productId))
                    }
                    if (blocked(s)) throw IllegalStateException(CanonJob.statusProblem(s) ?: "The printer needs attention.")
                    if (s.status != "idle") sawBusy = true
                    else if (sawBusy || System.currentTimeMillis() - t0 > 10_000) break
                }
                Log.i(TAG, "canon job done after ${System.currentTimeMillis() - t0} ms, busy seen=$sawBusy")
            }
        }
    }

    /** One IPP request/response over IPP-over-USB: HTTP carried on the printer's bulk endpoints. */
    private fun usbPost(d: UsbDevice, path: String, body: ByteArray): Reply {
        val iface = usbIppIface(d) ?: throw IllegalStateException("This USB printer requires a dedicated driver or print station.")
        return synchronized(usbLockFor("usb:" + d.deviceName)) {
            usbSession(d, iface) { conn, out, inn ->
                if (inn == null) throw IllegalStateException("The USB printer has no reply port.")
                val head = "POST $path HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/ipp\r\nContent-Length: ${body.size}\r\n\r\n"
                usbWrite(conn, out, head.toByteArray(Charsets.ISO_8859_1))
                if (body.isNotEmpty()) usbWrite(conn, out, body)
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
    }

    private fun indexOfCrlf(b: ByteArray, from: Int): Int {
        var i = from
        while (i + 1 < b.size) {
            if (b[i] == 0x0D.toByte() && b[i + 1] == 0x0A.toByte()) return i
            i++
        }
        return -1
    }

    private fun indexOfHeaderEnd(b: ByteArray, from: Int): Int {
        var i = from
        while (i + 3 < b.size) {
            if (b[i] == 0x0D.toByte() && b[i + 1] == 0x0A.toByte() &&
                b[i + 2] == 0x0D.toByte() && b[i + 3] == 0x0A.toByte()) return i
            i++
        }
        return -1
    }

    /** Skips any leading HTTP/1.1 100 Continue informational headers so the real 200/4xx reply is read. */
    private fun skip100Continue(b: ByteArray): Int {
        var off = 0
        while (off < b.size) {
            val split = indexOfHeaderEnd(b, off)
            if (split < 0) return off
            val crlf = indexOfCrlf(b, off)
            val eol = if (crlf in off..split) crlf else split
            val line = String(b, off, eol - off, Charsets.ISO_8859_1)
            if (Regex("^HTTP/1\\.[01]\\s+100\\b", RegexOption.IGNORE_CASE).containsMatchIn(line)) {
                off = split + 4
            } else {
                return off
            }
        }
        return off
    }

    /** Decodes an HTTP/1.1 Transfer-Encoding: chunked body across any number of chunks. */
    private fun decodeChunked(b: ByteArray, bodyStart: Int): Pair<Boolean, ByteArray> {
        val out = ByteArrayOutputStream()
        var p = bodyStart
        while (p < b.size) {
            val nl = indexOfCrlf(b, p)
            if (nl < 0) return Pair(false, out.toByteArray())
            val sizeHex = String(b, p, nl - p, Charsets.ISO_8859_1).substringBefore(';').trim()
            val size = sizeHex.toIntOrNull(16) ?: return Pair(false, out.toByteArray())
            p = nl + 2
            if (size == 0) {
                if (p + 2 <= b.size && b[p] == 0x0D.toByte() && b[p + 1] == 0x0A.toByte()) {
                    return Pair(true, out.toByteArray())
                }
                return Pair(indexOfHeaderEnd(b, p) >= 0, out.toByteArray())
            }
            if (p + size + 2 > b.size) return Pair(false, out.toByteArray())
            out.write(b, p, size)
            p += size + 2
        }
        return Pair(false, out.toByteArray())
    }

    private fun httpComplete(b: ByteArray): Boolean {
        val start = skip100Continue(b)
        val split = indexOfHeaderEnd(b, start)
        if (split < 0) return false
        val head = String(b, start, split - start, Charsets.ISO_8859_1)
        val len = Regex("(?im)^content-length:\\s*(\\d+)").find(head)?.groupValues?.get(1)?.toIntOrNull()
        if (len != null) return b.size - (split + 4) >= len
        if (Regex("(?im)^transfer-encoding:[^\\r\\n]*chunked").containsMatchIn(head)) return decodeChunked(b, split + 4).first
        return b.size - (split + 4) >= 8
    }

    // ── IPP ──────────────────────────────────────────────────────────────────

    private fun ippPaths(e: Entry): Set<String> {
        val paths = LinkedHashSet<String>()
        if (e.ippPath.isNotBlank()) paths.add(e.ippPath)
        paths.addAll(listOf("/ipp/print", "/ipp", "/", "/ipp/printer", "/printer"))
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
                val stateReasons = ArrayList<String>()
                var model = ""
                var zeroMargin = false
                parseIppGrouped(r.body) { grp, name, tag, raw ->
                    if (grp == 0x05) return@parseIppGrouped
                    // A margin of 0 in the list of supported margins (1/100 mm, a 4-byte integer) is how a printer says it can print edge to edge.
                    if (tag == 0x21 && raw.size == 4 && name.startsWith("media-") && name.endsWith("-margin-supported") &&
                        raw[0].toInt() == 0 && raw[1].toInt() == 0 && raw[2].toInt() == 0 && raw[3].toInt() == 0) zeroMargin = true
                    val value = String(raw, Charsets.UTF_8)
                    if (name == "document-format-supported" && tag == 0x49) formats.add(value.lowercase())
                    if (name == "printer-make-and-model" && (tag == 0x41 || tag == 0x42) && model.isEmpty()) model = value
                    if (name == "print-quality-supported" && tag == 0x23 && raw.size == 4) qualities.add(raw[3].toInt() and 0xFF)
                    if (name == "print-color-mode-supported" && tag == 0x44) colorModes.add(value)
                    if (name == "media-type-supported" && (tag == 0x44 || tag == 0x42)) mediaTypes.add(value)
                    if (name == "pwg-raster-document-type-supported" && tag == 0x44) pwgTypes.add(value)
                    if (name == "media-ready" && (tag == 0x44 || tag == 0x42)) mediaReady.add(value)
                    if (name == "media-supported" && (tag == 0x44 || tag == 0x42)) mediaSupported.add(value)
                    if (name == "printer-state-reasons" && tag == 0x44) stateReasons.add(value)
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
                e.stateReasons = stateReasons
                e.borderlessCap = zeroMargin || mediaSupported.any { Regex("(?i)[-_.](borderless|full-?bleed)$").containsMatchIn(it) }
                if (model.isNotBlank()) { e.model = model; if (e.name.isBlank()) e.name = model }
                e.ippPath = path
                e.attrsTried = true
                return
            } catch (_: Exception) { return }
        }
    }

    /** Walks an IPP response and hands every attribute value (with its group delimiter tag) to the callback. */
    private fun parseIppGrouped(b: ByteArray, cb: (group: Int, name: String, tag: Int, value: ByteArray) -> Unit) {
        if (b.size < 8) return
        var p = 8
        var grp = 0
        var last = ""
        fun u16(i: Int) = ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)
        while (p < b.size) {
            val tag = b[p++].toInt() and 0xFF
            if (tag == 0x03) return
            if (tag <= 0x05) { grp = tag; last = ""; continue }     // group delimiter (0x01 op, 0x02 job, 0x04 printer, 0x05 unsupported)
            if (p + 2 > b.size) return
            val nl = u16(p); p += 2
            if (p + nl + 2 > b.size) return
            if (nl > 0) { last = String(b, p, nl, Charsets.ISO_8859_1); p += nl }
            val vl = u16(p); p += 2
            if (p + vl > b.size) return
            cb(grp, last, tag, b.copyOfRange(p, p + vl))
            p += vl
        }
    }

    /** Walks an IPP response and hands every attribute value to the callback. */
    private fun parseIpp(b: ByteArray, cb: (name: String, tag: Int, value: ByteArray) -> Unit) {
        parseIppGrouped(b) { _, name, tag, raw -> cb(name, tag, raw) }
    }

    private fun ippValText(tag: Int, raw: ByteArray): String = when {
        tag == 0x10 -> "(unsupported)"
        tag == 0x12 -> "(unknown)"
        tag == 0x13 -> "(no-value)"
        tag == 0x21 && raw.size == 4 -> (((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)).toString()
        tag == 0x22 && raw.size == 1 -> if (raw[0].toInt() != 0) "true" else "false"
        tag == 0x23 && raw.size == 4 -> (((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)).toString()
        tag == 0x32 && raw.size == 9 -> {
            val x = ((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
            val y = ((raw[4].toInt() and 0xFF) shl 24) or ((raw[5].toInt() and 0xFF) shl 16) or ((raw[6].toInt() and 0xFF) shl 8) or (raw[7].toInt() and 0xFF)
            val u = if (raw[8].toInt() == 3) "dpi" else "dpcm"
            if (x == y) "$x$u" else "${x}x${y}$u"
        }
        tag == 0x33 && raw.size == 8 -> {
            val lo = ((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
            val hi = ((raw[4].toInt() and 0xFF) shl 24) or ((raw[5].toInt() and 0xFF) shl 16) or ((raw[6].toInt() and 0xFF) shl 8) or (raw[7].toInt() and 0xFF)
            "$lo..$hi"
        }
        tag == 0x34 -> "{"
        tag == 0x37 -> "}"
        tag == 0x4a -> String(raw, Charsets.UTF_8)
        tag >= 0x40 -> String(raw, Charsets.UTF_8)
        else -> "0x" + raw.joinToString("") { "%02x".format(it) }
    }

    private fun extractUnsupported(b: ByteArray): List<String> {
        val out = ArrayList<String>()
        parseIppGrouped(b) { grp, name, tag, raw ->
            if (grp != 0x05) return@parseIppGrouped
            if (tag == 0x34 || tag == 0x37) return@parseIppGrouped
            if (tag == 0x4a) {
                val m = String(raw, Charsets.UTF_8)
                if (m.isNotEmpty()) out.add("member:$m")
            } else if (name.isNotEmpty()) {
                val v = ippValText(tag, raw)
                out.add(if (v.isNotEmpty() && v != "(unsupported)") "$name=$v" else name)
            }
        }
        return out.distinct()
    }

    private fun extractStatusMessage(b: ByteArray): String {
        var msg = ""
        parseIppGrouped(b) { grp, name, tag, raw ->
            if (grp == 0x01 && name == "status-message" && (tag == 0x41 || tag == 0x42) && msg.isEmpty()) {
                msg = String(raw, Charsets.UTF_8)
            }
        }
        return msg
    }

    private fun extractJobId(b: ByteArray): Int? {
        var id: Int? = null
        parseIppGrouped(b) { _, name, tag, raw ->
            if (name == "job-id" && tag == 0x21 && raw.size == 4 && id == null) {
                id = ((raw[0].toInt() and 0xFF) shl 24) or ((raw[1].toInt() and 0xFF) shl 16) or ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
            }
        }
        return id
    }

    private fun ippStatusName(code: Int): String = when (code) {
        0x0000 -> "successful-ok"
        0x0001 -> "successful-ok-ignored-or-substituted-attributes"
        0x0002 -> "successful-ok-conflicting-attributes"
        0x0400 -> "client-error-bad-request"
        0x0403 -> "client-error-not-authorized"
        0x0404 -> "client-error-not-possible"
        0x0406 -> "client-error-not-found"
        0x040a -> "client-error-document-format-not-supported"
        0x040b -> "client-error-attributes-or-values-not-supported"
        0x040e -> "client-error-conflicting-attributes"
        0x0500 -> "server-error-internal-error"
        0x0501 -> "server-error-operation-not-supported"
        0x0507 -> "server-error-busy"
        else -> "0x" + Integer.toHexString(code)
    }

    private fun ippJobStateName(st: Int): String = when (st) {
        3 -> "pending"
        4 -> "pending-held"
        5 -> "processing"
        6 -> "processing-stopped"
        7 -> "canceled"
        8 -> "aborted"
        9 -> "completed"
        else -> "unknown($st)"
    }

    private fun ippGetJobAttributes(uri: String, jobId: Int): ByteArray {
        val o = ByteArrayOutputStream()
        fun u8(v: Int) = o.write(v and 0xFF)
        fun u16(v: Int) { u8(v shr 8); u8(v) }
        fun u32(v: Int) { u16(v ushr 16); u16(v) }
        fun str(s: String) { val b = s.toByteArray(Charsets.UTF_8); u16(b.size); o.write(b) }
        fun attr(tag: Int, name: String, value: String) { u8(tag); str(name); str(value) }
        u16(0x0200); u16(0x0009); u32(2)                       // IPP 2.0, Get-Job-Attributes
        u8(0x01)
        attr(0x47, "attributes-charset", "utf-8")
        attr(0x48, "attributes-natural-language", "en")
        attr(0x45, "printer-uri", uri)
        u8(0x21); str("job-id"); u16(4); u32(jobId)
        attr(0x44, "requested-attributes", "job-state")
        u8(0x44); u16(0); str("job-state-reasons")
        u8(0x44); u16(0); str("job-state-message")
        u8(0x03)
        return o.toByteArray()
    }

    private data class JobPollResult(val state: Int, val stateName: String, val reasons: List<String>, val message: String)

    private fun queryJobStateOnce(e: Entry, path: String, jobId: Int): JobPollResult? {
        return try {
            val r = doPost(e, path, ippGetJobAttributes(ippUri(e, path), jobId))
            if (r.http != 200 || r.ipp !in 0..2) return null
            var st = 0
            val reasons = ArrayList<String>()
            var msg = ""
            parseIppGrouped(r.body) { grp, name, tag, raw ->
                if (grp == 0x05) return@parseIppGrouped
                if (name == "job-state" && tag == 0x23 && raw.size == 4) st = raw[3].toInt() and 0xFF
                if (name == "job-state-reasons" && tag == 0x44) reasons.add(String(raw, Charsets.UTF_8))
                if (name == "job-state-message" && (tag == 0x41 || tag == 0x42) && msg.isEmpty()) msg = String(raw, Charsets.UTF_8)
            }
            if (st == 0) null else JobPollResult(st, ippJobStateName(st), reasons, msg)
        } catch (_: Exception) { null }
    }

    /** Background job watcher after Print-Job returns HTTP 200: warns if the printer stops, cancels, or aborts the job. */
    private fun watchIppJob(e: Entry, path: String, jobId: Int) {
        try {
            val end = System.currentTimeMillis() + 25_000L
            var stoppedAt = 0L
            while (System.currentTimeMillis() < end) {
                try { Thread.sleep(2500) } catch (_: InterruptedException) { return }
                val js = queryJobStateOnce(e, path, jobId) ?: continue
                val reasonText = js.reasons.filter { it != "none" }.joinToString(", ")
                e.lastJobStatus = "job #$jobId ${js.stateName}" + (if (reasonText.isNotEmpty()) " ($reasonText)" else "") +
                    (if (js.message.isNotEmpty()) " — ${js.message}" else "")
                if (js.state == 7 || js.state == 8) {
                    emitIppWarn("The printer ${js.stateName} the photo" +
                        (if (reasonText.isNotEmpty()) " ($reasonText)" else "") +
                        ". Check paper size, paper type, or ink on the printer.")
                    return
                }
                if (js.state == 9) return
                if (js.state == 6) {
                    if (stoppedAt == 0L) stoppedAt = System.currentTimeMillis()
                    else if (System.currentTimeMillis() - stoppedAt > 10_000L) {
                        emitIppWarn("The printer paused the print" +
                            (if (reasonText.isNotEmpty()) " ($reasonText)" else "") +
                            ". Check paper tray / screen on the printer.")
                        return
                    }
                } else {
                    stoppedAt = 0L
                }
            }
        } catch (_: Exception) {}
    }

    private class Opts(val quality: String, val color: String, val media: String, val borderless: Boolean = false, val dpi: Int = 0)

    /** One way of asking the printer for a job: with the page size, with the quality / colour / paper-type settings, the paper's own name, how to scale, and margins (1/100 mm). */
    private data class IppAttempt(val withMedia: Boolean, val withOpts: Boolean, val mediaName: String, val scaling: String, val sizeW: Double = 0.0, val sizeH: Double = 0.0, val marginMm100: Int = 0)

    /** The size in mm that a paper name carries ("jpn_hagaki_100x148mm" -> 100 x 148, "na_index-4x6_4x6in" -> 101.6 x 152.4), or null. */
    private fun mediaSizeMm(name: String): Pair<Double, Double>? {
        val m = Regex("_(\\d+(?:\\.\\d+)?)x(\\d+(?:\\.\\d+)?)(mm|in)(?:[-_.]?(?:borderless|full-?bleed))?$", RegexOption.IGNORE_CASE).find(name) ?: return null
        val k = if (m.groupValues[3].lowercase() == "in") 25.4 else 1.0
        return Pair(Math.round(m.groupValues[1].toDouble() * k * 100) / 100.0, Math.round(m.groupValues[2].toDouble() * k * 100) / 100.0)
    }

    /** Waits between multi-sheet Canon SELPHY IPP prints so the next job never arrives mid-pass and freezes the printer. */
    private fun awaitSelphyIppIdle(e: Entry, path: String, jobId: Int?) {
        if (jobId == null || path.isBlank()) {
            try { Thread.sleep(3500) } catch (_: InterruptedException) {}
            return
        }
        val deadline = System.currentTimeMillis() + 75_000L
        var misses = 0
        while (System.currentTimeMillis() < deadline) {
            try { Thread.sleep(2500) } catch (_: InterruptedException) { return }
            val r = try { doPost(e, path, ippGetJobAttributes(ippUri(e, path), jobId)) } catch (_: Exception) {
                if (++misses >= 6) return
                continue
            }
            if (r.http != 200) return
            if (r.ipp == 0x0406 || r.ipp == 0x0501) return   // job purged (done) or Get-Job-Attributes unsupported
            if (r.ipp !in 0..2) {
                if (++misses >= 4) return
                continue
            }
            misses = 0
            var st = 0
            parseIppGrouped(r.body) { grp, name, tag, raw ->
                if (grp != 0x05 && name == "job-state" && tag == 0x23 && raw.size == 4) st = raw[3].toInt() and 0xFF
            }
            if (st == 0 || st >= 7) return   // 7 canceled, 8 aborted, 9 completed
        }
    }

    private fun sendIppJob(e: Entry, job: String, jpegIn: ByteArray, wMm: Double, hMm: Double, opts: Opts): Pair<Int?, String> {
        val jpeg = jpegAtDpi(jpegIn, opts.dpi)
        fetchAttrs(e)
        // Only ask for settings this printer says it supports (quality, colour mode, paper type).
        // Exception, hardcoded: an Epson L8050 on USB does not list its print qualities or paper types, so nothing was ever
        // sent and every job came out on the printer's own default (plain paper, standard quality). For it the picked values
        // are sent anyway; if the printer refuses them, the attempts below drop them one at a time.
        // The same goes for an Epson L8050 on Wi-Fi (known by the name it gives): a client's Xiaomi Pad 5 sent none of the settings over
        // Wi-Fi, so the printer used plain paper at standard quality (banding lines, no borderless) where the Epson app printed it sharp.
        val hardEpsonL = e.usbDev?.let { EpsonLModels.isKnown(it) } == true ||
            (e.usbDev == null && Regex("(?i)(?:^|[^A-Za-z0-9])L8050(?![0-9])").containsMatchIn(e.model + " " + e.name))
        val q = when (opts.quality) { "draft" -> 3; "normal" -> 4; "high", "high720" -> 5; else -> 0 }
        val qv = if (q != 0 && (q in e.qualities || hardEpsonL)) q else 0
        val cm = when {
            opts.color == "mono" && "monochrome" in e.colorModes -> "monochrome"
            opts.color == "color" && "color" in e.colorModes -> "color"
            else -> ""
        }
        val mt = when (opts.media) {
            "plain" -> e.mediaTypes.firstOrNull { it == "stationery" } ?: e.mediaTypes.firstOrNull { it.startsWith("stationery") } ?: (if (hardEpsonL) "stationery" else "")
            "inkjet" -> e.mediaTypes.firstOrNull { it == "stationery-inkjet" } ?: e.mediaTypes.firstOrNull { it.contains("inkjet", true) } ?: ""
            "photo", "photopg" -> e.mediaTypes.firstOrNull { it == "photographic-glossy" } ?: e.mediaTypes.firstOrNull { it.startsWith("photographic") } ?: (if (hardEpsonL) "photographic-glossy" else "")
            "photosg" -> e.mediaTypes.firstOrNull { it == "photographic-semi-gloss" } ?: (if (hardEpsonL) "photographic-semi-gloss" else "")
            "matte" -> e.mediaTypes.firstOrNull { it == "photographic-matte" } ?: (if (hardEpsonL) "photographic-matte" else "")
            "bp71" -> e.mediaTypes.firstOrNull { it.equals("com.brother-bp71", true) } ?: e.mediaTypes.firstOrNull { it.contains("bp71", true) } ?: ""
            else -> if (opts.media.isNotEmpty()) (e.mediaTypes.firstOrNull { it.equals(opts.media, true) } ?: "") else ""
        }
        val formats = e.formats
        val rasterOnly = "image/pwg-raster" in formats && "image/jpeg" !in formats && "application/pdf" !in formats
        val rasterNamed = if (rasterOnly) selphyMedia(e, wMm, hMm, false) else null
        val rasterDims = if (rasterOnly) (rasterNamed?.let { mediaSizeMm(it) } ?: Pair(minOf(wMm, hMm), maxOf(wMm, hMm))) else Pair(wMm, hMm)
        // Brother DCP-T420W constrains borderless against plain paper (stationery): when printing a photo sheet borderless
        // with no paper type picked yet, default to photographic-glossy so borderless works cleanly out of the box.
        val effMt = if (rasterOnly && mt.isEmpty() && opts.borderless && rasterDims.first <= 155.0 && rasterDims.second <= 210.0 && "photographic-glossy" in e.mediaTypes) {
            "photographic-glossy"
        } else mt
        val hasOpts = qv != 0 || cm.isNotEmpty() || mt.isNotEmpty()
        val rasterHasOpts = qv != 0 || cm.isNotEmpty() || effMt.isNotEmpty()
        // Formats to try, in order: the photo as-is when the printer takes JPEG (or won't say), then PDF, then PWG raster.
        val candidates = ArrayList<Pair<String, () -> ByteArray>>()
        if (formats.isEmpty() || "image/jpeg" in formats) candidates.add("image/jpeg" to { jpeg })
        if ("application/pdf" in formats) candidates.add("application/pdf" to { jpegToPdf(jpeg, wMm, hMm) })
        if ("image/pwg-raster" in formats) {
            candidates.add("image/pwg-raster" to {
                pwgPage(e, jpeg, rasterDims.first, rasterDims.second, opts, effMt, rasterNamed)
            })
        }
        if (candidates.isEmpty()) {
            throw IllegalStateException(
                (e.model.ifBlank { "This printer" }) + " can't take photos from the tablet (it accepts: " +
                    formats.filter { it.startsWith("image/") || it.startsWith("application/") }.take(5).joinToString(", ") + ")."
            )
        }
        var lastErr = "The printer didn't accept the job."
        // A Canon SELPHY has only a few fixed papers (postcard, L, card) and often refuses a custom size such as 101.6 x 152.4 mm,
        // so name the loaded paper itself first ("jpn_hagaki_100x148mm") and fall back to the custom size after that.
        val selphy = isSelphy(e)
        val named = if (selphy) selphyMedia(e, wMm, hMm, opts.borderless) else null
        val ownScaling = if (opts.borderless) "none" else "fill"
        // Try ideal zero-margin borderless settings first, then drop print-scaling (some non-AirPrint printers reject "none" even when they
        // support zero-margin media-col), then drop quality/media-type, then fall back to 3 mm margins (keeps paper size when a printer
        // refuses 0 mm margins on plain paper or non-borderless sizes) before finally dropping media-col.
        val baseStd = ArrayList<IppAttempt>()
        if (hasOpts) {
            baseStd.add(IppAttempt(true, true, "", ownScaling))
            baseStd.add(IppAttempt(true, true, "", ""))
            baseStd.add(IppAttempt(true, false, "", ownScaling))
            baseStd.add(IppAttempt(true, false, "", ""))
            baseStd.add(IppAttempt(true, true, "", "fill", 0.0, 0.0, 300))
            baseStd.add(IppAttempt(true, false, "", "", 0.0, 0.0, 300))
            baseStd.add(IppAttempt(false, true, "", ""))
            baseStd.add(IppAttempt(false, false, "", ""))
        } else {
            baseStd.add(IppAttempt(true, false, "", ownScaling))
            baseStd.add(IppAttempt(true, false, "", ""))
            baseStd.add(IppAttempt(true, false, "", "fill", 0.0, 0.0, 300))
            baseStd.add(IppAttempt(false, false, "", ""))
        }
        val ns = if (named != null) mediaSizeMm(named) else null
        val zeroMargin = if (selphy && opts.borderless && ns != null) listOf(
            IppAttempt(true, true, "", "fill", ns.first, ns.second), IppAttempt(true, false, "", "fill", ns.first, ns.second)) else emptyList()
        val stdAttempts = zeroMargin + (if (named != null) listOf(IppAttempt(true, true, named, "fill"), IppAttempt(true, true, named, ownScaling),
            IppAttempt(true, false, named, "fill"), IppAttempt(true, false, named, ownScaling)) else emptyList()) +
            (if (selphy) listOf(IppAttempt(true, true, "", "fill"), IppAttempt(true, false, "", "fill")) else emptyList()) +
            baseStd
        val rasterAttempts = if (rasterOnly) {
            val wantZero = opts.borderless && !effMt.equals("stationery", ignoreCase = true)
            val rBase = ArrayList<IppAttempt>()
            if (wantZero) rBase.add(IppAttempt(true, false, "", "", rasterDims.first, rasterDims.second, 0))
            rBase.add(IppAttempt(true, false, "", "", rasterDims.first, rasterDims.second, 300))
            if (rasterNamed != null) rBase.add(IppAttempt(true, false, rasterNamed, "", rasterDims.first, rasterDims.second, 0))
            rBase.add(IppAttempt(false, false, "", "", 0.0, 0.0, 0))
            rBase.flatMap { a -> if (rasterHasOpts) listOf(a.copy(withOpts = true), a) else listOf(a) }
        } else stdAttempts

        val attemptLog = ArrayList<String>()
        var drops = 0
        val maxDrops = 6
        for ((format, make) in candidates) {
            val data = try { make() } catch (ex: Exception) { lastErr = ex.message ?: lastErr; continue }
            val raster = format == "image/pwg-raster"
            val useAttempts = (if (raster && rasterOnly) rasterAttempts else stdAttempts).distinct()
            val jobMt = if (raster && rasterOnly) effMt else mt
            for (at in useAttempts) {
                // A raster page already has the sheet's size, so print-scaling means nothing to it: leave it out (a Brother DCP-T420W takes only raster).
                val sc = if (raster) "" else at.scaling
                val pathList = if (e.attrsTried && e.ippPath.isNotBlank()) listOf(e.ippPath) else ippPaths(e).toList()
                var pathIdx = 0
                val pathsToTry = ArrayList<String>(pathList)
                while (pathIdx < pathsToTry.size) {
                    val path = pathsToTry[pathIdx++]
                    val desc = "$format $path " + (if (at.mediaName.isNotEmpty()) "media=${at.mediaName}" else if (at.withMedia) "media-col(m=${at.marginMm100})" else "no-media") +
                        (if (sc.isNotEmpty()) " sc=$sc" else "") +
                        (if (at.withOpts) " q=$qv mt=${jobMt.ifEmpty { "-" }}" else " no-opts")
                    // Always place media-type inside media-col (RFC 8011 / PWG 5100.7), never as a non-standard top-level attribute alongside media-col.
                    val body = ippPrintJob(ippUri(e, path), job, format, data, if (at.withMedia) (if (at.sizeW > 0) at.sizeW else wMm) else 0.0, if (at.sizeH > 0) at.sizeH else hMm,
                        if (at.withOpts) qv else 0, if (at.withOpts) cm else "", if (at.withOpts) jobMt else "", sc, at.mediaName, true, at.marginMm100)
                    var busyRetries = 0
                    var r = try { doPost(e, path, body) } catch (nf: NetFail) {
                        attemptLog.add("$desc -> NET_FAIL(connected=${nf.connected}): ${nf.message}")
                        e.lastAttempts = attemptLog.toList()
                        // Can't connect at all: stop now. Connected but dropped mid-job: move on to the next attempt (do not burn retries on alternate paths).
                        if (!nf.connected || ++drops >= maxDrops) throw nf
                        lastErr = nf.message ?: lastErr
                        break
                    }
                    // Canon SELPHY (CP1300 / CP1500) and compact IPP printers return 0x0507 (server-error-busy) while finishing the previous sheet;
                    // wait and retry the SAME attempt instead of dropping paper/borderless attributes.
                    while (r.http == 200 && r.ipp == 0x0507 && busyRetries < 24) {
                        busyRetries++
                        try { Thread.sleep(2500) } catch (_: InterruptedException) { break }
                        r = try { doPost(e, path, body) } catch (nf: NetFail) {
                            if (!nf.connected || ++drops >= maxDrops) throw nf
                            break
                        }
                    }
                    val unsup = if (r.http == 200) extractUnsupported(r.body) else emptyList()
                    val smsg = if (r.http == 200) extractStatusMessage(r.body) else ""
                    attemptLog.add("$desc -> HTTP ${r.http} IPP ${ippStatusName(r.ipp)}" +
                        (if (unsup.isNotEmpty()) " unsup=[${unsup.joinToString(",")}]" else "") +
                        (if (smsg.isNotEmpty()) " msg=$smsg" else ""))
                    e.lastAttempts = attemptLog.toList()
                    when {
                        r.http == 200 && r.ipp in 0..2 -> {
                            val marginDesc = if (at.marginMm100 > 0) "${at.marginMm100 / 100} mm margins" else "zero margins"
                            e.lastUnsupported = unsup
                            e.lastJobStatus = ""
                            e.lastSent = (if (at.mediaName.isNotEmpty()) "paper " + at.mediaName else if (at.withMedia) "custom page size, $marginDesc" else "no paper named") +
                                ", scaling " + (if (sc.isEmpty()) "not set" else sc) + (if (at.withOpts) ", with quality/colour options" + (if (jobMt.isNotEmpty()) " ($jobMt)" else "") else "") + ", " + format + ", path " + path +
                                (if (unsup.isNotEmpty()) " [ignored: ${unsup.joinToString(", ")}]" else "")
                            val jobId = extractJobId(r.body)
                            if (jobId != null && e.usbDev == null) {
                                pool.execute { watchIppJob(e, path, jobId) }
                            }
                            return jobId to path
                        }
                        r.http == 200 && r.ipp == 0x406 -> {
                            if (pathsToTry.size == 1) {
                                for (alt in ippPaths(e)) if (alt !in pathsToTry) pathsToTry.add(alt)
                            }
                            lastErr = "The printer says it has no print queue at the addresses tried (" +
                                ippPaths(e).joinToString(", ") + "; code 0x406). Add it by its IP address again, or check it has IPP / AirPrint turned on."
                        }
                        r.http == 200 && r.ipp == 0x0507 -> {
                            throw IllegalStateException("The printer is still busy with the previous photo (code 0x507). Wait for it to finish, then print again.")
                        }
                        r.http == 200 -> {
                            lastErr = "The printer refused the photo (code 0x" + Integer.toHexString(r.ipp) +
                                (if (unsup.isNotEmpty()) "; unsupported: ${unsup.take(4).joinToString(", ")}" else "") + ")."
                            break // move to next attribute attempt on the same known path
                        }
                        r.http == 426 || r.http == 301 || r.http == 302 -> lastErr = "This printer only accepts secure printing, which the app doesn't support yet."
                        r.http == 404 -> {
                            if (pathsToTry.size == 1) {
                                for (alt in ippPaths(e)) if (alt !in pathsToTry) pathsToTry.add(alt)
                            }
                        }
                        else -> if (r.http > 0) lastErr = "The printer answered with HTTP ${r.http}."
                    }
                }
            }
        }
        e.lastAttempts = attemptLog.toList()
        throw IllegalStateException(lastErr)
    }

    private val selphyCpModelRx = Regex("(?i)\\bCP[\\s_-]?(?:820|910|1000|1200|1300|1500)\\b")
    private fun isSelphy(e: Entry): Boolean {
        val text = e.model + " " + e.name
        return text.contains("selphy", true) || selphyCpModelRx.containsMatchIn(text) || (e.usbDev?.let { usbIsSelphy(it) } == true)
    }

    /**
     * The paper the SELPHY names (loaded paper first, then everything it supports) that is closest to the sheet asked for,
     * or null when none is within 6 mm. Names carry their own size: "jpn_hagaki_100x148mm", "na_index-4x6_4x6in".
     */
    private fun selphyMedia(e: Entry, wMm: Double, hMm: Double, borderless: Boolean = false): String? {
        if (wMm <= 0 || hMm <= 0) return null
        val want = listOf(minOf(wMm, hMm), maxOf(wMm, hMm))
        // A printer may list a separate borderless version of a paper ("jpn_hagaki_100x148mm_borderless"): the name then ends in a tag
        // after the size. Those are read too, and the one that matches the Borderless choice wins when two have the same size.
        val re = Regex("_(\\d+(?:\\.\\d+)?)x(\\d+(?:\\.\\d+)?)(mm|in)(?:[-_.]?(borderless|full-?bleed))?$", RegexOption.IGNORE_CASE)
        fun pick(names: List<String>): String? {
            var best: String? = null
            var bestDiff = 6.0
            var bestMatchesChoice = false
            for (n in names) {
                val m = re.find(n) ?: continue
                val k = if (m.groupValues[3] == "in") 25.4 else 1.0
                val a = m.groupValues[1].toDouble() * k
                val b = m.groupValues[2].toDouble() * k
                val d = maxOf(Math.abs(minOf(a, b) - want[0]), Math.abs(maxOf(a, b) - want[1]))
                val matchesChoice = (m.groupValues[4].isNotEmpty()) == borderless
                if (d < bestDiff - 0.01 || (Math.abs(d - bestDiff) <= 0.01 && matchesChoice && !bestMatchesChoice) || (d <= bestDiff && best == null)) {
                    bestDiff = d; best = n; bestMatchesChoice = matchesChoice
                }
            }
            return best
        }
        val tag = Regex("[-_.]?(borderless|full-?bleed)$", RegexOption.IGNORE_CASE)
        val ready = pick(e.mediaReady)
        if (ready != null) {
            // The paper that is loaded wins; if the printer lists the same paper in the version that matches the Borderless choice, that version is used.
            if (tag.containsMatchIn(ready) != borderless) {
                val alt = e.mediaSupported.firstOrNull { it.replace(tag, "") == ready.replace(tag, "") && tag.containsMatchIn(it) == borderless }
                if (alt != null) return alt
            }
            return ready
        }
        pick(e.mediaSupported)?.let { return it }
        if (isSelphy(e)) {
            if (Math.abs(want[0] - 54.0) < 8.0 && Math.abs(want[1] - 86.0) < 8.0) return "om_card_54x86mm"
            if (Math.abs(want[0] - 89.0) < 8.0 && Math.abs(want[1] - 119.0) < 8.0) return "oe_photo-l_3.5x5in"
            if (Math.abs(want[0] - 100.0) < 8.0 && Math.abs(want[1] - 148.0) < 8.0) return "jpn_hagaki_100x148mm"
        }
        return null
    }

    /** The JPEG with the requested DPI (default 300) written into its JFIF header, so a printer printing at actual size (no scaling) gets the exact sheet dimensions. */
    private fun jpegAtDpi(j: ByteArray, dpi: Int = 300): ByteArray {
        val d = if (dpi in 150..1200) dpi else 300
        // JFIF header: FF D8 FF E0 len(2) 'J' 'F' 'I' 'F' 0 ver(2) units(1) Xdensity(2) Ydensity(2)
        if (j.size < 20 || j[0] != 0xFF.toByte() || j[1] != 0xD8.toByte() || j[2] != 0xFF.toByte() || j[3] != 0xE0.toByte()) return j
        if (j[6] != 0x4A.toByte() || j[7] != 0x46.toByte() || j[8] != 0x49.toByte() || j[9] != 0x46.toByte()) return j   // "JFIF"
        val out = j.copyOf()
        out[13] = 1                                       // dots per inch
        out[14] = (d shr 8).toByte(); out[15] = (d and 0xFF).toByte()
        out[16] = (d shr 8).toByte(); out[17] = (d and 0xFF).toByte()
        return out
    }

    private fun jpegAt300Dpi(j: ByteArray): ByteArray = jpegAtDpi(j, 300)

    /** One PWG Raster page for printers that list image/pwg-raster: 300 dpi when offered, colour unless grey is asked for or all they list. */
    private fun pwgPage(e: Entry, jpeg: ByteArray, wMm: Double, hMm: Double, opts: Opts,
                        mediaType: String = "", namedOverride: String? = null): ByteArray {
        val types = e.pwgTypes
        if (types.isNotEmpty() && "srgb_8" !in types && "sgray_8" !in types) {
            throw IllegalStateException("This printer's raster mode (" + types.take(3).joinToString(", ") + ") isn't supported yet.")
        }
        val gray = types.isNotEmpty() && "sgray_8" in types && ("srgb_8" !in types || opts.color == "mono")
        val avail = if (e.pwgRes.isNotEmpty()) e.pwgRes else listOf(300)
        val want = when (opts.quality) { "draft" -> 150; "high", "high720" -> 600; else -> 300 }
        fun pixelsAt(d: Int) = Math.round(minOf(wMm, hMm) / 25.4 * d).toLong() * Math.round(maxOf(wMm, hMm) / 25.4 * d)
        val fits = avail.filter { pixelsAt(it) <= 26_000_000L }
        val dpi = (if (fits.isNotEmpty()) fits else avail).minByOrNull { Math.abs(it - want) } ?: 300
        // A printer that takes ONLY raster (no JPEG, no PDF: a Brother DCP-T420W) gets the page labelled and written the way CUPS does it,
        // which is what such a printer is tested with: the IPP name of the paper and of its type in the header, the image box left zero.
        val rasterOnly = "image/jpeg" !in e.formats && "application/pdf" !in e.formats
        val shortMm = minOf(wMm, hMm)
        val longMm = maxOf(wMm, hMm)
        val named = if (rasterOnly) (namedOverride ?: selphyMedia(e, wMm, hMm, false)?.takeIf { n ->
            mediaSizeMm(n)?.let { Math.abs(it.first - shortMm) < 0.6 && Math.abs(it.second - longMm) < 0.6 } == true
        }) else null
        val pageName = if (!rasterOnly) "" else named ?: ("custom_photo_" + (Math.round(shortMm * 10) / 10.0) + "x" + (Math.round(longMm * 10) / 10.0) + "mm")
        return PwgRaster.fromJpeg(jpeg, shortMm, longMm, dpi, gray, pageName, if (rasterOnly) mediaType else "", rasterOnly)
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
            "pwg-raster-document-resolution-supported", "pwg-raster-document-type-supported", "media-ready", "media-supported",
            "media-top-margin-supported", "media-bottom-margin-supported", "media-left-margin-supported", "media-right-margin-supported",
            "printer-state-reasons")) {
            u8(0x44); u16(0); str(n)
        }
        u8(0x03)
        return o.toByteArray()
    }

    private fun ippGetAllAttributes(uri: String): ByteArray {
        val o = ByteArrayOutputStream()
        fun u8(v: Int) = o.write(v and 0xFF)
        fun u16(v: Int) { u8(v shr 8); u8(v) }
        fun str(s: String) { val b = s.toByteArray(Charsets.UTF_8); u16(b.size); o.write(b) }
        fun attr(tag: Int, name: String, value: String) { u8(tag); str(name); str(value) }
        u16(0x0200); u16(0x000B); u16(0); u16(1)
        u8(0x01)
        attr(0x47, "attributes-charset", "utf-8")
        attr(0x48, "attributes-natural-language", "en")
        attr(0x45, "printer-uri", uri)
        attr(0x44, "requested-attributes", "all")
        u8(0x03)
        return o.toByteArray()
    }

    private class Reply(val http: Int, val ipp: Int, val body: ByteArray = ByteArray(0))

    /** A network failure talking to the printer. [connected] is true when the printer did answer the connection, then dropped it. */
    private class NetFail(msg: String, val connected: Boolean) : IllegalStateException(msg)

    private fun post(ip: String, port: Int, path: String, body: ByteArray, connectTimeoutMs: Int = 5000, readTimeoutMs: Int = 90_000, maxReplyBytes: Int = 262144): Reply {
        var connected = false
        try {
            newSocket(ip).use { s ->
                s.connect(InetSocketAddress(ip, port), connectTimeoutMs)
                connected = true
                s.soTimeout = readTimeoutMs
                val out = s.getOutputStream()
                val head = "POST $path HTTP/1.1\r\nHost: $ip:$port\r\nContent-Type: application/ipp\r\n" +
                    "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                // A printer that dislikes the job often answers at once and hangs up, which breaks our write halfway.
                // Keep the error, but still read what it said: that answer is the real reason.
                var sendErr: java.io.IOException? = null
                try {
                    out.write(head.toByteArray(Charsets.ISO_8859_1))
                    out.write(body)
                    out.flush()
                } catch (ex: java.io.IOException) { sendErr = ex }
                val buf = ByteArrayOutputStream()
                val tmp = ByteArray(4096)
                try {
                    while (buf.size() < maxReplyBytes) {
                        val n = s.getInputStream().read(tmp)
                        if (n < 0) break
                        buf.write(tmp, 0, n)
                    }
                } catch (ex: java.io.IOException) {
                    if (buf.size() == 0) throw sendErr ?: ex
                }
                if (buf.size() == 0 && sendErr != null) throw sendErr
                return parseReply(buf.toByteArray())
            }
        } catch (ex: Exception) {
            Log.w(TAG, "post $ip:$port$path", ex)
            val why = when {
                ex is java.net.SocketTimeoutException && !connected -> "it did not answer within ${connectTimeoutMs / 1000} seconds"
                ex is java.net.SocketTimeoutException -> "it stopped answering while printing"
                ex is java.net.ConnectException -> "it refused the connection on port $port"
                ex is java.net.NoRouteToHostException || ex is java.net.UnknownHostException -> "the tablet has no route to it"
                connected -> "it hung up while the photo was being sent (${ex.message ?: ex.javaClass.simpleName})"
                else -> ex.message ?: ex.javaClass.simpleName
            }
            val subnetHint = if (!connected && matchLocalNet(ip) == null) {
                val active = currentNets().joinToString(", ") { "${it.addr.hostAddress}/${it.prefix}" }
                if (active.isNotEmpty()) " (Tablet Wi-Fi is $active — if you switched between Wi-Fi and Wi-Fi Direct, tap Find printers.)" else ""
            } else ""
            throw NetFail("Could not reach printer at $ip: $why. Check it is on, and on the same Wi-Fi as the tablet.$subnetHint", connected)
        }
    }

    /** Splits an HTTP reply into its status code, the IPP status and the IPP body (handles 100 Continue and multi-chunk encoding). */
    private fun parseReply(bytes: ByteArray): Reply {
        val start = skip100Continue(bytes)
        val split = indexOfHeaderEnd(bytes, start)
        val head = if (split >= 0) String(bytes, start, split - start, Charsets.ISO_8859_1)
            else String(bytes, start, bytes.size - start, Charsets.ISO_8859_1)
        val http = Regex("^HTTP/1\\.[01]\\s+(\\d{3})").find(head)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        if (http != 200 || split < 0) return Reply(http, -1)
        val bodyStart = split + 4
        val body = if (Regex("(?im)^transfer-encoding:[^\\r\\n]*chunked").containsMatchIn(head)) {
            decodeChunked(bytes, bodyStart).second
        } else {
            bytes.copyOfRange(bodyStart, bytes.size)
        }
        if (body.size < 4) return Reply(http, -1)
        return Reply(
            http, ((body[2].toInt() and 0xFF) shl 8) or (body[3].toInt() and 0xFF),
            body
        )
    }

    private fun ippUri(e: Entry, path: String) = if (e.usbDev != null) "ipp://localhost$path" else "ipp://${e.ip}:${e.ippPort}$path"

    private fun doPost(e: Entry, path: String, body: ByteArray): Reply =
        if (e.usbDev != null) usbPost(e.usbDev!!, path, body) else post(e.ip, e.ippPort, path, body)

    private fun ippPrintJob(uri: String, job: String, format: String, doc: ByteArray, wMm: Double, hMm: Double,
                            quality: Int = 0, colorMode: String = "", mediaType: String = "", scaling: String = "fill",
                            mediaName: String = "", mediaTypeInCol: Boolean = true, marginMm100: Int = 0,
                            opCode: Int = 0x0002, mediaTypeMode: String = ""): ByteArray {
        val o = ByteArrayOutputStream()
        fun u8(v: Int) = o.write(v and 0xFF)
        fun u16(v: Int) { u8(v shr 8); u8(v) }
        fun u32(v: Int) { u16(v ushr 16); u16(v) }
        fun str(s: String) { val b = s.toByteArray(Charsets.UTF_8); u16(b.size); o.write(b) }
        fun attr(tag: Int, name: String, value: String) { u8(tag); str(name); str(value) }
        fun member(name: String) { u8(0x4a); u16(0); str(name) }
        fun memberInt(name: String, v: Int) { member(name); u8(0x21); u16(0); u16(4); u32(v) }

        val mtMode = if (mediaTypeMode.isNotEmpty()) mediaTypeMode.lowercase() else if (mediaTypeInCol) "col" else "top"
        u16(0x0200); u16(opCode); u32(1)                       // IPP 2.0, Print-Job (0x0002) or Validate-Job (0x0004)
        u8(0x01)                                                // operation attributes
        attr(0x47, "attributes-charset", "utf-8")
        attr(0x48, "attributes-natural-language", "en")
        attr(0x45, "printer-uri", uri)
        attr(0x42, "requesting-user-name", "photobooth")
        attr(0x42, "job-name", job)
        attr(0x49, "document-format", format)
        u8(0x02)                                                // job attributes
        val margin = marginMm100.coerceAtLeast(0)
        var sentMtInCol = false
        if (mediaName.isNotEmpty()) {
            attr(0x44, "media", mediaName)                      // a paper the printer itself lists
        } else if (wMm > 0) {
            u8(0x34); str("media-col"); u16(0)                  // begCollection
            member("media-size")
            u8(0x34); u16(0); u16(0)                            // nested begCollection
            memberInt("x-dimension", Math.round(minOf(wMm, hMm) * 100).toInt())
            memberInt("y-dimension", Math.round(maxOf(wMm, hMm) * 100).toInt())
            u8(0x37); u16(0); u16(0)                            // end media-size
            memberInt("media-top-margin", margin)
            memberInt("media-bottom-margin", margin)
            memberInt("media-left-margin", margin)
            memberInt("media-right-margin", margin)
            // IPP RFC 8011 / PWG 5100.7: media-type belongs inside media-col.
            if (mediaType.isNotEmpty() && (mtMode == "col" || mtMode == "both")) {
                member("media-type"); u8(0x44); u16(0); str(mediaType)
                sentMtInCol = true
            }
            u8(0x37); u16(0); u16(0)                            // end media-col
        } else if (mediaType.isNotEmpty() && mtMode == "col") {
            // Minimal media-col carrying only media-type when no page size is attached.
            u8(0x34); str("media-col"); u16(0)
            member("media-type"); u8(0x44); u16(0); str(mediaType)
            u8(0x37); u16(0); u16(0)
            sentMtInCol = true
        }
        if (scaling.isNotEmpty()) attr(0x44, "print-scaling", scaling)
        if (quality != 0) { u8(0x23); str("print-quality"); u16(4); u32(quality) }          // enum
        if (colorMode.isNotEmpty()) attr(0x44, "print-color-mode", colorMode)
        if (mediaType.isNotEmpty() && mtMode != "none" && (!sentMtInCol || mtMode == "both")) {
            attr(0x44, "media-type", mediaType)
        }
        u8(0x03)                                                // end of attributes
        if (opCode != 0x0004 && doc.isNotEmpty()) o.write(doc)
        return o.toByteArray()
    }

    // ── Shared Wireless Printer Diagnostic Engine (in-app + 127.0.0.1:17321 /printer/diag/*) ──

    private fun appVersionName(): String = try {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "?"
    } catch (_: Exception) { "?" }

    /** Active tablet network interfaces, Wi-Fi Direct hints, and currently discovered printers. */
    fun diagNetworkJson(): JSONObject {
        nets = localNets(); netsAt = System.currentTimeMillis()
        val netArr = JSONArray()
        val suggestions = LinkedHashSet<String>()
        var wifiDirectDetected = false
        for (n in nets) {
            val ip = n.addr.hostAddress ?: ""
            val gw = ipText((ipLong(n.addr) and 0xFFFFFF00L) or 1L)
            // Note: 192.168.0.x is NOT flagged automatically because consumer routers (TP-Link, D-Link, pocket Wi-Fi) use 192.168.0.1.
            val isEpsonWfd = ip.startsWith("192.168.223.")
            val isBrotherWfd = ip.startsWith("192.168.118.")
            val isP2p = n.ifaceName.lowercase().contains("p2p") || ip.startsWith("192.168.49.")
            val isWfd = isEpsonWfd || isBrotherWfd || isP2p
            if (isWfd) wifiDirectDetected = true
            if (isBrotherWfd) suggestions.add("192.168.118.1")
            if (isEpsonWfd) suggestions.add("192.168.223.1")
            if (gw != ip) suggestions.add(gw)
            netArr.put(JSONObject()
                .put("iface", n.ifaceName.ifEmpty { "wifi" })
                .put("ip", ip)
                .put("prefix", n.prefix)
                .put("gateway", gw)
                .put("boundNetwork", n.network != null)
                .put("wifiDirectHint", isWfd))
        }
        val printersArr = JSONArray()
        for (e in found.values.sortedBy { it.ip }) {
            if (e.ippPort > 0 || e.rawPort > 0 || e.lpdPort > 0) {
                suggestions.add(e.ip)
                printersArr.put(JSONObject()
                    .put("ip", e.ip)
                    .put("name", e.name.ifBlank { e.model.ifBlank { "Printer at ${e.ip}" } })
                    .put("model", e.model)
                    .put("ippPort", e.ippPort)
                    .put("ippPath", e.ippPath)
                    .put("rawPort", e.rawPort)
                    .put("lpdPort", e.lpdPort)
                    .put("qualities", JSONArray(e.qualities))
                    .put("mediaTypes", JSONArray(e.mediaTypes))
                    .put("borderlessCap", e.borderlessCap)
                    .put("route", routeHintFor(e.ip)))
            }
        }
        return JSONObject()
            .put("platform", "android")
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})")
            .put("appVersion", appVersionName())
            .put("wifiDirectDetected", wifiDirectDetected)
            .put("nets", netArr)
            .put("suggestedIps", JSONArray(suggestions.toList()))
            .put("printers", printersArr)
    }

    @JavascriptInterface
    fun diagNetwork(): String = diagNetworkJson().toString()

    /** Native Android clipboard write so Copy Report always works offline in WebView even when navigator.clipboard is blocked. */
    @JavascriptInterface
    fun copyText(text: String): Boolean {
        val ok = java.util.concurrent.atomic.AtomicBoolean(false)
        val latch = CountDownLatch(1)
        try {
            activity.runOnUiThread {
                try {
                    val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager
                    if (cm != null) {
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("photobooth4u", text))
                        ok.set(true)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "copyText failed", e)
                } finally {
                    latch.countDown()
                }
            }
            latch.await(1500, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {}
        return ok.get()
    }

    /** Quick discovery helper for 127.0.0.1:17321 /printer/discover (probes gateway .1 + any supplied IPs immediately). */
    fun discoverForHelper(extraIps: List<String> = emptyList()): JSONObject {
        nets = localNets(); netsAt = System.currentTimeMillis()
        val toProbe = LinkedHashSet<String>()
        for (ip in extraIps) if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) toProbe.add(ip)
        for (n in nets) {
            val gw = ipText((ipLong(n.addr) and 0xFFFFFF00L) or 1L)
            if (gw != n.addr.hostAddress) toProbe.add(gw)
        }
        for (ip in toProbe) {
            val e = Entry(ip)
            probeInto(e, 1500)
            if (e.ippPort > 0 || e.rawPort > 0 || e.lpdPort > 0) {
                val cur = found.getOrPut(ip) { e }
                if (cur !== e) {
                    if (cur.ippPort == 0) cur.ippPort = e.ippPort
                    if (cur.rawPort == 0) cur.rawPort = e.rawPort
                    if (cur.lpdPort == 0) cur.lpdPort = e.lpdPort
                }
                if (cur.ippPort > 0) fetchAttrs(cur) else fetchWebModel(cur)
            }
        }
        val info = diagNetworkJson()
        val names = JSONArray()
        for (n in getPrinterNames()) names.put(n)
        info.put("printerNames", names)
        return info
    }

    private fun portProbeTimed(ip: String, port: Int, timeoutMs: Int): JSONObject {
        val t0 = System.currentTimeMillis()
        return try {
            newSocket(ip).use { s ->
                s.connect(InetSocketAddress(ip, port), timeoutMs)
            }
            JSONObject().put("port", port).put("open", true).put("ms", System.currentTimeMillis() - t0)
        } catch (ex: Exception) {
            JSONObject().put("port", port).put("open", false).put("ms", System.currentTimeMillis() - t0)
                .put("error", ex.javaClass.simpleName + (ex.message?.let { ": $it" } ?: ""))
        }
    }

    private fun defaultValidateCases(named4x6: String, supportsPwg: Boolean): JSONArray {
        val arr = JSONArray()
        fun add(id: String, label: String, withMedia: Boolean, mediaName: String, margin: Int, q: Int, mt: String, mtMode: String, sc: String, fmt: String = "image/jpeg") {
            arr.put(JSONObject()
                .put("id", id).put("label", label).put("withMedia", withMedia).put("mediaName", mediaName)
                .put("marginMm100", margin).put("quality", q).put("mediaType", mt).put("mediaTypeMode", mtMode)
                .put("scaling", sc).put("format", fmt))
        }
        add("ipp-col-q5-glossy-scNone", "media-col (0mm) + glossy IN col + High(5) + scaling=none", true, "", 0, 5, "photographic-glossy", "col", "none")
        add("ipp-col-q5-glossy-noSc", "media-col (0mm) + glossy IN col + High(5) + NO scaling", true, "", 0, 5, "photographic-glossy", "col", "")
        add("ipp-col-q5-glossy-scFill", "media-col (0mm) + glossy IN col + High(5) + scaling=fill", true, "", 0, 5, "photographic-glossy", "col", "fill")
        add("ipp-top-q5-glossy-scNone", "OLD ca4428a style: media-col + TOP-LEVEL glossy + High(5) + scaling=none", true, "", 0, 5, "photographic-glossy", "top", "none")
        if (named4x6.isNotEmpty()) {
            add("ipp-named-q5-glossy-noSc", "named media=$named4x6 + High(5) + top glossy + NO scaling", false, named4x6, 0, 5, "photographic-glossy", "top", "")
        }
        add("ipp-col-only-noSc", "media-col (0mm) only (no quality / media-type / scaling)", true, "", 0, 0, "", "none", "")
        add("ipp-minimal", "Minimal JPEG (no job attributes)", false, "", 0, 0, "", "none", "")
        if (supportsPwg) {
            add("ipp-pwg-col-q5-glossy", "PWG Raster + media-col (0mm) + glossy IN col + High(5)", true, "", 0, 5, "photographic-glossy", "col", "", "image/pwg-raster")
        }
        return arr
    }

    /**
     * Zero-paper comprehensive Wi-Fi / Wi-Fi Direct diagnostic probe:
     *   1) Active interfaces & socket route check
     *   2) TCP port scan (631 IPP, 9100 raw/ESC/P-R, 515 LPD, 80 Web Config)
     *   3) Full IPP Get-Printer-Attributes ("all") dump + media-col-database 4x6/borderless summary
     *   4) Zero-paper IPP Validate-Job (0x0004) matrix checking unsupported-attributes (group 0x05)
     */
    fun diagProbeSync(ipRaw: String, casesArr: JSONArray? = null): JSONObject {
        val ip = ipRaw.trim()
        val out = JSONObject()
            .put("ip", ip)
            .put("timestamp", System.currentTimeMillis())
            .put("network", diagNetworkJson())
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) {
            return out.put("ok", false).put("error", "Invalid IPv4 address: $ip")
        }
        out.put("route", routeHintFor(ip))

        // Step 1: TCP port checks
        val portsObj = JSONObject()
        val p631 = portProbeTimed(ip, 631, 3000)
        val p9100 = portProbeTimed(ip, 9100, 2500)
        val p515 = portProbeTimed(ip, 515, 1500)
        val p80 = portProbeTimed(ip, 80, 1500)
        portsObj.put("631", p631).put("9100", p9100).put("515", p515).put("80", p80)
        out.put("ports", portsObj)

        if (!p631.optBoolean("open") && !p9100.optBoolean("open") && !p515.optBoolean("open")) {
            return out.put("ok", true).put("reachable", false)
                .put("recommendation", "Printer $ip did not answer on port 631 (IPP), 9100 (raw/ESC/P-R), or 515 (LPD). Check power, 2.4 GHz Wi-Fi / Wi-Fi Direct connection, and router AP Isolation (Privacy Separator).")
        }
        out.put("reachable", true)
        val diagEntry = found.getOrPut(ip) { Entry(ip) }
        if (p631.optBoolean("open") && diagEntry.ippPort <= 0) diagEntry.ippPort = 631
        if (p9100.optBoolean("open") && diagEntry.rawPort <= 0) diagEntry.rawPort = 9100
        if (p515.optBoolean("open") && diagEntry.lpdPort <= 0) diagEntry.lpdPort = 515
        if (!p631.optBoolean("open")) {
            val wm = fetchWebModel(diagEntry, force = true)
            if (wm.isNotBlank()) out.put("webModel", wm)
            else if (diagEntry.webHint.isNotBlank()) out.put("webModel", diagEntry.webHint)
        }

        // Step 2: Full IPP Get-Printer-Attributes ("all")
        val ippObj = JSONObject()
        var chosenPath = ""
        var named4x6 = ""
        var supportsPwg = false
        val wantedKeys = setOf(
            "printer-make-and-model", "printer-name", "printer-info", "printer-dns-sd-name",
            "printer-state", "printer-state-reasons", "printer-state-message",
            "ipp-versions-supported", "operations-supported", "document-format-supported", "document-format-default",
            "print-quality-supported", "print-quality-default", "print-color-mode-supported", "print-color-mode-default",
            "print-scaling-supported", "print-scaling-default",
            "media-supported", "media-ready", "media-default",
            "media-type-supported", "media-source-supported", "media-col-supported",
            "media-top-margin-supported", "media-bottom-margin-supported", "media-left-margin-supported", "media-right-margin-supported",
            "pwg-raster-document-resolution-supported", "pwg-raster-document-type-supported", "urf-supported",
            "printer-resolution-supported", "color-supported"
        )
        if (p631.optBoolean("open")) {
            val e = found.getOrPut(ip) { Entry(ip).also { it.ippPort = 631 } }
            if (e.ippPort <= 0) e.ippPort = 631
            if (p9100.optBoolean("open") && e.rawPort <= 0) e.rawPort = 9100
            for (path in ippPaths(e)) {
                val t0 = System.currentTimeMillis()
                try {
                    val uri = "ipp://$ip:631$path"
                    var r = post(ip, 631, path, ippGetAllAttributes(uri), 5000, 12_000, 524288)
                    if (r.http != 200 || r.ipp !in 0..2) {
                        r = post(ip, 631, path, ippGetAttributes(uri), 5000, 10_000, 262144)
                    }
                    if (r.http != 200 || r.ipp !in 0..2) continue
                    chosenPath = path
                    e.ippPath = path
                    val attrMap = LinkedHashMap<String, ArrayList<String>>()
                    val allAttrNames = LinkedHashSet<String>()
                    // Track media-col-database summary without flooding memory
                    var dbTotal = 0
                    val dbMediaTypes = LinkedHashSet<String>()
                    val dbSample4x6 = ArrayList<String>()
                    var inDb = false
                    var dbDepth = 0
                    var curMember = ""
                    var curX = 0; var curY = 0; var curTop = -1; var curLeft = -1; var curMt = ""; var curSrc = ""
                    parseIppGrouped(r.body) { grp, name, tag, raw ->
                        if (grp == 0x05) return@parseIppGrouped
                        if (name.isNotEmpty() && !inDb) allAttrNames.add(name)
                        if (name == "media-col-database" || inDb) {
                            if (name == "media-col-database" && tag == 0x34 && !inDb) {
                                inDb = true; dbDepth = 1; dbTotal++
                                curMember = ""; curX = 0; curY = 0; curTop = -1; curLeft = -1; curMt = ""; curSrc = ""
                                return@parseIppGrouped
                            }
                            if (inDb) {
                                if (tag == 0x34) { dbDepth++; return@parseIppGrouped }
                                if (tag == 0x37) {
                                    dbDepth--
                                    if (dbDepth <= 0) {
                                        inDb = false
                                        if (curMt.isNotEmpty()) dbMediaTypes.add(curMt)
                                        val is4x6Entry = (curX in 9900..10400 && curY in 14700..15500) || curTop == 0
                                        if (is4x6Entry && dbSample4x6.size < 16) {
                                            dbSample4x6.add("${curX}x${curY} m=($curTop,$curLeft) mt=${curMt.ifEmpty { "-" }} src=${curSrc.ifEmpty { "-" }}")
                                        }
                                    }
                                    return@parseIppGrouped
                                }
                                if (tag == 0x4a) { curMember = String(raw, Charsets.UTF_8); return@parseIppGrouped }
                                val txt = ippValText(tag, raw)
                                when (curMember) {
                                    "x-dimension" -> curX = txt.toIntOrNull() ?: curX
                                    "y-dimension" -> curY = txt.toIntOrNull() ?: curY
                                    "media-top-margin" -> curTop = txt.toIntOrNull() ?: curTop
                                    "media-left-margin" -> curLeft = txt.toIntOrNull() ?: curLeft
                                    "media-type" -> curMt = txt
                                    "media-source" -> curSrc = txt
                                }
                                return@parseIppGrouped
                            }
                        }
                        if (name in wantedKeys && tag != 0x34 && tag != 0x37 && tag != 0x4a) {
                            val list = attrMap.getOrPut(name) { ArrayList() }
                            val v = ippValText(tag, raw)
                            if (v.isNotEmpty() && list.size < 64) list.add(v)
                        }
                    }
                    val attrsJson = JSONObject()
                    for ((k, v) in attrMap) attrsJson.put(k, JSONArray(v))
                    val formats = attrMap["document-format-supported"]?.map { it.lowercase() } ?: emptyList()
                    supportsPwg = "image/pwg-raster" in formats
                    val mediaAll = (attrMap["media-ready"] ?: emptyList()) + (attrMap["media-supported"] ?: emptyList())
                    named4x6 = mediaAll.firstOrNull { n ->
                        val sz = mediaSizeMm(n)
                        sz != null && Math.abs(sz.first - 101.6) <= 3.0 && Math.abs(sz.second - 152.4) <= 5.0
                    } ?: ""
                    ippObj.put("answered", true)
                        .put("path", path)
                        .put("ms", System.currentTimeMillis() - t0)
                        .put("ippStatus", ippStatusName(r.ipp))
                        .put("bodyBytes", r.body.size)
                        .put("attrCount", allAttrNames.size)
                        .put("attrs", attrsJson)
                        .put("mediaColDbCount", dbTotal)
                        .put("mediaColDbMediaTypes", JSONArray(dbMediaTypes.toList()))
                        .put("mediaColDb4x6Samples", JSONArray(dbSample4x6))
                    val model = attrMap["printer-make-and-model"]?.firstOrNull() ?: ""
                    if (model.isNotBlank()) { e.model = model; if (e.name.isBlank()) e.name = model }
                    break
                } catch (ex: Exception) {
                    ippObj.put("error", ex.message ?: ex.javaClass.simpleName)
                }
            }
        }
        if (!ippObj.has("answered")) ippObj.put("answered", false)
        out.put("ipp", ippObj)

        // Step 3: Zero-paper Validate-Job (0x0004) matrix
        val valResults = JSONArray()
        if (chosenPath.isNotEmpty()) {
            val cases = if (casesArr != null && casesArr.length() > 0) casesArr else defaultValidateCases(named4x6, supportsPwg)
            val uri = "ipp://$ip:631$chosenPath"
            for (i in 0 until cases.length()) {
                val c = cases.optJSONObject(i) ?: continue
                val cid = c.optString("id", "case-$i")
                val label = c.optString("label", cid)
                val fmt = c.optString("format", "image/jpeg").ifBlank { "image/jpeg" }
                val withMedia = c.optBoolean("withMedia", true)
                val wMm = if (withMedia) c.optDouble("widthMm", 101.6) else 0.0
                val hMm = if (withMedia) c.optDouble("heightMm", 152.4) else 0.0
                val mediaName = c.optString("mediaName", "")
                val margin = c.optInt("marginMm100", 0)
                val quality = c.optInt("quality", 0)
                val colorMode = c.optString("colorMode", "")
                val mediaType = c.optString("mediaType", "")
                val mtMode = c.optString("mediaTypeMode", "col")
                val scaling = c.optString("scaling", "")
                val t0 = System.currentTimeMillis()
                val res = JSONObject().put("id", cid).put("label", label)
                try {
                    val reqBody = ippPrintJob(uri, "pb4u-validate", fmt, ByteArray(0), wMm, hMm,
                        quality, colorMode, mediaType, scaling, mediaName, mtMode == "col", margin, 0x0004, mtMode)
                    val r = post(ip, 631, chosenPath, reqBody, 5000, 10_000, 65536)
                    val unsup = if (r.http == 200) extractUnsupported(r.body) else emptyList()
                    val smsg = if (r.http == 200) extractStatusMessage(r.body) else ""
                    val accepted = r.http == 200 && r.ipp in 0..2
                    res.put("http", r.http)
                        .put("ipp", r.ipp)
                        .put("ippHex", "0x" + Integer.toHexString(if (r.ipp < 0) 0 else r.ipp))
                        .put("ippName", ippStatusName(r.ipp))
                        .put("ok", accepted)
                        .put("clean", accepted && unsup.isEmpty() && r.ipp == 0)
                        .put("unsupported", JSONArray(unsup))
                        .put("statusMessage", smsg)
                        .put("ms", System.currentTimeMillis() - t0)
                } catch (ex: Exception) {
                    res.put("ok", false).put("clean", false).put("error", ex.message ?: ex.javaClass.simpleName)
                        .put("ms", System.currentTimeMillis() - t0)
                }
                valResults.put(res)
            }
        }
        out.put("validateMatrix", valResults)

        // Plain-English diagnosis summary
        val rec = StringBuilder()
        if (p9100.optBoolean("open")) rec.append("Port 9100 (raw ESC/P-R) is OPEN. ")
        else rec.append("Port 9100 (raw ESC/P-R) is CLOSED. ")
        if (p515.optBoolean("open")) rec.append("Port 515 (LPD /PASSTHRU) is OPEN. ")
        if (chosenPath.isNotEmpty()) {
            var cleanId = ""
            var anyOkId = ""
            var oldStyleFailed = false
            for (i in 0 until valResults.length()) {
                val r = valResults.getJSONObject(i)
                val id = r.optString("id")
                if (cleanId.isEmpty() && r.optBoolean("clean") && id != "ipp-minimal") cleanId = id
                if (anyOkId.isEmpty() && r.optBoolean("ok") && id != "ipp-minimal") anyOkId = id
                if (id == "ipp-top-q5-glossy-scNone" && !r.optBoolean("ok")) oldStyleFailed = true
            }
            if (cleanId.isNotEmpty()) rec.append("Cleanest IPP Validate-Job winner: $cleanId (0 ignored attributes). ")
            else if (anyOkId.isNotEmpty()) rec.append("IPP accepted $anyOkId but ignored some attributes — check unsupported list and also test ESC/P-R on port 9100 or LPD :515. ")
            else rec.append("IPP Validate-Job rejected photo options (or Validate-Job unsupported) — run a 1-sheet live test on IPP, ESC/P-R :9100, or LPD :515. ")
            if (oldStyleFailed) rec.append("Confirmed: old top-level media-type + scaling=none failed Validate-Job on this printer.")
        } else if (p515.optBoolean("open") && !p9100.optBoolean("open")) {
            rec.append("IPP port 631 and RAW port 9100 are closed — use LPD :515 (ESC/P-R PASSTHRU) preset below (photobooth4u also uses LPD :515 automatically when printing).")
        } else {
            rec.append("IPP port 631 did not answer Get-Printer-Attributes — use ESC/P-R on port 9100 or LPD :515.")
        }
        out.put("recommendation", rec.toString().trim())
        return out.put("ok", true)
    }

    /**
     * Explicit 1-sheet live diagnostic print (IPP Print-Job + Get-Job-Attributes polling,
     * raw ESC/P-R on port 9100, or RFC 1179 LPD :515 /PASSTHRU with explicit dpi/mediaCode/qualityCode/l8050Geo).
     */
    fun diagPrintSync(payload: JSONObject): JSONObject {
        val ip = payload.optString("ip", "").trim()
        val protocol = payload.optString("protocol", "ipp").lowercase()
        val out = JSONObject().put("ip", ip).put("protocol", protocol).put("route", routeHintFor(ip))
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) {
            return out.put("ok", false).put("error", "Invalid IPv4 address: $ip")
        }
        val b64 = payload.optString("imageBase64", "")
        if (b64.isBlank()) return out.put("ok", false).put("error", "Missing calibration imageBase64.")
        val jpegIn = decode(b64)
        val wMm = payload.optDouble("widthMm", 101.6)
        val hMm = payload.optDouble("heightMm", 152.4)

        if (protocol == "lpd") {
            val port = payload.optInt("port", 515)
            val queue = payload.optString("queue", "PASSTHRU")
            val dpi = payload.optInt("dpi", 360)
            val mediaCode = payload.optInt("mediaCode", EscprJob.MEDIA_EPSON_GLOSSY)
            val qualityCode = payload.optInt("qualityCode", 2)
            val borderless = payload.optBoolean("borderless", true)
            val l8050Geo = payload.optBoolean("l8050Geo", true)
            val sendSetiChku = payload.optBoolean("sendSetiChku", true)
            val sendSetm = payload.optBoolean("sendSetm", false)
            val mono = payload.optBoolean("mono", false)
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpegIn, 0, jpegIn.size)
                ?: return out.put("ok", false).put("error", "Could not decode JPEG image.")
            val cfg = EscprJob.Config(dpi, mediaCode, qualityCode, borderless, l8050Geo, sendSetiChku, mono, PrintColorAdj(), sendSetm)
            val sendStart = System.currentTimeMillis()
            try {
                val (streamedBytes, usedQueue) = netLpdStream(ip, port, queue) { writeChunk ->
                    EscprJob.streamWithConfig(bmp, wMm, hMm, cfg, writeChunk)
                }
                return out.put("ok", true)
                    .put("port", port)
                    .put("queue", usedQueue)
                    .put("bytes", streamedBytes)
                    .put("buildMs", 0L)
                    .put("sendMs", System.currentTimeMillis() - sendStart)
                    .put("config", JSONObject()
                        .put("dpi", dpi).put("mediaHex", "0x%02x".format(mediaCode))
                        .put("qualityCode", qualityCode).put("borderless", borderless)
                        .put("l8050Geo", l8050Geo).put("sendSetiChku", sendSetiChku).put("sendSetm", sendSetm))
            } catch (ex: Exception) {
                return out.put("ok", false).put("error", ex.message ?: ex.javaClass.simpleName)
                    .put("port", port).put("queue", queue)
                    .put("sendMs", System.currentTimeMillis() - sendStart)
            } finally {
                try { bmp.recycle() } catch (_: Exception) {}
            }
        }

        if (protocol == "escpr") {
            val port = payload.optInt("port", 9100)
            val dpi = payload.optInt("dpi", 720)
            val mediaCode = payload.optInt("mediaCode", EscprJob.MEDIA_EPSON_GLOSSY)
            val qualityCode = payload.optInt("qualityCode", 2)
            val borderless = payload.optBoolean("borderless", true)
            val l8050Geo = payload.optBoolean("l8050Geo", true)
            val sendSetiChku = payload.optBoolean("sendSetiChku", true)
            val sendSetm = payload.optBoolean("sendSetm", false)
            val mono = payload.optBoolean("mono", false)
            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpegIn, 0, jpegIn.size)
                ?: return out.put("ok", false).put("error", "Could not decode JPEG image.")
            val cfg = EscprJob.Config(dpi, mediaCode, qualityCode, borderless, l8050Geo, sendSetiChku, mono, PrintColorAdj(), sendSetm)
            val sendStart = System.currentTimeMillis()
            var streamedBytes = 0L
            val replyBuf = ByteArrayOutputStream()
            try {
                newSocket(ip).use { s ->
                    s.connect(InetSocketAddress(ip, port), 6000)
                    val bos = java.io.BufferedOutputStream(s.getOutputStream(), 65536)
                    streamedBytes = EscprJob.streamWithConfig(bmp, wMm, hMm, cfg) { buf, len -> bos.write(buf, 0, len) }
                    bos.flush()
                    try {
                        s.shutdownOutput()
                        s.soTimeout = 3000
                        val tmp = ByteArray(512)
                        val until = System.currentTimeMillis() + 8_000
                        val inp = s.getInputStream()
                        while (System.currentTimeMillis() < until && replyBuf.size() < 4096) {
                            val n = inp.read(tmp)
                            if (n < 0) break
                            replyBuf.write(tmp, 0, n)
                        }
                    } catch (_: Exception) {}
                }
                val replyBytes = replyBuf.toByteArray()
                return out.put("ok", true)
                    .put("port", port)
                    .put("bytes", streamedBytes)
                    .put("buildMs", 0L)
                    .put("sendMs", System.currentTimeMillis() - sendStart)
                    .put("replyBytes", replyBytes.size)
                    .put("replyPreview", String(replyBytes.take(120).toByteArray(), Charsets.ISO_8859_1).replace(Regex("[^\\x20-\\x7E]"), "."))
                    .put("config", JSONObject()
                        .put("dpi", dpi).put("mediaHex", "0x%02x".format(mediaCode))
                        .put("qualityCode", qualityCode).put("borderless", borderless)
                        .put("l8050Geo", l8050Geo).put("sendSetiChku", sendSetiChku).put("sendSetm", sendSetm))
            } catch (ex: Exception) {
                return out.put("ok", false).put("error", ex.message ?: ex.javaClass.simpleName)
                    .put("bytes", streamedBytes).put("buildMs", 0L).put("sendMs", System.currentTimeMillis() - sendStart)
            } finally {
                try { bmp.recycle() } catch (_: Exception) {}
            }
        }

        // IPP Print-Job + Get-Job-Attributes live trace
        val port = payload.optInt("port", 631)
        val path = payload.optString("path", "").ifBlank { found[ip]?.ippPath?.ifBlank { "/ipp/print" } ?: "/ipp/print" }
        val format = payload.optString("format", "image/jpeg").ifBlank { "image/jpeg" }
        val withMedia = payload.optBoolean("withMedia", true)
        val mediaName = payload.optString("mediaName", "")
        val margin = payload.optInt("marginMm100", 0)
        val quality = payload.optInt("quality", 5)
        val colorMode = payload.optString("colorMode", "")
        val mediaType = payload.optString("mediaType", "photographic-glossy")
        val mtMode = payload.optString("mediaTypeMode", "col")
        val scaling = payload.optString("scaling", "")
        val ippDpi = payload.optInt("dpi", 0)
        val pollSeconds = payload.optInt("pollSeconds", 15).coerceIn(0, 30)

        val e = found.getOrPut(ip) { Entry(ip).also { it.ippPort = port; it.ippPath = path } }
        if (e.ippPort <= 0) e.ippPort = port
        if (e.ippPath.isBlank()) e.ippPath = path
        val doc = when (format) {
            "application/pdf" -> jpegToPdf(jpegAtDpi(jpegIn, ippDpi), wMm, hMm)
            "image/pwg-raster" -> PwgRaster.fromJpeg(jpegIn, minOf(wMm, hMm), maxOf(wMm, hMm), 300, false, mediaName, mediaType, true)
            else -> jpegAtDpi(jpegIn, ippDpi)
        }
        val uri = "ipp://$ip:$port$path"
        val reqBody = ippPrintJob(uri, "pb4u-diag", format, doc, if (withMedia) wMm else 0.0, if (withMedia) hMm else 0.0,
            quality, colorMode, mediaType, scaling, mediaName, mtMode == "col", margin, 0x0002, mtMode)
        val t0 = System.currentTimeMillis()
        try {
            val r = post(ip, port, path, reqBody, 5000, 90_000, 65536)
            val unsup = if (r.http == 200) extractUnsupported(r.body) else emptyList()
            val smsg = if (r.http == 200) extractStatusMessage(r.body) else ""
            val jobId = if (r.http == 200) extractJobId(r.body) else null
            val accepted = r.http == 200 && r.ipp in 0..2
            out.put("ok", accepted)
                .put("path", path)
                .put("format", format)
                .put("docBytes", doc.size)
                .put("sendMs", System.currentTimeMillis() - t0)
                .put("http", r.http)
                .put("ipp", r.ipp)
                .put("ippHex", "0x" + Integer.toHexString(if (r.ipp < 0) 0 else r.ipp))
                .put("ippName", ippStatusName(r.ipp))
                .put("unsupported", JSONArray(unsup))
                .put("statusMessage", smsg)
                .put("jobId", jobId ?: -1)
            val states = JSONArray()
            if (accepted && jobId != null && pollSeconds > 0) {
                val pollEnd = System.currentTimeMillis() + pollSeconds * 1000L
                while (System.currentTimeMillis() < pollEnd) {
                    try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
                    val js = queryJobStateOnce(e, path, jobId)
                    if (js != null) {
                        states.put(JSONObject()
                            .put("atMs", System.currentTimeMillis() - t0)
                            .put("state", js.state)
                            .put("stateName", js.stateName)
                            .put("reasons", JSONArray(js.reasons))
                            .put("message", js.message))
                        if (js.state in setOf(7, 8, 9)) break
                    }
                }
            }
            out.put("jobStates", states)
            return out
        } catch (ex: Exception) {
            return out.put("ok", false).put("error", ex.message ?: ex.javaClass.simpleName)
                .put("sendMs", System.currentTimeMillis() - t0)
        }
    }

    @JavascriptInterface
    fun diagRunProbe(job: String, ip: String, casesJson: String): String {
        pool.execute {
            val res = try {
                val arr = if (casesJson.isNotBlank()) try { JSONArray(casesJson) } catch (_: Exception) { null } else null
                diagProbeSync(ip, arr)
            } catch (ex: Exception) {
                JSONObject().put("ok", false).put("error", ex.message ?: "Probe failed")
            }
            res.put("job", job).put("op", "probe")
            deliverDiag(res)
        }
        return "started"
    }

    @JavascriptInterface
    fun diagRunPrint(job: String, payloadJson: String): String {
        pool.execute {
            val res = try {
                diagPrintSync(JSONObject(payloadJson))
            } catch (ex: Exception) {
                JSONObject().put("ok", false).put("error", ex.message ?: "Diagnostic print failed")
            }
            res.put("job", job).put("op", "print")
            deliverDiag(res)
        }
        return "started"
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
            if (e.ippPort > 0 || e.rawPort > 0 || e.lpdPort > 0) {
                val n = e.name.ifBlank { e.model.ifBlank { "Printer at ${e.ip}" } }
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
        receipt: JSONObject? = null,
        options: JSONObject? = null
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
                        val optJson = options ?: JSONObject()
                        val model = EpsonLModels.match(d) ?: ""
                        val isL8050 = model == "L8050" || isL8050Name(usbName(d))
                        val isL3210 = model == "L3210"
                        val blReq = optJson.optBoolean("borderless", true)
                        val borderless = blReq && (if (isL3210 || model == "L3276") EpsonL3210RasterJob.isBorderlessSize(widthMm, heightMm) else ((epsonL && EpsonLModels.isBorderless(d)) || escpr))
                        val photoMedia = optJson.optString("media", "") != "plain"
                        val adj = PrintColorAdj.from(optJson)
                        val l8050Cfg = if (isL8050) l8050EscprConfig(optJson, borderless, adj, widthMm, heightMm) else null
                        val l3210Cfg = if (isL3210) l3210RasterConfig(optJson, borderless, adj, widthMm, heightMm) else null
                        val escprCfg = if (l8050Cfg == null && l3210Cfg == null) {
                            epsonL360EscprConfig(model, optJson, borderless, photoMedia, adj, widthMm, heightMm)
                        } else null
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                when {
                                    l8050Cfg != null ->
                                        usbRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                    l3210Cfg != null ->
                                        usbRawStream(id) { writeChunk -> EpsonL3210RasterJob.stream(bmp, widthMm, heightMm, l3210Cfg, writeChunk) }
                                    escprCfg != null ->
                                        usbRawStream(id) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, escprCfg, writeChunk) }
                                }
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
                            canonPrintPage(id, jpeg, widthMm, heightMm, false, 1, 1, false, adj, "")
                        }
                    }
                    raw -> {
                        val is58 = widthMm <= 55.0 || isKnown58mmName(usbName(d))
                        val rollW = if (is58) 384 else 576
                        val effOpt = if (is58 && (receiptOpt.bandRows <= 0 || receiptOpt.bandRows > 32)) {
                            ReceiptRaster.Options(receiptOpt.dither, receiptOpt.threshold, 32, receiptOpt.brightness, receiptOpt.sharpen, receiptOpt.slowPrint, receiptOpt.toneLift, receiptOpt.toneDone)
                        } else receiptOpt
                        for (i in 0 until pagesArr.length()) {
                            val jpeg = decode(pagesArr.getString(i))
                            val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                ?: throw IllegalStateException("Couldn't decode photo for printing.")
                            try {
                                val escpos = ReceiptRaster.build(bmp, rollW, effOpt)
                                usbRaw(id, escpos, paced = rollW <= 384)
                            } finally {
                                try { bmp.recycle() } catch (_: Exception) {}
                            }
                        }
                    }
                    ipp -> {
                        val isL8050 = EpsonLModels.match(d) == "L8050" || isL8050Name(usbName(d))
                        val opts = if (isL8050) Opts("high", "", "photo", true) else Opts("", "", "", true)
                        val e = usbEntry(id)
                        for (i in 0 until pagesArr.length()) {
                            val data = decode(pagesArr.getString(i))
                            val (jid, jpath) = sendIppJob(e, "helper_" + System.currentTimeMillis(), data, widthMm, heightMm, opts)
                            if (i < pagesArr.length() - 1 && isSelphy(e)) {
                                awaitSelphyIppIdle(e, jpath, jid)
                            }
                        }
                    }
                    else -> {
                        if (d.vendorId == BrotherUsbModels.VENDOR_ID) {
                            throw IllegalStateException("${usbName(d)} does not expose IPP-over-USB on this cable (only Brother's proprietary USB language). Connect it to Wi-Fi or Wi-Fi Direct for direct printing.")
                        }
                        throw IllegalStateException("Unsupported USB printer model: VID=%04x PID=%04x".format(d.vendorId, d.productId))
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
                    val is58 = widthMm <= 55.0 || isKnown58mmName(netMatch.name)
                    val rollW = if (is58) 384 else 576
                    val effOpt = if (is58 && (receiptOpt.bandRows <= 0 || receiptOpt.bandRows > 32)) {
                        ReceiptRaster.Options(receiptOpt.dither, receiptOpt.threshold, 32, receiptOpt.brightness, receiptOpt.sharpen, receiptOpt.slowPrint, receiptOpt.toneLift, receiptOpt.toneDone)
                    } else receiptOpt
                    for (i in 0 until pagesArr.length()) {
                        val jpeg = decode(pagesArr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't decode photo for printing.")
                        try {
                            val escpos = ReceiptRaster.build(bmp, rollW, effOpt)
                            newSocket(netMatch.ip).use { s ->
                                s.connect(InetSocketAddress(netMatch.ip, netMatch.rawPort), 5000)
                                s.soTimeout = 15000
                                s.getOutputStream().apply { write(escpos); flush() }
                            }
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
                    }
                } else if (netMatch.ippPort == 0 && (netMatch.rawPort > 0 || netMatch.lpdPort > 0)) {
                    if (netMatch.model.isBlank()) fetchWebModel(netMatch)
                    val isL8050 = isL8050Name(netMatch.model + " " + netMatch.name)
                    val l8050Cfg = if (isL8050) l8050EscprConfig(JSONObject(), true, PrintColorAdj(), widthMm, heightMm) else null
                    for (i in 0 until pagesArr.length()) {
                        val jpeg = decode(pagesArr.getString(i))
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                            ?: throw IllegalStateException("Couldn't decode photo for printing.")
                        try {
                            if (l8050Cfg != null) {
                                if (netMatch.rawPort > 0) {
                                    netRawStream(netMatch.ip, netMatch.rawPort) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                } else {
                                    netLpdStream(netMatch.ip, netMatch.lpdPort) { writeChunk -> EscprJob.streamWithConfig(bmp, widthMm, heightMm, l8050Cfg, writeChunk) }
                                }
                            } else {
                                val data = EscprJob.build(bmp, widthMm, heightMm, false, borderless = true, photoMedia = true, epsonBorderless = true)
                                if (netMatch.rawPort > 0) netRawJob(netMatch.ip, data) else netLpdBytes(netMatch.ip, data, netMatch.lpdPort)
                            }
                        } finally {
                            try { bmp.recycle() } catch (_: Exception) {}
                        }
                    }
                } else {
                    val isL8050 = isL8050Name(netMatch.model + " " + netMatch.name)
                    val opts = if (isL8050) Opts("high", "", "photo", true) else Opts("", "", "", true)
                    for (i in 0 until pagesArr.length()) {
                        val data = decode(pagesArr.getString(i))
                        val (jid, jpath) = sendIppJob(netMatch, "helper_" + System.currentTimeMillis(), data, widthMm, heightMm, opts)
                        if (i < pagesArr.length() - 1 && isSelphy(netMatch)) {
                            awaitSelphyIppIdle(netMatch, jpath, jid)
                        }
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
