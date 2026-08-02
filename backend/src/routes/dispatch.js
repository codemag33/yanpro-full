const express = require('express');
const { EVENTS } = require('../../shared/protocol');
const db = require('../db');
const redis = require('../redis');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

// ─── Активные заказы и заявки ─────────────────────────────────────
router.get('/active', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rides = await db.query(`
      SELECT r.id, r.status, r.price, r.price_offer,
             ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lon,
             r.pickup_address, r.destination_address,
             r.created_at, r.accepted_at, r.started_at,
             u.name AS passenger_name, u.phone AS passenger_phone,
             d.name AS driver_name
      FROM rides r
      LEFT JOIN users u ON u.id = r.passenger_id
      LEFT JOIN users d ON d.id = r.driver_id
      WHERE r.status IN ('searching', 'accepted', 'in_progress')
      ORDER BY r.created_at ASC
    `);
    const assists = await db.query(`
      SELECT ar.id, ar.status,
             ST_Y(ar.pickup::geometry) AS pickup_lat, ST_X(ar.pickup::geometry) AS pickup_lon,
             ar.car_make, ar.phone, ar.breakdown_type, ar.description,
             u.name AS passenger_name, ar.created_at, ar.accepted_at,
             d.name AS mechanic_name
      FROM assistance_requests ar
      LEFT JOIN users u ON u.id = ar.passenger_id
      LEFT JOIN users d ON d.id = ar.mechanic_id
      WHERE ar.status IN ('waiting', 'accepted', 'in_progress')
      ORDER BY ar.created_at ASC
    `);
    res.json({ rides: rides.rows, assists: assists.rows });
  } catch (err) {
    console.error('[dispatch/active]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Онлайн водители и механики ───────────────────────────────────
router.get('/drivers', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const drivers = [];
    for (const role of ['driver', 'mechanic']) {
      const geoKey = `geo:${role}`;
      const all = await redis.zrangebyscore(geoKey, '-inf', '+inf', 'WITHSCORES');
      for (let i = 0; i < all.length; i += 2) {
        const userId = all[i];
        const metaKey = `driver_meta:${role}:${userId}`;
        const meta = await redis.hgetall(metaKey);
        const pos = await redis.geopos(geoKey, userId);
        if (meta.status === 'online' && pos && pos[0]) {
          const [lon, lat] = pos[0];
          drivers.push({
            userId, role, name: meta.name || 'Unknown',
            lon: parseFloat(lon), lat: parseFloat(lat),
            status: meta.status,
          });
        }
      }
    }
    res.json({ drivers });
  } catch (err) {
    console.error('[dispatch/drivers]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Назначение заказа водителю ────────────────────────────────────
router.post('/assign', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rideId, driverId, type } = req.body;
    if (!rideId || !driverId) return res.status(400).json({ error: 'missing_params' });

    if (type === 'ride') {
      const result = await db.query(
        `UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now()
         WHERE id = $1 AND status = 'searching'
         RETURNING id, passenger_id`,
        [rideId, driverId]
      );
      if (!result.rows[0]) return res.status(400).json({ error: 'ride_not_available' });

      const io = req.app.get('io');
      if (io) {
        // Получаем полные данные поездки для восстановления сессии водителя
        const fullRide = await db.query(`
          SELECT r.id, r.status, r.passenger_id, r.driver_id,
                 ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lon,
                 r.pickup_address, ST_Y(r.destination::geometry) AS destination_lat,
                 ST_X(r.destination::geometry) AS destination_lon, r.destination_address,
                 u.name AS passenger_name, u.phone AS passenger_phone
          FROM rides r LEFT JOIN users u ON u.id = r.passenger_id
          WHERE r.id = $1`, [rideId]);
        const rideData = fullRide.rows[0];
        if (rideData) {
          io.to(`user_${driverId}`).emit(EVENTS.SESSION_RESTORE_RIDE, rideData);
        }
        // Уведомляем пассажира
        if (result.rows[0].passenger_id) {
          io.to(`user_${result.rows[0].passenger_id}`).emit(EVENTS.RIDE_ACCEPTED, { rideId, driverId });
        }
        io.to('dispatch').emit(EVENTS.RIDE_ACCEPTED, { rideId });
      }
      res.json({ ok: true });
    } else if (type === 'assist') {
      const result = await db.query(
        `UPDATE assistance_requests SET mechanic_id = $2, status = 'accepted', accepted_at = now()
         WHERE id = $1 AND status = 'waiting'
         RETURNING id, passenger_id`,
        [rideId, driverId]
      );
      if (!result.rows[0]) return res.status(400).json({ error: 'assist_not_available' });

      const io = req.app.get('io');
      if (io) {
        io.to(`user_${driverId}`).emit(EVENTS.SESSION_RESTORE_ASSIST, { id: rideId, status: 'accepted' });
        if (result.rows[0].passenger_id) {
          io.to(`user_${result.rows[0].passenger_id}`).emit(EVENTS.ASSIST_ACCEPTED, { assistId: rideId, mechanicId: driverId });
        }
        io.to('dispatch').emit(EVENTS.ASSIST_ACCEPTED, { assistId: rideId });
      }
      res.json({ ok: true });
    } else {
      return res.status(400).json({ error: 'invalid_type' });
    }
  } catch (err) {
    console.error('[dispatch/assign]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Отмена заказа диспетчером ─────────────────────────────────────
router.post('/cancel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rideId, type } = req.body;
    if (!rideId) return res.status(400).json({ error: 'missing_params' });

    if (type === 'ride') {
      await db.query(
        `UPDATE rides SET status = 'cancelled', finished_at = now(), cancel_reason = 'dispatch_cancel'
         WHERE id = $1 AND status IN ('searching', 'accepted')`,
        [rideId]
      );
    } else {
      await db.query(
        `UPDATE assistance_requests SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND status IN ('waiting', 'accepted')`,
        [rideId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[dispatch/cancel]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Статистика для диспетчерской ──────────────────────────────────
router.get('/stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [rides, assists] = await Promise.all([
      db.query(`SELECT status, COUNT(*) as count FROM rides WHERE status IN ('searching','accepted','in_progress') GROUP BY status`),
      db.query(`SELECT status, COUNT(*) as count FROM assistance_requests WHERE status IN ('waiting','accepted','in_progress') GROUP BY status`),
    ]);
    res.json({ rides: rides.rows, assists: assists.rows });
  } catch (err) {
    console.error('[dispatch/stats]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
