/**
 * weekly-insights
 * Cada lunes 07:00 UTC: genera reporte completo de la semana pasada,
 * guarda en agents.weekly_insights, sube dashboard HTML a Storage y
 * manda resumen a Telegram.
 */

import { startOfWeek, endOfWeek, subWeeks, format } from 'date-fns';
import { AGENT_NAMES } from '@phantara/shared';
import { getDb, getPublicDb, startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';
import { complete, MODELS } from '@phantara/claude';
import { requireEnv } from '@phantara/shared';

const AGENT = AGENT_NAMES.WEEKLY_INSIGHTS;

// ============================================================
// Tipos
// ============================================================

interface ReadingCard {
  card_key: string;
  reversed?: boolean;
  position?: string;
}

interface ReadingRow {
  id: string;
  user_id: string;
  type: string;
  cards: ReadingCard[];
  created_at: string;
}

interface WeekMetrics {
  period: {
    week_start: string;
    week_end: string;
  };
  growth: {
    new_users: number;
    total_users: number;
    new_users_vs_prev_week_pct: number | null;
  };
  engagement: {
    readings_this_week: number;
    readings_prev_week: number;
    readings_change_pct: number | null;
    readings_per_active_user: number;
    active_users: number;
    retention_d7: number;
  };
  product: {
    readings_by_type: {
      daily_card: number;
      three_card: number;
      celtic_cross: number;
      love_spread: number;
      decision_spread: number;
      annual_spread: number;
    };
    top_cards: Array<{ card_key: string; count: number }>;
    resonance_avg: number;
    journal_entries_count: number;
  };
  conversion: {
    free_to_pro_conversions: number;
    total_pro_users: number;
    conversion_rate_pct: number;
    share_unlock_used_count: number;
    share_events_count: number;
    payments_completed: number;
    revenue_eur: number;
  };
}

// ============================================================
// Helpers de rango de semana
// ============================================================

function getWeekRange(referenceDate: Date): { weekStart: Date; weekEnd: Date } {
  // date-fns: weekStartsOn: 1 = lunes
  const weekStart = startOfWeek(subWeeks(referenceDate, 1), { weekStartsOn: 1 });
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekEnd = endOfWeek(subWeeks(referenceDate, 1), { weekStartsOn: 1 });
  weekEnd.setUTCHours(23, 59, 59, 999);

  return { weekStart, weekEnd };
}

function getPrevWeekRange(weekStart: Date): { prevStart: Date; prevEnd: Date } {
  const prevStart = subWeeks(weekStart, 1);
  prevStart.setUTCHours(0, 0, 0, 0);

  const prevEnd = new Date(weekStart.getTime() - 1);
  prevEnd.setUTCHours(23, 59, 59, 999);

  return { prevStart, prevEnd };
}

function pct(current: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((current - prev) / prev) * 1000) / 10;
}

function fmtPct(val: number | null): string {
  if (val === null) return '—';
  return `${val > 0 ? '+' : ''}${val}%`;
}

// ============================================================
// Calcular métricas
// ============================================================

