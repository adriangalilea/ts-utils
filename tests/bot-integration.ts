/**
 * Runnable smoke-test for the four GramIO plugins shipped with this package.
 *
 * Run:
 *   BOT_TOKEN=… pnpm tsx tests/bot-integration.ts
 *
 * Manual test plan (commands are admin-only unless noted):
 *
 *   /start      — shows you which gate let the request through
 *                 (admin / default / store), plus thread/topic info
 *                 for the chat the command was sent in.
 *   /stream     — exercises llmStream: streams a markdown reply with
 *                 bullets, code, and a blockquote
 *   <any text>  — echoes the message back into the same thread, plus
 *                 exercises coalesceLongMessages. Paste >4096 chars
 *                 and the echo should report the full length, not half.
 *   /access     — opens the persistent admin menu (Aprobados, Pendientes,
 *                 Denegados, Refresh, Cerrar)
 *   /simulate   — fakes "another user just DMed the bot"; you'll receive an
 *                 admin notification with [✅ Aprobar][❌ Denegar]. Tapping
 *                 those buttons hits the real handlers, no second account
 *                 needed.
 *
 *   Ctrl-C      — gracefulStart catches SIGINT → bot.stop() → exit 0
 *
 * ## Threaded Mode demo (BotFather → bot → Bot Settings → Threaded Mode)
 *
 * With Threaded Mode enabled for the bot, your private chat can have
 * multiple parallel topic threads. Each incoming message carries
 * `message_thread_id`, surfaced as `ctx.threadId`. With this repo's
 * pinned fork of `@gramio/contexts`, the SendMixin auto-forwards
 * `message_thread_id` on every `ctx.send` family call — replies stay
 * in their thread automatically. `llmHistory` shards conversation
 * state per thread, so each thread is its own conversation.
 */
import { Bot } from 'gramio'
import { session } from '@gramio/session'
import { inMemoryStorage } from '@gramio/storage'
import { kev } from '../src/platform/kev.js'
import { adminContext, gracefulStart } from '../src/bot/kit.js'
import { accessControl, simulateAccessRequest } from '../src/bot/access-control.js'
import { coalesceLongMessages } from '../src/bot/coalesce.js'
import { llmStream, llmHistory } from '../src/bot/llm.js'
import { botMenu } from '../src/bot/menu.js'
import { language } from '../src/bot/language.js'

const token = kev.mustGet('BOT_TOKEN')

const storage = inMemoryStorage()

// Shared session — one record per user, with each plugin owning a
// distinct field by convention (`access`, `language`, `llm`).
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

const chat = llmHistory({
  session: userSession,
  maxTurns: 20,
  retentionDays: 7,
})

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@adriangalilea',
  personalData: { storage },     // ← enables 🗑 Forget · 📥 Export (wipes ctx.llm too)
  items: [
    lang.menuItem,
    {
      id: 'recent',
      label: '📜 Show last 3 turns (this thread)',
      action: async (ctx) => {
        // ctx.llm is sharded per thread → this shows the current
        // thread's last 3 messages, not the global feed.
        type Helpers = {
          llm?: { get: () => ReadonlyArray<{ role: string; content: unknown }> }
          send: (t: string, params?: object) => Promise<unknown>
        }
        const c = ctx as unknown as Helpers
        const last = (c.llm?.get() ?? [])
          .slice(-3)
          .map(
            (m, i) =>
              `${i + 1}. [${m.role}] ${
                typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
              }`,
          )
          .join('\n')
        await c.send(last || '(no turns in this thread yet)')
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
  .extend(chat.plugin)
  .extend(lang.plugin)
  .extend(menu.plugin)

  // ─── /start ────────────────────────────────────────────────────
  .command('start', { description: 'Show what the bot can do' }, (ctx) => {
    if (!ctx.access.allowed) return
    const threadLine =
      `🧵 ctx.threadId: ${ctx.threadId ?? '(none)'}\n` +
      `   isTopicMessage: ${ctx.isTopicMessage()}\n` +
      `   directMessagesTopic: ${ctx.directMessagesTopic?.topicId ?? '(none)'}`
    // Auto-threads via gramio SendMixin (forked, see README).
    return ctx.say.send({
      en:
        `👋 hi\n\n` +
        `🔑 access.source: ${ctx.access.source}\n` +
        `👑 isAdmin: ${ctx.isAdmin}\n` +
        `🆔 adminId: ${ctx.adminId}\n` +
        `🌐 ctx.lang: ${ctx.lang}\n` +
        `${threadLine}\n\n` +
        `Commands:\n` +
        `  /settings — user menu (language + forget/export/privacy)\n` +
        `  /stream   — streaming markdown demo\n` +
        `  /access   — admin menu (admin only)\n` +
        `  /simulate — fake access request (admin only)\n\n` +
        `Paste >4096 chars to test coalesce. Send any text to see the echo + thread routing.`,
      es:
        `👋 hola\n\n` +
        `🔑 access.source: ${ctx.access.source}\n` +
        `👑 isAdmin: ${ctx.isAdmin}\n` +
        `🆔 adminId: ${ctx.adminId}\n` +
        `🌐 ctx.lang: ${ctx.lang}\n` +
        `${threadLine}\n\n` +
        `Comandos:\n` +
        `  /settings — menu user-facing (language + forget/export/privacy)\n` +
        `  /stream   — demo streaming markdown\n` +
        `  /access   — menú admin (sólo admin)\n` +
        `  /simulate — fake access request (sólo admin)\n\n` +
        `Pega texto >4096 chars para coalesce. Manda cualquier texto para ver el echo y el routing de thread.`,
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

  // ─── plain text echo — exercises coalesce + thread routing + ctx.llm ─
  // Any non-command message:
  //   1. records the user turn in ctx.llm (so "Show last 3 turns"
  //      in /settings actually has something to show)
  //   2. echoes back into the same thread with diagnostic info
  //   3. records the echo as the assistant turn in ctx.llm
  //
  // Coalesce: if you paste >4096 chars Telegram splits it client-side;
  // coalesce joins them, this handler sees ONE event with the full
  // length. If coalesce is broken you'd see two events of <4096 each.
  //
  // Threaded Mode demo: send the same text in two different threads —
  // each echo lands in its own thread AND each /settings → Show last
  // 3 turns lists only that thread's exchanges (no bleed).
  .on('message', async (ctx) => {
    if (!ctx.access.allowed) return
    if (ctx.text?.startsWith('/')) return // commands handled above

    const len = ctx.text?.length ?? 0
    const echo = ctx.text ?? '(non-text message)'
    // Cap the echo at 500 chars in the reply text so long pastes don't
    // double-render (coalesce stats are the point, not the content).
    const echoTrimmed = echo.length > 500 ? `${echo.slice(0, 500)}…` : echo

    const threadInfo =
      ctx.threadId !== undefined
        ? `🧵 thread: ${ctx.threadId}` +
          (ctx.directMessagesTopic
            ? ' (private-chat topic)'
            : ctx.isTopicMessage()
              ? ' (forum-supergroup topic)'
              : ' (raw threadId, no topic flag set)')
        : '🧵 no thread'

    ctx.llm.add({ role: 'user', content: echo })

    // Auto-threads via gramio SendMixin (forked, see README).
    await ctx.say.send({
      en: `📏 ${len} chars · ${threadInfo}\n\n🔁 echo:\n${echoTrimmed}`,
      es: `📏 ${len} chars · ${threadInfo}\n\n🔁 echo:\n${echoTrimmed}`,
    })

    ctx.llm.add({ role: 'assistant', content: echoTrimmed })
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
