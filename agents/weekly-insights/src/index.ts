/**
 * weekly-insights
 * Cron lunes 08:00 CET: resume las metricas de la semana pasada y las manda a Telegram.
 *
 * STUB inicial: verifica pipeline end-to-end.
 * Este agente puede arrancar YA aunque las metricas sean pequenas: construir baseline.
 */

import { AGENT_NAMES } from '@phantara/shared';
import { startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';

const AGENT = AGENT_NAMES.WEEKLY_INSIGHTS;

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    // TODO: implementar logica real
    // 1. Query public.readings: count por dia ultima semana
    // 2. Query public.users: nuevos registros ultima semana
    // 3. Query public.subscriptions: conversiones free -> paid
    // 4. Query agents.pinterest_pins: pins publicados
    // 5. Query agents.reddit_drafts: borradores enviados + status
    // 6. Comparar con semana anterior (% cambio)
    // 7. Pedir a Claude (Sonnet) narrativa corta en espanol con insights
    // 8. Guardar en agents.weekly_insights
    // 9. Mandar resumen a Telegram

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
