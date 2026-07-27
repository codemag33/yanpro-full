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
      `SELECT r.id, 'ride' as type, status, price,
              r.pickup_address, r.destination_address,
              r.created_at, r.finished_at, r.cancel_reason,
              u.name as passenger_name, u.phone as passenger_phone
       FROM rides r
       LEFT JOIN users u ON u.id = r.passenger_id
       WHERE r.driver_id = $1 AND r.status IN ('completed', 'cancelled')
       UNION ALL
       SELECT ar.id, 'assistance' as type, status, NULL as price,
              COALESCE(ar.car_make, '') || CASE WHEN ar.breakdown_type IS NOT NULL THEN ' — ' || ar.breakdown_type ELSE '' END as pickup_address,
              COALESCE(ar.description, '') as destination_address,
              ar.created_at, ar.finished_at, NULL as cancel_reason,
              NULL as passenger_name, ar.phone as passenger_phone
       FROM assistance_requests ar
       WHERE ar.mechanic_id = $1 AND ar.status IN ('completed', 'cancelled')
       ORDER BY finished_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ rides: rides.rows });
  } catch (err) {
    console.error('[driver/history]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Журнал пропущенных заказов/заявок — с телефонами, неисправностями, статусом.
router.get('/skipped', requireAuth, requireRole('driver', 'mechanic'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sr.id as skip_id, sr.request_type, sr.request_id, sr.skipped_at,
              CASE
                WHEN sr.request_type = 'ride' THEN r.status
                ELSE ar.status
              END as status,
              CASE
                WHEN sr.request_type = 'ride' THEN r.pickup_address
                ELSE COALESCE(ar.car_make, '') || CASE WHEN ar.breakdown_type IS NOT NULL THEN ' — ' || ar.breakdown_type ELSE '' END
              END as pickup_address,
              CASE
                WHEN sr.request_type = 'ride' THEN r.destination_address
                ELSE COALESCE(ar.description, '')
              END as destination_address,
              CASE
                WHEN sr.request_type = 'ride' THEN u.name
                ELSE COALESCE(ar.passenger_name, 'Пассажир')
              END as passenger_name,
              CASE
                WHEN sr.request_type = 'ride' THEN u.phone
                ELSE ar.phone
              END as passenger_phone,
              CASE
                WHEN sr.request_type = 'ride' THEN r.created_at
                ELSE ar.created_at
              END as request_created_at
       FROM skipped_requests sr
       LEFT JOIN rides r ON sr.request_type = 'ride' AND sr.request_id = r.id
       LEFT JOIN assistance_requests ar ON sr.request_type = 'assist' AND sr.request_id = ar.id
       LEFT JOIN users u ON sr.request_type = 'ride' AND r.passenger_id = u.id
       WHERE sr.user_id = $1
       ORDER BY sr.skipped_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ skips: result.rows });
  } catch (err) {
    console.error('[driver/skipped]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
