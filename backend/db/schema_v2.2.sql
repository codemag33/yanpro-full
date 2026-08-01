-- Yan.Pro — миграция v2.2
-- 1) Журнал пропущенных заказов (таблица отсутствовала в schema.sql — из-за этого
--    история пропущенных была пустой)
-- 2) Цена за помощь на дороге (механик указывает сумму после завершения работы)

CREATE TABLE IF NOT EXISTS skipped_requests (
    id              bigserial PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_type    text NOT NULL CHECK (request_type IN ('ride', 'assist')),
    request_id      uuid NOT NULL,
    skipped_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skipped_user ON skipped_requests(user_id, skipped_at DESC);

ALTER TABLE assistance_requests ADD COLUMN IF NOT EXISTS price numeric(10,2);
