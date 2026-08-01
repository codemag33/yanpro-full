package com.driver.app

import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.driver.app.data.SessionManager
import com.driver.app.databinding.ActivityEarningsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class EarningsActivity : AppCompatActivity() {

    private lateinit var binding: ActivityEarningsBinding
    private lateinit var session: SessionManager

    private var currentDays = 1 // 1 | 7 | 30

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityEarningsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        session = SessionManager(this)

        binding.btnBack.setOnClickListener { finish() }

        binding.chipDay.setOnClickListener { selectPeriod(1) }
        binding.chipWeek.setOnClickListener { selectPeriod(7) }
        binding.chipMonth.setOnClickListener { selectPeriod(30) }

        selectPeriod(1)
    }

    private fun selectPeriod(days: Int) {
        currentDays = days
        binding.chipDay.isChecked = days == 1
        binding.chipWeek.isChecked = days == 7
        binding.chipMonth.isChecked = days == 30
        val label = when (days) {
            7 -> "За неделю (₽)"
            30 -> "За месяц (₽)"
            else -> "Сегодня (₽)"
        }
        binding.tvStatsLabel.text = label
        binding.tvRidesTitle.text = when (days) {
            7 -> "📋 Поездки за неделю"
            30 -> "📋 Поездки за месяц"
            else -> "📋 Поездки за сегодня"
        }
        binding.tvChartTitle.text = "📊 График заработков (${days} дн.)"
        loadStats()
        loadHistory()
        loadChart()
    }

    private fun loadStats() {
        lifecycleScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    apiGet("/api/driver/stats/today?days=$currentDays")
                }
                if (data != null) {
                    val earnings = data.optDouble("earningsToday", 0.0) ?: 0.0
                    val rides = data.optInt("ridesToday", 0)

                    binding.tvTodayEarnings.text = "₽${earnings.toInt()}"
                    binding.tvTodayRides.text = rides.toString()
                    binding.tvAvgRide.text = if (rides > 0) "₽${(earnings / rides).toInt()}" else "0"
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun loadHistory() {
        lifecycleScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    apiGet("/api/driver/history")
                }
                if (data != null) {
                    val rides = data.optJSONArray("rides")
                    if (rides != null && rides.length() > 0) {
                        binding.tvRidesEmpty.visibility = View.GONE
                        binding.ridesListContainer.visibility = View.VISIBLE
                        binding.ridesListContainer.removeAllViews()

                        val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
                        val from = System.currentTimeMillis() - currentDays * 24L * 3600 * 1000

                        for (i in 0 until minOf(rides.length(), 30)) {
                            val ride = rides.getJSONObject(i)
                            val finishedAt = ride.optString("finished_at", "")
                            val ts = parseTs(finishedAt)

                            if (ts >= from && ride.optString("status") == "completed") {
                                val row = createRideRow(
                                    time = finishedAt,
                                    from = ride.optString("pickup_address", ""),
                                    to = ride.optString("destination_address", ""),
                                    price = ride.optDouble("price", 0.0)
                                )
                                binding.ridesListContainer.addView(row)
                            }
                        }

                        if (binding.ridesListContainer.childCount == 0) {
                            binding.tvRidesEmpty.visibility = View.VISIBLE
                            binding.ridesListContainer.visibility = View.GONE
                        }
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    // Устойчивый парсинг даты Postgres (с миллисекундами/Z/+00:00)
    private fun parseTs(raw: String): Long {
        if (raw.isEmpty()) return 0
        val normalized = raw.replace("Z", "").replace("+00:00", "").replace("+00", "").trim()
        val formats = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd'T'HH:mm"
        )
        for (fmt in formats) {
            try {
                SimpleDateFormat(fmt, Locale.getDefault()).parse(normalized)?.let { return it.time }
            } catch (_: Exception) {}
        }
        return 0
    }

    private fun createRideRow(time: String, from: String, to: String, price: Double): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 16, 0, 16)
            gravity = Gravity.CENTER_VERTICAL
        }

        val timeTv = TextView(this).apply {
            text = if (time.length >= 16) {
                SimpleDateFormat("HH:mm", Locale.getDefault()).format(
                    SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.getDefault()).parse(time) ?: Date()
                )
            } else "--:--"
            setTextColor(Color.parseColor("#999999"))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.2f)
        }

        val fromTv = TextView(this).apply {
            text = from.take(20).ifEmpty { "--" }
            setTextColor(Color.parseColor("#999999"))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.35f)
        }

        val toTv = TextView(this).apply {
            text = to.take(20).ifEmpty { "--" }
            setTextColor(Color.parseColor("#999999"))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.35f)
        }

        val priceTv = TextView(this).apply {
            text = "₽${price.toInt()}"
            setTextColor(Color.parseColor("#FFCC00"))
            textSize = 14f
            paint.isFakeBoldText = true
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.1f)
            gravity = Gravity.END
        }

        row.addView(timeTv)
        row.addView(fromTv)
        row.addView(toTv)
        row.addView(priceTv)
        return row
    }

    private fun loadChart() {
        lifecycleScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    apiGet("/api/driver/earnings-history?days=$currentDays")
                }
                if (data != null) {
                    val days = data.optJSONArray("days")
                    if (days != null && days.length() > 0) {
                        val pairs = mutableListOf<Pair<String, Float>>()
                        for (i in 0 until days.length()) {
                            val day = days.getJSONObject(i)
                            val date = day.optString("date", "")
                            val earnings = day.optDouble("earnings", 0.0)
                            val label = if (date.length >= 10) {
                                val d = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).parse(date)
                                SimpleDateFormat("dd.MM", Locale.getDefault()).format(d ?: Date())
                            } else "?"
                            pairs.add(Pair(label, earnings.toFloat()))
                        }
                        binding.barChart.setData(pairs)
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun apiGet(path: String): JSONObject? {
        val serverUrl = session.serverUrl ?: return null
        val token = session.token ?: return null
        val url = URL("$serverUrl$path")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            if (conn.responseCode == 200) {
                return JSONObject(conn.inputStream.bufferedReader().readText())
            }
        } finally {
            conn.disconnect()
        }
        return null
    }
}
