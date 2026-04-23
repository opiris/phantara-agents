/**
 * @phantara/telegram
 * Wrapper minimo del Bot API de Telegram via fetch (sin dependencias).
 * Todos los mensajes van al mismo chat con prefijo visual del agente.
 */

import { AGENT_PREFIXES, requireEnv, type AgentName } from '@phantara/shared';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export interface SendMessageOptions {
  parseMode?: 'Markdown' | 'HTML';
  disableNotification?: boolean;
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
}

/**
 * Envia un mensaje al chat configurado, con prefijo del agente.
 * Devuelve el message_id para poder editar despues.
 */
export async function sendMessage(
  agent: AgentName,
  text: string,
  options: SendMessageOptions = {},
): Promise<TelegramMessage> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  const prefix = AGENT_PREFIXES[agent];

  const body = {
    chat_id: chatId,
    text: `${prefix}\n\n${text}`,
    parse_mode: options.parseMode ?? 'Markdown',
    disable_notification: options.disableNotification ?? false,
    disable_web_page_preview: options.disableWebPagePreview ?? false,
    reply_to_message_id: options.replyToMessageId,
  };

  const response = await fetch(`${TELEGRAM_API_BASE}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as { ok: boolean; result?: TelegramMessage; description?: string };

  if (!data.ok || !data.result) {
    throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
  }

  return data.result;
}

/**
 * Edita un mensaje previo (util para actualizar estado de borradores).
 */
export async function editMessage(messageId: number, text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');

  const response = await fetch(`${TELEGRAM_API_BASE}${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
    }),
  });

  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram editMessage failed: ${data.description ?? 'unknown error'}`);
  }
}

/**
 * Notifica un error grave de un agente (siempre con notificacion sonora).
 */
export async function notifyError(agent: AgentName, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  try {
    await sendMessage(agent, `❌ *ERROR*\n\n\`\`\`\n${msg}\n\`\`\``, {
      disableNotification: false,
    });
  } catch (e) {
    // Si Telegram falla, al menos lo logueamos para Railway
    console.error(`Failed to notify error to Telegram:`, e);
    console.error(`Original error:`, msg);
  }
}
