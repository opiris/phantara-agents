/**
 * pinterest-publisher (modo draft manual)
 * Cron diario 09:00 CET (08:00 UTC): genera 3 borradores de pins y los manda
 * por Telegram con todo el contenido listo para copy-paste. NO publica a la
 * API de Pinterest (requiere Standard access que Pinterest no aprueba facil).
 */

import {
  AGENT_NAMES,
  SUPPORTED_LANGS,
  phantaraUrl,
  type Lang,
} from '@phantara/shared';
import {
  startExecution,
  finishExecution,
  failExecution,
  getDb,
  getPublicDb,
} from '@phantara/db';
import { sendMessage, notifyError } from '@phantara/telegram';
import { completeJson, MODELS } from '@phantara/claude';

const AGENT = AGENT_NAMES.PINTEREST_PUBLISHER;
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const STORAGE_BUCKET = 'tarot-cards';

interface SeoRow {
  card_key: string;
  lang: Lang;
  title: string;
  meta_description: string;
}

interface PinContent {
  title: string;
  description: string;
  altText: string;
}

interface GeneratedDraft {
  card_key: string;
  lang: Lang;
  title: string;
  description: string;
  altText: string;
  imageUrl: string;
  destinationUrl: string;
}

async function pickCardForLang(lang: Lang, exclude: Set<string>): Promise<string | null> {
  const db = getDb();

  const { data: existingDrafts, error } = await db
    .from('pinterest_drafts')
    .select('card_key, created_at')
    .eq('lang', lang);

  if (error) {
    throw new Error(`Failed to read pinterest_drafts: ${error.message}`);
  }

  const stats = new Map<string, { count: number; lastCreated: number }>();
  for (const row of existingDrafts ?? []) {
    if (!row.card_key) continue;
    const prev = stats.get(row.card_key);
    const t = new Date(row.created_at as string).getTime();
    if (prev) {
      prev.count += 1;
      if (t > prev.lastCreated) prev.lastCreated = t;
    } else {
      stats.set(row.card_key, { count: 1, lastCreated: t });
    }
  }

  const pdb = getPublicDb();
  const { data: cards, error: cardsErr } = await pdb
    .from('tarot_cards_seo')
    .select('card_key')
    .eq('lang', lang);

  if (cardsErr) {
    throw new Error(`Failed to read tarot_cards_seo: ${cardsErr.message}`);
  }

  const uniqueCards = Array.from(new Set((cards ?? []).map((c) => c.card_key as string)));

  const ranked = uniqueCards
    .filter((c) => !exclude.has(c))
    .map((card_key) => {
      const s = stats.get(card_key);
      return {
        card_key,
        count: s?.count ?? 0,
        lastCreated: s?.lastCreated ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count;
      return a.lastCreated - b.lastCreated;
    });

  return ranked[0]?.card_key ?? null;
}

async function generatePinContent(seo: SeoRow): Promise<PinContent> {
  const langInstructions: Record<Lang, string> = {
    es: 'Responde en espanol.',
    en: 'Respond in English.',
    pt: 'Responde em portugues (pt-PT).',
  };

  const prompt = `
Eres un especialista en Pinterest SEO y copy visual. Genera un pin para la siguiente carta de tarot.

Carta: ${seo.card_key}
Idioma: ${seo.lang}
Titulo SEO existente: ${seo.title}
Meta description existente: ${seo.meta_description}

Tu tarea: crear un TITULO y DESCRIPCION especificos para Pinterest.
- El titulo Pinterest debe ser mas emocional/curioso que el SEO, pensado para que alguien haga clic al verlo en su feed. Maximo 95 caracteres.
- La descripcion debe incluir 3-4 hashtags relevantes al final. Tono mistico pero accesible. Maximo 480 caracteres.
- El alt_text describe la imagen de la carta en una frase (maximo 100 caracteres).

${langInstructions[seo.lang]}

Devuelve SOLO un JSON con esta forma exacta, sin markdown ni texto extra:
{"title": "...", "description": "...", "altText": "..."}
`.trim();

  const result = await completeJson<PinContent>(prompt, {
    model: MODELS.HAIKU,
    maxTokens: 500,
    temperature: 0.8,
  });

  return {
    title: result.title.slice(0, 100),
    description: result.description.slice(0, 500),
    altText: result.altText.slice(0, 500),
  };
}

async function generateDraft(cardKey: string, lang: Lang): Promise<GeneratedDraft> {
  const pdb = getPublicDb();
  const { data: seoRow, error: seoErr } = await pdb
    .from('tarot_cards_seo')
    .select('card_key, lang, title, meta_description')
    .eq('card_key', cardKey)
    .eq('lang', lang)
    .single<SeoRow>();

  if (seoErr || !seoRow) {
    throw new Error(`No SEO row for ${cardKey}/${lang}: ${seoErr?.message}`);
  }

  const content = await generatePinContent(seoRow);

  const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${cardKey}.webp`;

  const destinationUrl = phantaraUrl(`/${lang}/tarot/${cardKey}`, {
    source: 'pinterest',
    medium: 'social',
    campaign: 'daily_pins',
  });

  const db = getDb();
  const { error: insertErr } = await db.from('pinterest_drafts').insert({
    card_key: cardKey,
    lang,
    title: content.title,
    description: content.description,
    alt_text: content.altText,
    image_url: imageUrl,
    destination_url: destinationUrl,
  });

  if (insertErr) {
    throw new Error(`Failed to save draft for ${cardKey}/${lang}: ${insertErr.message}`);
  }

  return {
    card_key: cardKey,
    lang,
    title: content.title,
    description: content.description,
    altText: content.altText,
    imageUrl,
    destinationUrl,
  };
}

function formatTelegramMessage(drafts: GeneratedDraft[]): string {
  const today = new Date().toISOString().slice(0, 10);

  const flagByLang: Record<Lang, string> = {
    es: '🇪🇸',
    en: '🇬🇧',
    pt: '🇵🇹',
  };

  let msg = `📌 *PINS DEL DIA* \\- ${escapeMd(today)}\n\n`;
  msg += `Copia cada bloque en Pinterest manualmente\\.\n\n`;

  let i = 0;
  for (const d of drafts) {
    i++;
    msg += `━━━━━━━━━━━━━━\n`;
    msg += `*${flagByLang[d.lang]} Pin ${i}/${drafts.length}* \\(${d.lang}\\)\n`;
    msg += `Carta: \`${escapeMd(d.card_key)}\`\n\n`;

    msg += `*TITULO:*\n\`\`\`\n${d.title}\n\`\`\`\n`;
    msg += `*DESCRIPCION:*\n\`\`\`\n${d.description}\n\`\`\`\n`;
    msg += `*ALT TEXT:*\n\`\`\`\n${d.altText}\n\`\`\`\n`;
    msg += `🖼 [Descargar imagen](${d.imageUrl})\n`;
    msg += `🔗 [URL destino del pin](${d.destinationUrl})\n\n`;
  }

  msg += `━━━━━━━━━━━━━━\n`;
  msg += `_Cuando los publiques, marca cada pin como publicado con el endpoint interno o ignoralo\\._`;

  return msg;
}

