// Карта Maplibre: инициализация, маркеры, маршруты (OSRM), геолокация,
// pending-заказы на карте.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { state, ORENBURG, isMechanic, getOSRMUrl, type PendingMarkerEntry } from './core';
import { EVENTS } from '../shared/protocol';
import { toast, drawRouteToPickup, drawRouteToAssist } from './ui';
import { takeRequestDirect, reactivateRequest } from './requests';

export const FALLBACK_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export async function fetchRoute(lat1: number, lon1: number, lat2: number, lon2: number) {
  try {
    const res = await fetch(getOSRMUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startLat: lat1, startLon: lon1, endLat: lat2, endLon: lon2 }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function drawRouteOnMap(geometry: unknown) {
  if (!state.map || !state.map.isStyleLoaded()) return;
  if (state.map.getSource('route-line')) {
    state.map.removeLayer('route-line');
    state.map.removeSource('route-line');
  }
  state.map.addSource('route-line', { type: 'geojson', data: geometry as any });
  state.map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-line',
    paint: { 'line-color': '#2563EB', 'line-width': 4, 'line-opacity': 0.85 },
  });
}

// Убирает линию маршрута с карты (после завершения/отмены заявки)
export function removeRouteLine() {
  if (!state.map) return;
  if (state.map.getSource('route-line')) {
    try {
      state.map.removeLayer('route-line');
    } catch (e) {
      /* noop */
    }
    try {
      state.map.removeSource('route-line');
    } catch (e) {
      /* noop */
    }
  }
}

export function drawDirectLineOnMap(lat1: number, lon1: number, lat2: number, lon2: number) {
  if (!state.map || !state.map.isStyleLoaded()) return;
  if (state.map.getSource('route-line')) {
    state.map.removeLayer('route-line');
    state.map.removeSource('route-line');
  }
  state.map.addSource('route-line', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[lon1, lat1], [lon2, lat2]] },
    },
  });
  state.map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-line',
    paint: { 'line-color': '#2563EB', 'line-width': 3, 'line-opacity': 0.85 },
  });
}

export function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [ORENBURG.lon, ORENBURG.lat],
    zoom: 13,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  // Тап по карте — вручную указать своё местоположение. Это ОСНОВНОЙ способ
  // на устройствах, где геолокация не работает (GPS выключен, нет разрешения).
  state.map.on('click', (e) => {
    if (state.activeRide || state.activeAssist) return; // во время поездки точку не трогаем
    const { lng, lat } = e.lngLat;
    state.lastPos = { lat, lon: lng };
    placeMarker('self', lat, lng, isMechanic() ? '🔧' : '🚗');
    if (state.socket) {
      state.socket.emit(EVENTS.LOCATION_UPDATE, {
        lat,
        lon: lng,
        rideId: state.activeRide?.id,
        assistId: state.activeAssist?.id,
      });
    }
    toast('Точка установлена вручную');
  });

  // Правая кнопка мыши — сразу взять заявку под курсором (левая занята
  // установкой точки). Если под курсором нет заявки — обычное контекстное меню.
  state.map.on('contextmenu', (e) => {
    const target = findPendingMarkerAt(e.point);
    if (target) {
      e.preventDefault();
      takeRequestDirect(target.kind, target.id);
    }
  });

  // Если vector-стиль не загрузился (блокировка/таймаут сети) — переключаемся
  // на простые растровые тайлы OSM вместо пустого экрана.
  let fellBack = false;
  const fallbackToRaster = () => {
    if (fellBack || state.map.isStyleLoaded()) return;
    fellBack = true;
    state.map.setStyle(FALLBACK_RASTER_STYLE as any);
    toast('Карта работает в упрощённом режиме');
  };
  state.map.on('error', (e) => {
    console.warn('Map error:', (e as any)?.error?.message || e);
    fallbackToRaster();
  });
  setTimeout(fallbackToRaster, 6000);

  // Если карта инициализировалась при скрытом контейнере — пересчитываем размер.
  setTimeout(() => state.map?.resize(), 300);
}

