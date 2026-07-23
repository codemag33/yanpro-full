const express = require('express');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const db = require('../db');

const router = express.Router();

// POST /api/reviews — оставить отзыв после поездки
router.post('/', requireAuth, async (req, res) => {
  try {
    const { rideId, recipientId, rating, comment } = req.body;
    const { id: reviewerId } = req.user;

    if (!rideId || !recipientId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // Проверим что поездка существует и завершена
    const ride = await db.query('SELECT * FROM rides WHERE id = $1 AND status = $2', [rideId, 'completed']);
    if (!ride.rows[0]) return res.status(404).json({ error: 'Ride not found or not completed' });

    // Получим роль получателя
    const recipient = await db.query('SELECT role FROM users WHERE id = $1', [recipientId]);
    if (!recipient.rows[0]) return res.status(404).json({ error: 'Recipient not found' });

    const recipientRole = recipient.rows[0].role;

    // Вставляем отзыв
    const result = await db.query(
      `INSERT INTO reviews (ride_id, reviewer_id, recipient_id, recipient_role, rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [rideId, reviewerId, recipientId, recipientRole, rating, comment || null]
    );

    // Обновляем кэш рейтинга у водителя
    if (recipientRole === 'driver') {
      await db.query(
        `UPDATE driver_profiles 
         SET rating_cache = (SELECT AVG(rating) FROM reviews WHERE recipient_id = $1),
             reviews_count = (SELECT COUNT(*) FROM reviews WHERE recipient_id = $1)
         WHERE user_id = $1`,
        [recipientId]
      );
    }

    // Логируем действие если админ
    if (req.user.role === 'admin') {
      await db.query(
        `INSERT INTO admin_logs (admin_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, $5)`,
        [reviewerId, 'review_created', 'review', result.rows[0].id, JSON.stringify({ rating, recipientId })]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[reviews POST]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/reviews/driver/:driverId — получить все отзывы водителя
router.get('/driver/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;

    const result = await db.query(
      `SELECT r.*, u.name as reviewer_name
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.recipient_id = $1 AND r.recipient_role = 'driver'
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [driverId]
    );

    // Получим агрегированный рейтинг
    const stats = await db.query(
      `SELECT 
         ROUND(AVG(rating)::numeric, 2) as avg_rating,
         COUNT(*) as total_reviews,
         SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_stars,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_stars
       FROM reviews
       WHERE recipient_id = $1 AND recipient_role = 'driver'`,
      [driverId]
    );

    res.json({
      reviews: result.rows,
      stats: stats.rows[0] || { avg_rating: 0, total_reviews: 0, five_stars: 0, one_stars: 0 }
    });
  } catch (err) {
    console.error('[reviews GET driver]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/reviews/my — мои отзывы (как водитель)
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { id } = req.user;

    const result = await db.query(
      `SELECT * FROM reviews WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[reviews GET my]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
