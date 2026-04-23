/**
 * @phantara/pinterest
 * Cliente minimo de Pinterest API v5 con manejo automatico del access_token.
 *
 * El refresh_token se pasa via env var (PINTEREST_REFRESH_TOKEN).
 * El access_token se cachea en agents.pinterest_oauth y se refresca
 * automaticamente cuando faltan <5min para expirar.
 */

import { requireEnv } from '@phantara/shared';
import { getDb } from '@phantara/db';

const PINTEREST_API = 'https://api.pinterest.com/v5';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refrescar si faltan <5min

// ============================================================
// Tipos
// ============================================================
export interface CreatePinInput {
  boardId: string;
  title: string;
  description: string;
  link: string;
  imageUrl: string;
  altText?: string;
}

export interface CreatePinResult {
  pinId: string;
  url: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  scope?: string;
  token_type?: string;
}

interface CachedToken {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// ============================================================
// Gestion de tokens
// ============================================================

/**
 * Obtiene un access_token valido. Lo refresca si hace falta.
 */
export async function getAccessToken(): Promise<string> {
  const db = getDb();

  const { data: cached } = await db
    .from('pinterest_oauth')
    .select('access_token, refresh_token, expires_at')
    .limit(1)
    .maybeSingle<CachedToken>();

  const now = Date.now();

  if (cached) {
    const expiresAt = new Date(cached.expires_at).getTime();
    if (expiresAt - now > REFRESH_MARGIN_MS) {
      return cached.access_token;
    }
    return refreshAndStore(cached.refresh_token);
  }

  // Primera ejecucion: usamos el refresh_token de env var
  const initialRefresh = requireEnv('PINTEREST_REFRESH_TOKEN');
  return refreshAndStore(initialRefresh);
}

/**
 * Intercambia un refresh_token por un nuevo access_token y lo guarda en DB.
 */
async function refreshAndStore(refreshToken: string): Promise<string> {
  const appId = requireEnv('PINTEREST_APP_ID');
  const appSecret = requireEnv('PINTEREST_APP_SECRET');

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read',
  });

  const response = await fetch(`${PINTEREST_API}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = (await response.json()) as TokenResponse & { error?: string; message?: string };

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Pinterest token refresh failed (${response.status}): ${data.error ?? data.message ?? JSON.stringify(data)}`,
    );
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  const newRefreshToken = data.refresh_token ?? refreshToken;

  const db = getDb();
  await db.from('pinterest_oauth').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { error: insertErr } = await db.from('pinterest_oauth').insert({
    access_token: data.access_token,
    refresh_token: newRefreshToken,
    expires_at: expiresAt.toISOString(),
  });

  if (insertErr) {
    throw new Error(`Failed to cache Pinterest token: ${insertErr.message}`);
  }

  return data.access_token;
}

// ============================================================
// Pin creation
// ============================================================

interface PinApiResponse {
  id: string;
  url?: string;
}

/**
 * Publica un pin en Pinterest usando una URL de imagen publica.
 */
export async function createPin(input: CreatePinInput): Promise<CreatePinResult> {
  const token = await getAccessToken();

  const body = {
    board_id: input.boardId,
    title: input.title.slice(0, 100),
    description: input.description.slice(0, 500),
    link: input.link,
    alt_text: (input.altText ?? input.title).slice(0, 500),
    media_source: {
      source_type: 'image_url',
      url: input.imageUrl,
    },
  };

  const response = await fetch(`${PINTEREST_API}/pins`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as PinApiResponse & { code?: number; message?: string };

  if (!response.ok || !data.id) {
    throw new Error(
      `Pinterest createPin failed (${response.status}): ${data.message ?? JSON.stringify(data)}`,
    );
  }

  return {
    pinId: data.id,
    url: data.url ?? `https://www.pinterest.com/pin/${data.id}/`,
  };
}
