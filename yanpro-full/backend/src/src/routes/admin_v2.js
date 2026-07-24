const express = require('express');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const db = require('../db');

const router = express.Router();

// ════════════════════ НАСТРОЙКИ ПЛАТФОРМЫ ════════════════════

// GET /api/admin/settings — получить все настройки
router.get('/settings', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM platform_settings ORDER BY setting_name');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_name] = {
        value: row.setting_type === 'number' ? parseFloat(row.setting_value) : row.setting_value,
        type: row.setting_type
      };
    });
    res.json(settings);
  } catch (err) {
    console.error('[admin/settings GET]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/settings/:name — обновить настройку
router.post('/settings/:name', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name } = req.params;
    const { value } = req.body;
    const { id: adminId } = req.user;

    if (!name || value === undefined) {
      return res.status(400).json({ error: 'Missing name or value' });
    }

    // Логируем изменение
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, 'setting_updated', 'platform_setting', name, JSON.stringify({ old: null, new: value })]
    );

    // Обновляем настройку
    const result = await db.query(
      `UPDATE platform_settings 
       SET setting_value = $1, updated_at = now(), updated_by = $2
       WHERE setting_name = $3
       RETURNING *`,
      [value.toString(), adminId, name]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[admin/settings POST]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════ БЛОКИРОВКА ПОЛЬЗОВАТЕЛЕЙ ════════════════════

// POST /api/admin/block — блокировать пользователя
router.post('/block', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { userId, reason, expiresAt } = req.body;
    const { id: adminId } = req.user;

    if (!userId || !reason) {
      return res.status(400).json({ error: 'Missing userId or reason' });
    }

    // Логируем блокировку
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, 'user_blocked', 'user', userId, JSON.stringify({ reason })]
    );

    const result = await db.query(
      `INSERT INTO user_blocks (user_id, blocked_by, reason, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET reason = $3, expires_at = $4
       RETURNING *`,
      [userId, adminId, reason, expiresAt || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[admin/block]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/unblock/:userId — разблокировать пользователя
router.post('/unblock/:userId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { id: adminId } = req.user;

    // Логируем разблокировку
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, 'user_unblocked', 'user', userId, JSON.stringify({})]
    );

    const result = await db.query(
      'DELETE FROM user_blocks WHERE user_id = $1 RETURNING *',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not blocked' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[admin/unblock]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/blocked-users — список заблокированных
router.get('/blocked-users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ub.*, u.name, u.email, u.role
       FROM user_blocks ub
       JOIN users u ON ub.user_id = u.id
       WHERE ub.expires_at IS NULL OR ub.expires_at > now()
       ORDER BY ub.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[admin/blocked-users]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════ ЛОГИ ДЕЙСТВИЙ ════════════════════

// GET /api/admin/logs — логи действий админов
router.get('/logs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT al.*, u.name as admin_name
       FROM admin_logs al
       JOIN users u ON al.admin_id = u.id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[admin/logs]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════ РЕЙТИНГИ ВОДИТЕЛЕЙ ════════════════════

// GET /api/admin/driver-stats — полная статистика всех водителей
router.get('/driver-stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM driver_full_stats ORDER BY rating DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('[admin/driver-stats]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/drivers-below-rating — водители с низким рейтингом
router.get('/drivers-below-rating', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { minRating = 4.0 } = req.query;

    const result = await db.query(
      `SELECT * FROM driver_full_stats
       WHERE rating < $1
       ORDER BY rating ASC`,
      [parseFloat(minRating)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[admin/drivers-below-rating]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════ ЭКСПОРТ ОТЧЁТОВ ════════════════════

// GET /api/admin/export/rides — экспорт поездок в CSV
router.get('/export/rides', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let query = `
      SELECT 
        r.id, u_pass.name as passenger, u_driver.name as driver,
        r.pickup_address, r.destination_address,
        r.price, r.status, r.created_at, r.finished_at
      FROM rides r
      JOIN users u_pass ON r.passenger_id = u_pass.id
      LEFT JOIN users u_driver ON r.driver_id = u_driver.id
      WHERE 1=1
    `;

    const params = [];

    if (startDate) {
      params.push(startDate);
      query += ` AND r.created_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND r.created_at <= $${params.length}`;
    }

    query += ' ORDER BY r.created_at DESC LIMIT 10000';

    const result = await db.query(query, params);

    // Преобразуем в CSV
    const csv = [
      'ID,Пассажир,Водитель,Откуда,Куда,Цена,Статус,Создано,Завершено',
      ...result.rows.map(r =>
        `"${r.id}","${r.passenger}","${r.driver || ''}","${r.pickup_address}","${r.destination_address}",${r.price},"${r.status}","${r.created_at}","${r.finished_at || ''}"`
      )
    ].join('\n');

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="rides_export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[admin/export/rides]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/export/drivers — экспорт статистики водителей в CSV
router.get('/export/drivers', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM driver_full_stats ORDER BY completed_rides DESC');

    const csv = [
      'ID,Имя,Телефон,Машина,Номер,Статус,Рейтинг,Отзывов,Поездок,Заработок,Последняя поездка',
      ...result.rows.map(r =>
        `"${r.id}","${r.name}","${r.phone}","${r.vehicle_make}","${r.vehicle_plate}","${r.status}",${r.rating},${r.reviews_count},${r.completed_rides},"${r.total_earnings || 0}","${r.last_ride || ''}"`
      )
    ].join('\n');

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="drivers_export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[admin/export/drivers]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
