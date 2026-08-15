// Карта пассажира: инициализация, маркеры-пины, точки А/Б, маршруты (OSRM)
// с фолбэком на прямую линию.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { state, ORENBURG, type PointSelection } from './core';
import { reverseGeocode } from './api';
import { toast } from './ui';
import { renderSheetIdle } from './sheet';

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

export function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [ORENBURG.lon, ORENBURG.lat],
    zoom: 13,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  // Если основной стиль не загрузился (сеть заблокировала openfreemap.org
  // или он недоступен) — переключаемся на простые растровые тайлы OSM,
  // а не оставляем пустой серый экран.
  let fellBack = false;
  state.map.on('error', (e) => {
    console.warn('Map error:', (e as any)?.error?.message || e);
    if (!fellBack && !state.map.isStyleLoaded()) {
      fellBack = true;
      state.map.setStyle(FALLBACK_RASTER_STYLE as any);
      toast('Карта работает в упрощённом режиме');
    }
  });
  // Если через 6 секунд стиль так и не загрузился — тоже переключаемся,
  // не дожидаясь явной ошибки (бывают тихие таймауты без события error).
  setTimeout(() => {
    if (!fellBack && state.map && !state.map.isStyleLoaded()) {
      fellBack = true;
      state.map.setStyle(FALLBACK_RASTER_STYLE as any);
      toast('Карта работает в упрощённом режиме');
    }
  }, 6000);

  // Хак Safari/старых WebView: если карта инициализировалась, пока контейнер был
  // скрыт (display:none / нулевая высота), тайлы рисуются в неправильном размере.
  setTimeout(() => state.map?.resize(), 300);

  // Долгое нажатие / клик по карте — ручная установка точки (всегда доступно,
  // не только как запасной вариант при сбое геолокации).
  state.map.on('click', (e) => {
    if (state.activeRide || state.activeAssist) return; // во время активной поездки клики по карте не меняют точки
    const { lng, lat } = e.lngLat;
    if (state.mode === 'assist') setPickup(lat, lng); // в режиме помощи нужна только одна точка
    else if (!state.pickup) setPickup(lat, lng);
    else setDestination(lat, lng);
  });
}

export function placeMarker(kind: string, lat: number, lon: number) {
  if (!state.map) return;
  if (state.markers[kind]) state.markers[kind].remove();
  const el = document.createElement('div');
  el.className = kind === 'driver' ? 'driverMarker' : `pinMarker ${kind}`;
  if (kind === 'driver') el.textContent = '🚗';
  const draggable = kind !== 'driver' && !state.activeRide && !state.activeAssist;
  const marker = new maplibregl.Marker({ element: el, draggable }).setLngLat([lon, lat]).addTo(state.map);
  if (draggable) {
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      if (kind === 'pickup') setPickup(p.lat, p.lng, true);
      else setDestination(p.lat, p.lng);
    });
  }
  state.markers[kind] = marker;
}

export async function setPickup(lat: number, lon: number, skipReverse?: boolean) {
  state.pickup = { lat, lon, address: skipReverse ? (state.pickup?.address || null) : null };
  placeMarker('pickup', lat, lon);
  renderSheetIdle();
  const addr = await reverseGeocode(lat, lon);
  if (state.pickup) state.pickup.address = addr;
  renderSheetIdle();
}

export async function setDestination(lat: number, lon: number) {
  state.destination = { lat, lon, address: null };
  placeMarker('dest', lat, lon);
  renderSheetIdle();
  const addr = await reverseGeocode(lat, lon);
  if (state.destination) state.destination.address = addr;
  renderSheetIdle();
}

export type { PointSelection };

/* ─── Маршруты (OSRM) ────────────────────────────────────────────────────── */
export async function getAndDrawRoute(lat1: number, lon1: number, lat2: number, lon2: number) {
  try {
    const res = await fetch(state.serverUrl + '/api/routing/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startLat: lat1, startLon: lon1, endLat: lat2, endLon: lon2 }),
    });
    if (!res.ok) throw new Error('Route error');
    const route = await res.json();

    // Рисуем маршрут на карте (жёлтая линия)
    if (state.map && state.map.isStyleLoaded()) {
      if (state.map.getSource('route-line')) {
        state.map.removeLayer('route-line');
        state.map.removeSource('route-line');
      }
      state.map.addSource('route-line', { type: 'geojson', data: route.geometry });
      state.map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route-line',
        paint: { 'line-color': '#FFCC00', 'line-width': 4, 'line-opacity': 0.8 },
      });
    }
    return route;
  } catch (err) {
    console.error('Route error:', err);
    drawDirectLine(lat1, lon1, lat2, lon2);
    return null;
  }
}

export function drawDirectLine(lat1: number, lon1: number, lat2: number, lon2: number) {
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
    paint: { 'line-color': '#FFCC00', 'line-width': 3 },
  });
}
