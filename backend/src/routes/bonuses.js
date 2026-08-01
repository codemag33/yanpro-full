const express = require('express');
const { requireAuth } = require('../middleware/authMiddleware');
const db = require('../db');

const router = express.Router();

const BONUSES = {
  first_ride: { name: 'Первая поездка', description: 'Выполни первую поездку/заявку', amount: 100 },
  rating_5: { name: 'Оценка 5 звёзд', description: 'Средняя оценка 5 после первого отзыва', amount: 50 },
  weekly_rides_5: { name: '5 заказов за неделю', description: 'Выполни 5 заказов за 7 дней', amount: 150 },
  complete_profile: { name: 'Заполненный профиль', description: 'Укажи марку и номер машины', amount: 75 },
};

// Проверка, выполнены ли условия бонуса. Верифицируем по факту, а не "на слово".
async function checkEligibility(userId, bonusType) {
  switch (bonusType) {
    case 'first_ride': {
      const r = await db.query(
        `SELECT (SELECT COUNT(*) FROM rides WHERE driver_id = $1 AND status = 'completed')
              + (SELECT COUNT(*) FROM assistance_requests WHERE mechanic_id = $1 AND status = 'completed') AS cnt`,
        [userId]
      );
      return parseInt(r.rows[0].cnt, 10) >= 1;
    }
    case 'rating_5': {
      const r = await db.query(
        `SELECT rating_cache, reviews_count FROM driver_profiles WHERE user_id = $1`,
        [userId]
      );
      const p = r.rows[0];
      return p && p.reviews_count >= 1 && parseFloat(p.rating_cache) >= 4.99;
    }
    case 'weekly_rides_5': {
      const r = await db.query(
        `SELECT (SELECT COUNT(*) FROM rides WHERE driver_id = $1 AND status = 'completed' AND finished_at >= now() - interval '7 days')
              + (SELECT COUNT(*) FROM assistance_requests WHERE mechanic_id = $1 AND status = 'completed' AND finished_at >= now() - interval '7 days') AS cnt`,
        [userId]
      );
      return parseInt(r.rows[0].cnt, 10) >= 5;
    }
    case 'complete_profile': {
      const r = await db.query(
        `SELECT vehicle_make, vehicle_plate FROM driver_profiles WHERE user_id = $1`,
        [userId]
      );
      const p = r.rows[0];
      return !!(p && p.vehicle_make && p.vehicle_plate);
    }
    default:
      return false;
  }
}

// POST /api/bonuses/claim — получить бонус (сервер проверяет условия + UNIQUE-констрейнт)
router.post('/claim', requireAuth, async (req, res) => {
  try {
    const { bonusType } = req.body;
    const { id: userId } = req.user;

    const bonus = BONUSES[bonusType];
    if (!bonus) return res.status(400).json({ error: 'Unknown bonus' });

    if (!(await checkEligibility(userId, bonusType))) {
      return res.status(400).json({ error: 'not_eligible' });
    }

    try {
      await db.query(
        `INSERT INTO bonus_claims (user_id, bonus_type, amount) VALUES ($1, $2, $3)`,
        [userId, bonusType, bonus.amount]
      );
    } catch (err) {
      // UNIQUE (user_id, bonus_type) — уже забирали
      if (err.code === '23505') {
        return res.status(409).json({ error: 'already_claimed' });
      }
      throw err;
    }

    res.json({ success: true, amount: bonus.amount, message: `+₽${bonus.amount} добавлено в кошелёк` });
  } catch (err) {
    console.error('[bonuses POST]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bonuses/my — доступные бонусы с реальным статусом (доступен/забран/не выполнено)
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const [claims, rides] = await Promise.all([
      db.query(`SELECT bonus_type, amount, claimed_at FROM bonus_claims WHERE user_id = $1`, [userId]),
      db.query(
        `SELECT COUNT(*) AS rides_cnt FROM rides WHERE driver_id = $1 AND status = 'completed'`,
        [userId]
      ),
    ]);

    const claimed = new Set(claims.rows.map((c) => c.bonus_type));
    const totalEarned = claims.rows.reduce((s, c) => s + parseFloat(c.amount), 0);

    const available = [];
    for (const [type, info] of Object.entries(BONUSES)) {
      const eligible = await checkEligibility(userId, type);
      available.push({
        type,
        name: info.name,
        description: info.description,
        amount: info.amount,
        claimed: claimed.has(type),
        eligible,
      });
    }

    res.json({ available, totalEarned, totalRides: parseInt(rides.rows[0].rides_cnt, 10) });
  } catch (err) {
    console.error('[bonuses GET]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
