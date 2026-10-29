package com.photobooth4u.booth

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.util.Log
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread
import kotlin.math.abs

/**
 * This tablet's licence: activation with a rental code, the signed licence, periodic
 * check-ins, and the checks that gate the booth opening.
 *
 * A Kotlin port of desktop/lib/licence.mjs, talking to the SAME /api/license endpoint
 * and checking the SAME Ed25519-signed licence text — so one rental code's "offline
 * app" add-on, and its device-slot limit, is shared between the desktop app and this
 * tablet the same way. Without this, the bundled booth would unlock itself for anyone
 * who installs the APK, with no code and no renewal ever required.
 *
 *   PB4U-LIC1.<payload base64url>.<signature base64url>
 *
 * The payload (v, typ, mid, exp, iat, chk, hard, feat, …) is signed on
 * photobooth4u.netlify.app with a private key that never leaves the server; this app
 * only has the matching PUBLIC key (below), so it can check a licence but never make
 * or extend one by itself.
 */
class AppLicence(private val ctx: Context) {

    data class LicStatus(
        val ok: Boolean,
        val reason: String,      // "" | none | invalid | revoked | clock | expired | checkin
        val message: String,
        val payload: JSONObject?,
        val warn: String
    )

    companion object {
        private const val TAG = "PBLicence"
        const val APP_VERSION = "1.0.9"
        const val SERVER = "https://photobooth4u.netlify.app"
        private const val PREFIX = "PB4U-LIC1"
        private const val CHECK_EVERY_MS = 10 * 60_000L
        private const val CLOCK_SLACK_MS = 6 * 3_600_000L
        private const val PREFS = "photobooth_licence"
        private const val KEY_STATE = "state"
        private const val KEY_RANDOM_ID = "random_id"

        // The same Ed25519 public key the desktop app has built in (desktop/license-pubkey.txt),
        // as its raw 32 bytes — the last 32 bytes of the SPKI DER the server also hands out at
        // /api/license?pub=1. It's a PUBLIC key: embedding it here reveals nothing.
        private val PUBKEY = byteArrayOf(
            0x4B.toByte(), 0xB8.toByte(), 0xF2.toByte(), 0x8E.toByte(), 0xBB.toByte(), 0x41.toByte(), 0x7F.toByte(), 0xD3.toByte(),
            0x6E.toByte(), 0x7A.toByte(), 0x0C.toByte(), 0x1D.toByte(), 0x84.toByte(), 0x46.toByte(), 0xBB.toByte(), 0x66.toByte(),
            0xA1.toByte(), 0x3B.toByte(), 0xFA.toByte(), 0xAE.toByte(), 0xA8.toByte(), 0xFC.toByte(), 0x7B.toByte(), 0xF9.toByte(),
            0x35.toByte(), 0x8E.toByte(), 0xD9.toByte(), 0x23.toByte(), 0x87.toByte(), 0xB6.toByte(), 0xA4.toByte(), 0x01.toByte()
        )
    }

    private val prefs by lazy { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    @Volatile private var lic: String? = null
    @Volatile private var seen: Long = 0L            // the latest time this tablet has ever seen
    @Volatile private var revokedReason: String? = null
    @Volatile private var revokedError: String? = null
    @Volatile private var lastCheck: Long = 0L
    @Volatile private var lastTry: Long = 0L
    @Volatile private var skew: Long = 0L            // non-zero when the tablet's clock looks wrong
    private var cachedMid: String? = null

    init { loadState() }

    // ---------- this tablet ----------

    @SuppressLint("HardwareIds")
    fun machineId(): String {
        cachedMid?.let { return it }
        val androidId = try { Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) } catch (e: Exception) { null }
        val raw = if (!androidId.isNullOrBlank()) androidId else {
            prefs.getString(KEY_RANDOM_ID, null) ?: UUID.randomUUID().toString().replace("-", "").also {
                prefs.edit().putString(KEY_RANDOM_ID, it).apply()
            }
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(("pb4u-mid|" + raw.uppercase(Locale.ROOT)).toByteArray(Charsets.UTF_8))
        val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val sb = StringBuilder()
        for (i in 0 until 16) sb.append(alphabet[(digest[i].toInt() and 0xFF) % 32])
        val grouped = sb.toString().chunked(4).joinToString("-")
        val mid = "AND-$grouped"
        cachedMid = mid
        return mid
    }

    private fun deviceName(): String {
        val model = Build.MODEL ?: ""
        val man = Build.MANUFACTURER ?: ""
        val n = if (model.startsWith(man, ignoreCase = true) || man.isBlank()) model else "$man $model"
        return n.trim().ifBlank { "Android tablet" }.take(60)
    }

    // ---------- licence text ----------

    private fun b64urlDecode(s: String): ByteArray {
        var t = s.trim().replace('-', '+').replace('_', '/')
        val pad = (4 - t.length % 4) % 4
        if (pad in 1..3) t += "=".repeat(pad)
        return Base64.decode(t, Base64.DEFAULT)
    }

    private fun verifySig(body: ByteArray, sig: ByteArray): Boolean = try {
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(PUBKEY, 0))
        signer.update(body, 0, body.size)
        signer.verifySignature(sig)
    } catch (e: Exception) { false }

