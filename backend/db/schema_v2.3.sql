-- v2.3: реальные бонусы — таблица полученных бонусов (UNIQUE не даст забрать дважды)

CREATE TABLE IF NOT EXISTS bonus_claims (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bonus_type text NOT NULL,
  amount numeric(10,2) NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bonus_type)
);

CREATE INDEX IF NOT EXISTS idx_bonus_claims_user ON bonus_claims(user_id);
