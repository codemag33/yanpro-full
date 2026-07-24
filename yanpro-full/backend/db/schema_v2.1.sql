-- ════════════════════════════════════════════════════════════════════════════
-- Yan.Pro v2.1 — Добавляем рейтинг и отзывы
-- ════════════════════════════════════════════════════════════════════════════

-- Таблица отзывов (рейтинг)
CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES rides(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id),
  recipient_id uuid REFERENCES users(id),
  recipient_role text CHECK (recipient_role IN ('driver', 'mechanic', 'passenger')),
  rating int CHECK (rating >= 1 AND rating <= 5),
  comment text,
  created_at timestamptz DEFAULT now()
);

-- Индексы для быстрого поиска
CREATE INDEX idx_reviews_recipient ON reviews(recipient_id, recipient_role);
CREATE INDEX idx_reviews_ride ON reviews(ride_id);

-- Представление: средний рейтинг водителя
CREATE OR REPLACE VIEW driver_ratings AS
SELECT
  u.id,
  u.name,
  COUNT(r.id) as total_reviews,
  ROUND(AVG(r.rating)::numeric, 2) as average_rating,
  SUM(CASE WHEN r.rating = 5 THEN 1 ELSE 0 END) as five_star_count
FROM users u
LEFT JOIN reviews r ON r.recipient_id = u.id AND r.recipient_role = 'driver'
WHERE u.role = 'driver'
GROUP BY u.id, u.name;

-- Таблица параметров платформы (цены, комиссии)
CREATE TABLE IF NOT EXISTS platform_settings (
  id serial PRIMARY KEY,
  setting_name text UNIQUE,
  setting_value text,
  setting_type text CHECK (setting_type IN ('number', 'percent', 'text', 'boolean')),
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

-- Вставляем стандартные настройки
INSERT INTO platform_settings (setting_name, setting_value, setting_type)
VALUES
  ('base_fare', '50', 'number'),           -- базовая тариф в рублях
  ('per_km_rate', '20', 'number'),         -- рубли за км
  ('per_minute_rate', '1.5', 'number'),    -- рубли за минуту
  ('platform_commission', '15', 'percent'), -- комиссия платформы
  ('assistance_base', '500', 'number'),     -- база для механика
  ('min_rating_to_drive', '4.0', 'number') -- минимальный рейтинг для работы
ON CONFLICT (setting_name) DO NOTHING;

-- Таблица блокировок пользователей
CREATE TABLE IF NOT EXISTS user_blocks (
  id serial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  blocked_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  UNIQUE(user_id)
);

-- Индекс для проверки блокировок
CREATE INDEX idx_user_blocks_active ON user_blocks(user_id) WHERE expires_at IS NULL OR expires_at > now();

-- Таблица логов действий администратора
CREATE TABLE IF NOT EXISTS admin_logs (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES users(id),
  action text,
  target_type text,
  target_id uuid,
  changes jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_admin_logs_created ON admin_logs(created_at DESC);
CREATE INDEX idx_admin_logs_admin ON admin_logs(admin_id);

-- Обновляем таблицу driver_profiles с полем рейтинга
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS rating_cache float DEFAULT 0;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS reviews_count int DEFAULT 0;

-- Представление: полная статистика водителя
CREATE OR REPLACE VIEW driver_full_stats AS
SELECT
  u.id,
  u.name,
  u.phone,
  dp.vehicle_make,
  dp.vehicle_plate,
  dp.status,
  ROUND(AVG(r.rating)::numeric, 2) as rating,
  COUNT(DISTINCT r.id) as reviews_count,
  COUNT(DISTINCT ride.id) as completed_rides,
  ROUND(SUM(ride.price)::numeric, 2) as total_earnings,
  MAX(ride.finished_at) as last_ride
FROM users u
LEFT JOIN driver_profiles dp ON u.id = dp.user_id
LEFT JOIN reviews r ON r.recipient_id = u.id AND r.recipient_role = 'driver'
LEFT JOIN rides ride ON ride.driver_id = u.id AND ride.status = 'completed'
WHERE u.role = 'driver'
GROUP BY u.id, u.name, u.phone, dp.vehicle_make, dp.vehicle_plate, dp.status;

