/**
 * feedback-analyst
 * Cron primer día de cada mes a las 06:00 UTC:
 * analiza el feedback del mes anterior (journal_entries + readings.question),
 * detecta clusters temáticos con Claude, genera dashboard HTML,
 * guarda en agents.feedback_clusters y manda resumen a Telegram.
 */

import { startOfMonth, endOfMonth, subMonths, format } from 'date-fns';
import { AGENT_NAMES } from '@phantara/shared';
import { getDb, getPublicDb, startExecution, finishExecution, failExecution } from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';
import { complete, completeJson, MODELS } from '@phantara/claude';
import { requireEnv } from '@phantara/shared';

const AGENT = AGENT_NAMES.FEEDBACK_ANALYST;

// ============================================================
// Tipos
// ============================================================

interface JournalRow {
  id: string;
  note: string | null;
  resonance_rating: number;
  reading_id: string;
  created_at: string;
}

interface QuestionRow {
  id: string;
  question: string | null;
  type: string;
  created_at: string;
}

interface Cluster {
  cluster_theme: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  feedback_count: number;
  sample_feedbacks: string[];
  suggested_action: string | null;
}

type ReadingType =
  | 'daily_card'
  | 'three_card'
  | 'celtic_cross'
  | 'love_spread'
  | 'decision_spread'
  | 'annual_spread';

interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

interface FeedbackMetrics {
  period: {
    month_start: string;
    month_end: string;
    label: string;
  };
  volume: {
    journal_entries_count: number;
    questions_count: number;
    total_signals: number;
  };
  ratings: {
    avg_resonance: number | null;
    distribution: RatingDistribution;
    negative_pct: number;
    positive_pct: number;
  };
  reading_types: Record<ReadingType, number>;
}

// ============================================================
// Helpers
// ============================================================

function monthLabel(date: Date): string {
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}

function sentimentEmoji(s: Cluster['sentiment']): string {
  if (s === 'positive') return '🟢';
  if (s === 'negative') return '🔴';
  return '⚪';
}

function sentimentColor(s: Cluster['sentiment']): string {
  if (s === 'positive') return '#34d399';
  if (s === 'negative') return '#f87171';
  return '#9ca3af';
}

// ============================================================
// Calcular métricas cuantitativas
// ============================================================

function calcMetrics(
  validJournals: JournalRow[],
  validQuestions: QuestionRow[],
  monthStart: Date,
  monthEnd: Date,
): FeedbackMetrics {
  const label = monthLabel(monthStart);

  // Ratings
  const dist: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingSum = 0;
  let ratingCount = 0;
  for (const j of validJournals) {
    const r = j.resonance_rating;
    if (r >= 1 && r <= 5) {
      dist[r as keyof RatingDistribution]++;
      ratingSum += r;
      ratingCount++;
    }
  }
  const avgResonance = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 100) / 100 : null;
  const negativePct = ratingCount > 0 ? Math.round(((dist[1] + dist[2]) / ratingCount) * 1000) / 10 : 0;
  const positivePct = ratingCount > 0 ? Math.round(((dist[4] + dist[5]) / ratingCount) * 1000) / 10 : 0;

  // Tipos de tirada con preguntas
  const readingTypes: Record<ReadingType, number> = {
    daily_card: 0, three_card: 0, celtic_cross: 0,
    love_spread: 0, decision_spread: 0, annual_spread: 0,
  };
  for (const q of validQuestions) {
    const t = q.type as ReadingType;
    if (t in readingTypes) readingTypes[t]++;
  }

  return {
    period: {
      month_start: format(monthStart, 'yyyy-MM-dd'),
      month_end: format(monthEnd, 'yyyy-MM-dd'),
      label,
    },
    volume: {
      journal_entries_count: validJournals.length,
      questions_count: validQuestions.length,
      total_signals: validJournals.length + validQuestions.length,
    },
    ratings: {
      avg_resonance: avgResonance,
      distribution: dist,
      negative_pct: negativePct,
      positive_pct: positivePct,
    },
    reading_types: readingTypes,
  };
}

// ============================================================
// Dashboard HTML
// ============================================================

