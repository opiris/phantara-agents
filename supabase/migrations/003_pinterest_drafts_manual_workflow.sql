-- Nueva tabla para borradores de pins generados por el agente
-- (se publican manualmente desde Pinterest, no via API)
CREATE TABLE agents.pinterest_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_date DATE NOT NULL DEFAULT CURRENT_DATE,
  card_key TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('es', 'en', 'pt')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  image_url TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  published_manually_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pinterest_drafts_date ON agents.pinterest_drafts(draft_date DESC);
CREATE INDEX idx_pinterest_drafts_card_lang ON agents.pinterest_drafts(card_key, lang);

ALTER TABLE agents.pinterest_drafts ENABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS agents.pinterest_oauth;
