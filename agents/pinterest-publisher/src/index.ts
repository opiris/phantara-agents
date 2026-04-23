/**
 * pinterest-publisher
 * Cron diario 09:00 CET: publica 3 pins en Pinterest.
 *
 * STUB inicial: verifica pipeline end-to-end (DB + Telegram).
 * La logica real se implementa cuando esten las 78 imagenes en Supabase Storage.
 */

import { AGENT_NAMES } from '@phantara/shared';
import { startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';

const AGENT = AGENT_NAMES.PINTEREST_PUBLISHER;

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    // TODO: implementar logica real
    // 1. Seleccionar 3 cartas del mazo que lleven mas tiempo sin pin
    // 2. Para cada una: generar titulo + descripcion SEO con Claude (Haiku)
    // 3. Subir pin via Pinterest API (POST /v5/pins)
    // 4. Guardar en agents.pinterest_pins

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