export function placeMarker(kind: 'self' | 'passenger', lat: number, lon: number, glyph?: string) {
  if (!state.map) return;
  if (state.markers[kind]) state.markers[kind].remove();
  const el = document.createElement('div');
  el.className = kind === 'self' ? 'selfMarker' : 'passMarker';
  el.textContent = glyph || (kind === 'self' ? '🚗' : '📍');
  state.markers[kind] = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(state.map);
}

export function getSelfPos() {
  return (
    state.markers.self?.getLngLat() ||
    (state.lastPos ? { lng: state.lastPos.lon, lat: state.lastPos.lat } : null)
  );
}

/* ─── Геолокация ──────────────────────────────────────────────────────────
   Как и в PWA пассажира — деградация без падений: если вотчер геолокации не
   отвечает, просто не шлём координаты, ничего не рушится. */
let geoWatchId: number | null = null;
let geoFailNotified = false;

export function startLocationWatch() {
  if (!navigator.geolocation || geoWatchId !== null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      state.lastPos = { lat, lon };
      placeMarker('self', lat, lon, isMechanic() ? '🔧' : '🚗');
      if (state.socket) {
        state.socket.emit(EVENTS.LOCATION_UPDATE, {
          lat,
          lon,
          rideId: state.activeRide?.id,
          assistId: state.activeAssist?.id,
        });
      }
      // Первая координата после принятия заказа — рисуем маршрут, если его ещё нет
      const r = state.activeRide;
      if (r && r.status === 'accepted' && !r.routeToPickup) drawRouteToPickup();
      const a = state.activeAssist;
      if (a && !a.routeToPickup) drawRouteToAssist();
    },
    () => {
      if (!geoFailNotified) {
        geoFailNotified = true;
        toast('Геолокация недоступна — тапните по карте, чтобы указать своё местоположение');
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

export function stopLocationWatch() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

/* ─── Pending-заказы на карте ───────────────────────────────────────────── */
function makePendingMarkerEl(kind: 'ride' | 'assist', id: string) {
  const el = document.createElement('div');
  el.className = 'pendingMarker' + (kind === 'assist' ? ' assist' : '');
  el.textContent = kind === 'assist' ? '🔧' : '🚕';
  el.onclick = () => reactivateRequest(kind, id);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    takeRequestDirect(kind, id);
  };
  return el;
}

export function renderPendingMarkers(kind: 'ride' | 'assist', items: Array<{ id: string; lat: number; lon: number }>) {
  if (!state.map) return;
  clearPendingMarkers(kind);
  items.forEach((item) => {
    const marker = new maplibregl.Marker({ element: makePendingMarkerEl(kind, item.id) })
      .setLngLat([item.lon, item.lat])
      .addTo(state.map);
    state.pendingMarkers.push({ id: item.id, kind, marker });
  });
}

export function clearPendingMarkers(kind: 'ride' | 'assist') {
  state.pendingMarkers = state.pendingMarkers.filter((m) => {
    if (m.kind === kind) {
      m.marker.remove();
      return false;
    }
    return true;
  });
}

export function addPendingMarker(kind: 'ride' | 'assist', data: { id: string; lat: number; lon: number }) {
  if (!state.map) return;
  const marker = new maplibregl.Marker({ element: makePendingMarkerEl(kind, data.id) })
    .setLngLat([data.lon, data.lat])
    .addTo(state.map);
  state.pendingMarkers.push({ id: data.id, kind, marker });
}

export function removePendingMarker(kind: 'ride' | 'assist', id: string) {
  const idx = state.pendingMarkers.findIndex((m) => m.kind === kind && m.id === id);
  if (idx !== -1) {
    state.pendingMarkers[idx].marker.remove();
    state.pendingMarkers.splice(idx, 1);
  }
}

// Ближайший свободный маркер заявки к точке экрана (для правой кнопки мыши)
export function findPendingMarkerAt(point: { x: number; y: number }): PendingMarkerEntry | null {
  if (!state.map) return null;
  let best: PendingMarkerEntry | null = null;
  let bestDist = Infinity;
  for (const m of state.pendingMarkers) {
    const p = state.map.project(m.marker.getLngLat());
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < 45 && d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}
