package com.photobooth4u.booth

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Updates the tablet app from inside the app: downloads the new APK with a progress bar, then hands it to
 * Android's installer ("Do you want to update this app?" → Update → Open). Nobody sees GitHub or the browser.
 *
 * The first time, Android must allow photobooth4u to "Install unknown apps"; we explain that, open the right
 * settings page, and carry on by ourselves when the person comes back (onResume).
 * The APK is saved in cache/updates/ and shared with the installer through the FileProvider in the manifest.
 */
class AppUpdater(private val activity: AppCompatActivity) {

    private val dir = File(activity.cacheDir, "updates")
    @Volatile private var downloading = false
    @Volatile private var cancelled = false
    @Volatile private var conn: HttpURLConnection? = null
    private var waitingForPermission: Pair<String, String>? = null   // (url, version) while the settings page is open
    private var dialog: AlertDialog? = null
    private var bar: ProgressBar? = null
    private var label: TextView? = null

    /** True while an update is downloading or waiting for the person, so no second "New version" prompt shows. */
    val busy: Boolean get() = downloading || waitingForPermission != null || dialog?.isShowing == true

    fun start(url: String, version: String) {
        if (downloading) return
        if (!canInstall()) { askPermission(url, version); return }
        val apk = apkFile(version)
        if (apk.exists() && checkApk(apk) == null) { install(apk, url, version); return }   // already downloaded
        download(url, version)
    }

    /** MainActivity.onResume: back from the "Install unknown apps" page. */
    fun onResume() {
        val w = waitingForPermission ?: return
        waitingForPermission = null
        if (canInstall()) start(w.first, w.second)
        else toast("Not updated: photobooth4u still isn't allowed to install apps.")
    }

    fun cancel() {
        cancelled = true
        try { conn?.disconnect() } catch (e: Exception) { }
    }

    /** Deletes downloaded APKs that this app has already reached (keep = still newer than this app). */
    fun cleanUp(keep: (String) -> Boolean) {
        if (downloading) return
        dir.listFiles()?.forEach { f ->
            val v = f.name.removePrefix("photobooth4u-").removeSuffix(".apk")
            if (f.name.endsWith(".part") || !keep(v)) f.delete()
        }
    }

    private fun apkFile(version: String) = File(dir, "photobooth4u-$version.apk")

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()

    private fun askPermission(url: String, version: String) {
        if (!alive()) return
        dialog = AlertDialog.Builder(activity)
            .setTitle("Allow photobooth4u to update itself")
            .setMessage("This is needed once. On the next screen, turn on \"Allow from this source\", then press Back. The update starts by itself.")
            .setCancelable(false)
            .setPositiveButton("Open settings") { _, _ ->
                waitingForPermission = url to version
                try {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
                } catch (e: Exception) {
                    waitingForPermission = null
                    openInBrowser(url)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun download(url: String, version: String) {
        if (!alive()) return
        downloading = true; cancelled = false
        showProgressDialog(version)
        Thread {
            val part = File(dir, "photobooth4u-$version.apk.part")
            try {
                dir.mkdirs(); part.delete()
                val c = URL(url).openConnection() as HttpURLConnection   // follows GitHub's https redirect to its file server
                conn = c
                c.connectTimeout = 15_000; c.readTimeout = 30_000; c.instanceFollowRedirects = true
                val code = c.responseCode
                if (code !in 200..299) throw IOException("the server answered $code")
                val total = c.contentLengthLong
                var done = 0L; var lastUi = 0L
                c.inputStream.use { inp ->
                    FileOutputStream(part).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (cancelled) throw IOException("cancelled")
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n); done += n
                            val t = System.currentTimeMillis()
                            if (t - lastUi > 200) { lastUi = t; val d = done; activity.runOnUiThread { showProgress(d, total) } }
                        }
                    }
                }
                if (total > 0 && done != total) throw IOException("the download was cut short")
                val apk = apkFile(version)
                apk.delete()
                if (!part.renameTo(apk)) throw IOException("the file couldn't be saved")
                checkApk(apk)?.let { apk.delete(); throw IOException(it) }
                activity.runOnUiThread { showProgress(done, done); closeDialog(); install(apk, url, version) }
            } catch (e: Exception) {
                part.delete()
                val why = e.message ?: "no connection"
                activity.runOnUiThread {
                    closeDialog()
                    if (!cancelled) showFailed(url, version, why)
                }
            } finally {
                conn?.disconnect(); conn = null
                downloading = false
            }
        }.start()
    }

    /** null when the file is a newer build of this app; otherwise why it can't be installed. */
    @Suppress("DEPRECATION")
    private fun checkApk(apk: File): String? {
        val pm = activity.packageManager
        val info = pm.getPackageArchiveInfo(apk.path, 0) ?: return "the downloaded file is damaged"
        if (info.packageName != activity.packageName) return "the downloaded file is a different app"
        val mine = pm.getPackageInfo(activity.packageName, 0)
        if (PackageInfoCompat.getLongVersionCode(info) <= PackageInfoCompat.getLongVersionCode(mine))
            return "the download isn't newer than this app"
        return null
    }

    private fun install(apk: File, url: String, version: String) {
        if (!alive()) return
        try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", apk)
            val i = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(i)
        } catch (e: Exception) {
            showFailed(url, version, "Android's installer didn't open")
        }
    }

    private fun showProgressDialog(version: String) {
        val pad = dp(24)
        val box = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, dp(8), pad, 0) }
        label = TextView(activity).apply { text = "Starting download…"; textSize = 16f }
        bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; isIndeterminate = true }
        box.addView(label)
        box.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        box.addView(TextView(activity).apply {
            text = "Keep the app open. Android asks to install it when the download is done."
            textSize = 13f; alpha = 0.7f; setPadding(0, dp(12), 0, 0)
        })
        dialog = AlertDialog.Builder(activity)
            .setTitle("Downloading photobooth4u $version")
            .setView(box)
            .setCancelable(false)
            .setNegativeButton("Cancel") { _, _ -> cancel() }
            .show()
    }

    private fun showProgress(done: Long, total: Long) {
        val b = bar ?: return; val l = label ?: return
        if (total > 0) {
            b.isIndeterminate = false
            b.progress = (done * 1000 / total).toInt()
            l.text = "Downloading… ${done * 100 / total}%  (${mb(done)} of ${mb(total)} MB)"
        } else {
            b.isIndeterminate = true
            l.text = "Downloading… ${mb(done)} MB"
        }
    }

    private fun showFailed(url: String, version: String, why: String) {
        if (!alive()) return
        dialog = AlertDialog.Builder(activity)
            .setTitle("Update didn't download")
            .setMessage("photobooth4u $version couldn't be downloaded ($why). Check the Wi-Fi and try again.")
            .setPositiveButton("Try again") { _, _ -> start(url, version) }
            .setNeutralButton("Open in browser") { _, _ -> openInBrowser(url) }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun openInBrowser(url: String) {
        try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { }
    }

    private fun closeDialog() {
        try { dialog?.dismiss() } catch (e: Exception) { }
        dialog = null; bar = null; label = null
    }

    private fun alive() = !activity.isFinishing && !activity.isDestroyed
    private fun toast(s: String) { if (alive()) Toast.makeText(activity, s, Toast.LENGTH_LONG).show() }
    private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
    private fun mb(bytes: Long) = String.format("%.1f", bytes / 1_048_576.0)
}
