// Общий помощник обратного геокодинга (Nominatim) с rate-limit и кэшем.
// Используется сервером для адреса точек заявок на помощь (у пассажира
// адреса нет — только координаты).
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
let lastRequestTime = 0;
const USER_AGENT = 'YanProTaxi/1.0 (https://taxi.fbs3.ru; admin@fbs3.ru)';

async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

// Возвращает адрес по координатам или null при неудаче (тихо, без падений).
async function reverseGeocode(lat, lon, timeoutMs = 2500) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
      lat: String(lat), lon: String(lon), format: 'jsonv2', 'accept-language': 'ru',
    });
    const r = await rateLimitedFetch(url);
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const addr = data && (data.display_name || data.name);
    cache.set(key, { ts: Date.now(), data: addr || null });
    return addr || null;
  } catch {
    return null;
  }
}

module.exports = { reverseGeocode };
