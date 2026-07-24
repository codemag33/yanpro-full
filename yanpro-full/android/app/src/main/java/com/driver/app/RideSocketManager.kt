package com.driver.app

import android.util.Log
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.URISyntaxException

/**
 * Обёртка над Socket.IO-клиентом для связи с сервером Yan.Pro (протокол v2).
 *
 * Отличия от старого протокола:
 *  - Аутентификация — JWT-токен передаётся при подключении (`IO.Options.auth`),
 *    сервер сам знает, кто вы (id/роль/имя) — никакого `driver:register` с
 *    самопровозглашённым именем/ролью больше нет.
 *  - Комнаты: сервер сам подключает вас в `ride_{id}` / `assist_{id}` после
 *    принятия заказа — события чата и локации приходят только оттуда, где
 *    вы реально участвуете.
 *  - Восстановление сессии: при реконнекте сервер сам присылает
 *    `session:restore_ride` / `session:restore_assist`, если у вас была
 *    активная поездка/заявка — не нужно ничего запрашивать вручную.
 *
 * Все колбэки вызываются НЕ на главном потоке — вызывающая сторона обязана
 * переключаться на UI через runOnUiThread или coroutines.
 */
class RideSocketManager(
    private val serverUrl: String,
    private val token: String
) {
    companion object {
        private const val TAG = "RideSocketManager"
    }

    private var socket: Socket? = null

    /** В новой модели у водителя одновременно одна активная поездка ИЛИ одна заявка на помощь —
     *  сервер физически ограничивает это через комнаты. Это единственный источник истины на клиенте. */
    var currentRideId: String? = null
        private set
    var currentAssistId: String? = null
        private set

    // ─── Callbacks: подключение ─────────────────────────────────────────────
    var onConnected: (() -> Unit)? = null
    var onConnectError: ((String) -> Unit)? = null
    var onAuthInvalid: (() -> Unit)? = null

    // ─── Callbacks: восстановление сессии ───────────────────────────────────
    var onRestoreRide: ((JSONObject) -> Unit)? = null
    var onRestoreAssist: ((JSONObject) -> Unit)? = null

    // ─── Callbacks: поездки ──────────────────────────────────────────────────
    var onNewRideRequest: ((rideId: String, passengerName: String, pickupLat: Double, pickupLon: Double, destLat: Double, destLon: Double, pickupAddress: String, destAddress: String) -> Unit)? = null
    var onRideAlreadyTaken: ((rideId: String) -> Unit)? = null
    var onRideClosedForOthers: ((rideId: String) -> Unit)? = null
    var onRideAccepted: ((rideId: String, driverId: String, driverName: String) -> Unit)? = null
    var onRideStarted: ((rideId: String) -> Unit)? = null
    var onRideFinished: ((rideId: String) -> Unit)? = null
    var onRideCancelled: ((rideId: String, by: String) -> Unit)? = null
    var onPassengerLocation: ((lat: Double, lon: Double) -> Unit)? = null

    // ─── Callbacks: помощь на дороге ─────────────────────────────────────────
    var onNewAssistRequest: ((assistId: String, passengerName: String, pickupLat: Double, pickupLon: Double, carMake: String, breakdownType: String, phone: String, description: String) -> Unit)? = null
    var onAssistAlreadyTaken: ((assistId: String) -> Unit)? = null
    var onAssistClosedForOthers: ((assistId: String) -> Unit)? = null
    var onAssistAccepted: ((assistId: String, mechanicId: String, mechanicName: String) -> Unit)? = null
    var onAssistFinished: ((assistId: String) -> Unit)? = null
    var onAssistCancelled: ((assistId: String, by: String) -> Unit)? = null
    var onAssistPassengerLocation: ((lat: Double, lon: Double) -> Unit)? = null

    // ─── Callbacks: чат (общий для ride/assist — различается по contextType) ─
    var onChatMessage: ((contextType: String, contextId: String, senderId: String, senderRole: String, text: String, createdAt: String) -> Unit)? = null
    var onChatHistory: ((contextType: String, contextId: String, messages: List<JSONObject>) -> Unit)? = null

    var onServerError: ((context: String) -> Unit)? = null

    fun connect() {
        if (socket?.connected() == true) return
        socket?.disconnect()
        socket?.off()
        try {
            val opts = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 2000
                auth = mapOf("token" to token) // JWT — проверяется на сервере в io.use() middleware
            }
            val s = IO.socket(serverUrl, opts)
            socket = s

            s.on(Socket.EVENT_CONNECT) {
                Log.d(TAG, "connected")
                onConnected?.invoke()
            }

            s.on(Socket.EVENT_CONNECT_ERROR) { args ->
                val msg = args.firstOrNull()?.toString() ?: "unknown error"
                Log.e(TAG, "connect_error: $msg")
                if (msg.contains("invalid_token") || msg.contains("no_token")) {
                    onAuthInvalid?.invoke()
                } else {
                    onConnectError?.invoke(msg)
                }
            }

            // ─── Восстановление сессии ────────────────────────────────────
            s.on("session:restore_ride") { args ->
                (args.firstOrNull() as? JSONObject)?.let {
                    currentRideId = it.optString("id").ifEmpty { null }
                    onRestoreRide?.invoke(it)
                }
            }
            s.on("session:restore_assist") { args ->
                (args.firstOrNull() as? JSONObject)?.let {
                    currentAssistId = it.optString("id").ifEmpty { null }
                    onRestoreAssist?.invoke(it)
                }
            }

            // ─── Поездки ───────────────────────────────────────────────────
            s.on("ride:new_request") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                val pickup = data.optJSONObject("pickup") ?: return@on
                val dest = data.optJSONObject("destination") ?: return@on
                onNewRideRequest?.invoke(
                    data.optString("rideId"),
                    data.optString("passengerName", "Пассажир"),
                    pickup.optDouble("lat"), pickup.optDouble("lon"),
                    dest.optDouble("lat"), dest.optDouble("lon"),
                    data.optString("pickupAddress", ""),
                    data.optString("destinationAddress", "")
                )
            }
            s.on("ride:already_taken") { args -> (args.firstOrNull() as? JSONObject)?.let { onRideAlreadyTaken?.invoke(it.optString("rideId")) } }
            s.on("ride:closed_for_others") { args -> (args.firstOrNull() as? JSONObject)?.let { onRideClosedForOthers?.invoke(it.optString("rideId")) } }
            s.on("ride:accepted") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                onRideAccepted?.invoke(data.optString("rideId"), data.optString("driverId"), data.optString("driverName"))
            }
            s.on("ride:started") { args -> (args.firstOrNull() as? JSONObject)?.let { onRideStarted?.invoke(it.optString("rideId")) } }
            s.on("ride:finished") { args -> (args.firstOrNull() as? JSONObject)?.let { val id = it.optString("rideId"); if (currentRideId == id) currentRideId = null; onRideFinished?.invoke(id) } }
            s.on("ride:cancelled") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                val id = data.optString("rideId")
                if (currentRideId == id) currentRideId = null
                onRideCancelled?.invoke(id, data.optString("by"))
            }
            s.on("ride:passenger_location") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                onPassengerLocation?.invoke(data.optDouble("lat"), data.optDouble("lon"))
            }

            // ─── Помощь на дороге ────────────────────────────────────────
            s.on("assistance:new_request") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                val pickup = data.optJSONObject("pickup") ?: return@on
                onNewAssistRequest?.invoke(
                    data.optString("assistId"),
                    data.optString("passengerName", "Пассажир"),
                    pickup.optDouble("lat"), pickup.optDouble("lon"),
                    data.optString("carMake", ""),
                    data.optString("breakdownType", ""),
                    data.optString("phone", ""),
                    data.optString("description", "")
                )
            }
            s.on("assistance:already_taken") { args -> (args.firstOrNull() as? JSONObject)?.let { onAssistAlreadyTaken?.invoke(it.optString("assistId")) } }
            s.on("assistance:closed_for_others") { args -> (args.firstOrNull() as? JSONObject)?.let { onAssistClosedForOthers?.invoke(it.optString("assistId")) } }
            s.on("assistance:accepted") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                onAssistAccepted?.invoke(data.optString("assistId"), data.optString("mechanicId"), data.optString("mechanicName"))
            }
            s.on("assistance:finished") { args -> (args.firstOrNull() as? JSONObject)?.let { val id = it.optString("assistId"); if (currentAssistId == id) currentAssistId = null; onAssistFinished?.invoke(id) } }
            s.on("assistance:cancelled") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                val id = data.optString("assistId")
                if (currentAssistId == id) currentAssistId = null
                onAssistCancelled?.invoke(id, data.optString("by"))
            }
            s.on("assistance:passenger_location") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                onAssistPassengerLocation?.invoke(data.optDouble("lat"), data.optDouble("lon"))
            }

            // ─── Чат ───────────────────────────────────────────────────────
            s.on("chat:message") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                onChatMessage?.invoke(
                    data.optString("contextType"), data.optString("contextId"),
                    data.optString("senderId"), data.optString("senderRole"),
                    data.optString("text"), data.optString("createdAt")
                )
            }
            s.on("chat:history") { args ->
                val data = args.firstOrNull() as? JSONObject ?: return@on
                val arr = data.optJSONArray("messages") ?: return@on
                val list = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                onChatHistory?.invoke(data.optString("contextType"), data.optString("contextId"), list)
            }

            s.on("error:server") { args ->
                val data = args.firstOrNull() as? JSONObject
                onServerError?.invoke(data?.optString("context") ?: "unknown")
            }

            s.connect()
        } catch (e: URISyntaxException) {
            Log.e(TAG, "Invalid server URL: $serverUrl", e)
            onConnectError?.invoke("Invalid server URL: $serverUrl")
        }
    }

    // ─── Исходящие события ────────────────────────────────────────────────

    fun setOnline(online: Boolean) {
        socket?.emit("driver:status", JSONObject().put("status", if (online) "online" else "offline"))
    }

    /** rideId/assistId — если сейчас ведётся конкретная поездка/заявка, координаты уйдут и в её комнату. */
    fun sendLocation(lat: Double, lon: Double, rideId: String? = null, assistId: String? = null) {
        val payload = JSONObject().put("lat", lat).put("lon", lon)
        rideId?.let { payload.put("rideId", it) }
        assistId?.let { payload.put("assistId", it) }
        socket?.emit("location:update", payload)
    }

    fun acceptRide(rideId: String) {
        currentRideId = rideId
        socket?.emit("ride:accept", JSONObject().put("rideId", rideId))
    }

    fun startRide(rideId: String) {
        socket?.emit("ride:start", JSONObject().put("rideId", rideId))
    }

    fun finishRide(rideId: String, price: Double? = null) {
        val payload = JSONObject().put("rideId", rideId)
        price?.let { payload.put("price", it) }
        socket?.emit("ride:finish", payload)
        if (currentRideId == rideId) currentRideId = null
    }

    fun cancelRide(rideId: String, reason: String? = null) {
        val payload = JSONObject().put("rideId", rideId)
        reason?.let { payload.put("reason", it) }
        socket?.emit("ride:cancel", payload)
        if (currentRideId == rideId) currentRideId = null
    }

    fun acceptAssistance(assistId: String) {
        currentAssistId = assistId
        socket?.emit("assistance:accept", JSONObject().put("assistId", assistId))
    }

    fun finishAssistance(assistId: String) {
        socket?.emit("assistance:finish", JSONObject().put("assistId", assistId))
        if (currentAssistId == assistId) currentAssistId = null
    }

    fun cancelAssistance(assistId: String) {
        socket?.emit("assistance:cancel", JSONObject().put("assistId", assistId))
        if (currentAssistId == assistId) currentAssistId = null
    }

    /** contextType: "ride" | "assist" */
    fun sendChat(contextType: String, contextId: String, text: String) {
        socket?.emit("chat:send", JSONObject().put("contextType", contextType).put("contextId", contextId).put("text", text))
    }

    fun requestChatHistory(contextType: String, contextId: String) {
        socket?.emit("chat:history", JSONObject().put("contextType", contextType).put("contextId", contextId))
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }
}
