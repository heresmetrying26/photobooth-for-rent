package com.photobooth4u.booth

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Automatically launches photobooth4u when the tablet turns on or restarts.
 *
 * Handles:
 * 1. Intent.ACTION_BOOT_COMPLETED (Standard Android boot completion)
 * 2. QUICKBOOT_POWERON (Snapdragon / fast-boot systems)
 * 3. Fallback High-Priority Notification with FullScreenIntent for Android 10+ background restrictions
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
        private const val BOOT_CHANNEL_ID = "photobooth_boot_channel"
        private const val BOOT_NOTIFICATION_ID = 1001
    }

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        Log.i(TAG, "BootReceiver received action: $action")

        val validActions = listOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            Intent.ACTION_REBOOT
        )

        if (action !in validActions) return

        val prefs = context.getSharedPreferences("photobooth_prefs", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("pref_auto_boot", true)) {
            Log.i(TAG, "Auto-boot is disabled by user in settings. Skipping launch.")
            return
        }

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

        // 1. Direct launch (works directly on Android 9 and below, or when app has overlay/kiosk permission)
        try {
            context.startActivity(launchIntent)
            Log.i(TAG, "Attempted direct startActivity from boot broadcast")
        } catch (e: Exception) {
            Log.w(TAG, "Direct startActivity on boot restricted by OS: ${e.message}")
        }

        // 2. Fallback for Android 10+ (API 29+) background activity start restriction:
        // Trigger via high-priority full-screen intent notification so the OS surfaces the app immediately
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (nm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val channel = NotificationChannel(
                        BOOT_CHANNEL_ID,
                        "Photo Booth Auto-Launch",
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = "Launches photo booth automatically when device starts"
                        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    }
                    nm.createNotificationChannel(channel)
                }

                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }

                val pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags)

                val notification = NotificationCompat.Builder(context, BOOT_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("photobooth4u")
                    .setContentText("Starting Photo Booth...")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setFullScreenIntent(pendingIntent, true)
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .build()

                nm.notify(BOOT_NOTIFICATION_ID, notification)
                Log.i(TAG, "Dispatched full-screen boot launch notification")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch photobooth4u from boot receiver", e)
        }
    }
}

