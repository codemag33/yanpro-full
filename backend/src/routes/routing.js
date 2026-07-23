const express = require('express');

const router = express.Router();

// Расчёт маршрута между двумя точками через OSRM (OpenStreetMap Routing Machine)
// Можно использовать публичный OSRM сервис или свой
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

router.post('/route', async (req, res) => {
  try {
    const { startLat, startLon, endLat, endLon } = req.body;

    if (!startLat || !startLon || !endLat || !endLon) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    // OSRM API: /route/v1/driving/lon,lat;lon,lat
    const url = `${OSRM_URL}/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&steps=true&geometries=geojson`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`OSRM error: ${response.status}`);

    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found' });
    }

    const route = data.routes[0];

    res.json({
      distance: route.distance,          // в метрах
      duration: route.duration,          // в секундах
      geometry: route.geometry,          // GeoJSON LineString
      steps: route.steps || []           // пошаговые указания
    });
  } catch (err) {
    console.error('[routing/route]', err);
    res.status(500).json({ error: 'Routing service error' });
  }
});

module.exports = router;
