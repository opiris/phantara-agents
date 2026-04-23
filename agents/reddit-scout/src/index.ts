/**
 * reddit-scout
 * Cron cada 6h: busca posts en r/tarot, r/Divination, r/Astrology donde
 * alguien pregunte algo donde Phantara pueda aportar, genera borrador
 * de respuesta con Claude, y lo manda a Telegram para aprobacion manual.
 *
 * STUB inicial: verifica pipeline end-to-end.
 */

import { AGENT_NAMES } from '@phantara/shared';
import { startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';

const AGENT = AGENT_NAMES.REDDIT_SCOUT;

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    // TODO: implementar logica real
    // 1. Login a Reddit API con client_credentials + password flow
    // 2. Search en subreddits de interes: q="tarot reading" OR "card meaning" etc.
    // 3. Filtrar posts < 24h, sin respuestas aun, con >3 upvotes
    // 4. Para cada post: pedir a Claude (Sonnet) que evalue relevancia 0-1
    //    y genere borrador de respuesta util (NO spam, aporta valor real,
    //    menciona Phantara solo si es relevante)
    // 5. Guardar en agents.reddit_drafts
    // 6. Mandar borrador a Telegram con post_url + draft_response

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
