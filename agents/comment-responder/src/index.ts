/**
 * comment-responder
 * Cron cada 4h: revisa comentarios nuevos en TikTok/Instagram de Phantara,
 * genera borradores de respuesta con Claude (tono de la marca) y los manda
 * a Telegram para aprobacion manual.
 *
 * STUB inicial: verifica pipeline end-to-end.
 * Logica real se activa cuando TikTok/IG tengan >1k seguidores.
 */

import { AGENT_NAMES } from '@phantara/shared';
import { startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';

const AGENT = AGENT_NAMES.COMMENT_RESPONDER;

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    // TODO: implementar logica real
    // 1. Pull comentarios de TikTok Display API y Instagram Graph API
    //    de las ultimas 4h, filtrar los que aun no estan en agents.comment_response_drafts
    // 2. Filtrar: ignorar spam, emojis solos, comentarios triviales
    // 3. Para cada comentario relevante: pedir a Claude (Haiku) que
    //    genere una respuesta corta en el tono tech-mistico de la marca
    // 4. Insert en agents.comment_response_drafts con status 'pending'
    // 5. Mandar borrador a Telegram con link al comentario

    await sendMessage(AGENT, `✅ Stub ejecutado correctamente.\nAgente: \`${AGENT}\``, {
      disableNotification: true,
    });

    await finishExecution(ctx, { stub: true });
    console.log(`[${AGENT}] OK`);
  } catch (err) {
    await failExecution(ctx, err);
    await notifyError(AGENT, err);
    console.error(`[${AGENT}] FAILED:`, err);
    process.exit(1);
  }
}

main();
