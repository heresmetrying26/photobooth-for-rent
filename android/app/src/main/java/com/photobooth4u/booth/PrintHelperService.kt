package com.photobooth4u.booth

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground Service that keeps the 127.0.0.1:17321 Print & Camera Helper running in the
 * background so mobile Chrome can print silently over direct USB OTG and Wi-Fi even when the
 * user switches to the browser.
 */
class PrintHelperService : Service() {

    companion object {
        private const val TAG = "PrintHelperService"
        const val CHANNEL_ID = "photobooth_helper_channel"
        const val NOTIFICATION_ID = 17321
        const val ACTION_START = "com.photobooth4u.booth.START_HELPER"
        const val ACTION_STOP = "com.photobooth4u.booth.STOP_HELPER"

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(ctx: Context) {
            try {
                val i = Intent(ctx, PrintHelperService::class.java).apply { action = ACTION_START }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(i)
                } else {
                    ctx.startService(i)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not start PrintHelperService", e)
            }
        }

        fun stop(ctx: Context) {
            try {
                val i = Intent(ctx, PrintHelperService::class.java).apply { action = ACTION_STOP }
                ctx.startService(i)
            } catch (e: Exception) {
                Log.w(TAG, "Could not stop PrintHelperService", e)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            isRunning = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isRunning = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to startForeground", e)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Photobooth Print Helper",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the 127.0.0.1:17321 helper running for Chrome and Web Booth."
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val appPending = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val openChromeIntent = Intent(Intent.ACTION_VIEW, Uri.parse("https://photobooth4u.netlify.app/booth")).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val chromePending = PendingIntent.getActivity(
            this, 1, openChromeIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val stopIntent = Intent(this, PrintHelperService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Photobooth Helper Active")
            .setContentText("Direct USB & Wi-Fi printing active on 127.0.0.1:17321")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(appPending)
            .setOngoing(true)
            .addAction(0, "Open in Chrome", chromePending)
            .addAction(0, "Stop", stopPending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
