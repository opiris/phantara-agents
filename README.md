# Phantara Agents

Monorepo de 7 agentes automatizados que soportan el crecimiento de Phantara (phantara.app).
Todos corren en Railway con crons, escriben en Supabase (schema `agents`) y notifican a Telegram.

## Los 7 agentes

| Agente | Que hace | Frecuencia | Notifica |
|---|---|---|---|
| `pinterest-publisher` | Publica 3 pins diarios via Pinterest API | Diario 09:00 CET | Solo en errores |
| `reddit-scout` | Busca preguntas de tarot, genera borradores, los manda a Telegram | Cada 6h | Siempre (borradores) |
| `seo-refresher` | Refresca contenido de las 234 paginas SEO que pierden ranking | Semanal | Solo si actualiza algo |
| `weekly-insights` | Resume metricas de la semana (tiradas, usuarios, conversiones) | Lunes 08:00 | Siempre |
| `comment-responder` | Genera borradores de respuesta a comentarios en TikTok/IG | Cada 4h | Cuando hay borradores |
| `viral-hunter` | Detecta trends emergentes en TikTok relacionadas con tarot | Cada 12h | Si encuentra trend >X score |
| `feedback-analyst` | Agrupa tematicamente el feedback de usuarios de Phantara | Semanal | Si detecta spike negativo |

## Arquitectura

- **1 repo, 1 proyecto Railway, 7 servicios**. Cada agente es un servicio Railway independiente con su propio cron.
- **TypeScript + Node 20** en todos los agentes.
- **pnpm workspaces** para compartir codigo entre agentes (`packages/shared`, `packages/db`, `packages/telegram`, `packages/claude`).
- **Supabase** (instancia de Phantara) con schema `agents` aislado para el estado.
- **Telegram**: 1 bot, 1 chat, prefijos visuales por agente.

```
phantara-agents/
├── agents/
│   ├── pinterest-publisher/
│   │   ├── src/index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── railpack.json
│   ├── reddit-scout/
│   ├── seo-refresher/
│   ├── weekly-insights/
│   ├── comment-responder/
│   ├── viral-hunter/
│   └── feedback-analyst/
├── packages/
│   ├── shared/        # tipos, constantes, utils
│   ├── db/            # cliente Supabase tipado
│   ├── telegram/      # wrapper del bot con prefijos
│   └── claude/        # wrapper del SDK de Anthropic
├── supabase/
│   └── migrations/
│       └── 001_agents_schema.sql
├── package.json       # root, pnpm workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

## Como se ejecutan los crons en Railway

Railway soporta "Cron Schedules" nativos desde 2024. Cada servicio tiene:

1. Un `railpack.json` que define el build.
2. En la UI de Railway → Settings → **Cron Schedule** → cron expression.
3. Railway arranca el servicio, ejecuta `pnpm start` (que hace `tsx src/index.ts`), el agente hace su trabajo, logs a stdout, y Railway apaga el servicio.

**Ventaja:** solo pagas por el tiempo de CPU real. Un agente que corre 30 segundos al dia te cuesta centimos.

## Coste estimado

- 7 servicios × ~1 minuto/ejecucion × frecuencia promedio = ~30 min CPU/dia total.
- Railway hobby plan: 5€/mes incluye $5 de credito de uso.
- Estimado real: **5-10€/mes** (probablemente dentro del credito del hobby plan).

## Variables de entorno globales

Las mismas para todos los servicios Railway (se configuran una vez a nivel proyecto):

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# APIs externas (solo agentes que las necesiten)
PINTEREST_ACCESS_TOKEN=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
TIKTOK_ACCESS_TOKEN=      # para comment-responder y viral-hunter
```

## Orden de deploy

1. Crear proyecto Railway vacio.
2. Conectar el repo GitHub.
3. Aplicar la migration SQL a Supabase (`supabase/migrations/001_agents_schema.sql`).
4. Configurar variables de entorno a nivel proyecto en Railway.
5. Crear 7 servicios, uno por cada carpeta de `/agents/*`:
   - Root directory: `/agents/{nombre}`
   - Cron Schedule: (ver tabla arriba)
6. Deploy.

## Roadmap de implementacion

Los agentes se implementan en este orden (de mas impacto y mas facil a menos):

1. **reddit-scout** (Semana 4 del plan original, pero es el mas util primero)
2. **pinterest-publisher** (Semana 3)
3. **weekly-insights** (baseline de metricas, arranca YA aunque este vacio)
4. **seo-refresher** (solo tiene sentido cuando las 234 paginas lleven >30 dias indexadas)
5. **comment-responder** (cuando TikTok/IG tenga >1k seguidores)
6. **viral-hunter** (mismo momento que el anterior)
7. **feedback-analyst** (cuando tengas >100 usuarios activos)

Este README solo monta la **infraestructura**. Cada agente tiene un stub funcional que manda un mensaje "Hola desde {agente}" a Telegram para verificar que el pipeline funciona end-to-end antes de implementar la logica real.
