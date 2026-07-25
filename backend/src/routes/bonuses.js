const express = require('express');
const { requireAuth } = require('../middleware/authMiddleware');
const db = require('../db');

const router = express.Router();

// POST /api/bonuses/claim — получить бонус
router.post('/claim', requireAuth, async (req, res) => {
  try {
    const { bonusType } = req.body;
    const { id: userId } = req.user;

    const bonuses = {
      'first_ride': 100,
      'rating_5': 50,
      'weekly_rides_5': 150,
      'complete_profile': 75
    };

    const amount = bonuses[bonusType];
    if (!amount) return res.status(400).json({ error: 'Unknown bonus' });

    res.json({ success: true, amount, message: `+₽${amount} добавлено в кошелёк` });
  } catch (err) {
    console.error('[bonuses POST]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bonuses/my — доступные бонусы
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const available = [
      {
        type: 'first_ride',
        name: '🎉 Первая поездка',
        description: 'Получи 100₽',
        amount: 100
      },
      {
        type: 'rating_5',
        name: '⭐ Отличная оценка',
        description: 'За 5 звёзд — 50₽',
        amount: 50
      },
      {
        type: 'weekly_rides_5',
        name: '🔥 5 поездок в неделю',
        description: '150₽ за активность',
        amount: 150
      },
      {
        type: 'complete_profile',
        name: '👤 Полный профиль',
        description: '75₽ за заполненный профиль',
        amount: 75
      }
    ];

    res.json({ available, totalEarned: 0 });
  } catch (err) {
    console.error('[bonuses GET]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
