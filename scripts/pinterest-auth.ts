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
 *   6. El script te devolvera el refresh_token. Copialo a Railway.
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
    const response = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
      error?: string;
      message?: string;
    };

    if (!response.ok || !data.access_token || !data.refresh_token) {
      throw new Error(`Token exchange failed: ${data.error ?? data.message ?? JSON.stringify(data)}`);
    }

    console.log('\n========================================================');
    console.log('AUTORIZACION COMPLETADA');
    console.log('========================================================\n');
    console.log('Copia esto a Railway como variables de entorno:\n');
    console.log(`PINTEREST_APP_ID=${APP_ID}`);
    console.log(`PINTEREST_APP_SECRET=${APP_SECRET}`);
    console.log(`PINTEREST_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(`\nAccess token (expira en ${data.expires_in}s, se refresca solo):`);
    console.log(`  ${data.access_token}`);
    console.log(`\nScope otorgado: ${data.scope}`);
    console.log(`Refresh token caduca en ${data.refresh_token_expires_in} segundos (~${Math.round((data.refresh_token_expires_in ?? 0) / 86400)} dias).\n`);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorizacion completada</h1><p>Vuelve al terminal para ver el refresh_token.</p>');

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