function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    if (!SUPABASE_URL) {
      throw new Error('Missing SUPABASE_URL env var');
    }

    const excluded = new Set<string>();
    const selections: Array<{ cardKey: string; lang: Lang }> = [];

    for (const lang of SUPPORTED_LANGS) {
      const cardKey = await pickCardForLang(lang, excluded);
      if (!cardKey) {
        throw new Error(`Could not find a card for lang ${lang}`);
      }
      excluded.add(cardKey);
      selections.push({ cardKey, lang });
    }

    const drafts: GeneratedDraft[] = [];
    const errors: Array<{ cardKey: string; lang: Lang; error: string }> = [];

    for (const { cardKey, lang } of selections) {
      try {
        const draft = await generateDraft(cardKey, lang);
        drafts.push(draft);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ cardKey, lang, error: msg });
        console.error(`[${AGENT}] Failed ${cardKey}/${lang}: ${msg}`);
      }
    }

    if (drafts.length > 0) {
      const msg = formatTelegramMessage(drafts);
      await sendMessage(AGENT, msg);
    }

    if (errors.length > 0) {
      let errMsg = `*Errores generando borradores:*\n`;
      for (const e of errors) {
        errMsg += `\\- \`${e.lang}\` ${escapeMd(e.cardKey)}: ${escapeMd(e.error)}\n`;
      }
      await sendMessage(AGENT, errMsg);
    }

    await finishExecution(ctx, {
      generated: drafts.length,
      failed: errors.length,
      drafts: drafts.map((d) => ({ card: d.card_key, lang: d.lang })),
    });

    console.log(`[${AGENT}] OK (${drafts.length}/3 drafts generated)`);

    if (drafts.length === 0 && errors.length > 0) {
      process.exit(1);
    }
  } catch (err) {
    await failExecution(ctx, err);
    await notifyError(AGENT, err);
    console.error(`[${AGENT}] FAILED:`, err);
    process.exit(1);
  }
}

main();
