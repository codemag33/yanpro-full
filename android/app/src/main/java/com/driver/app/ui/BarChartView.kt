package com.driver.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

class BarChartView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyle: Int = 0
) : View(context, attrs, defStyle) {

    data class BarEntry(val label: String, val value: Float)

    private var entries: List<BarEntry> = emptyList()

    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FFCC00")
        style = Paint.Style.FILL
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#999999")
        textSize = 28f
        textAlign = Paint.Align.CENTER
    }
    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FFCC00")
        textSize = 26f
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#333333")
        strokeWidth = 1f
        style = Paint.Style.STROKE
    }
    private val bgRect = RectF()

    fun setData(data: List<Pair<String, Float>>) {
        entries = data.map { BarEntry(it.first, it.second) }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (entries.isEmpty()) return

        val w = width.toFloat()
        val h = height.toFloat()
        val paddingBottom = 40f
        val paddingTop = 20f
        val chartHeight = h - paddingBottom - paddingTop
        val maxVal = entries.maxOfOrNull { it.value }?.coerceAtLeast(1f) ?: 1f
        val barWidth = (w / entries.size) * 0.6f
        val gap = (w / entries.size) * 0.4f

        // Draw grid lines
        for (i in 0..4) {
            val y = paddingTop + chartHeight * (1f - i / 4f)
            canvas.drawLine(0f, y, w, y, gridPaint)
        }

        entries.forEachIndexed { index, entry ->
            val x = index * (barWidth + gap) + gap / 2
            val barHeight = (entry.value / maxVal) * chartHeight
            val top = paddingTop + chartHeight - barHeight

            bgRect.set(x, top, x + barWidth, paddingTop + chartHeight)
            canvas.drawRoundRect(bgRect, 8f, 8f, barPaint)

            // Value on top
            if (entry.value > 0) {
                canvas.drawText(entry.value.toInt().toString(), x + barWidth / 2, top - 8f, valuePaint)
            }
            // Label below
            canvas.drawText(entry.label, x + barWidth / 2, h - 6f, textPaint)
        }
    }
}
