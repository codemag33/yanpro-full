package com.driver.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Foreground-сервис «Приём заказов».
 *
 * Держит процесс в живых, пока приложение свёрнуто (в т.ч. в PiP после
 * перехода в Яндекс Навигатор), чтобы socket.io-соединение не обрывалось
 * и заказы продолжали приходить. Уведомление постоянно висит в шторке —
 * по тапу открывает главный экран.
 *
 * Запускается только когда водитель онлайн; останавливается при выходе
 * в офлайн и при закрытии приложения.
 */
class DriverService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val online = intent?.getBooleanExtra(EXTRA_ONLINE, true) ?: true
        val notif = buildNotification(
            "Ян.Про — приём заказов",
            if (online) "Вы онлайн" else "Соединение устанавливается..."
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForeground(NOTIFICATION_ID, notif)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notif)
        }
        return START_STICKY
    }

    private fun buildNotification(title: String, text: String): Notification {
        val channelId = CHANNEL_ID
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(channelId, "Приём заказов", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, channelId)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_directions)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "orders"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_ONLINE = "online"

        fun start(context: Context, online: Boolean) {
            val intent = Intent(context, DriverService::class.java)
                .putExtra(EXTRA_ONLINE, online)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DriverService::class.java))
        }
    }
}
