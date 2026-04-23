/**
 * feedback-analyst
 * Cron semanal (lunes 06:00 UTC): agrupa tematicamente el feedback
 * de usuarios de Phantara y detecta spikes negativos.
 *
 * STUB inicial: verifica pipeline end-to-end.
 * Logica real se activa cuando haya >100 usuarios activos.
 */

import { AGENT_NAMES } from '@phantara/shared';
import { startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';

const AGENT = AGENT_NAMES.FEEDBACK_ANALYST;

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    // TODO: implementar logica real
    // 1. Query public.feedback / public.reviews / rows con rating bajo
    //    de la ultima semana
    // 2. Pedir a Claude (Sonnet) clustering tematico:
    //    agrupa los feedbacks en 3-5 temas con sentiment y action sugerida
    // 3. Comparar volumen de feedback negativo vs semana anterior
    // 4. Insert en agents.feedback_clusters
    // 5. Si hay spike negativo (>30% mas feedback negativo que semana pasada),
    //    notificar a Telegram con los clusters principales

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
