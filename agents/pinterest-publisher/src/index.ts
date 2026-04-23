/**
 * pinterest-publisher
 * Cron diario 09:00 CET (08:00 UTC): publica 3 pins en Pinterest, uno por idioma.
 *
 * Flujo:
 *   1. Selecciona 3 cartas distintas, una por cada idioma (es/en/pt).
 *      Prioriza cartas con menos pins publicados en ese idioma, luego
 *      las que llevan mas tiempo sin pin.
 *   2. Para cada (card, lang): lee titulo/meta_description de public.tarot_cards_seo,
 *      pide a Claude Haiku un titulo + descripcion optimizados para Pinterest.
 *   3. Publica pin via Pinterest API v5 apuntando a phantara.app/[lang]/tarot/[card]
 *      con imagen publica de Supabase Storage (bucket 'tarot-cards').
 *   4. Guarda en agents.pinterest_pins y notifica a Telegram con enlace.
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
import { createPin } from '@phantara/pinterest';
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

// ============================================================
// Seleccion de cartas a publicar
// ============================================================

async function pickCardForLang(lang: Lang, exclude: Set<string>): Promise<string | null> {
  const db = getDb();

  const { data: existingPins, error } = await db
    .from('pinterest_pins')
    .select('card_key, published_at')
    .eq('lang', lang)
    .not('card_key', 'is', null);

  if (error) {
    throw new Error(`Failed to read pinterest_pins: ${error.message}`);
  }

  const stats = new Map<string, { count: number; lastPublished: number }>();
  for (const row of existingPins ?? []) {
    if (!row.card_key) continue;
    const prev = stats.get(row.card_key);
    const t = new Date(row.published_at as string).getTime();
    if (prev) {
      prev.count += 1;
      if (t > prev.lastPublished) prev.lastPublished = t;
    } else {
      stats.set(row.card_key, { count: 1, lastPublished: t });
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
        lastPublished: s?.lastPublished ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count;
      return a.lastPublished - b.lastPublished;
    });

  return ranked[0]?.card_key ?? null;
}

// ============================================================
// Generacion de contenido del pin
// ============================================================

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

// ============================================================
// Publicacion de un pin
// ============================================================

interface PublishedPin {
  card_key: string;
  lang: Lang;
  pinId: string;
  pinUrl: string;
  title: string;
}

async function publishSinglePin(
  cardKey: string,
  lang: Lang,
  boardId: string,
): Promise<PublishedPin> {
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

  const { pinId, url } = await createPin({
    boardId,
    title: content.title,
    description: content.description,
    link: destinationUrl,
    imageUrl,
    altText: content.altText,
  });

  const db = getDb();
  const { error: insertErr } = await db.from('pinterest_pins').insert({
    pin_id: pinId,
    card_key: cardKey,
    lang,
    title: content.title,
    description: content.description,
    link: destinationUrl,
    image_url: imageUrl,
    board_id: boardId,
    utm_campaign: 'daily_pins',
  });

  if (insertErr) {
    console.error(`[${AGENT}] Failed to log pin in DB: ${insertErr.message}`);
  }

  return {
    card_key: cardKey,
    lang,
    pinId,
    pinUrl: url,
    title: content.title,
  };
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const ctx = await startExecution(AGENT);

  try {
    const boardId = process.env.PINTEREST_BOARD_ID;
    if (!boardId) {
      throw new Error('Missing PINTEREST_BOARD_ID env var');
    }
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

    const results: PublishedPin[] = [];
    const errors: Array<{ cardKey: string; lang: Lang; error: string }> = [];

    for (const { cardKey, lang } of selections) {
      try {
        const pin = await publishSinglePin(cardKey, lang, boardId);
        results.push(pin);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ cardKey, lang, error: msg });
        console.error(`[${AGENT}] Failed ${cardKey}/${lang}: ${msg}`);
      }
    }

    let summary = `*Publicados ${results.length}/3 pins*\n\n`;
    for (const p of results) {
      summary += `✓ \`${p.lang}\` ${p.card_key}\n   [${escapeMd(p.title)}](${p.pinUrl})\n\n`;
    }
    if (errors.length > 0) {
      summary += `\n*Errores:*\n`;
      for (const e of errors) {
        summary += `✗ \`${e.lang}\` ${e.cardKey}: ${escapeMd(e.error)}\n`;
      }
    }

    await sendMessage(AGENT, summary, { disableNotification: errors.length === 0 });

    await finishExecution(ctx, {
      published: results.length,
      failed: errors.length,
      pins: results.map((r) => ({ card: r.card_key, lang: r.lang, id: r.pinId })),
    });

    console.log(`[${AGENT}] OK (${results.length}/3 published)`);

    if (results.length === 0 && errors.length > 0) {
      process.exit(1);
    }
  } catch (err) {
    await failExecution(ctx, err);
    await notifyError(AGENT, err);
    console.error(`[${AGENT}] FAILED:`, err);
    process.exit(1);
  }
}

function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

main();
