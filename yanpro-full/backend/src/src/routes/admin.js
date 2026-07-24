const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

// Общая статистика админ-панели
router.get('/stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    // Активные пользователи (подключались за последний час)
    const activeUsers = await db.query(
      `SELECT COUNT(DISTINCT id) as count FROM users WHERE last_activity > now() - interval '1 hour'`
    );

    // Поездки за сегодня
    const ridestoday = await db.query(
      `SELECT 
        COUNT(*) as count,
        COALESCE(SUM(price), 0) as earnings
       FROM rides 
       WHERE status = 'completed' AND DATE(finished_at) = CURRENT_DATE`
    );

    // Водители онлайн
    const driversOnline = await db.query(
      `SELECT COUNT(*) as count FROM driver_profiles WHERE status = 'online'`
    );

    res.json({
      activeUsers: parseInt(activeUsers.rows[0]?.count || 0),
      ridesToday: parseInt(ridestoday.rows[0]?.count || 0),
      earningsToday: parseFloat(ridestoday.rows[0]?.earnings || 0),
      driversOnline: parseInt(driversOnline.rows[0]?.count || 0),
    });
  } catch (err) {
    console.error('[admin/stats]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Последние поездки (для таблицы)
router.get('/recent-rides', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const rides = await db.query(
      `SELECT 
        r.id, r.status, r.price, r.finished_at,
        (SELECT name FROM users WHERE id = r.passenger_id) as passenger_name,
        (SELECT name FROM users WHERE id = r.driver_id) as driver_name
       FROM rides r
       WHERE r.status IN ('completed', 'cancelled')
       ORDER BY r.finished_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ rides: rides.rows });
  } catch (err) {
    console.error('[admin/recent-rides]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Водители онлайн (для таблицы)
router.get('/drivers-online', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const drivers = await db.query(
      `SELECT 
        u.id, u.name,
        dp.status, dp.rating,
        (SELECT COUNT(*) FROM rides WHERE driver_id = u.id AND status = 'completed') as rides_count,
        dp.updated_at as online_since
       FROM users u
       LEFT JOIN driver_profiles dp ON u.id = dp.user_id
       WHERE u.role = 'driver' AND dp.status = 'online'
       ORDER BY dp.updated_at DESC
       LIMIT 20`
    );
    res.json({ drivers: drivers.rows });
  } catch (err) {
    console.error('[admin/drivers-online]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// История поездок (за N дней)
router.get('/rides-history', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const history = await db.query(
      `SELECT 
        DATE(finished_at) as date,
        COUNT(*) as count,
        COALESCE(SUM(price), 0) as earnings
       FROM rides
       WHERE status = 'completed' AND finished_at >= now() - interval '1 day' * $1
       GROUP BY DATE(finished_at)
       ORDER BY date ASC`,
      [days]
    );
    res.json({ history: history.rows });
  } catch (err) {
    console.error('[admin/rides-history]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Статистика по пользователям (сегментация)
router.get('/users-stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const stats = await db.query(
      `SELECT 
        role,
        COUNT(*) as count,
        COUNT(CASE WHEN last_activity > now() - interval '1 day' THEN 1 END) as active_today
       FROM users
       GROUP BY role`
    );
    res.json({ byRole: stats.rows });
  } catch (err) {
    console.error('[admin/users-stats]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
