/**
 * @phantara/claude
 * Wrapper del SDK de Anthropic con defaults sensatos y helpers.
 */

import Anthropic from '@anthropic-ai/sdk';
import { requireEnv, extractJson } from '@phantara/shared';

let _client: Anthropic | null = null;

export function getClaude(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return _client;
}

// ============================================================
// Modelos disponibles
// ============================================================
export const MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-7',
} as const;

export type Model = typeof MODELS[keyof typeof MODELS];

// ============================================================
// Helper: completion de texto simple
// ============================================================
export interface CompleteOptions {
  model?: Model;
  maxTokens?: number;
  system?: string;
  temperature?: number;
}

export async function complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
  const response = await getClaude().messages.create({
    model: options.model ?? MODELS.HAIKU,
    max_tokens: options.maxTokens ?? 2000,
    system: options.system,
    temperature: options.temperature ?? 1.0,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text block in Claude response');
  }
  return textBlock.text;
}

// ============================================================
// Helper: completion que devuelve JSON tipado
// ============================================================
export async function completeJson<T = unknown>(prompt: string, options: CompleteOptions = {}): Promise<T> {
  const text = await complete(prompt, options);
  return extractJson<T>(text);
}
