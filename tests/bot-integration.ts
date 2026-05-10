/**
 * Runnable smoke-test for the four GramIO plugins shipped with this package.
 *
 * Run:
 *   BOT_TOKEN=… pnpm tsx tests/bot-integration.ts
 *
 * Manual test plan (commands are admin-only unless noted):
 *
 *   /start      — shows you which gate let the request through
 *                 (admin / default / store)
 *   /stream     — exercises llmStream: streams a markdown reply with
 *                 bullets, code, and a blockquote
 *   <any text>  — exercises coalesceLongMessages. Just paste >4096
 *                 chars. The plain-message handler reports the
 *                 received length. If coalesce works you see one
 *                 number ≥4096 instead of two events of <4096 each.
 *   /access     — opens the persistent admin menu (Aprobados, Pendientes,
 *                 Denegados, Refresh, Cerrar)
 *   /simulate   — fakes "another user just DMed the bot"; you'll receive an
 *                 admin notification with [✅ Aprobar][❌ Denegar]. Tapping
 *                 those buttons hits the real handlers, no second account
 *                 needed.
 *
 *   Ctrl-C      — gracefulStart catches SIGINT → bot.stop() → exit 0
 */
import { Bot } from 'gramio'
import { session } from '@gramio/session'
import { inMemoryStorage } from '@gramio/storage'
import { kev } from '../src/platform/kev.js'
import { adminContext, gracefulStart } from '../src/bot/kit.js'
import { accessControl, simulateAccessRequest } from '../src/bot/access-control.js'
import { coalesceLongMessages } from '../src/bot/coalesce.js'
import { llmStream } from '../src/bot/llm-stream.js'
import { botMenu } from '../src/bot/menu.js'
import { language } from '../src/bot/language.js'
import { messageHistory } from '../src/bot/message-history.js'

const token = kev.mustGet('BOT_TOKEN')

const storage = inMemoryStorage()

// Shared session — one record per user, with each plugin owning a
// distinct field by convention (`access`, `language`, `history`).
// All session-using plugins below declare this as a dependency;
// gramio's runtime deduplication ensures the session derive runs
// exactly once per update.
const userSession = session({
  storage,
  key: 'session',
  initial: () => ({}),
})

const lang = language({
  session: userSession,
  supported: ['en', 'es'] as const,
  default: 'en',
})

const history = messageHistory({
  session: userSession,
  maxMessages: 50,
  retentionDays: 7,
})

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@adriangalilea',
  personalData: { storage },     // ← enables 🗑 Forget · 📥 Export
  items: [
    lang.menuItem,
    {
      id: 'recent',
      label: '📜 Show last 3 messages',
      action: async (ctx) => {
        const recent =
          (ctx as unknown as { history?: ReadonlyArray<{ text: string }> }).history ?? []
        const last = recent
          .slice(-3)
          .map((e, i) => `${i + 1}. ${e.text}`)
          .join('\n')
        await (ctx as unknown as { send: (t: string) => Promise<unknown> }).send(
          last || '(no history)',
        )
      },
    },
  ],
})

