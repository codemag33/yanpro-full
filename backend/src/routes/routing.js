const express = require('express');
const redis = require('../redis');

const router = express.Router();

// Расчёт маршрута между двумя точками через OSRM (OpenStreetMap Routing Machine)
// Можно использовать публичный OSRM сервис или свой
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

// Таймаут на запрос к OSRM (публичный сервис может висеть)
const OSRM_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS) || 5000;

// TTL кэша маршрутов (городская сеть меняется редко)
const CACHE_TTL_SEC = 7 * 24 * 60 * 60;

// Округление координат до 4 знаков (~11 м) — повышает hit rate кэша
function roundCoord(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

async function fetchRouteFromOSRM(startLon, startLat, endLon, endLat) {
  const url = `${OSRM_URL}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&steps=true&geometries=geojson`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`OSRM error: ${response.status}`);
    const data = await response.json();
    if (!data.routes || data.routes.length === 0) {
      throw new Error('No route found');
    }
    const route = data.routes[0];
    return {
      distance: route.distance,          // в метрах
      duration: route.duration,          // в секундах
      geometry: route.geometry,          // GeoJSON LineString
      steps: route.steps || []           // пошаговые указания
    };
  } finally {
    clearTimeout(timer);
  }
}

router.post('/route', async (req, res) => {
  try {
    const { startLat, startLon, endLat, endLon } = req.body;

    if (!startLat || !startLon || !endLat || !endLon) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    const key = `osrm:route:${roundCoord(startLon)},${roundCoord(startLat)};${roundCoord(endLon)},${roundCoord(endLat)}`;

    // 1) Кэш
    try {
      const cached = await redis.get(key);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      console.error('[routing/cache]', err.message);
    }

    // 2) OSRM (при сбое Redis-кэш просто пропускается)
    const route = await fetchRouteFromOSRM(startLon, startLat, endLon, endLat);

    try {
      await redis.set(key, JSON.stringify(route), 'EX', CACHE_TTL_SEC);
    } catch (err) {
      console.error('[routing/cache-set]', err.message);
    }

    res.json(route);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[routing/route] OSRM timeout', OSRM_TIMEOUT_MS + 'ms');
    } else {
      console.error('[routing/route]', err.message);
    }
    res.status(500).json({ error: 'Routing service error' });
  }
});

module.exports = router;
