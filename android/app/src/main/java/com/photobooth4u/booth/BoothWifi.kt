package com.photobooth4u.booth

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.Collections

/**
 * The booth's own Wi-Fi: this tablet makes the network guests' phones join (window.__PBWifi), so no router,
 * pocket Wi-Fi or phone hotspot is needed at the booth. It is the tablet-side twin of desktop/lib/hotspot.mjs.
 *
 * 1. A Wi-Fi Direct group with a name and password made once per tablet (Android 10 and up lets an app choose them).
 *    Phones join it like any Wi-Fi network (the name starts with DIRECT-). The tablet is at 192.168.49.1.
 * 2. Android's local-only hotspot (Android 8 and up) when the group can't start. Android picks its name and
 *    password; the Join QR carries whatever it picked.
 *
 * Either way the booth's Join Wi-Fi QR is filled in from [info], and [PBLocal.ownAddress] makes the guests' QR
 * point at the tablet's address on this network. The tablet's Wi-Fi has to be switched on (it need not join anything).
 * While it hosts, many tablets can't also stay on another Wi-Fi.
 */
class BoothWifi(private val activity: Activity, private val local: PBLocal) {

    companion object {
        private const val TAG = "PBWifi"
        const val REQ_PERMISSION = 2002
        private const val PREFS = "photobooth_prefs"
        private const val K_SSID = "booth_wifi_ssid"
        private const val K_PASS = "booth_wifi_pass"
        private const val K_AUTO = "booth_wifi_auto"
        private const val ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"
        private const val KEEP_MS = 15000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val p2p = activity.applicationContext.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var directIface = ""
    private var pendingStart = false
    private var fails = 0
    private var keeping = false

    // What the page reads (any thread); everything is changed on the main thread.
    @Volatile private var mode = ""          // "direct", "hotspot" or "" (off)
    @Volatile private var busy = false
    @Volatile private var wanted = false
    @Volatile private var error = ""
    @Volatile private var liveSsid = ""
    @Volatile private var livePass = ""
    @Volatile private var address = ""

    // Made once per tablet (not one name and password shared by every booth).
    private val wantSsid: String
    private val wantPass: String

    init {
        var s = prefs.getString(K_SSID, "") ?: ""
        var p = prefs.getString(K_PASS, "") ?: ""
        if (s.length < 12 || p.length < 8) {
            s = "DIRECT-pb-photobooth4u-" + random(4)
            p = random(10)
            prefs.edit().putString(K_SSID, s).putString(K_PASS, p).apply()
        }
        wantSsid = s
        wantPass = p
    }

    private fun random(n: Int): String {
        val r = SecureRandom()
        val sb = StringBuilder()
        for (i in 0 until n) sb.append(ALPHABET[r.nextInt(ALPHABET.length)])
        return sb.toString()
    }

    private fun supported(): Boolean = wifi != null && (p2p != null || Build.VERSION.SDK_INT >= 26)

    // ---------- what the booth page calls (window.__PBWifi) ----------

    /** { supported, on, wanted, busy, auto, ssid, pass, address, mode, error } as JSON text. */
    @JavascriptInterface
    fun info(): String {
        val o = JSONObject()
        o.put("supported", supported())
        o.put("on", mode.isNotEmpty() && address.isNotEmpty())
        o.put("wanted", wanted)
        o.put("busy", busy)
        o.put("auto", prefs.getBoolean(K_AUTO, false))
        o.put("ssid", if (liveSsid.isNotEmpty()) liveSsid else wantSsid)
        o.put("pass", if (livePass.isNotEmpty()) livePass else wantPass)
        o.put("address", address)
        o.put("mode", mode)
        o.put("error", error)
        return o.toString()
    }

    @JavascriptInterface
    fun set(on: Boolean) {
        main.post { if (on) startNow() else stopNow() }
    }

    @JavascriptInterface
    fun setAuto(on: Boolean) {
        prefs.edit().putBoolean(K_AUTO, on).apply()
    }

    // ---------- life cycle (MainActivity) ----------

    /** At app start: switch the booth Wi-Fi on when the operator chose "turn it on whenever the app opens". */
    fun autoStart() {
        if (prefs.getBoolean(K_AUTO, false) && supported()) main.post { startNow() }
    }

    fun shutdown() {
        main.removeCallbacksAndMessages(null)
        wanted = false
        releaseAll()
    }

    fun onPermissionResult(granted: Boolean) {
        if (!pendingStart) return
        pendingStart = false
        if (granted) startNow()
        else fail("Allow “Nearby devices” (or Location on older Android) so this tablet can make its own Wi-Fi.")
    }

    // ---------- start / stop (main thread) ----------

    private fun neededPermissions(): List<String> {
        val want = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
        return if (ContextCompat.checkSelfPermission(activity, want) == PackageManager.PERMISSION_GRANTED) emptyList() else listOf(want)
    }

    private fun startNow() {
        if (busy) return
        if (!supported()) { fail("This tablet can’t make its own Wi-Fi. Use a router or a phone hotspot."); return }
        wanted = true
        error = ""
        val need = neededPermissions()
        if (need.isNotEmpty()) {
            pendingStart = true
            ActivityCompat.requestPermissions(activity, need.toTypedArray(), REQ_PERMISSION)
            return
        }
        if (wifi?.isWifiEnabled != true) {
            fail("Turn this tablet’s Wi-Fi on (it doesn’t have to join a network), then try again.")
            return
        }
        busy = true
        // Clear anything left from before (an old group of ours), then start.
        releaseAll { startDirect() }
        scheduleKeep()
        // Never leave the switch stuck if Android doesn't answer.
        main.postDelayed({
            if (busy) fail("The tablet’s Wi-Fi didn’t start. Turn its Wi-Fi off and on, then try again.")
        }, 45000L)
    }

    private fun stopNow() {
        wanted = false
        error = ""
        pendingStart = false
        releaseAll()
    }

    private fun fail(msg: String) {
        busy = false
        wanted = false
        mode = ""
        address = ""
        local.ownAddress = null
        error = msg
        fails++
        Log.w(TAG, msg)
    }

    /** Wi-Fi Direct group (the preferred way). */
    @SuppressLint("MissingPermission")
    private fun startDirect() {
        val mgr = p2p
        if (mgr == null) { startHotspot(); return }
        val ch = channel ?: try { mgr.initialize(activity.applicationContext, Looper.getMainLooper(), null) } catch (e: Exception) { null }
        if (ch == null) { startHotspot(); return }
        channel = ch
        val done = object : WifiP2pManager.ActionListener {
            override fun onSuccess() { readGroup(0) }
            override fun onFailure(reason: Int) {
                Log.w(TAG, "Wi-Fi Direct group failed ($reason), trying the local hotspot")
                startHotspot()
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val cfg = WifiP2pConfig.Builder()
                    .setNetworkName(wantSsid)
                    .setPassphrase(wantPass)
                    .enablePersistentMode(false)
                    .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
                    .build()
                mgr.createGroup(ch, cfg, done)
            } else {
                mgr.createGroup(ch, done)
            }
        } catch (e: Exception) {
            Log.w(TAG, "createGroup threw", e)
            startHotspot()
        }
    }

    /** Waits for the group to be ready, then reads its real name, password and the tablet's address. */
    @SuppressLint("MissingPermission")
    private fun readGroup(attempt: Int) {
        val mgr = p2p
        val ch = channel
        if (mgr == null || ch == null) { startHotspot(); return }
        try {
            mgr.requestGroupInfo(ch) { group ->
                val iface = if (group != null) (group.`interface` ?: "") else ""
                val ip = if (group != null && group.isGroupOwner) addressOn(iface) else null
                if (group != null && group.isGroupOwner && ip != null) {
                    directIface = iface
                    liveSsid = group.networkName ?: wantSsid
                    livePass = group.passphrase ?: wantPass
                    up("direct", ip)
                } else if (attempt < 8) {
                    main.postDelayed({ readGroup(attempt + 1) }, 700)
                } else {
                    startHotspot()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "requestGroupInfo threw", e)
            startHotspot()
        }
    }

    /** Android's local-only hotspot (when the Wi-Fi Direct group can't start). */
    @SuppressLint("MissingPermission")
    private fun startHotspot() {
        val w = wifi
        if (w == null || Build.VERSION.SDK_INT < 26) {
            fail("This tablet can’t make its own Wi-Fi. Use a router or a phone hotspot.")
            return
        }
        val before = addressesNow()
        try {
            w.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
                    reservation = r
                    readHotspotCredentials(r)
                    waitForAddress(before, 0)
                }

                override fun onStopped() {
                    if (mode == "hotspot") main.post { lost() }
                }

                override fun onFailed(reason: Int) {
                    val msg = when (reason) {
                        WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "This tablet has no free Wi-Fi channel right now. Turn its Wi-Fi off and on, then try again."
                        WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "This tablet doesn’t allow hotspots. Use a router or a phone hotspot."
                        WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> "Turn off this tablet’s own hotspot or Wi-Fi Direct, then try again."
                        else -> "This tablet can’t make its own Wi-Fi. Use a router or a phone hotspot."
                    }
                    main.post { fail(msg) }
                }
            }, main)
        } catch (e: Exception) {
            Log.w(TAG, "startLocalOnlyHotspot threw", e)
            fail("This tablet can’t make its own Wi-Fi. Use a router or a phone hotspot.")
        }
    }

    @Suppress("DEPRECATION")
    private fun readHotspotCredentials(r: WifiManager.LocalOnlyHotspotReservation) {
        var s = ""
        var p = ""
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                val c = r.softApConfiguration
                s = c.ssid ?: ""
                p = c.passphrase ?: ""
            } else {
                val c = r.wifiConfiguration
                s = c?.SSID ?: ""
                p = c?.preSharedKey ?: ""
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the hotspot name", e)
        }
        liveSsid = unquote(s)
        livePass = unquote(p)
    }

    private fun unquote(t: String): String =
        if (t.length >= 2 && t.startsWith("\"") && t.endsWith("\"")) t.substring(1, t.length - 1) else t

    private fun waitForAddress(before: Set<String>, attempt: Int) {
        val ip = addressesNow().firstOrNull { it !in before && it.startsWith("192.168.") }
            ?: addressesNow().firstOrNull { it.endsWith(".1") && it.startsWith("192.168.") && it !in before }
        if (ip != null) { up("hotspot", ip); return }
        if (attempt < 10) main.postDelayed({ waitForAddress(before, attempt + 1) }, 600)
        else fail("The tablet’s Wi-Fi started but has no address. Try again.")
    }

    private fun up(m: String, ip: String) {
        mode = m
        address = ip
        busy = false
        fails = 0
        error = ""
        local.ownAddress = ip
        Log.i(TAG, "Booth Wi-Fi on ($m): $liveSsid at $ip")
    }

    /** The network went away by itself (Android stopped it): put it back while it is wanted. */
    private fun lost() {
        mode = ""
        address = ""
        local.ownAddress = null
    }

    /** Closes whatever we started, then calls [then]. */
    @SuppressLint("MissingPermission")
    private fun releaseAll(then: (() -> Unit)? = null) {
        try { reservation?.close() } catch (e: Exception) { /* already closed */ }
        reservation = null
        mode = ""
        address = ""
        liveSsid = ""
        livePass = ""
        local.ownAddress = null
        val mgr = p2p
        val ch = channel
        if (mgr == null || ch == null) {
            if (then == null) busy = false
            then?.invoke()
            return
        }
        try {
            mgr.removeGroup(ch, object : WifiP2pManager.ActionListener {
                override fun onSuccess() { main.postDelayed({ then?.invoke() }, 400) }
                override fun onFailure(reason: Int) { then?.invoke() }   // no group to remove: fine
            })
        } catch (e: Exception) {
            then?.invoke()
        }
        if (then == null) busy = false
    }

    // ---------- keeping it on ----------

    /** Android can drop an idle group or hotspot: start it again while the operator wants it. */
    private fun scheduleKeep() {
        if (keeping) return
        keeping = true
        main.postDelayed(object : Runnable {
            override fun run() {
                if (!wanted) { keeping = false; return }
                if (!busy && fails < 3) {
                    val gone = address.isEmpty() || (mode == "direct" && directIface.isNotEmpty() && addressOn(directIface) == null)
                    if (gone) {
                        Log.i(TAG, "Booth Wi-Fi went off by itself, starting it again")
                        lost()
                        startNow()
                    }
                }
                main.postDelayed(this, KEEP_MS)
            }
        }, KEEP_MS)
    }

    // ---------- addresses ----------

    private fun addressOn(iface: String): String? {
        try {
            if (iface.isNotEmpty()) {
                val ni = NetworkInterface.getByName(iface)
                if (ni != null) {
                    for (ia in Collections.list(ni.inetAddresses)) {
                        if (ia is Inet4Address && !ia.isLoopbackAddress) return ia.hostAddress
                    }
                }
                return null
            }
            // The usual Wi-Fi Direct owner address, when the interface name wasn't given.
            return addressesNow().firstOrNull { it == "192.168.49.1" }
        } catch (e: Exception) {
            return null
        }
    }

    private fun addressesNow(): Set<String> {
        val out = LinkedHashSet<String>()
        try {
            val nets = NetworkInterface.getNetworkInterfaces() ?: return out
            for (ni in Collections.list(nets)) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in Collections.list(ni.inetAddresses)) {
                    if (ia is Inet4Address && !ia.isLoopbackAddress && !ia.isLinkLocalAddress) ia.hostAddress?.let { out.add(it) }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the network addresses", e)
        }
        return out
    }
}
