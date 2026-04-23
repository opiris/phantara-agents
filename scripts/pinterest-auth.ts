/**
 * Script de autorizacion inicial de Pinterest (se ejecuta UNA vez).
 *
 * Uso:
 *   1. Registra una app en https://developers.pinterest.com/apps/
 *   2. En la config de la app, anade como redirect URI: http://localhost:8787/callback
 *   3. Exporta las variables:
 *        export PINTEREST_APP_ID=xxx
 *        export PINTEREST_APP_SECRET=xxx
 *   4. Ejecuta: pnpm tsx scripts/pinterest-auth.ts
 *   5. Abre el link que imprime, autoriza la app en tu cuenta Pinterest Business
 *   6. El script te devolvera el refresh_token + lista de todos tus tableros con su ID
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';

const APP_ID = process.env.PINTEREST_APP_ID;
const APP_SECRET = process.env.PINTEREST_APP_SECRET;
const REDIRECT_URI = 'http://localhost:8787/callback';
const SCOPES = 'boards:read,pins:read,pins:write,user_accounts:read';

if (!APP_ID || !APP_SECRET) {
  console.error('Missing PINTEREST_APP_ID or PINTEREST_APP_SECRET env vars.');
  process.exit(1);
}

const authUrl = new URL('https://www.pinterest.com/oauth/');
authUrl.searchParams.set('client_id', APP_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('state', 'phantara-init');

console.log('\n========================================================');
console.log('Abre esta URL en tu navegador y autoriza la app:');
console.log('========================================================\n');
console.log(authUrl.toString());
console.log('\nEsperando el callback en http://localhost:8787/callback ...\n');

interface BoardsResponse {
  items?: Array<{ id: string; name: string; privacy?: string; pin_count?: number }>;
}

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:8787');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}`);
    console.error(`Authorization error: ${error}`);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No code received');
    return;
  }

  const basicAuth = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  try {
    const tokenResponse = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
      error?: string;
      message?: string;
    };

    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.refresh_token) {
      throw new Error(
        `Token exchange failed: ${tokenData.error ?? tokenData.message ?? JSON.stringify(tokenData)}`,
      );
    }

    const boardsResp = await fetch('https://api.pinterest.com/v5/boards?page_size=100', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const boardsData = (await boardsResp.json()) as BoardsResponse & {
      code?: number;
      message?: string;
    };

    console.log('\n========================================================');
    console.log('AUTORIZACION COMPLETADA');
    console.log('========================================================\n');

    if (boardsResp.ok && boardsData.items && boardsData.items.length > 0) {
      console.log('TUS TABLEROS:\n');
      for (const board of boardsData.items) {
        console.log(`  Nombre:    ${board.name}`);
        console.log(`  ID:        ${board.id}`);
        console.log(`  Privacy:   ${board.privacy ?? '-'}`);
        console.log(`  Pins:      ${board.pin_count ?? 0}`);
        console.log('');
      }
    } else if (boardsResp.ok) {
      console.log('NO TIENES TABLEROS CREADOS TODAVIA.');
      console.log('Crea uno en pinterest.com y vuelve a ejecutar el script.\n');
    } else {
      console.log(`Error listando boards: ${boardsData.message ?? JSON.stringify(boardsData)}\n`);
    }

    console.log('========================================================');
    console.log('VARIABLES PARA RAILWAY:');
    console.log('========================================================\n');
    console.log(`PINTEREST_APP_ID=${APP_ID}`);
    console.log(`PINTEREST_APP_SECRET=${APP_SECRET}`);
    console.log(`PINTEREST_REFRESH_TOKEN=${tokenData.refresh_token}`);
    console.log(`PINTEREST_BOARD_ID=<elige el ID del tablero de la lista de arriba>`);
    console.log(`\nAccess token (expira en ${tokenData.expires_in}s, se refresca solo):`);
    console.log(`  ${tokenData.access_token}`);
    console.log(`\nScope: ${tokenData.scope}`);
    console.log(
      `Refresh token caduca en ~${Math.round((tokenData.refresh_token_expires_in ?? 0) / 86400)} dias.\n`,
    );

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>Autorizacion completada</h1><p>Vuelve al terminal para ver el refresh_token y el board_id.</p>',
    );

    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${msg}`);
    console.error(msg);
    process.exit(1);
  }
});

server.listen(8787, () => {
  console.log('Servidor local escuchando en http://localhost:8787');
});
