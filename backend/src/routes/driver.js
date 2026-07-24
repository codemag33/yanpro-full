const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

// Статистика за сегодня — для карточки заработка на главном экране PWA водителя/механика.
router.get('/stats/today', requireAuth, requireRole('driver', 'mechanic'), async (req, res) => {
  try {
    const rides = await db.query(
      `SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS count
       FROM rides
       WHERE driver_id = $1 AND status = 'completed' AND finished_at >= date_trunc('day', now())`,
      [req.user.id]
    );
    const assists = await db.query(
      `SELECT COUNT(*) AS count
       FROM assistance_requests
       WHERE mechanic_id = $1 AND status = 'completed' AND finished_at >= date_trunc('day', now())`,
      [req.user.id]
    );
    res.json({
      earningsToday: parseFloat(rides.rows[0].total),
      ridesToday: parseInt(rides.rows[0].count, 10),
      assistsToday: parseInt(assists.rows[0].count, 10),
    });
  } catch (err) {
    console.error('[driver/stats]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Короткая история последних поездок/заявок — для вкладки "История".
router.get('/history', requireAuth, requireRole('driver', 'mechanic'), async (req, res) => {
  try {
    const rides = await db.query(
      `SELECT id, 'ride' as type, status, price,
              r.pickup_address, r.destination_address,
              r.created_at, r.finished_at, r.cancel_reason,
              u.name as passenger_name, u.phone as passenger_phone
       FROM rides r
       LEFT JOIN users u ON u.id = r.passenger_id
       WHERE r.driver_id = $1 AND r.status IN ('completed', 'cancelled')
       UNION ALL
       SELECT id, 'assistance' as type, status, NULL as price,
              car_make || ' — ' || COALESCE(breakdown_type, '') as pickup_address,
              description as destination_address,
              created_at, finished_at, NULL as cancel_reason,
              NULL as passenger_name, phone as passenger_phone
       FROM assistance_requests
       WHERE mechanic_id = $1 AND status IN ('completed', 'cancelled')
       ORDER BY finished_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ rides: rides.rows });
  } catch (err) {
    console.error('[driver/history]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
