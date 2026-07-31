package com.driver.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Dialog
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Icon
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.driver.app.databinding.ActivityMainBinding
import com.google.android.material.bottomsheet.BottomSheetBehavior
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.location.LocationComponentActivationOptions
import org.maplibre.android.location.modes.CameraMode
import org.maplibre.android.location.modes.RenderMode
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val COUNTDOWN_MS = 30000L
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var session: com.driver.app.data.SessionManager
    private lateinit var rideSocket: RideSocketManager
    private var mapLibreMap: MapLibreMap? = null
    private val mapController by lazy { com.driver.app.ui.MapController(this) }
    private val sheetBehavior by lazy { BottomSheetBehavior.from(binding.bottomSheet) }

    private var mapFallbackTimer: Handler? = null
    private var mapStyleLoaded = false

    private var backgrounded = false
    private var isOnline = false

    private var currentRideId: String? = null
    private var currentAssistId: String? = null
    private var currentPassengerName = ""
    private var currentPickupAddr = ""
    private var currentDestAddr = ""
    private var currentPickupLat = 0.0
    private var currentPickupLon = 0.0
    private var currentDestLat = 0.0
    private var currentDestLon = 0.0
    private var currentRideStatus = ""
    private var navigatedToPickup = false

    private var requestTimerHandler: Handler? = null
    private var requestTimerRunnable: Runnable? = null
    private var requestStartTime = 0L
    private var pendingRideId: String? = null
    private var pendingAssistId: String? = null
    private var currentRequestType = "" // "ride" or "assist"

    // Request queue (like PWA)
    private data class QueuedRequest(val type: String, val rideId: String?, val assistId: String?,
        val pName: String, val pLat: Double, val pLon: Double, val dLat: Double, val dLon: Double,
        val pAddr: String, val dAddr: String, val carMake: String = "", val bType: String = "",
        val phone: String = "", val desc: String = "")
    private val requestQueue = ArrayDeque<QueuedRequest>()

    // Breakdown type labels (like PWA)
    private val breakdownLabels = mapOf(
        "battery" to "Не заводится / аккумулятор",
        "tire" to "Прокол колеса",
        "fuel" to "Нет топлива",
        "lockout" to "Заблокирован в машине",
        "other" to "Другое"
    )

    // Route info for price calculation
    private var lastRouteDistance = 0.0 // km
    private var lastRouteDuration = 0.0 // seconds

    private var locationBroadcastHandler = Handler(Looper.getMainLooper())
    private var locationBroadcastRunnable: Runnable? = null

    private var chatDialog: Dialog? = null

    private var savedStateBundle: Bundle? = null

    // Active ride state persistence (survives process death)
    private val rideStatePrefs by lazy { getSharedPreferences("active_ride", MODE_PRIVATE) }

    private fun saveRideState() {
        rideStatePrefs.edit()
            .putString("rideId", currentRideId)
            .putString("assistId", currentAssistId)
            .putString("rideStatus", currentRideStatus)
            .putString("passengerName", currentPassengerName)
            .putString("pickupAddr", currentPickupAddr)
            .putString("destAddr", currentDestAddr)
            .putFloat("pickupLat", currentPickupLat.toFloat())
            .putFloat("pickupLon", currentPickupLon.toFloat())
            .putFloat("destLat", currentDestLat.toFloat())
            .putFloat("destLon", currentDestLon.toFloat())
            .putBoolean("navigatedToPickup", navigatedToPickup)
            .apply()
    }

    private fun loadRideState(): Boolean {
        val rideId = rideStatePrefs.getString("rideId", null) ?: return false
        currentRideId = rideId
        currentAssistId = rideStatePrefs.getString("assistId", null)
        currentRideStatus = rideStatePrefs.getString("rideStatus", "") ?: ""
        currentPassengerName = rideStatePrefs.getString("passengerName", "") ?: ""
        currentPickupAddr = rideStatePrefs.getString("pickupAddr", "") ?: ""
        currentDestAddr = rideStatePrefs.getString("destAddr", "") ?: ""
        currentPickupLat = rideStatePrefs.getFloat("pickupLat", 0f).toDouble()
        currentPickupLon = rideStatePrefs.getFloat("pickupLon", 0f).toDouble()
        currentDestLat = rideStatePrefs.getFloat("destLat", 0f).toDouble()
        currentDestLon = rideStatePrefs.getFloat("destLon", 0f).toDouble()
        navigatedToPickup = rideStatePrefs.getBoolean("navigatedToPickup", false)
        return true
    }

    private fun clearRideState() {
        rideStatePrefs.edit().clear().apply()
    }

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true) {
            enableLocationComponent()
        } else {
            Toast.makeText(this, R.string.toast_location_permission_denied, Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedStateBundle = savedInstanceState
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        session = com.driver.app.data.SessionManager(this)
        if (!session.isLoggedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        MapLibre.getInstance(this)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (loadRideState()) {
            // restored from local persistence — will call showActiveRide after map is ready
        }

        initMap()
        setupTopBar()
        setupRequestCard()
        setupActiveCard()
        setupPriceModal()
        setupFab()

        setupRideSocket()
        rideSocket.connect()
    }

    // ─── Ride Socket ───────────────────────────────────────────────────────

    private fun setupRideSocket() {
        rideSocket = RideSocketManager(session.serverUrl, session.token!!)

        rideSocket.onConnected = {
            Log.d(TAG, "socket connected")
            runOnUiThread {
                binding.connBar.visibility = View.VISIBLE
                binding.connBar.setBackgroundColor(Color.parseColor("#4CAF50"))
                binding.tvConnStatus.text = "✅ Подключено"
                Handler(Looper.getMainLooper()).postDelayed({
                    binding.connBar.visibility = View.GONE
                }, 2000)
                rideSocket.setOnline(isOnline)
                rideSocket.requestPendingList()
                fetchEarnings()
            }
        }

        rideSocket.onConnectError = { msg ->
            Log.e(TAG, "socket error: $msg")
            runOnUiThread {
                binding.connBar.visibility = View.VISIBLE
                binding.connBar.setBackgroundColor(Color.parseColor("#FF9800"))
                binding.tvConnStatus.text = "⏳ Переподключение..."
            }
        }

        rideSocket.onAuthInvalid = {
            runOnUiThread {
                Toast.makeText(this, "Ошибка авторизации", Toast.LENGTH_LONG).show()
                session.clear()
                startActivity(Intent(this, LoginActivity::class.java))
                finish()
            }
        }

        rideSocket.onRestoreRide = restoreRide@{ data ->
            if (currentRideId != null) return@restoreRide // already restored from local state

            val id = data.optString("id")
            val status = data.optString("status")
            val pName = data.optString("passengerName", "Пассажир")
            val pickup = data.optJSONObject("pickup")
            val dest = data.optJSONObject("destination")
            val pAddr = data.optString("pickupAddress", "")
            val dAddr = data.optString("destinationAddress", "")

            currentRideId = id
            currentPassengerName = pName
            currentRideStatus = status
            currentPickupAddr = pAddr
            currentDestAddr = dAddr
            if (pickup != null) { currentPickupLat = pickup.optDouble("lat"); currentPickupLon = pickup.optDouble("lon") }
            if (dest != null) { currentDestLat = dest.optDouble("lat"); currentDestLon = dest.optDouble("lon") }

            runOnUiThread {
                showActiveRide()
                drawRoute(currentPickupLat, currentPickupLon, currentDestLat, currentDestLon)
            }
        }

        rideSocket.onRestoreAssist = { data ->
            val id = data.optString("id")
            val pName = data.optString("passengerName", "Пассажир")
            val pickup = data.optJSONObject("pickup")
            val pAddr = data.optString("pickupAddress", "")

            currentAssistId = id
            currentPassengerName = pName
            currentPickupAddr = pAddr
            currentRideStatus = "assistance"
            if (pickup != null) { currentPickupLat = pickup.optDouble("lat"); currentPickupLon = pickup.optDouble("lon") }

            runOnUiThread {
                showActiveAssistance()
            }
        }

        rideSocket.onNewRideRequest = { rideId, pName, pLat, pLon, dLat, dLon, pAddr, dAddr ->
            runOnUiThread {
                showIncomingRideRequest(rideId, pName, pLat, pLon, dLat, dLon, pAddr, dAddr)
            }
        }

        rideSocket.onNewAssistRequest = { assistId, pName, pLat, pLon, carMake, bType, phone, desc ->
            runOnUiThread {
                showIncomingAssistRequest(assistId, pName, pLat, pLon, carMake, bType, phone, desc)
            }
        }

        rideSocket.onRideAlreadyTaken = { rideId ->
            runOnUiThread {
                if (rideId == pendingRideId) {
                    Toast.makeText(this, "Заказ уже принят другим водителем", Toast.LENGTH_SHORT).show()
                    hideRequestCard()
                    showNextFromQueue()
                }
            }
        }

        rideSocket.onRideClosedForOthers = { rideId ->
            runOnUiThread {
                if (rideId == pendingRideId) {
                    Toast.makeText(this, "Заказ закрыт для других водителей", Toast.LENGTH_SHORT).show()
                    hideRequestCard()
                    showNextFromQueue()
                }
            }
        }

        rideSocket.onAssistAlreadyTaken = { assistId ->
            runOnUiThread {
                if (assistId == pendingAssistId) {
                    Toast.makeText(this, "Заявка уже принята другим мастером", Toast.LENGTH_SHORT).show()
                    hideRequestCard()
                    showNextFromQueue()
                }
            }
        }

        rideSocket.onAssistClosedForOthers = { assistId ->
            runOnUiThread {
                if (assistId == pendingAssistId) {
                    Toast.makeText(this, "Заявка закрыта для других мастеров", Toast.LENGTH_SHORT).show()
                    hideRequestCard()
                    showNextFromQueue()
                }
            }
        }

        rideSocket.onPassengerLocation = { lat, lon ->
            runOnUiThread { mapController.setPassengerMarker(mapLibreMap, lat, lon) }
        }

        rideSocket.onAssistPassengerLocation = { lat, lon ->
            runOnUiThread { mapController.setPassengerMarker(mapLibreMap, lat, lon) }
        }

        rideSocket.onRideAccepted = { rideId, _, _ ->
            runOnUiThread {
                currentRideId = rideId
                showActiveRide()
            }
        }

        rideSocket.onAssistAccepted = { assistId, _, _ ->
            runOnUiThread {
                currentAssistId = assistId
                showActiveAssistance()
            }
        }

        rideSocket.onRideStarted = { rideId ->
            runOnUiThread {
                currentRideStatus = "in_progress"
                updateActiveCardButtons()
                drawRoute(currentPickupLat, currentPickupLon, currentDestLat, currentDestLon)
                mapController.flyTo(mapLibreMap, currentDestLat, currentDestLon)
            }
        }

        rideSocket.onRideFinished = { rideId ->
            runOnUiThread {
                Toast.makeText(this, R.string.toast_order_finished, Toast.LENGTH_SHORT).show()
                clearActiveState()
                clearRideState()
                mapController.clearAll(mapLibreMap)
                fetchEarnings()
            }
        }

        rideSocket.onRideCancelled = { rideId, by ->
            runOnUiThread {
                currentRideId = null
                hideActiveCard()
                clearActiveState()
                clearRideState()
                mapController.clearAll(mapLibreMap)
                if (by != session.userId) {
                    Toast.makeText(this, "Пассажир отменил поездку", Toast.LENGTH_SHORT).show()
                }
            }
        }

        rideSocket.onAssistFinished = { assistId ->
            runOnUiThread {
                Toast.makeText(this, R.string.toast_assistance_finished, Toast.LENGTH_SHORT).show()
                clearActiveState()
                clearRideState()
                mapController.clearAll(mapLibreMap)
                fetchEarnings()
            }
        }

        rideSocket.onAssistCancelled = { assistId, by ->
            runOnUiThread {
                currentAssistId = null
                hideActiveCard()
                clearActiveState()
                clearRideState()
                mapController.clearAll(mapLibreMap)
                if (by != session.userId) {
                    Toast.makeText(this, "Пассажир отменил заявку", Toast.LENGTH_SHORT).show()
                }
            }
        }

        rideSocket.onServerError = { ctx ->
            runOnUiThread { Toast.makeText(this, "Ошибка: $ctx", Toast.LENGTH_SHORT).show() }
        }

        rideSocket.onChatHistory = { contextType, contextId, messages ->
            runOnUiThread { updateChatLog(messages) }
        }

        rideSocket.onChatMessage = { contextType, contextId, senderId, senderRole, text, createdAt ->
            runOnUiThread { appendChatMessage(senderRole, text) }
        }

        rideSocket.onPendingRides = { rides ->
            runOnUiThread { rides.forEach { mapController.addPendingMarker(mapLibreMap, it.optString("id"), it.optDouble("lat"), it.optDouble("lon"), "ride") } }
        }

        rideSocket.onPendingAssists = { assists ->
            runOnUiThread { assists.forEach { mapController.addPendingMarker(mapLibreMap, it.optString("id"), it.optDouble("lat"), it.optDouble("lon"), "assist") } }
        }

        rideSocket.onPendingRideCreated = { id, lat, lon ->
            runOnUiThread { mapController.addPendingMarker(mapLibreMap, id, lat, lon, "ride") }
        }

        rideSocket.onPendingAssistCreated = { id, lat, lon ->
            runOnUiThread { mapController.addPendingMarker(mapLibreMap, id, lat, lon, "assist") }
        }

        rideSocket.onPendingRideRemoved = { id ->
            runOnUiThread { mapController.removePendingMarker(mapLibreMap, id) }
        }

        rideSocket.onPendingAssistRemoved = { id ->
            runOnUiThread { mapController.removePendingMarker(mapLibreMap, id) }
        }
    }

    // ─── Map ───────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun initMap() {
        binding.mapView.onCreate(null)
        binding.mapView.getMapAsync { map ->
            mapLibreMap = map
            val styleUrl = "https://tiles.openfreemap.org/styles/liberty"

            map.setStyle(Style.Builder().fromUri(styleUrl)) { style ->
                mapStyleLoaded = true
                mapFallbackTimer?.removeCallbacksAndMessages(null)
                mapController.setupLayers(style)
                rideSocket.requestPendingList()
                if (currentRideId != null) showActiveRide()

                if (hasLocationPermission()) {
                    enableLocationComponent()
                } else {
                    map.cameraPosition = CameraPosition.Builder()
                        .target(LatLng(55.751244, 37.618423))
                        .zoom(12.0)
                        .build()
                    locationPermissionLauncher.launch(
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                    )
                }
            }
        }

        mapFallbackTimer = Handler(Looper.getMainLooper()).apply {
            postDelayed({
                if (!mapStyleLoaded) {
                    mapLibreMap?.setStyle(Style.Builder().fromUri("https://tile.openstreetmap.org/{z}/{x}/{y}.png"))
                }
            }, 6000)
        }
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    @SuppressLint("MissingPermission")
    private fun enableLocationComponent() {
        val map = mapLibreMap ?: return
        val style = map.style ?: return
        val loc = map.locationComponent
        val opts = LocationComponentActivationOptions.builder(this, style).useDefaultLocationEngine(true).build()
        loc.activateLocationComponent(opts)
        loc.isLocationComponentEnabled = true
        loc.cameraMode = CameraMode.TRACKING
        loc.renderMode = RenderMode.COMPASS
        loc.lastKnownLocation?.let { loc2 ->
            map.easeCamera(CameraUpdateFactory.newLatLngZoom(LatLng(loc2.latitude, loc2.longitude), 17.0))
        }
        startLocationBroadcast()
    }

    private fun startLocationBroadcast() {
        locationBroadcastHandler.removeCallbacksAndMessages(null)
        locationBroadcastRunnable = object : Runnable {
            override fun run() {
                val loc = mapLibreMap?.locationComponent?.lastKnownLocation
                if (loc != null) {
                    rideSocket.sendLocation(loc.latitude, loc.longitude, currentRideId, currentAssistId)
                }
                locationBroadcastHandler.postDelayed(this, 5000)
            }
        }
        locationBroadcastHandler.post(locationBroadcastRunnable!!)
    }

    // ─── Top Bar ────────────────────────────────────────────────────────────

    private fun setupTopBar() {
        binding.chipOnline.setOnClickListener {
            isOnline = !isOnline
            rideSocket.setOnline(isOnline)
            binding.onlineDot.setBackgroundResource(if (isOnline) R.drawable.bg_online_dot else R.drawable.bg_offline_dot)
            binding.tvOnlineStatus.text = getString(if (isOnline) R.string.status_online else R.string.status_offline)
            Toast.makeText(this, if (isOnline) R.string.toast_went_online else R.string.toast_went_offline, Toast.LENGTH_SHORT).show()
        }

        binding.btnHistory.setOnClickListener {
            startActivity(Intent(this, HistoryActivity::class.java))
        }

        binding.btnSkipped.setOnClickListener {
            showSkippedDialog()
        }

        binding.btnMenu.setOnClickListener {
            showMenuDialog()
        }
    }

    // ─── Incoming Request Card ─────────────────────────────────────────────

    private fun setupRequestCard() {
        binding.btnAcceptRequest.setOnClickListener { acceptCurrentRequest() }
        binding.btnPassRequest.setOnClickListener { passCurrentRequest() }
    }

    private fun showIncomingRideRequest(rideId: String, pName: String, pLat: Double, pLon: Double,
                                         dLat: Double, dLon: Double, pAddr: String, dAddr: String) {
        if (currentRideId != null || currentAssistId != null) {
            // Queue the request if one is already showing
            requestQueue.addLast(QueuedRequest("ride", rideId, null, pName, pLat, pLon, dLat, dLon, pAddr, dAddr))
            return
        }

        pendingRideId = rideId
        pendingAssistId = null
        currentRequestType = "ride"
        currentPassengerName = pName
        currentPickupAddr = pAddr
        currentDestAddr = dAddr
        currentPickupLat = pLat
        currentPickupLon = pLon
        currentDestLat = dLat
        currentDestLon = dLon

        binding.requestCard.visibility = View.VISIBLE
        binding.activeCard.visibility = View.GONE
        binding.bottomSheet.post { sheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED }
        binding.tvRequestBadge.text = getString(R.string.badge_new_order)
        binding.tvRequestBadge.setTextColor(Color.parseColor("#FFC107"))
        binding.tvRequestBadge.visibility = View.VISIBLE
        val initial = pName.firstOrNull()?.toString() ?: "?"
        binding.tvRequestAvatar.text = initial
        binding.tvRequestAvatar.visibility = View.VISIBLE
        binding.tvRequestPassengerName.text = pName
        binding.tvRequestPickup.text = pAddr.ifEmpty { "Подача: %.5f, %.5f".format(pLat, pLon) }
        binding.tvRequestDest.text = dAddr.ifEmpty { "Куда: %.5f, %.5f".format(dLat, dLon) }
        binding.tvRequestRouteInfo.text = "— км · — мин"
        binding.tvRequestDest.visibility = View.VISIBLE

        mapController.setIncomingRequestOnMap(mapLibreMap, pLat, pLon, dLat, dLon)

        vibrateAndBeep()
        startCountdown()

        lifecycleScope.launch {
            val route = withContext(Dispatchers.IO) { fetchRoute(pLon, pLat, dLon, dLat) }
            if (route != null && pendingRideId == rideId) {
                runOnUiThread {
                    lastRouteDistance = route.optDouble("distance", 0.0) / 1000.0
                    lastRouteDuration = route.optDouble("duration", 0.0)
                    val km = route.optString("km", "—")
                    val min = route.optString("min", "—")
                    binding.tvRequestRouteInfo.text = "$km · $min"
                    val geom = route.optJSONObject("geometry")
                    if (geom != null) {
                        mapController.drawRouteOnMap(mapLibreMap, geom)
                    }
                }
            }
        }
    }

    private fun showIncomingAssistRequest(assistId: String, pName: String, pLat: Double, pLon: Double,
                                           carMake: String, bType: String, phone: String, desc: String) {
        if (currentRideId != null || currentAssistId != null) {
            requestQueue.addLast(QueuedRequest("assist", null, assistId, pName, pLat, pLon, pLat, pLon, "", "", carMake, bType, phone, desc))
            return
        }

        pendingAssistId = assistId
        pendingRideId = null
        currentRequestType = "assist"
        currentPassengerName = pName
        currentPickupAddr = "$carMake, $phone"
        currentDestAddr = desc
        currentPickupLat = pLat
        currentPickupLon = pLon

        binding.requestCard.visibility = View.VISIBLE
        binding.activeCard.visibility = View.GONE
        binding.bottomSheet.post { sheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED }
        binding.tvRequestBadge.text = getString(R.string.badge_assistance)
        binding.tvRequestBadge.setTextColor(Color.parseColor("#4CAF50"))
        binding.tvRequestBadge.visibility = View.VISIBLE
        binding.tvRequestPassengerName.text = pName
        val breakdownLabel = breakdownLabels[bType] ?: bType
        binding.tvRequestPickup.text = "$breakdownLabel · $carMake"
        binding.tvRequestDest.text = if (desc.isNotEmpty()) desc else ""
        binding.tvRequestDest.visibility = if (desc.isNotEmpty()) View.VISIBLE else View.GONE
        binding.tvRequestRouteInfo.text = phone

        mapController.setIncomingRequestOnMap(mapLibreMap, pLat, pLon, pLat, pLon)

        vibrateAndBeep()
        startCountdown()
    }

    private fun acceptCurrentRequest() {
        val rideId = pendingRideId
        val assistId = pendingAssistId
        if (rideId != null) {
            rideSocket.acceptRide(rideId)
            currentRideId = rideId
            pendingRideId = null
            showActiveRide()
        } else if (assistId != null) {
            rideSocket.acceptAssistance(assistId)
            currentAssistId = assistId
            pendingAssistId = null
            showActiveAssistance()
        }
    }

    private fun passCurrentRequest() {
        pendingRideId?.let { rideSocket.skipRide(it) }
        pendingAssistId?.let { rideSocket.skipAssistance(it) }
        hideRequestCard()
        showNextFromQueue()
    }

    private fun showNextFromQueue() {
        if (requestQueue.isEmpty()) return
        val next = requestQueue.removeFirst()
        if (next.type == "ride") {
            showIncomingRideRequest(next.rideId!!, next.pName, next.pLat, next.pLon, next.dLat, next.dLon, next.pAddr, next.dAddr)
        } else {
            showIncomingAssistRequest(next.assistId!!, next.pName, next.pLat, next.pLon, next.carMake, next.bType, next.phone, next.desc)
        }
    }

    private fun vibrateAndBeep() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vm = getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager
                    vm.defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    getSystemService(VIBRATOR_SERVICE) as Vibrator
                }
                val effect = VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE)
                vibrator.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                (getSystemService(VIBRATOR_SERVICE) as Vibrator).vibrate(500)
            }
        } catch (_: Exception) {}

        try {
            val tone = ToneGenerator(android.media.AudioManager.STREAM_ALARM, 100)
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 400)
        } catch (_: Exception) {}
    }

    private var countdownStart = 0L
    private var countdownRemaining = COUNTDOWN_MS

    private fun startCountdown() {
        stopCountdown()
        countdownStart = System.currentTimeMillis()
        countdownRemaining = COUNTDOWN_MS
        binding.countdownBar.progress = COUNTDOWN_MS.toInt()
        binding.tvRequestTimer.text = "30"

        requestTimerRunnable = object : Runnable {
            override fun run() {
                val elapsed = System.currentTimeMillis() - countdownStart
                val remaining = (COUNTDOWN_MS - elapsed).toInt()
                if (remaining <= 0) {
                    binding.countdownBar.progress = 0
                    binding.tvRequestTimer.text = "0"
                    passCurrentRequest()
                    return
                }
                binding.countdownBar.progress = remaining
                binding.tvRequestTimer.text = "${(remaining / 1000) + 1}"
                requestTimerHandler?.postDelayed(this, 100)
            }
        }
        requestTimerHandler = Handler(Looper.getMainLooper())
        requestTimerHandler?.post(requestTimerRunnable!!)
    }

    private fun stopCountdown() {
        requestTimerHandler?.removeCallbacksAndMessages(null)
        requestTimerHandler = null
        requestTimerRunnable = null
    }

    private fun hideRequestCard() {
        binding.requestCard.visibility = View.GONE
        sheetBehavior.state = BottomSheetBehavior.STATE_HIDDEN
        stopCountdown()
        pendingRideId = null
        pendingAssistId = null
        mapController.clearIncomingRequest(mapLibreMap)
    }

    // ─── Active Ride Card ──────────────────────────────────────────────────

    private fun setupActiveCard() {
        binding.btnActiveCancel.setOnClickListener { cancelActiveRide() }
        binding.btnActiveAction.setOnClickListener { onActiveAction() }
        binding.btnActiveChat.setOnClickListener { openChat() }
    }

    private fun showActiveRide() {
        binding.activeCard.visibility = View.VISIBLE
        binding.requestCard.visibility = View.GONE
        binding.bottomSheet.post { sheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED }
        stopCountdown()
        binding.tvRequestBadge.visibility = View.GONE
        binding.tvRequestAvatar.visibility = View.GONE
        mapController.clearIncomingRequest(mapLibreMap)

        val initial = currentPassengerName.firstOrNull()?.toString() ?: "?"
        binding.tvActiveAvatar.text = initial
        binding.tvActivePassenger.text = currentPassengerName
        binding.tvActivePickup.text = currentPickupAddr.ifEmpty { "%.5f, %.5f".format(currentPickupLat, currentPickupLon) }
        binding.tvActiveDest.text = currentDestAddr.ifEmpty { "%.5f, %.5f".format(currentDestLat, currentDestLon) }

        // Route to pickup (accepted phase)
        lifecycleScope.launch {
            val route = withContext(Dispatchers.IO) { fetchRoute(currentPickupLon, currentPickupLat, currentPickupLon, currentPickupLat) }
            if (route != null) {
                runOnUiThread {
                    lastRouteDistance = route.optDouble("distance", 0.0) / 1000.0
                    lastRouteDuration = route.optDouble("duration", 0.0)
                    binding.tvActiveRouteInfo.text = "🚗 ${route.optString("km", "—")} · ${route.optString("min", "—")}"
                    val geom = route.optJSONObject("geometry")
                    if (geom != null) mapController.drawRouteOnMap(mapLibreMap, geom)
                }
            }
        }

        mapController.flyTo(mapLibreMap, currentPickupLat, currentPickupLon)
        updateActiveCardButtons()
        saveRideState()
    }

    private fun showActiveAssistance() {
        binding.activeCard.visibility = View.VISIBLE
        binding.requestCard.visibility = View.GONE
        binding.bottomSheet.post { sheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED }
        stopCountdown()
        binding.tvRequestBadge.visibility = View.GONE
        binding.tvRequestAvatar.visibility = View.GONE
        mapController.clearIncomingRequest(mapLibreMap)

        val initial = currentPassengerName.firstOrNull()?.toString() ?: "?"
        binding.tvActiveAvatar.text = "🔧"
        binding.tvActivePassenger.text = currentPassengerName
        binding.tvActivePickup.text = currentPickupAddr
        binding.tvActiveDest.text = currentDestAddr
        binding.tvActiveDest.visibility = if (currentDestAddr.isNotEmpty()) View.VISIBLE else View.GONE
        binding.tvActiveRouteInfo.text = currentDestAddr
        binding.btnActiveAction.text = getString(R.string.btn_complete)
        binding.btnActiveCancel.visibility = View.VISIBLE

        // Navigate to client location for assistance
        mapController.flyTo(mapLibreMap, currentPickupLat, currentPickupLon)
        lifecycleScope.launch {
            val route = withContext(Dispatchers.IO) { fetchRoute(currentPickupLon, currentPickupLat, currentPickupLon, currentPickupLat) }
            if (route != null) {
                runOnUiThread {
                    val geom = route.optJSONObject("geometry")
                    if (geom != null) mapController.drawRouteOnMap(mapLibreMap, geom)
                }
            }
        }
    }

    private fun updateActiveCardButtons() {
        when (currentRideStatus) {
            "accepted" -> {
                if (navigatedToPickup) {
                    binding.btnActiveAction.text = "Приехал к клиенту"
                    binding.tvActiveStatus.text = "Заберите пассажира"
                } else {
                    binding.btnActiveAction.text = "Навигатор"
                    binding.tvActiveStatus.text = getString(R.string.status_driving_to_pickup)
                }
                binding.btnActiveCancel.visibility = View.VISIBLE
            }
            "in_progress" -> {
                binding.btnActiveAction.text = getString(R.string.btn_finish_ride)
                binding.tvActiveStatus.text = getString(R.string.status_in_ride)
                binding.btnActiveCancel.visibility = View.VISIBLE
            }
            else -> {
                binding.btnActiveAction.text = "Навигатор"
                binding.tvActiveStatus.text = getString(R.string.status_accepted)
                binding.btnActiveCancel.visibility = View.VISIBLE
            }
        }
    }

    private fun onActiveAction() {
        val rideId = currentRideId
        val assistId = currentAssistId

        if (assistId != null) {
            rideSocket.finishAssistance(assistId)
            clearActiveState()
            mapController.clearAll(mapLibreMap)
            return
        }

        if (rideId == null) return

        when (currentRideStatus) {
            "accepted", "" -> {
                if (!navigatedToPickup) {
                    // Step 1: open navigator to pickup
                    navigatedToPickup = true
                    launchYandexNavigator(currentPickupLat, currentPickupLon)
                    updateActiveCardButtons()
                } else {
                    // Step 2: arrived at pickup — start ride + navigate to destination
                    rideSocket.startRide(rideId)
                    currentRideStatus = "in_progress"
                    updateActiveCardButtons()
                    saveRideState()
                    launchYandexNavigator(currentDestLat, currentDestLon)
                }
            }
            "in_progress" -> {
                // Step 3: finish ride — show price modal
                showPriceModal(rideId)
            }
        }
    }

    private fun cancelActiveRide() {
        val reasons = arrayOf(
            "passenger_unreachable",
            "cant_reach_address",
            "personal_circumstances",
            "other"
        )
        val labels = arrayOf(
            "Пассажир не выходит на связь",
            "Не могу добраться до адреса",
            "Личные обстоятельства",
            "Другое"
        )

        val dialog = android.app.AlertDialog.Builder(this)
            .setTitle("Причина отмены")
            .setItems(labels) { _, which ->
                val reason = reasons[which]
                val rideId = currentRideId
                val assistId = currentAssistId
                if (rideId != null) {
                    rideSocket.cancelRide(rideId, reason)
                    currentRideId = null
                }
                if (assistId != null) {
                    rideSocket.cancelAssistance(assistId)
                    currentAssistId = null
                }
                clearActiveState()
                mapController.clearAll(mapLibreMap)
                clearRideState()
            }
            .setNegativeButton("Отмена", null)
            .create()
        dialog.show()
    }

    private fun hideActiveCard() {
        binding.activeCard.visibility = View.GONE
        sheetBehavior.state = BottomSheetBehavior.STATE_HIDDEN
    }

    private fun clearActiveState() {
        currentRideId = null
        currentAssistId = null
        currentRideStatus = ""
        navigatedToPickup = false
        hideActiveCard()
        hideRequestCard()
    }

    // ─── Price Modal ─────────────────────────────────────────────────────

    private fun setupPriceModal() {
        binding.btnPriceCancel.setOnClickListener { binding.priceOverlay.visibility = View.GONE }
        binding.btnPriceConfirm.setOnClickListener { confirmPrice() }
    }

    private var pendingPriceRideId: String? = null

    private fun showPriceModal(rideId: String) {
        pendingPriceRideId = rideId
        val suggested = calculateSuggestedPrice()
        binding.tvPriceSuggestion.text = "Предлагаемая цена: %.0f ₽".format(suggested)
        binding.etPriceInput.setText("%.0f".format(suggested))
        binding.priceOverlay.visibility = View.VISIBLE
    }

    private fun confirmPrice() {
        val rideId = pendingPriceRideId ?: return
        val priceText = binding.etPriceInput.text.toString().trim()
        val price = priceText.toDoubleOrNull()
        if (price == null || price <= 0) {
            Toast.makeText(this, "Укажите корректную цену", Toast.LENGTH_SHORT).show()
            return
        }
        rideSocket.finishRide(rideId, price)
        binding.priceOverlay.visibility = View.GONE
        clearActiveState()
        mapController.clearAll(mapLibreMap)
        Toast.makeText(this, "Поездка завершена за %.0f ₽".format(price), Toast.LENGTH_SHORT).show()
    }

    private fun calculateSuggestedPrice(): Double {
        // Same formula as PWA: 50 + km*20 + duration_min*1.5
        val km = lastRouteDistance
        val durationMin = lastRouteDuration / 60.0
        return 50.0 + km * 20.0 + durationMin * 1.5
    }

    // ─── Yandex Navigator ─────────────────────────────────────────────────

    private fun launchYandexNavigator(lat: Double, lon: Double) {
        val uri = android.net.Uri.parse(
            "yandexnavi://build_route_on_map?lat_to=$lat&lon_to=$lon"
        )
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(packageManager) != null) {
            startActivity(intent)
        } else {
            Toast.makeText(this, R.string.nav_yandex_not_installed, Toast.LENGTH_LONG).show()
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=ru.yandex.yandexnavi")))
        }
        enterPipMode()
    }

    private fun enterPipMode() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (currentRideId == null && currentAssistId == null) return
        val params = PictureInPictureParams.Builder()
            .setActions(listOf(
                RemoteAction(
                    Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                    getString(R.string.pip_action_finish),
                    getString(R.string.pip_action_finish),
                    PendingIntent.getBroadcast(
                        this, 0,
                        Intent(this, PipActionReceiver::class.java).apply {
                            action = PipActionReceiver.ACTION_FINISH_ORDER
                        },
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                    )
                )
            ))
            .build()
        enterPictureInPictureMode(params)
    }

    // ─── Chat ──────────────────────────────────────────────────────────────

    private fun openChat() {
        val contextType = if (currentRideId != null) "ride" else "assist"
        val contextId = currentRideId ?: currentAssistId ?: return

        chatDialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar)
        chatDialog!!.setContentView(R.layout.dialog_chat)

        val tvTitle = chatDialog!!.findViewById<TextView>(R.id.tvChatPassengerName)
        val tvLog = chatDialog!!.findViewById<TextView>(R.id.tvChatLog)
        val etInput = chatDialog!!.findViewById<EditText>(R.id.etChatInput)
        val btnSend = chatDialog!!.findViewById<ImageButton>(R.id.btnSendChat)
        val scrollChat = chatDialog!!.findViewById<ScrollView>(R.id.scrollChat)

        tvTitle.text = currentPassengerName

        rideSocket.requestChatHistory(contextType, contextId)

        btnSend.setOnClickListener {
            val text = etInput.text.toString().trim()
            if (text.isNotEmpty()) {
                rideSocket.sendChat(contextType, contextId, text)
                val html = "<font color='#FFC107'><b>Вы:</b> $text</font>"
                tvLog.append("\n" + android.text.Html.fromHtml(html, android.text.Html.FROM_HTML_MODE_LEGACY))
                etInput.setText("")
                scrollChat.post { scrollChat.fullScroll(ScrollView.FOCUS_DOWN) }
            }
        }

        chatDialog!!.setOnDismissListener { chatDialog = null }
        chatDialog!!.show()
    }

    private fun appendChatMessage(senderRole: String, text: String) {
        val d = chatDialog ?: return
        val tvLog = d.findViewById<TextView>(R.id.tvChatLog) ?: return
        val isDriver = senderRole == "driver" || senderRole == "mechanic"
        val label = if (isDriver) "Вы" else "Пассажир"
        val color = if (isDriver) "#FFC107" else "#333333"
        val html = "<font color='$color'><b>$label:</b> $text</font>"
        val prev = tvLog.text
        tvLog.append(if (prev.isEmpty()) android.text.Html.fromHtml(html, android.text.Html.FROM_HTML_MODE_LEGACY) else "\n" + android.text.Html.fromHtml(html, android.text.Html.FROM_HTML_MODE_LEGACY))
        val scroll = d.findViewById<ScrollView>(R.id.scrollChat)
        scroll?.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun updateChatLog(messages: List<JSONObject>) {
        val d = chatDialog ?: return
        val tvLog = d.findViewById<TextView>(R.id.tvChatLog) ?: return
        val sb = StringBuilder()
        for (msg in messages) {
            val sender = msg.optString("senderId")
            val text = msg.optString("text")
            val isDriver = sender == session.userId
            val label = if (isDriver) "Вы" else "Пассажир"
            val color = if (isDriver) "#FFC107" else "#333333"
            if (sb.isNotEmpty()) sb.append("\n")
            sb.append("<font color='$color'><b>$label:</b> $text</font>")
        }
        tvLog.text = android.text.Html.fromHtml(sb.toString(), android.text.Html.FROM_HTML_MODE_LEGACY)
    }

    // ─── Menu Dialog ──────────────────────────────────────────────────────

    private fun showMenuDialog() {
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar)
        dialog.setContentView(R.layout.dialog_menu)

        val tvName = dialog.findViewById<TextView>(R.id.tvMenuName)
        val tvRole = dialog.findViewById<TextView>(R.id.tvMenuRole)
        val tvEarnings = dialog.findViewById<TextView>(R.id.tvMenuEarnings)
        val tvVersion = dialog.findViewById<TextView>(R.id.tvMenuVersion)
        val btnSkipped = dialog.findViewById<Button>(R.id.btnMenuSkipped)
        val btnSettings = dialog.findViewById<Button>(R.id.btnMenuSettings)
        val btnLogout = dialog.findViewById<Button>(R.id.btnMenuLogout)
        val btnEarnings = dialog.findViewById<Button>(R.id.btnMenuEarningsPage)

        tvName.text = session.name
        tvRole.text = session.login ?: "—"

        try {
            val pkg = packageManager.getPackageInfo(packageName, 0)
            tvVersion.text = "v${pkg.versionName}"
        } catch (_: Exception) {}

        lifecycleScope.launch {
            fetchEarnings()
        }

        btnEarnings.setOnClickListener {
            dialog.dismiss()
            startActivity(Intent(this, EarningsActivity::class.java))
        }
        btnSkipped.setOnClickListener { dialog.dismiss(); showSkippedDialog() }
        btnSettings.setOnClickListener { dialog.dismiss(); openServerSettingsDialog() }
        btnLogout.setOnClickListener {
            dialog.dismiss()
            rideSocket.disconnect()
            session.clear()
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
        }

        dialog.show()
    }

    private fun fetchEarnings() {
        lifecycleScope.launch {
            try {
                val url = URL(session.serverUrl.trimEnd('/') + "/api/driver/stats/today")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer ${session.token}")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                if (conn.responseCode == 200) {
                    val body = BufferedReader(InputStreamReader(conn.inputStream)).readText()
                    val json = org.json.JSONObject(body)
                    val earnings = json.optDouble("earningsToday", 0.0)
                    val rides = json.optInt("ridesToday", 0) + json.optInt("assistsToday", 0)
                    runOnUiThread {
                        binding.tvEarnings.text = "%.0f ₽ · %d".format(earnings, rides)
                    }
                }
                conn.disconnect()
            } catch (_: Exception) {
                runOnUiThread { binding.tvEarnings.text = "— ₽" }
            }
        }
    }

    private fun showSkippedDialog() {
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar)
        dialog.setContentView(R.layout.dialog_skipped)

        val backBtn = dialog.findViewById<View>(R.id.btnSkippedBack)
        val tvEmpty = dialog.findViewById<TextView>(R.id.tvSkippedEmpty)
        val listView = dialog.findViewById<android.widget.ListView>(R.id.lvSkipped)

        backBtn.setOnClickListener { dialog.dismiss() }

        lifecycleScope.launch {
            try {
                val url = URL(session.serverUrl.trimEnd('/') + "/api/driver/skipped")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer ${session.token}")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                if (conn.responseCode == 200) {
                    val body = BufferedReader(InputStreamReader(conn.inputStream)).readText()
                    val json = org.json.JSONObject(body)
                    val arr = json.optJSONArray("skips") ?: org.json.JSONArray()
                    runOnUiThread {
                        if (arr.length() == 0) {
                            tvEmpty.visibility = View.VISIBLE
                        } else {
                            val items = (0 until arr.length()).map { i ->
                                val obj = arr.optJSONObject(i)
                                val name = obj?.optString("passenger_name", "—") ?: "—"
                                val addr = obj?.optString("pickup_address", "") ?: ""
                                val time = obj?.optString("skipped_at", "")?.take(16)?.replace("T", " ") ?: ""
                                "$name  ·  $time\n$addr"
                            }
                            val adapter = android.widget.ArrayAdapter(this@MainActivity,
                                android.R.layout.simple_list_item_1, items)
                            listView.adapter = adapter
                        }
                    }
                }
                conn.disconnect()
            } catch (_: Exception) {
                runOnUiThread { tvEmpty.visibility = View.VISIBLE }
            }
        }
        dialog.show()
    }

    private fun openServerSettingsDialog() {
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar)
        dialog.setContentView(R.layout.dialog_settings)
        val etUrl = dialog.findViewById<EditText>(R.id.etServerUrl)
        val etName = dialog.findViewById<EditText>(R.id.etDriverName)
        val btnSave = dialog.findViewById<Button>(R.id.btnSaveServer)

        etUrl.setText(session.serverUrl)
        etName.setText(session.name)

        btnSave.setOnClickListener {
            val newUrl = etUrl.text.toString().trim()
            val newName = etName.text.toString().trim()
            if (newUrl.isNotEmpty() && newName.isNotEmpty()) {
                session.serverUrl = newUrl
                session.name = newName
                rideSocket.disconnect()
                Toast.makeText(this, "Сервер: $newUrl", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    // ─── FAB ───────────────────────────────────────────────────────────────

    private fun setupFab() {
        binding.fabMyLocation.setOnClickListener {
            if (!hasLocationPermission()) {
                locationPermissionLauncher.launch(
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                )
                return@setOnClickListener
            }
            val loc = mapLibreMap?.locationComponent?.lastKnownLocation
            if (loc != null) {
                mapLibreMap?.easeCamera(CameraUpdateFactory.newLatLngZoom(LatLng(loc.latitude, loc.longitude), 17.0))
            }
        }
    }

    // ─── Route / API helpers ───────────────────────────────────────────────

    private suspend fun fetchRoute(startLon: Double, startLat: Double, endLon: Double, endLat: Double): JSONObject? {
        return try {
            val url = URL(session.serverUrl.trimEnd('/') + "/api/routing/route")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val body = JSONObject().apply {
                put("startLat", startLat); put("startLon", startLon)
                put("endLat", endLat); put("endLon", endLon)
            }
            conn.outputStream.write(body.toString().toByteArray())
            if (conn.responseCode == 200) {
                val resp = BufferedReader(InputStreamReader(conn.inputStream)).readText()
                JSONObject(resp)
            } else null
        } catch (_: Exception) { null }
    }

    private fun drawRoute(startLat: Double, startLon: Double, endLat: Double, endLon: Double) {
        lifecycleScope.launch {
            val route = withContext(Dispatchers.IO) { fetchRoute(startLon, startLat, endLon, endLat) }
            if (route != null) {
                val geom = route.optJSONObject("geometry")
                if (geom != null) {
                    runOnUiThread { mapController.drawRouteOnMap(mapLibreMap, geom) }
                }
            }
        }
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("rideId", currentRideId)
        outState.putString("rideStatus", currentRideStatus)
        outState.putString("assistId", currentAssistId)
        outState.putString("passengerName", currentPassengerName)
        outState.putString("pickupAddr", currentPickupAddr)
        outState.putString("destAddr", currentDestAddr)
        outState.putDouble("pickupLat", currentPickupLat)
        outState.putDouble("pickupLon", currentPickupLon)
        outState.putDouble("destLat", currentDestLat)
        outState.putDouble("destLon", currentDestLon)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(PipActionReceiver.EXTRA_FINISH_ORDER, false)) {
            if (currentRideStatus == "in_progress" && currentRideId != null) {
                showPriceModal(currentRideId!!)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        binding.mapView.onResume()
        backgrounded = false
        savedStateBundle?.let { restoreSavedState(it); savedStateBundle = null }
    }

    override fun onPause() {
        super.onPause()
        binding.mapView.onPause()
        backgrounded = true
    }

    override fun onDestroy() {
        super.onDestroy()
        binding.mapView.onDestroy()
        locationBroadcastHandler.removeCallbacksAndMessages(null)
        stopCountdown()
    }

    private fun restoreSavedState(bundle: Bundle) {
        val rideId = bundle.getString("rideId") ?: return
        currentRideId = rideId
        currentRideStatus = bundle.getString("rideStatus", "")
        currentAssistId = bundle.getString("assistId")
        currentPassengerName = bundle.getString("passengerName", "")
        currentPickupAddr = bundle.getString("pickupAddr", "")
        currentDestAddr = bundle.getString("destAddr", "")
        currentPickupLat = bundle.getDouble("pickupLat")
        currentPickupLon = bundle.getDouble("pickupLon")
        currentDestLat = bundle.getDouble("destLat")
        currentDestLon = bundle.getDouble("destLon")
        showActiveRide()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        binding.mapView.onLowMemory()
    }

}