function generateHtml(
  metrics: FeedbackMetrics,
  clusters: Cluster[],
  narrative: string,
): string {
  const { period, volume, ratings, reading_types } = metrics;

  // Clusters HTML
  const clustersHtml = clusters
    .map(
      c => `
      <div class="cluster-card">
        <div class="cluster-header">
          <span class="sentiment-badge" style="background:${sentimentColor(c.sentiment)}22;color:${sentimentColor(c.sentiment)};border:1px solid ${sentimentColor(c.sentiment)}44">${sentimentEmoji(c.sentiment)} ${c.sentiment}</span>
          <span class="cluster-count">${c.feedback_count} señales</span>
        </div>
        <h3 class="cluster-title">${c.cluster_theme}</h3>
        <ul class="sample-list">
          ${c.sample_feedbacks.map(s => `<li><blockquote>${s}</blockquote></li>`).join('')}
        </ul>
        ${c.suggested_action ? `<div class="action-box">💡 ${c.suggested_action}</div>` : ''}
      </div>`,
    )
    .join('');

  // Barras de rating CSS
  const maxRating = Math.max(...Object.values(ratings.distribution), 1);
  const ratingBarsHtml = ([1, 2, 3, 4, 5] as const)
    .map(n => {
      const val = ratings.distribution[n];
      const pct = Math.round((val / maxRating) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${'★'.repeat(n)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${n <= 2 ? '#f87171' : n === 3 ? '#fbbf24' : '#34d399'}"></div></div>
        <span class="bar-val">${val}</span>
      </div>`;
    })
    .join('');

  // Tipos de tirada ordenados
  const sortedTypes = Object.entries(reading_types)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><span>${type.replace(/_/g, ' ')}</span><span>${count}</span></li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Phantara — Feedback ${period.label}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #020203; color: #e2d9f3; font-family: 'Inter', sans-serif; min-height: 100vh; padding: 2rem 1rem; }
    h1, h2, h3 { font-family: 'Cinzel', serif; }
    .container { max-width: 960px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 2.5rem; }
    header h1 { color: #d4af72; font-size: clamp(1.4rem, 4vw, 2.2rem); margin-bottom: 0.5rem; }
    header p { color: #9d8cc4; font-size: 0.95rem; }
    .section { margin-bottom: 2rem; }
    .section-title { font-family: 'Cinzel', serif; font-size: 1rem; color: #d4af72; border-bottom: 1px solid #2a1f4a; padding-bottom: 0.5rem; margin-bottom: 1rem; }
    .card { background: #0e0b1a; border: 1px solid #2a1f4a; border-radius: 12px; padding: 1.25rem; }
    .narrative-card { background: #0e0b1a; border: 1px solid #7c3aed44; border-radius: 12px; padding: 1.5rem; line-height: 1.7; white-space: pre-wrap; font-size: 0.95rem; color: #ddd6f3; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .metric-value { font-size: 2rem; font-weight: 600; color: #fff; line-height: 1; }
    .metric-label { font-size: 0.8rem; color: #9d8cc4; margin-top: 0.3rem; }
    .card h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7c3aed; margin-bottom: 0.75rem; }
    .cluster-card { background: #0e0b1a; border: 1px solid #2a1f4a; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
    .cluster-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .sentiment-badge { font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 999px; font-weight: 500; }
    .cluster-count { font-size: 0.8rem; color: #9d8cc4; }
    .cluster-title { font-size: 1rem; color: #e2d9f3; margin-bottom: 0.75rem; }
    .sample-list { list-style: none; margin-bottom: 0.75rem; }
    .sample-list li { margin-bottom: 0.4rem; }
    blockquote { border-left: 2px solid #7c3aed; padding-left: 0.75rem; color: #b09fd6; font-size: 0.875rem; font-style: italic; }
    .action-box { background: #1a1230; border-left: 3px solid #d4af72; border-radius: 0 8px 8px 0; padding: 0.6rem 0.9rem; font-size: 0.875rem; color: #d4af72; margin-top: 0.5rem; }
    .bar-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
    .bar-label { width: 60px; font-size: 0.8rem; color: #9d8cc4; flex-shrink: 0; }
    .bar-track { flex: 1; height: 10px; background: #1a1230; border-radius: 5px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 5px; transition: width 0.3s; }
    .bar-val { width: 24px; text-align: right; font-size: 0.8rem; color: #9d8cc4; flex-shrink: 0; }
    ul.stat-list { list-style: none; }
    ul.stat-list li { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #1a1230; font-size: 0.9rem; color: #c4b5e8; text-transform: capitalize; }
    ul.stat-list li:last-child { border-bottom: none; }
    footer { text-align: center; margin-top: 3rem; color: #4b4272; font-size: 0.75rem; }
    @media (max-width: 480px) { .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>Phantara — Feedback Mensual</h1>
    <p>${period.label} · ${period.month_start} → ${period.month_end}</p>
  </header>

  <div class="narrative-card">${narrative}</div>

  <!-- Métricas clave -->
  <div class="section">
    <div class="section-title">Resumen cuantitativo</div>
    <div class="grid">
      <div class="card">
        <h2>Señales totales</h2>
        <div class="metric-value">${volume.total_signals}</div>
        <div class="metric-label">${volume.journal_entries_count} notas + ${volume.questions_count} preguntas</div>
      </div>
      <div class="card">
        <h2>Rating medio</h2>
        <div class="metric-value">${ratings.avg_resonance !== null ? ratings.avg_resonance : '—'}</div>
        <div class="metric-label">sobre 5 estrellas</div>
      </div>
      <div class="card">
        <h2>% positivo</h2>
        <div class="metric-value" style="color:#34d399">${ratings.positive_pct}%</div>
        <div class="metric-label">rating 4-5</div>
      </div>
      <div class="card">
        <h2>% negativo</h2>
        <div class="metric-value" style="color:#f87171">${ratings.negative_pct}%</div>
        <div class="metric-label">rating 1-2</div>
      </div>
    </div>
  </div>

  <!-- Clusters -->
  <div class="section">
    <div class="section-title">Clusters detectados (${clusters.length})</div>
    ${clustersHtml}
  </div>

  <!-- Distribución de ratings -->
  <div class="section">
    <div class="section-title">Distribución de ratings</div>
    <div class="card">
      ${ratingBarsHtml}
    </div>
  </div>

  <!-- Tipos de tirada -->
  <div class="section">
    <div class="section-title">Tipos de tirada con preguntas</div>
    <div class="card">
      <ul class="stat-list">${sortedTypes}</ul>
    </div>
  </div>

  <footer>Generado automáticamente por el agente feedback-analyst · ${new Date().toISOString()}</footer>
</div>
</body>
</html>`;
}

// ============================================================
// Subir HTML a Supabase Storage
// ============================================================

async function uploadDashboard(monthStartISO: string, html: string): Promise<string | null> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const { createClient } = await import('@supabase/supabase-js');
  const storage = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage;

  const bucket = 'monthly-feedback-reports';
  const fileName = `${monthStartISO}.html`;

  try {
    await storage.createBucket(bucket, { public: true });
  } catch {
    // Ya existe o sin permisos — continuar
  }

  const { error } = await storage.from(bucket).upload(fileName, html, {
    contentType: 'text/html',
    upsert: true,
  });

  if (error) {
    console.error('[feedback-analyst] Storage upload failed:', error.message);
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
    const prevMonth = subMonths(now, 1);
    const monthStart = startOfMonth(prevMonth);
    const monthEnd = endOfMonth(prevMonth);
    monthStart.setUTCHours(0, 0, 0, 0);
    monthEnd.setUTCHours(23, 59, 59, 999);

    const monthStartISO = format(monthStart, 'yyyy-MM-dd');
    const monthEndISO = format(monthEnd, 'yyyy-MM-dd');
    const label = monthLabel(monthStart);

    // Idempotencia
    const { data: existing } = await getDb()
      .from('feedback_clusters')
      .select('id')
      .eq('week_start', monthStartISO)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[feedback-analyst] Analysis already exists for month ${monthStartISO}`);
      await finishExecution(ctx, { skipped: true, reason: 'already_exists' });
      return;
    }

    console.log(`[feedback-analyst] Analyzing month ${monthStartISO} to ${monthEndISO}`);

    const db = getPublicDb();

    // Recoger datos del mes
    const [{ data: journalsRaw }, { data: questionsRaw }] = await Promise.all([
      db
        .from('journal_entries')
        .select('id, note, resonance_rating, reading_id, created_at')
        .gte('created_at', monthStart.toISOString())
        .lte('created_at', monthEnd.toISOString()),
      db
        .from('readings')
        .select('id, question, type, created_at')
        .gte('created_at', monthStart.toISOString())
        .lte('created_at', monthEnd.toISOString())
        .not('question', 'is', null),
    ]);

    const validJournals = ((journalsRaw ?? []) as JournalRow[]).filter(
      j => j.note && j.note.trim().length >= 10,
    );
    const validQuestions = ((questionsRaw ?? []) as QuestionRow[]).filter(
      q => q.question && q.question.trim().length >= 5,
    );
    const totalFeedbackSignals = validJournals.length + validQuestions.length;

    console.log(
      `[feedback-analyst] Collected ${validJournals.length} journals + ${validQuestions.length} questions = ${totalFeedbackSignals} signals`,
    );

    // Circuit breaker
    if (totalFeedbackSignals < 5) {
      const msg = `📭 *Feedback del mes ${label}*\n\nAún no hay suficiente volumen para un análisis temático.\n\n• Notas en journal: ${validJournals.length}\n• Preguntas en tiradas: ${validQuestions.length}\n\nEl análisis se ejecutará cuando haya al menos 5 entradas.`;
      await sendMessage(AGENT, msg, { disableNotification: true });
      await finishExecution(ctx, {
        skipped: true,
        reason: 'below_threshold',
        total: totalFeedbackSignals,
      });
      console.log(`[feedback-analyst] Circuit breaker — below threshold (${totalFeedbackSignals} signals)`);
      return;
    }

    // Métricas cuantitativas
    const metrics = calcMetrics(validJournals, validQuestions, monthStart, monthEnd);

    // Clustering con Claude
    console.log('[feedback-analyst] Generating clusters with Claude');
    const clusterPrompt = `Eres analista de producto especializado en comportamiento de usuarios.

Te paso feedback de usuarios de Phantara (web app de tarot con IA) del mes ${label}. Hay dos fuentes:

1. NOTAS del diario (journal_entries.note): texto libre que el usuario escribe tras hacer una tirada, opcionalmente con un rating 1-5 de cuánto le resonó la lectura.

2. PREGUNTAS de tiradas (readings.question): la pregunta que el usuario escribió al abrir una tirada.

Tu tarea: agrupa estas señales en 3-6 clusters temáticos. Para cada cluster:

- cluster_theme: frase corta que describe el tema (ej: "Confusión con cartas reversed", "Preguntas sobre ex-parejas", "Feedback positivo sobre la interpretación").
- sentiment: "positive" | "neutral" | "negative". Basado en el contenido, no solo en el rating.
- feedback_count: cuántas de las señales encajan en este cluster.
- sample_feedbacks: array con 2-3 textos representativos (literales, del input).
- suggested_action: acción concreta y corta para mejorar el producto o la experiencia respecto a este cluster. Si es positivo, qué reforzar. Si es negativo, qué arreglar. Máximo 2 frases. Null si no hay acción clara.

Reglas:
- Los clusters deben ser mutuamente exclusivos en la medida de lo posible.
- No inventes clusters si no hay suficiente señal para sostenerlos.
- Devuelve SOLO JSON válido, sin markdown, sin preámbulo. Array de clusters.

Datos:

NOTAS DEL DIARIO (total ${validJournals.length}):
${JSON.stringify(validJournals.map(j => ({ note: j.note, rating: j.resonance_rating })), null, 2)}

PREGUNTAS (total ${validQuestions.length}):
${JSON.stringify(validQuestions.map(q => ({ question: q.question, reading_type: q.type })), null, 2)}

Devuelve un array JSON con esta estructura exacta:
[
  {
    "cluster_theme": "...",
    "sentiment": "positive" | "neutral" | "negative",
    "feedback_count": number,
    "sample_feedbacks": ["...", "..."],
    "suggested_action": "..." | null
  }
]`;

    const clusters = await completeJson<Cluster[]>(clusterPrompt, {
      model: MODELS.SONNET,
      maxTokens: 2500,
      temperature: 0.4,
    });

    console.log(`[feedback-analyst] ${clusters.length} clusters detected`);

    // Narrativa ejecutiva
    const narrativePrompt = `Eres analista de producto. Te paso el análisis de clusters del feedback mensual de Phantara y las métricas cuantitativas. Escribe un resumen ejecutivo en español, 120-180 palabras.

Tono: directo, claro, accionable. Sin hedging. Sin jerga. Sin metáforas. Sin florituras.

Estructura:
1. Una frase de estado general.
2. Señal más positiva detectada (1 frase).
3. Señal más preocupante detectada (1 frase).
4. Una sola acción priorizada para este mes.

Métricas cuantitativas:
${JSON.stringify(metrics, null, 2)}

Clusters detectados:
${JSON.stringify(clusters, null, 2)}`;

    const narrative = await complete(narrativePrompt, {
      model: MODELS.SONNET,
      maxTokens: 500,
      temperature: 0.6,
    });

    console.log('[feedback-analyst] Narrative generated');

    // Dashboard HTML
    const html = generateHtml(metrics, clusters, narrative);
    const dashboardUrl = await uploadDashboard(monthStartISO, html);
    if (dashboardUrl) {
      console.log(`[feedback-analyst] Dashboard uploaded: ${dashboardUrl}`);
    } else {
      console.log('[feedback-analyst] Dashboard upload failed — continuing');
    }

    // Guardar clusters en agents.feedback_clusters
    const rows = clusters.map(c => ({
      week_start: monthStartISO,
      cluster_theme: c.cluster_theme,
      sentiment: c.sentiment,
      feedback_count: c.feedback_count,
      sample_feedbacks: c.sample_feedbacks,
      suggested_action: c.suggested_action ?? null,
    }));

    const { error: insertError } = await getDb().from('feedback_clusters').insert(rows);
    if (insertError) {
      // No es fatal — logueamos pero seguimos para mandar Telegram
      console.error('[feedback-analyst] Insert error:', insertError.message);
    } else {
      console.log(`[feedback-analyst] Stored ${rows.length} rows in agents.feedback_clusters`);
    }

    // Telegram
    const clusterList = clusters
      .map(c => `• ${sentimentEmoji(c.sentiment)} ${c.cluster_theme} (${c.feedback_count})`)
      .join('\n');

    const hasUrgentNegative = clusters.some(
      c => c.sentiment === 'negative' && c.feedback_count >= 3,
    );

    const dashboardLine = dashboardUrl
      ? `\n📄 [Dashboard completo](${dashboardUrl})`
      : '\n⚠️ Dashboard no disponible';

    const avgLabel =
      metrics.ratings.avg_resonance !== null ? `${metrics.ratings.avg_resonance}/5` : '—';

    const message = `⚠️ *Feedback Analyst — ${label}*

*Volumen:*
• ${totalFeedbackSignals} señales analizadas (${validJournals.length} notas + ${validQuestions.length} preguntas)
• Rating medio: ${avgLabel}

*Clusters detectados:* ${clusters.length}
${clusterList}

---

${narrative}
${dashboardLine}`;

    await sendMessage(AGENT, message, {
      parseMode: 'Markdown',
      disableNotification: !hasUrgentNegative,
      disableWebPagePreview: false,
    });

    console.log('[feedback-analyst] Telegram sent');
    await finishExecution(ctx, {
      month_start: monthStartISO,
      clusters_count: clusters.length,
      total_signals: totalFeedbackSignals,
    });
    console.log('[feedback-analyst] OK');
  } catch (err) {
    await failExecution(ctx, err);
    await notifyError(AGENT, err);
    console.error('[feedback-analyst] FAILED:', err);
    process.exit(1);
  }
}

main();