async function calcMetrics(weekStart: Date, weekEnd: Date): Promise<WeekMetrics> {
  const db = getPublicDb();
  const ws = weekStart.toISOString();
  const we = weekEnd.toISOString();

  const { prevStart, prevEnd } = getPrevWeekRange(weekStart);
  const ps = prevStart.toISOString();
  const pe = prevEnd.toISOString();

  // --- Growth ---
  const [{ count: newUsers }, { count: newUsersPrev }, { count: totalUsers }] = await Promise.all([
    db.from('users').select('*', { count: 'exact', head: true }).gte('created_at', ws).lte('created_at', we).throwOnError().then(r => r),
    db.from('users').select('*', { count: 'exact', head: true }).gte('created_at', ps).lte('created_at', pe).throwOnError().then(r => r),
    db.from('users').select('*', { count: 'exact', head: true }).lte('created_at', we).throwOnError().then(r => r),
  ]);

  // --- Readings esta semana y semana anterior ---
  const { data: readingsThisWeek, error: readingsErr } = await db
    .from('readings')
    .select('id, user_id, type, cards, created_at')
    .gte('created_at', ws)
    .lte('created_at', we);
  if (readingsErr) throw new Error(`readings query failed: ${readingsErr.message}`);

  const { count: readingsPrevCount } = await db
    .from('readings')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', ps)
    .lte('created_at', pe)
    .throwOnError();

  const readings = (readingsThisWeek ?? []) as ReadingRow[];
  const readingsThisWeekCount = readings.length;
  const activeUserIds = new Set(readings.map(r => r.user_id));
  const activeUsers = activeUserIds.size;
  const readingsPerActiveUser = activeUsers > 0
    ? Math.round((readingsThisWeekCount / activeUsers) * 100) / 100
    : 0;

  // --- Retention D7 ---
  // Usuarios registrados entre 7 y 13 días antes de week_start
  const d7Start = new Date(weekStart.getTime() - 13 * 24 * 60 * 60 * 1000);
  const d7End = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: cohortUsers } = await db
    .from('users')
    .select('id')
    .gte('created_at', d7Start.toISOString())
    .lte('created_at', d7End.toISOString())
    .throwOnError();

  const cohortIds = new Set((cohortUsers ?? []).map((u: { id: string }) => u.id));
  const cohortRetained = [...activeUserIds].filter(id => cohortIds.has(id)).length;
  const retentionD7 = cohortIds.size > 0
    ? Math.round((cohortRetained / cohortIds.size) * 1000) / 10
    : 0;

  // --- Product: readings por tipo ---
  const byType = {
    daily_card: 0, three_card: 0, celtic_cross: 0,
    love_spread: 0, decision_spread: 0, annual_spread: 0,
  };
  for (const r of readings) {
    const t = r.type as keyof typeof byType;
    if (t in byType) byType[t]++;
  }

  // --- Top cards ---
  const cardCounts: Record<string, number> = {};
  for (const r of readings) {
    const cards = Array.isArray(r.cards) ? r.cards : [];
    for (const card of cards) {
      if (card.card_key) {
        cardCounts[card.card_key] = (cardCounts[card.card_key] ?? 0) + 1;
      }
    }
  }
  const topCards = Object.entries(cardCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([card_key, count]) => ({ card_key, count }));

  // --- Journal entries ---
  const { data: journalRows } = await db
    .from('journal_entries')
    .select('resonance_rating')
    .gte('created_at', ws)
    .lte('created_at', we)
    .throwOnError();

  const journalEntries = (journalRows ?? []) as Array<{ resonance_rating: number }>;
  const journalCount = journalEntries.length;
  const resonanceAvg = journalCount > 0
    ? Math.round((journalEntries.reduce((s, e) => s + e.resonance_rating, 0) / journalCount) * 100) / 100
    : 0;

  // --- Conversion ---
  const { count: totalProUsers } = await db
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'pro')
    .throwOnError();

  // free_to_pro: usuarios cuyo PRIMER pago completed cae en la semana
  const { data: newProPayments } = await db
    .from('payments')
    .select('user_id, created_at')
    .eq('status', 'completed')
    .gte('created_at', ws)
    .lte('created_at', we)
    .throwOnError();

  const newProUserIds = new Set(
    (newProPayments ?? []).map((p: { user_id: string }) => p.user_id)
  );

  // Verificar cuáles tienen su primer pago en esta semana
  let freeToProConversions = 0;
  for (const userId of newProUserIds) {
    const { data: firstPayment } = await db
      .from('payments')
      .select('created_at')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    if (firstPayment && firstPayment.created_at >= ws && firstPayment.created_at <= we) {
      freeToProConversions++;
    }
  }

  const { count: shareUnlockCount } = await db
    .from('users')
    .select('*', { count: 'exact', head: true })
    .gte('share_unlock_used_date', format(weekStart, 'yyyy-MM-dd'))
    .lte('share_unlock_used_date', format(weekEnd, 'yyyy-MM-dd'))
    .throwOnError();

  const { count: shareEventsCount } = await db
    .from('share_events')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', ws)
    .lte('created_at', we)
    .throwOnError();

  const { data: completedPayments } = await db
    .from('payments')
    .select('amount')
    .eq('status', 'completed')
    .gte('created_at', ws)
    .lte('created_at', we)
    .throwOnError();

  const paymentsCompleted = (completedPayments ?? []).length;
  const revenueEur = (completedPayments ?? []).reduce(
    (s: number, p: { amount: number }) => s + Number(p.amount), 0
  );

  const conversionRatePct = (totalUsers ?? 0) > 0
    ? Math.round(((totalProUsers ?? 0) / (totalUsers ?? 1)) * 1000) / 10
    : 0;

  return {
    period: {
      week_start: format(weekStart, 'yyyy-MM-dd'),
      week_end: format(weekEnd, 'yyyy-MM-dd'),
    },
    growth: {
      new_users: newUsers ?? 0,
      total_users: totalUsers ?? 0,
      new_users_vs_prev_week_pct: pct(newUsers ?? 0, newUsersPrev ?? 0),
    },
    engagement: {
      readings_this_week: readingsThisWeekCount,
      readings_prev_week: readingsPrevCount ?? 0,
      readings_change_pct: pct(readingsThisWeekCount, readingsPrevCount ?? 0),
      readings_per_active_user: readingsPerActiveUser,
      active_users: activeUsers,
      retention_d7: retentionD7,
    },
    product: {
      readings_by_type: byType,
      top_cards: topCards,
      resonance_avg: resonanceAvg,
      journal_entries_count: journalCount,
    },
    conversion: {
      free_to_pro_conversions: freeToProConversions,
      total_pro_users: totalProUsers ?? 0,
      conversion_rate_pct: conversionRatePct,
      share_unlock_used_count: shareUnlockCount ?? 0,
      share_events_count: shareEventsCount ?? 0,
      payments_completed: paymentsCompleted,
      revenue_eur: Math.round(revenueEur * 100) / 100,
    },
  };
}

