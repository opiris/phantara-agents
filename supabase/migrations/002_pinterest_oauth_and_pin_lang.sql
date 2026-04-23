-- Tabla para cachear el access_token de Pinterest y evitar refrescarlo en cada ejecucion
CREATE TABLE agents.pinterest_oauth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_pinterest_oauth_singleton ON agents.pinterest_oauth ((TRUE));

ALTER TABLE agents.pinterest_oauth ENABLE ROW LEVEL SECURITY;

ALTER TABLE agents.pinterest_pins ADD COLUMN lang TEXT CHECK (lang IN ('es', 'en', 'pt'));

CREATE INDEX idx_pinterest_pins_card_lang ON agents.pinterest_pins(card_key, lang);
