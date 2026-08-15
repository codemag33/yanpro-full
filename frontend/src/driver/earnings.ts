import Chart from 'chart.js/auto';

// Сервер и токен — как в основном PWA водителя; поддержка старых ключей
// (yanpro_server/yanpro_token) для обратной совместимости.
const serverUrl =
  localStorage.getItem('yanpro_driver_server_url') ||
  localStorage.getItem('yanpro_server') ||
  window.location.origin;
const token =
  localStorage.getItem('yanpro_driver_token') ||
  localStorage.getItem('yanpro_token');

async function loadStats() {
  try {
    const res = await fetch(serverUrl + '/api/driver/stats/today', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json();

    document.getElementById('today-earnings').textContent = String(data.earningsToday || 0);
    document.getElementById('today-rides').textContent = String(data.ridesToday || 0);
    document.getElementById('avg-ride').textContent = data.ridesToday > 0 ? String(Math.round(data.earningsToday / data.ridesToday)) : '0';
    document.getElementById('rating').textContent = data.driverRating?.toFixed(1) || '--';
  } catch (e) {
    console.error('Error loading stats', e);
  }
}

async function loadRides() {
  try {
    const res = await fetch(serverUrl + '/api/driver/history', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json();

    if (!data.rides || data.rides.length === 0) {
      document.getElementById('rides-table').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Нет поездок</td></tr>';
      return;
    }

    document.getElementById('rides-table').innerHTML = data.rides
      .slice(0, 10)
      .map((r: any) => `
        <tr>
          <td>${new Date(r.finished_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</td>
          <td style="color:var(--muted);font-size:11px">${r.pickup_address?.substring(0, 20) || '--'}</td>
          <td style="color:var(--muted);font-size:11px">${r.destination_address?.substring(0, 20) || '--'}</td>
          <td style="color:var(--y);font-weight:700">₽${r.price ?? 0}</td>
        </tr>
      `)
      .join('');
  } catch (e) {
    console.error('Error loading rides', e);
  }
}

async function loadChart() {
  try {
    const daysCount = 7;
    const res = await fetch(serverUrl + '/api/driver/earnings-history?days=' + daysCount, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json();
    if (!data || !Array.isArray(data.days)) return;

    // Сервер возвращает только дни с активностью — добиваем пустые дни нулями,
    // чтобы график показывал ровно последние 7 дней.
    const byDate: Record<string, number> = {};
    data.days.forEach((d: any) => {
      if (d.date) byDate[d.date.slice(0, 10)] = Number(d.earnings || 0);
    });
    const labels: string[] = [];
    const earnings: number[] = [];
    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }));
      earnings.push(byDate[key] || 0);
    }

    const ctx = (document.getElementById('earningsChart') as HTMLCanvasElement).getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Заработок (₽)',
            data: earnings,
            backgroundColor: '#FFCC00',
            borderColor: '#FFB800',
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { color: '#999' }, grid: { color: '#333' } }, x: { ticks: { color: '#999' }, grid: { display: false } } },
      },
    });
  } catch (e) {
    console.error('Error loading chart', e);
  }
}

document.getElementById('header-date').textContent = new Date().toLocaleDateString('ru-RU', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

loadStats();
loadRides();
loadChart();