    /** Returns the payload when the licence text is genuinely signed by our server, else null. */
    fun readLicence(licText: String?): JSONObject? {
        if (licText == null) return null
        val cleaned = licText.replace(Regex("\\s+"), "")
        val parts = cleaned.split(".")
        if (parts.size != 3 || parts[0] != PREFIX) return null
        return try {
            val body = (parts[0] + "." + parts[1]).toByteArray(Charsets.US_ASCII)
            val sig = b64urlDecode(parts[2])
            if (!verifySig(body, sig)) return null
            val p = JSONObject(String(b64urlDecode(parts[1]), Charsets.UTF_8))
            if (p.optString("typ") == "pb4u-desktop") p else null
        } catch (e: Exception) { null }
    }

    // ---------- saved state (HMAC-sealed so it isn't easy to hand-edit) ----------

    private fun secret(): ByteArray = MessageDigest.getInstance("SHA-256").digest(("pb4u-state|" + machineId()).toByteArray(Charsets.UTF_8))
    private fun hmacHex(data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret(), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun loadState() {
        val raw = prefs.getString(KEY_STATE, null) ?: return
        try {
            val outer = JSONObject(raw)
            val body = outer.getString("body")
            if (hmacHex(body) != outer.getString("mac")) return
            val s = JSONObject(body)
            lic = if (s.has("lic") && !s.isNull("lic")) s.getString("lic") else null
            seen = s.optLong("seen", 0L)
            revokedReason = if (s.has("revokedReason") && !s.isNull("revokedReason")) s.getString("revokedReason") else null
            revokedError = if (s.has("revokedError") && !s.isNull("revokedError")) s.getString("revokedError") else null
            lastCheck = s.optLong("lastCheck", 0L)
            lastTry = s.optLong("lastTry", 0L)
            skew = s.optLong("skew", 0L)
        } catch (e: Exception) { Log.w(TAG, "licence state unreadable, starting fresh", e) }
    }

    private fun saveState() {
        try {
            val s = JSONObject()
            s.put("lic", lic)
            s.put("seen", seen)
            s.put("revokedReason", revokedReason)
            s.put("revokedError", revokedError)
            s.put("lastCheck", lastCheck)
            s.put("lastTry", lastTry)
            s.put("skew", skew)
            val body = s.toString()
            val outer = JSONObject().put("body", body).put("mac", hmacHex(body))
            prefs.edit().putString(KEY_STATE, outer.toString()).apply()
        } catch (e: Exception) { Log.w(TAG, "could not save licence state", e) }
    }

    private fun touchClock() { val now = System.currentTimeMillis(); if (now > seen) seen = now }

    private fun applyClockFrom(serverDateMs: Long) {
        if (serverDateMs <= 0L) return
        val off = System.currentTimeMillis() - serverDateMs
        skew = if (abs(off) > 36 * 3_600_000L) off else 0L
        seen = maxOf(seen, minOf(System.currentTimeMillis(), serverDateMs + 3_600_000L))
    }

    private fun store(licText: String) {
        lic = licText.replace(Regex("\\s+"), "")
        revokedReason = null; revokedError = null; lastCheck = System.currentTimeMillis(); skew = 0L
        touchClock(); saveState()
    }

    // ---------- status: the checks that gate the booth opening ----------

    fun status(): LicStatus {
        val now = System.currentTimeMillis()
        val l = lic ?: return LicStatus(false, "none", "", null, "")
        val p = readLicence(l)
            ?: return LicStatus(false, "invalid", "This tablet's licence isn’t valid. Activate it again with your code.", null, "")
        if (p.optString("mid") != machineId()) {
            return LicStatus(false, "invalid", "This licence isn’t for this tablet. Activate it again with your code.", null, "")
        }
        revokedReason?.let {
            return LicStatus(false, "revoked", revokedError?.takeIf { e -> e.isNotBlank() } ?: "This tablet’s code was cancelled. Activate it again with your code.", p, "")
        }
        if (skew != 0L) {
            return LicStatus(false, "clock", "This tablet’s date and time are wrong. Turn on automatic date & time in Settings, then try again.", p, "")
        }
        val iat = p.optLong("iat", 0L)
        if (now < seen - CLOCK_SLACK_MS || now < iat - CLOCK_SLACK_MS) {
            return LicStatus(false, "clock", "This tablet’s clock was set back. Turn on automatic date & time in Settings, then try again.", p, "")
        }
        val hasExp = p.has("exp") && !p.isNull("exp")
        val exp = if (hasExp) p.optLong("exp") else 0L
        if (hasExp && now >= exp) {
            return LicStatus(false, "expired", "This code has ended. Message us to book again.", p, "")
        }
        val hard = p.optLong("hard", 0L)
        if (hard > 0 && now >= hard) {
            return LicStatus(false, "checkin", "Connect this tablet to Wi-Fi once so it can renew its licence — it needs to every few weeks.", p, "")
        }
        var warn = ""
        val chk = p.optLong("chk", 0L)
        if (!hasExp && chk > 0 && now >= chk) warn = "Connect to Wi-Fi soon: this tablet needs to renew its licence."
        return LicStatus(true, "", "", p, warn)
    }

    // ---------- talking to photobooth4u.netlify.app ----------

    private data class NetResult(val status: Int, val json: JSONObject, val date: Long)

    private fun parseHttpDate(s: String?): Long {
        if (s.isNullOrBlank()) return 0L
        return try {
            val fmt = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("GMT")
            fmt.parse(s)?.time ?: 0L
        } catch (e: Exception) { 0L }
    }

    private fun post(body: JSONObject, timeoutMs: Int): NetResult? {
        var conn: HttpURLConnection? = null
        return try {
            val c = URL("$SERVER/api/license").openConnection() as HttpURLConnection
            conn = c
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val dateHeader = c.getHeaderField("Date")
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "{}"
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            NetResult(code, json, parseHttpDate(dateHeader))
        } catch (e: Exception) {
            Log.w(TAG, "licence request failed", e)
            null
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { /* ignore */ }
        }
    }

    /** Activates this tablet with a rental code. Needs Wi-Fi; calls back on the main thread. */
    fun activate(code: String, cb: (ok: Boolean, error: String?) -> Unit) {
        val c = code.trim()
        if (c.isEmpty()) { cb(false, "Type your code first."); return }
        thread(name = "pb-licence-activate") {
            val body = JSONObject()
                .put("action", "activate").put("code", c).put("mid", machineId())
                .put("name", deviceName()).put("os", "android").put("ver", APP_VERSION)
            val res = post(body, 20000)
            if (res == null) { mainHandler.post { cb(false, "Can’t reach photobooth4u. Check the Wi-Fi and try again.") }; return@thread }
            val licText = res.json.optString("licence", "")
            if (res.status != 200 || !res.json.optBoolean("ok", false) || readLicence(licText) == null) {
                mainHandler.post { cb(false, res.json.optString("error", "Activation failed (" + res.status + ").")) }
                return@thread
            }
            applyClockFrom(res.date)
            store(licText)
            mainHandler.post { cb(true, null) }
        }
    }

    /** Renews the stored licence while online. Returns "ok" | "revoked" | "offline" | "skip" on the main thread. */
    fun checkin(force: Boolean = false, cb: ((String) -> Unit)? = null) {
        val l = lic
        if (l == null) { cb?.invoke("skip"); return }
        val now = System.currentTimeMillis()
        if (!force && now - lastTry < CHECK_EVERY_MS && skew == 0L) { cb?.invoke("skip"); return }
        lastTry = now; saveState()
        thread(name = "pb-licence-checkin") {
            val body = JSONObject().put("action", "checkin").put("licence", l).put("mid", machineId()).put("ver", APP_VERSION)
            val res = post(body, 15000)
            if (res == null) { mainHandler.post { cb?.invoke("offline") }; return@thread }
            applyClockFrom(res.date)
            if (res.status == 200 && res.json.optBoolean("ok", false)) {
                val newLic = res.json.optString("licence", "")
                if (readLicence(newLic) != null) { store(newLic); mainHandler.post { cb?.invoke("ok") }; return@thread }
            }
            if (res.json.optBoolean("revoked", false)) {
                revokedReason = res.json.optString("reason", "removed")
                revokedError = res.json.optString("error", "")
                lastCheck = now; saveState()
                mainHandler.post { cb?.invoke("revoked") }
                return@thread
            }
            saveState()
            mainHandler.post { cb?.invoke("offline") }
        }
    }
}