// ============================================================
// Generar narrativa con Claude
// ============================================================

async function generateNarrative(metrics: WeekMetrics): Promise<string> {
  const prompt = `Eres analista de producto. Resume estas métricas semanales de Phantara (web app de tarot con IA) en 150-200 palabras, en español.

Tono: directo, claro, accionable. Sin hedging. Sin jerga. Sin metáforas. Sin florituras.

Estructura:
1. Una frase resumen del estado de la semana.
2. Lo que ha ido bien (máximo 2 puntos).
3. Lo que ha ido mal o está estancado (máximo 2 puntos).
4. Una sola acción concreta recomendada para la próxima semana.

Métricas:
${JSON.stringify(metrics, null, 2)}`;

  return complete(prompt, {
    model: MODELS.SONNET,
    maxTokens: 800,
    temperature: 0.7,
  });
}

// ============================================================
// Generar dashboard HTML
// ============================================================

function generateHtml(metrics: WeekMetrics, narrative: string): string {
  const { period, growth, engagement, product, conversion } = metrics;

  const topCardsHtml = product.top_cards.slice(0, 5)
    .map(c => `<li><span class="card-key">${c.card_key.replace(/_/g, ' ')}</span><span class="card-count">${c.count}</span></li>`)
    .join('');

  const readingsByTypeHtml = Object.entries(product.readings_by_type)
    .map(([type, count]) => `<li><span>${type.replace(/_/g, ' ')}</span><span>${count}</span></li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Phantara — Weekly Insights ${period.week_start}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #020203;
      color: #e2d9f3;
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    h1, h2 { font-family: 'Cinzel', serif; }
    .container { max-width: 960px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 2.5rem; }
    header h1 { color: #d4af72; font-size: clamp(1.4rem, 4vw, 2.2rem); margin-bottom: 0.5rem; }
    header p { color: #9d8cc4; font-size: 0.95rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card {
      background: #0e0b1a;
      border: 1px solid #2a1f4a;
      border-radius: 12px;
      padding: 1.25rem;
    }
    .card h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7c3aed; margin-bottom: 0.75rem; }
    .metric-value { font-size: 2rem; font-weight: 600; color: #fff; line-height: 1; }
    .metric-label { font-size: 0.8rem; color: #9d8cc4; margin-top: 0.3rem; }
    .metric-delta { font-size: 0.8rem; margin-top: 0.4rem; }
    .delta-pos { color: #34d399; }
    .delta-neg { color: #f87171; }
    .delta-null { color: #6b7280; }
    .section { margin-bottom: 2rem; }
    .section-title {
      font-family: 'Cinzel', serif;
      font-size: 1rem;
      color: #d4af72;
      border-bottom: 1px solid #2a1f4a;
      padding-bottom: 0.5rem;
      margin-bottom: 1rem;
    }
    ul.stat-list { list-style: none; }
    ul.stat-list li {
      display: flex;
      justify-content: space-between;
      padding: 0.4rem 0;
      border-bottom: 1px solid #1a1230;
      font-size: 0.9rem;
      color: #c4b5e8;
    }
    ul.stat-list li:last-child { border-bottom: none; }
    .card-key { text-transform: capitalize; }
    .card-count { font-weight: 600; color: #d4af72; }
    .narrative-card {
      background: #0e0b1a;
      border: 1px solid #7c3aed44;
      border-radius: 12px;
      padding: 1.5rem;
      line-height: 1.7;
      white-space: pre-wrap;
      font-size: 0.95rem;
      color: #ddd6f3;
    }
    footer { text-align: center; margin-top: 3rem; color: #4b4272; font-size: 0.75rem; }
    @media (max-width: 480px) { .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>Phantara Weekly Insights</h1>
    <p>Semana del ${period.week_start} al ${period.week_end}</p>
  </header>

  <!-- Growth -->
  <div class="section">
    <div class="section-title">Crecimiento</div>
    <div class="grid">
      <div class="card">
        <h2>Nuevos usuarios</h2>
        <div class="metric-value">${growth.new_users}</div>
        <div class="metric-delta ${growth.new_users_vs_prev_week_pct === null ? 'delta-null' : growth.new_users_vs_prev_week_pct >= 0 ? 'delta-pos' : 'delta-neg'}">
          ${fmtPct(growth.new_users_vs_prev_week_pct)} vs semana anterior
        </div>
      </div>
      <div class="card">
        <h2>Total usuarios</h2>
        <div class="metric-value">${growth.total_users}</div>
      </div>
    </div>
  </div>

  <!-- Engagement -->
  <div class="section">
    <div class="section-title">Engagement</div>
    <div class="grid">
      <div class="card">
        <h2>Lecturas esta semana</h2>
        <div class="metric-value">${engagement.readings_this_week}</div>
        <div class="metric-delta ${engagement.readings_change_pct === null ? 'delta-null' : engagement.readings_change_pct >= 0 ? 'delta-pos' : 'delta-neg'}">
          ${fmtPct(engagement.readings_change_pct)} vs semana anterior
        </div>
      </div>
      <div class="card">
        <h2>Usuarios activos</h2>
        <div class="metric-value">${engagement.active_users}</div>
      </div>
      <div class="card">
        <h2>Lecturas / usuario</h2>
        <div class="metric-value">${engagement.readings_per_active_user}</div>
      </div>
      <div class="card">
        <h2>Retención D7</h2>
        <div class="metric-value">${engagement.retention_d7}%</div>
      </div>
    </div>
  </div>

  <!-- Product -->
  <div class="section">
    <div class="section-title">Producto</div>
    <div class="grid">
      <div class="card">
        <h2>Lecturas por tipo</h2>
        <ul class="stat-list">${readingsByTypeHtml}</ul>
      </div>
      <div class="card">
        <h2>Top 5 cartas</h2>
        <ul class="stat-list">${topCardsHtml}</ul>
      </div>
      <div class="card">
        <h2>Resonancia media</h2>
        <div class="metric-value">${product.resonance_avg}</div>
        <div class="metric-label">sobre 5 (${product.journal_entries_count} entradas)</div>
      </div>
    </div>
  </div>

  <!-- Conversion -->
  <div class="section">
    <div class="section-title">Conversión</div>
    <div class="grid">
      <div class="card">
        <h2>Conversiones a Pro</h2>
        <div class="metric-value">${conversion.free_to_pro_conversions}</div>
      </div>
      <div class="card">
        <h2>Total Pro</h2>
        <div class="metric-value">${conversion.total_pro_users}</div>
        <div class="metric-label">${conversion.conversion_rate_pct}% del total</div>
      </div>
      <div class="card">
        <h2>Ingresos</h2>
        <div class="metric-value">${conversion.revenue_eur}€</div>
        <div class="metric-label">${conversion.payments_completed} pagos completados</div>
      </div>
      <div class="card">
        <h2>Share unlock</h2>
        <div class="metric-value">${conversion.share_unlock_used_count}</div>
        <div class="metric-label">${conversion.share_events_count} share events</div>
      </div>
    </div>
  </div>

  <!-- Narrativa -->
  <div class="section">
    <div class="section-title">Análisis narrativo</div>
    <div class="narrative-card">${narrative}</div>
  </div>

  <footer>Generado automáticamente por el agente weekly-insights · ${new Date().toISOString()}</footer>
</div>
</body>
</html>`;
}

// ============================================================
// Subir HTML a Supabase Storage
// ============================================================

async function uploadDashboard(weekStart: string, html: string): Promise<string | null> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Importar dinámicamente para evitar import circular con getPublicDb
  const { createClient } = await import('@supabase/supabase-js');
  const storage = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage;

  const bucket = 'weekly-reports';
  const fileName = `${weekStart}.html`;

  // Intentar crear el bucket si no existe
  try {
    await storage.createBucket(bucket, { public: true });
  } catch {
    // Ya existe o sin permisos — continuamos
  }

  const { error } = await storage.from(bucket).upload(fileName, html, {
    contentType: 'text/html',
    upsert: true,
  });

  if (error) {
    console.error(`[weekly-insights] Storage upload failed:`, error.message);
    return null;
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    const now = new Date();
    const { weekStart, weekEnd } = getWeekRange(now);
    const weekStartStr = format(weekStart, 'yyyy-MM-dd');
    const weekEndStr = format(weekEnd, 'yyyy-MM-dd');

    // Idempotencia: comprobar si ya existe el reporte
    const { data: existing } = await getDb()
      .from('weekly_insights')
      .select('id')
      .eq('week_start', weekStartStr)
      .maybeSingle();

    if (existing) {
      console.log(`[weekly-insights] Report already exists for week ${weekStartStr}`);
      await finishExecution(ctx, { week_start: weekStartStr, has_report: false, skipped: true });
      return;
    }

    console.log(`[weekly-insights] Analyzing week ${weekStartStr} to ${weekEndStr}`);

    // 1. Métricas
    const metrics = await calcMetrics(weekStart, weekEnd);
    console.log('[weekly-insights] Metrics calculated');

    // 2. Narrativa
    const narrative = await generateNarrative(metrics);
    console.log('[weekly-insights] Narrative generated');

    // 3. Dashboard HTML
    const html = generateHtml(metrics, narrative);
    const dashboardUrl = await uploadDashboard(weekStartStr, html);
    if (dashboardUrl) {
      console.log(`[weekly-insights] Dashboard uploaded: ${dashboardUrl}`);
    } else {
      console.log('[weekly-insights] Dashboard upload failed — continuing without link');
    }

    // 4. Guardar en agents.weekly_insights
    const { error: upsertError } = await getDb()
      .from('weekly_insights')
      .upsert({ week_start: weekStartStr, metrics, narrative }, { onConflict: 'week_start' });

    if (upsertError) throw new Error(`weekly_insights upsert failed: ${upsertError.message}`);
    console.log('[weekly-insights] Stored in agents.weekly_insights');

    // 5. Mensaje Telegram
    const g = metrics.growth;
    const e = metrics.engagement;
    const c = metrics.conversion;

    const dashboardLine = dashboardUrl
      ? `\n📄 [Dashboard completo](${dashboardUrl})`
      : '\n⚠️ Dashboard no disponible esta semana';

    const message = `📊 *Phantara — Semana del ${weekStartStr} al ${weekEndStr}*

*Crecimiento:*
• ${g.new_users} usuarios nuevos (${fmtPct(g.new_users_vs_prev_week_pct)} vs semana anterior)
• ${g.total_users} usuarios totales

*Engagement:*
• ${e.readings_this_week} lecturas (${fmtPct(e.readings_change_pct)})
• ${e.readings_per_active_user} lecturas/usuario activo
• ${e.active_users} usuarios activos
• Retención D7: ${e.retention_d7}%

*Conversión:*
• ${c.free_to_pro_conversions} conversiones a Pro
• ${c.revenue_eur}€ de ingresos
• ${c.share_unlock_used_count} usos de share\\_unlock

---

${narrative}
${dashboardLine}`;

    await sendMessage(AGENT, message, { parseMode: 'Markdown', disableWebPagePreview: false });
    console.log('[weekly-insights] Telegram message sent');

    await finishExecution(ctx, { week_start: weekStartStr, has_report: true });
    console.log('[weekly-insights] OK');
  } catch (err) {
    await failExecution(ctx, err);
    await notifyError(AGENT, err);
    console.error('[weekly-insights] FAILED:', err);
    process.exit(1);
  }
}

main();
