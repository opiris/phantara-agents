/**
 * @phantara/db
 * Cliente Supabase tipado y helpers comunes.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv, type AgentName } from '@phantara/shared';

// Tipos tolerantes: el generico de SupabaseClient cambio en versiones recientes
// y endurecio el schema. Usamos `any` en los slots de schema para mantener
// compatibilidad entre getDb() (schema 'agents') y getPublicDb() (schema 'public').
type AgentsClient = SupabaseClient<any, any, any>;
type PublicClient = SupabaseClient<any, any, any>;

let _client: AgentsClient | null = null;

/**
 * Cliente Supabase singleton con service_role key.
 * Schema por defecto: 'agents'.
 */
export function getDb(): AgentsClient {
  if (_client) return _client;
  _client = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    db: { schema: 'agents' },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as AgentsClient;
  return _client;
}

/**
 * Cliente Supabase con schema 'public' (para leer datos de Phantara).
 */
export function getPublicDb(): PublicClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as PublicClient;
}

// ============================================================
// Helpers de execution_log
// ============================================================

export interface ExecutionContext {
  executionId: string;
  agentName: AgentName;
  startedAt: Date;
}

/**
 * Marca el inicio de una ejecucion y devuelve el contexto.
 */
export async function startExecution(agentName: AgentName): Promise<ExecutionContext> {
  const startedAt = new Date();
  const { data, error } = await getDb()
    .from('execution_log')
    .insert({
      agent_name: agentName,
      started_at: startedAt.toISOString(),
      status: 'running',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to start execution log: ${error?.message}`);
  }

  return { executionId: data.id as string, agentName, startedAt };
}

/**
 * Marca el fin de una ejecucion exitosa.
 */
export async function finishExecution(
  ctx: ExecutionContext,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - ctx.startedAt.getTime();

  const { error } = await getDb()
    .from('execution_log')
    .update({
      finished_at: finishedAt.toISOString(),
      status: 'success',
      duration_ms: durationMs,
      metadata,
    })
    .eq('id', ctx.executionId);

  if (error) {
    console.error('Failed to update execution log (success):', error.message);
  }
}

/**
 * Marca el fin de una ejecucion fallida.
 */
export async function failExecution(ctx: ExecutionContext, err: unknown): Promise<void> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - ctx.startedAt.getTime();
  const errorMessage = err instanceof Error ? err.message : String(err);

  const { error } = await getDb()
    .from('execution_log')
    .update({
      finished_at: finishedAt.toISOString(),
      status: 'failed',
      duration_ms: durationMs,
      error_message: errorMessage,
    })
    .eq('id', ctx.executionId);

  if (error) {
    console.error('Failed to update execution log (failed):', error.message);
  }
}
