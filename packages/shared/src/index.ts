/**
 * @phantara/shared
 * Tipos, constantes y utilidades compartidas entre todos los agentes.
 */

// ============================================================
// Identificadores de agentes
// ============================================================
export const AGENT_NAMES = {
  PINTEREST_PUBLISHER: 'pinterest-publisher',
  REDDIT_SCOUT: 'reddit-scout',
  SEO_REFRESHER: 'seo-refresher',
  WEEKLY_INSIGHTS: 'weekly-insights',
  COMMENT_RESPONDER: 'comment-responder',
  VIRAL_HUNTER: 'viral-hunter',
  FEEDBACK_ANALYST: 'feedback-analyst',
} as const;

export type AgentName = typeof AGENT_NAMES[keyof typeof AGENT_NAMES];

// ============================================================
// Prefijos visuales de Telegram por agente
// ============================================================
export const AGENT_PREFIXES: Record<AgentName, string> = {
  'pinterest-publisher': '📌 [Pinterest]',
  'reddit-scout': '🔴 [Reddit Scout]',
  'seo-refresher': '🔍 [SEO Refresher]',
  'weekly-insights': '📊 [Weekly Insights]',
  'comment-responder': '💬 [Comment Responder]',
  'viral-hunter': '🔥 [Viral Hunter]',
  'feedback-analyst': '⚠️ [Feedback Analyst]',
};

// ============================================================
// Idiomas soportados
// ============================================================
export const SUPPORTED_LANGS = ['es', 'en', 'pt'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];

// ============================================================
// URLs base
// ============================================================
export const PHANTARA_URL = 'https://phantara.app';

// ============================================================
// Utilidades
// ============================================================

/**
 * Lee una variable de entorno requerida o lanza error.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Sleep en ms (para rate limiting).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Construye una URL de Phantara con UTM params.
 */
export function phantaraUrl(path: string, utm: { source: string; medium: string; campaign: string }): string {
  const url = new URL(path, PHANTARA_URL);
  url.searchParams.set('utm_source', utm.source);
  url.searchParams.set('utm_medium', utm.medium);
  url.searchParams.set('utm_campaign', utm.campaign);
  return url.toString();
}

/**
 * Extrae JSON de una respuesta de Claude que puede venir con markdown fences.
 */
export function extractJson<T = unknown>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}
