package com.driver.app

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.driver.app.data.SessionManager
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class HistoryActivity : AppCompatActivity() {

    private lateinit var rvHistory: RecyclerView
    private lateinit var emptyState: View
    private lateinit var loadingState: View
    private lateinit var tvHistoryCount: TextView
    private lateinit var adapter: HistoryAdapter

    private var allItems = listOf<HistoryItem>()
    private var currentFilter = "all"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_history)

        rvHistory = findViewById(R.id.rvHistory)
        emptyState = findViewById(R.id.emptyState)
        loadingState = findViewById(R.id.loadingState)
        tvHistoryCount = findViewById(R.id.tvHistoryCount)

        adapter = HistoryAdapter()
        rvHistory.layoutManager = LinearLayoutManager(this)
        rvHistory.adapter = adapter

        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        setupFilterChips()
        loadHistory()
    }

    private fun setupFilterChips() {
        val chipAll = findViewById<Chip>(R.id.chipAll)
        val chipRides = findViewById<Chip>(R.id.chipRides)
        val chipAssists = findViewById<Chip>(R.id.chipAssists)

        chipAll.setOnClickListener { applyFilter("all") }
        chipRides.setOnClickListener { applyFilter("ride") }
        chipAssists.setOnClickListener { applyFilter("assistance") }

        chipAll.isChecked = true
    }

    private fun applyFilter(filter: String) {
        currentFilter = filter
        val filtered = when (filter) {
            "ride" -> allItems.filter { it.type == "ride" }
            "assistance" -> allItems.filter { it.type == "assistance" }
            else -> allItems
        }
        adapter.submitList(filtered)
        tvHistoryCount.text = getString(R.string.history_count, filtered.size)
        emptyState.visibility = if (filtered.isEmpty()) View.VISIBLE else View.GONE
        rvHistory.visibility = if (filtered.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun loadHistory() {
        val session = SessionManager(this)
        val token = session.token ?: return
        val serverUrl = session.serverUrl

        loadingState.visibility = View.VISIBLE
        emptyState.visibility = View.GONE
        rvHistory.visibility = View.GONE

        lifecycleScope.launch {
            try {
                val items = withContext(Dispatchers.IO) {
                    fetchHistory(serverUrl, token)
                }
                allItems = items
                applyFilter(currentFilter)
            } catch (e: Exception) {
                emptyState.visibility = View.VISIBLE
                tvHistoryCount.text = ""
            } finally {
                loadingState.visibility = View.GONE
            }
        }
    }

    private fun fetchHistory(serverUrl: String, token: String): List<HistoryItem> {
        val url = URL("${serverUrl.trimEnd('/')}/api/driver/history")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Authorization", "Bearer $token")
        }

        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: "[]"
            if (code !in 200..299) return emptyList()

            val json = org.json.JSONObject(text)
            val arr = json.optJSONArray("rides") ?: return emptyList()
            parseHistoryItems(arr)
        } catch (e: Exception) {
            emptyList()
        } finally {
            conn.disconnect()
        }
    }

    private fun parseHistoryItems(arr: JSONArray): List<HistoryItem> {
        val items = mutableListOf<HistoryItem>()
        val inputFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US)
        val outputFmt = SimpleDateFormat("d MMM, HH:mm", Locale("ru"))

        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val type = obj.optString("type", "ride")
            val status = obj.optString("status", "")
            val price = obj.optDouble("price", -1.0)
            val pickup = obj.optString("pickup_address", "")
            val dest = obj.optString("destination_address", "")
            val finishedAt = obj.optString("finished_at", "")

            val dateStr = try {
                val date = inputFmt.parse(finishedAt.replace("Z", "").take(16))
                date?.let { outputFmt.format(it) } ?: ""
            } catch (e: Exception) { "" }

            items.add(
                HistoryItem(
                    type = type,
                    status = status,
                    price = if (price >= 0) "${price.toInt()} \u20BD" else "",
                    pickupAddress = pickup,
                    destAddress = dest,
                    date = dateStr
                )
            )
        }
        return items
    }

    // ─── Data class ─────────────────────────────────────────────────────────

    data class HistoryItem(
        val type: String,
        val status: String,
        val price: String,
        val pickupAddress: String,
        val destAddress: String,
        val date: String
    )

    // ─── Adapter ────────────────────────────────────────────────────────────

    inner class HistoryAdapter : RecyclerView.Adapter<HistoryAdapter.VH>() {
        private val items = mutableListOf<HistoryItem>()

        fun submitList(newItems: List<HistoryItem>) {
            items.clear()
            items.addAll(newItems)
            notifyDataSetChanged()
        }

        inner class VH(view: View) : RecyclerView.ViewHolder(view) {
            val ivType: ImageView = view.findViewById(R.id.ivType)
            val tvType: TextView = view.findViewById(R.id.tvType)
            val tvDate: TextView = view.findViewById(R.id.tvDate)
            val tvPickup: TextView = view.findViewById(R.id.tvPickup)
            val tvDest: TextView = view.findViewById(R.id.tvDest)
            val tvStatus: TextView = view.findViewById(R.id.tvStatus)
            val tvPrice: TextView = view.findViewById(R.id.tvPrice)
            val statusDot: View = view.findViewById(R.id.statusDot)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val view = LayoutInflater.from(parent.context).inflate(R.layout.item_history, parent, false)
            return VH(view)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]

            if (item.type == "ride") {
                holder.ivType.setImageResource(R.drawable.ic_car)
                holder.tvType.text = getString(R.string.history_type_ride)
                holder.tvType.setTextColor(ContextCompat.getColor(holder.itemView.context, R.color.uber_green))
            } else {
                holder.ivType.setImageResource(R.drawable.ic_wrench)
                holder.tvType.text = getString(R.string.history_type_assistance)
                holder.tvType.setTextColor(ContextCompat.getColor(holder.itemView.context, R.color.uber_yellow))
            }

            holder.tvDate.text = item.date
            holder.tvPickup.text = item.pickupAddress.ifEmpty { "\u2014" }
            holder.tvDest.text = item.destAddress.ifEmpty { "\u2014" }

            val statusColor = when (item.status) {
                "completed" -> R.color.uber_green
                "cancelled" -> R.color.uber_red
                else -> R.color.uber_text_secondary
            }
            holder.tvStatus.text = when (item.status) {
                "completed" -> getString(R.string.history_status_completed)
                "cancelled" -> getString(R.string.history_status_cancelled)
                else -> item.status
            }
            holder.tvStatus.setTextColor(ContextCompat.getColor(holder.itemView.context, statusColor))
            holder.statusDot.setBackgroundResource(
                if (item.status == "completed") R.drawable.bg_online_dot else R.drawable.bg_offline_dot
            )

            holder.tvPrice.text = item.price
            holder.tvPrice.visibility = if (item.price.isNotEmpty()) View.VISIBLE else View.GONE
        }

        override fun getItemCount(): Int = items.size
    }
}