const bot = new Bot(token)
  .extend(adminContext({ adminId: 190202471 }))
  .extend(userSession)                                          // session first
  .extend(accessControl({ session: userSession, storage, defaults: [] }))
  .extend(coalesceLongMessages({ log: true }))
  .extend(llmStream())
  .extend(lang.plugin)
  .extend(history.plugin)
  .extend(menu.plugin)

  // ─── /start ────────────────────────────────────────────────────
  .command('start', { description: 'Show what the bot can do' }, (ctx) => {
    if (!ctx.access.allowed) return
    return ctx.say.send({
      en:
        `👋 hi\n\n` +
        `🔑 access.source: ${ctx.access.source}\n` +
        `👑 isAdmin: ${ctx.isAdmin}\n` +
        `🆔 adminId: ${ctx.adminId}\n` +
        `🌐 ctx.lang: ${ctx.lang}\n\n` +
        `Commands:\n` +
        `  /settings — user menu (language + forget/export/privacy)\n` +
        `  /stream   — streaming markdown demo\n` +
        `  /access   — admin menu (admin only)\n` +
        `  /simulate — fake access request (admin only)\n\n` +
        `Paste >4096 chars to test coalesce.`,
      es:
        `👋 hola\n\n` +
        `🔑 access.source: ${ctx.access.source}\n` +
        `👑 isAdmin: ${ctx.isAdmin}\n` +
        `🆔 adminId: ${ctx.adminId}\n` +
        `🌐 ctx.lang: ${ctx.lang}\n\n` +
        `Comandos:\n` +
        `  /settings — menu user-facing (language + forget/export/privacy)\n` +
        `  /stream   — demo streaming markdown\n` +
        `  /access   — menú admin (sólo admin)\n` +
        `  /simulate — fake access request (sólo admin)\n\n` +
        `Pega texto >4096 chars para coalesce.`,
    })
  })

  // ─── /stream — exercises llmStream ─────────────────────────────
  .command(
    'stream',
    { description: 'Stream a fake LLM markdown reply' },
    async (ctx) => {
    if (!ctx.access.allowed) return
      const stream = ctx.startStream()
      for await (const chunk of fakeLLM()) {
        await stream.append(chunk)
      }
      await stream.end()
    },
  )

  // ─── plain text echo — exercises coalesce ──────────────────────
  // Any non-command message: report the length we received.
  // If you paste >4096 chars, Telegram splits it client-side; coalesce
  // joins them; this handler should see ONE event with the full
  // length (~paste size). If coalesce is broken, you'd see two events
  // each with <4096.
  .on('message', (ctx) => {
    if (!ctx.access.allowed) return
    if (ctx.text?.startsWith('/')) return // commands handled above
    return ctx.say.send({
      en:
        `📏 received: ${ctx.text?.length ?? 0} chars\n\n` +
        `If you pasted long text and this number is the full length ` +
        `(not half), coalesce works.`,
      es:
        `📏 recibido: ${ctx.text?.length ?? 0} chars\n\n` +
        `Si pegaste un texto largo y este número es la longitud ` +
        `total (no la mitad), coalesce funciona.`,
    })
  })

  // ─── /simulate — fake "stranger DMed the bot" ──────────────────
  .command(
    'simulate',
    { description: 'Admin: inject a fake access request', hide: true },
    async (ctx) => {
      if (!ctx.isAdmin) return
      const fakeId = 900_000_000 + Math.floor(Math.random() * 99_999)
      await simulateAccessRequest(
        ctx.bot,
        storage,
        ctx.adminId,
        {
          id: fakeId,
          firstName: 'Pepe',
          lastName: 'Pérez',
          username: 'pepe_fake',
        },
        'hola, ¿me dejas usar tu bot?',
      )
      await ctx.say.send({
        en:
          `🧪 simulated request from id ${fakeId}.\n` +
          `Check above — admin notification with ✅/❌ should have arrived.`,
        es:
          `🧪 simulated request from id ${fakeId}.\n` +
          `Mira arriba — debería haber llegado la notificación con ✅/❌.`,
      })
    },
  )

  .onStart(({ info }) => console.log(`[bot] running as @${info.username}`))

await gracefulStart(bot)

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Fakes an LLM token stream so we can exercise the streaming plugin
 * without a real model. Yields a piece of markdown every ~80ms.
 */
async function* fakeLLM(): AsyncGenerator<string> {
  const reply =
    `**Streaming test** — markdown crudo parseado en cliente.\n\n` +
    `Aquí va una respuesta simulada:\n\n` +
    `- *primer* punto en cursiva\n` +
    `- **segundo** en negrita\n` +
    `- tercer punto con \`código inline\`\n\n` +
    `Y un bloque de código:\n\n` +
    `\`\`\`ts\nconst greeting = 'hola'\nconsole.log(greeting)\n\`\`\`\n\n` +
    `> Cita al final para cerrar.`

  // Tokenize keeping whitespace so the stream "feels" like an LLM.
  const tokens = reply.match(/\S+|\s+/g) ?? [reply]
  for (const t of tokens) {
    await sleep(80)
    yield t
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
