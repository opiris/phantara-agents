-- Migration: 001_agents_schema.sql
-- Crea el schema aislado 'agents' con las tablas de estado para los 7 agentes.

CREATE SCHEMA IF NOT EXISTS agents;

-- ============================================================
-- Tabla: execution_log
-- Registra cada ejecucion de cada agente para debug y metricas.
-- ============================================================
CREATE TABLE agents.execution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  duration_ms INTEGER,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_execution_log_agent_started ON agents.execution_log(agent_name, started_at DESC);

-- ============================================================
-- Tabla: pinterest_pins
-- Historico de pins publicados para evitar duplicados.
-- ============================================================
CREATE TABLE agents.pinterest_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id TEXT UNIQUE NOT NULL,       -- ID devuelto por Pinterest API
  card_key TEXT,                      -- si el pin va de una carta concreta
  title TEXT NOT NULL,
  description TEXT,
  link TEXT NOT NULL,
  image_url TEXT NOT NULL,
  board_id TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  utm_campaign TEXT
);

CREATE INDEX idx_pinterest_pins_published ON agents.pinterest_pins(published_at DESC);

-- ============================================================
-- Tabla: reddit_drafts
-- Borradores de respuestas generados por reddit-scout, pendientes de aprobacion manual.
-- ============================================================
CREATE TABLE agents.reddit_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_post_id TEXT UNIQUE NOT NULL,
  subreddit TEXT NOT NULL,
  post_title TEXT NOT NULL,
  post_url TEXT NOT NULL,
  post_body TEXT,
  draft_response TEXT NOT NULL,
  relevance_score NUMERIC(3,2),      -- 0.00 a 1.00
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'ignored', 'posted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  telegram_message_id BIGINT         -- para poder editar despues
);

CREATE INDEX idx_reddit_drafts_status ON agents.reddit_drafts(status, created_at DESC);

-- ============================================================
-- Tabla: seo_refresh_log
-- Historico de refrescos del seo-refresher.
-- ============================================================
CREATE TABLE agents.seo_refresh_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_key TEXT NOT NULL,
  lang TEXT NOT NULL,
  reason TEXT NOT NULL,              -- 'ranking_drop', 'outdated', 'manual'
  old_title TEXT,
  new_title TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_seo_refresh_card ON agents.seo_refresh_log(card_key, lang, refreshed_at DESC);

-- ============================================================
-- Tabla: weekly_insights
-- Snapshots semanales del weekly-insights para tracking historico.
-- ============================================================
CREATE TABLE agents.weekly_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE UNIQUE NOT NULL,
  metrics JSONB NOT NULL,            -- readings, users, conversions, share_unlocks...
  narrative TEXT,                     -- resumen narrativo generado por Claude
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Tabla: comment_response_drafts
-- Borradores de respuestas a comentarios TikTok/IG.
-- ============================================================
CREATE TABLE agents.comment_response_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
  post_id TEXT NOT NULL,
  comment_id TEXT UNIQUE NOT NULL,
  comment_text TEXT NOT NULL,
  comment_author TEXT,
  draft_response TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'ignored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  telegram_message_id BIGINT
);

CREATE INDEX idx_comment_drafts_status ON agents.comment_response_drafts(status, created_at DESC);

-- ============================================================
-- Tabla: viral_trends
-- Trends detectados por viral-hunter para inspirar contenido propio.
-- ============================================================
CREATE TABLE agents.viral_trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_hash TEXT UNIQUE NOT NULL,   -- hash del hashtag/sonido/concepto
  platform TEXT NOT NULL,
  trend_type TEXT NOT NULL,          -- 'hashtag', 'sound', 'format'
  trend_value TEXT NOT NULL,
  relevance_score NUMERIC(3,2),
  sample_urls TEXT[],
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acted_on BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_viral_trends_detected ON agents.viral_trends(detected_at DESC);

-- ============================================================
-- Tabla: feedback_clusters
-- Agrupaciones tematicas del feedback analizadas semanalmente.
-- ============================================================
CREATE TABLE agents.feedback_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  cluster_theme TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  feedback_count INTEGER NOT NULL,
  sample_feedbacks TEXT[],
  suggested_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feedback_clusters_week ON agents.feedback_clusters(week_start DESC);

-- ============================================================
-- Row Level Security
-- Solo la service_role key puede acceder (los agentes la usan).
-- ============================================================
ALTER TABLE agents.execution_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.pinterest_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.reddit_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.seo_refresh_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.weekly_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.comment_response_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.viral_trends ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.feedback_clusters ENABLE ROW LEVEL SECURITY;
