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
import { inMemoryStorage } from '@gramio/storage'
import { kev } from '../src/platform/kev.js'
import { adminContext, gracefulStart } from '../src/bot/kit.js'
import { accessControl, simulateAccessRequest } from '../src/bot/access-control.js'
import { coalesceLongMessages } from '../src/bot/coalesce.js'
import { llmStream } from '../src/bot/llm-stream.js'

const token = kev.mustGet('BOT_TOKEN')

// Share the storage between accessControl() and the /simulate helper so
// the fake record lives where the plugin's handlers can find it.
const storage = inMemoryStorage()

const bot = new Bot(token)
  .extend(adminContext({ adminId: 190202471 }))
  .extend(accessControl({ storage, defaults: [] }))
  .extend(coalesceLongMessages({ log: true }))
  .extend(llmStream())

  // ─── /start ────────────────────────────────────────────────────
  .command('start', (ctx) => {
    if (!ctx.access.allowed) return
    return ctx.send(
      `👋 hola\n\n` +
        `🔑 access.source: ${ctx.access.source}\n` +
        `👑 isAdmin: ${ctx.isAdmin}\n` +
        `🆔 adminId: ${ctx.adminId}\n\n` +
        `Comandos disponibles:\n` +
        `  /stream   — demo de streaming markdown\n` +
        `  /access   — menú admin (sólo admin)\n` +
        `  /simulate — fake access request (sólo admin)\n\n` +
        `Pega cualquier texto >4096 chars para probar coalesce.`,
    )
  })

  // ─── /stream — exercises llmStream ─────────────────────────────
  .command('stream', async (ctx) => {
    if (!ctx.access.allowed) return
    const stream = ctx.startStream()
    for await (const chunk of fakeLLM()) {
      await stream.append(chunk)
    }
    await stream.end()
  })

  // ─── plain text echo — exercises coalesce ──────────────────────
  // Any non-command message: report the length we received.
  // If you paste >4096 chars, Telegram splits it client-side; coalesce
  // joins them; this handler should see ONE event with the full
  // length (~paste size). If coalesce is broken, you'd see two events
  // each with <4096.
  .on('message', (ctx) => {
    if (!ctx.access.allowed) return
    if (ctx.text?.startsWith('/')) return // commands handled above
    return ctx.send(
      `📏 recibido: ${ctx.text?.length ?? 0} chars\n\n` +
        `Si pegaste un texto largo y este número es la longitud ` +
        `total (no la mitad), coalesce funciona.`,
    )
  })

  // ─── /simulate — fake "stranger DMed the bot" ──────────────────
  .command('simulate', async (ctx) => {
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
    await ctx.send(
      `🧪 simulated request from id ${fakeId}.\n` +
        `Mira arriba — debería haber llegado la notificación con ✅/❌.`,
    )
  })

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
