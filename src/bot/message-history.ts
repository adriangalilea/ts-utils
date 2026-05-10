/**
 * Per-user rolling message history for GramIO bots — opt-in, with
 * retention.
 *
 * Follows the same shared-session pattern as `bot/language`: the
 * user creates a `session()` once at bot level, and each feature
 * plugin (including this one) declares it as a dependency. gramio
 * dedupes the runtime extension; the types flow.
 *
 * ## What this plugin owns
 *
 *   - Appends each incoming user message to `ctx.session.history.items`
 *   - Prunes entries older than `retentionDays` or beyond `maxMessages`
 *   - Exposes a read-only pruned snapshot at `ctx.history` for handlers
 *
 * ## GDPR caveat — retention IS personal data
 *
 * Unlike `bot/language` (preference data, covered by Telegram's standard
 * privacy policy), retaining user **message content** is the one thing
 * the [standard policy](https://telegram.org/privacy-tpa) does NOT cover
 * by default. If you extend `messageHistory`, you should:
 *
 *   1. Set a custom `privacy` URL on your `botMenu` describing what you
 *      retain and for how long.
 *   2. Pass `personalData: { storage }` to your `botMenu` so 🗑 Forget
 *      and 📥 Export buttons appear — letting users see and delete
 *      the data you keep about them.
 *
 * These are not enforced by this plugin (would couple it to menu); they
 * are documented as the bot author's legal responsibility.
 *
 * ## Storage layout
 *
 * Lives entirely inside the shared session record:
 *
 *   storage[String(senderId)] = {
 *     ...other plugins' fields,
 *     history: { items: [HistoryEntry, ...] }
 *   }
 *
 * Peer deps: `gramio`, `@gramio/session`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { messageHistory } from '@adriangalilea/utils/bot/message-history'
 *
 * const userSession = session({ storage: redisStorage(), key: 'session', initial: () => ({}) })
 *
 * const history = messageHistory({
 *   session: userSession,
 *   maxMessages: 100,
 *   retentionDays: 7,
 * })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(userSession)
 *   .extend(history.plugin)
 *   .command('replay', (ctx) => {
 *     const last = ctx.history.slice(-3).map((e) => e.text).join('\n---\n')
 *     return ctx.send(last || '(no history)')
 *   })
 */
import { type DeriveDefinitions, Plugin } from 'gramio'
import { session } from '@gramio/session'

// ─── public types ──────────────────────────────────────────────────

export type HistoryEntry = {
  /** Telegram message id. */
  messageId: number
  /** Unix seconds (Telegram's `message.date`). */
  date: number
  /** Message text, or empty string if non-text. */
  text: string
}

export type HistoryRecord = {
  items: HistoryEntry[]
}

/** Loose session shape — this plugin only touches the `history` field. */
type SessionLike = { history?: HistoryRecord }

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type HistorySessionPluginRef = ReturnType<typeof session<SessionLike, 'session'>>

export type MessageHistoryOptions = {
  /**
   * Shared session plugin. This plugin extends it for the type flow;
   * gramio's runtime dedup ensures it only runs once per update.
   */
  session: HistorySessionPluginRef
  /** Ring buffer cap. Oldest entries dropped when exceeded. */
  maxMessages: number
  /** Entries older than this (in days) are dropped on read. */
  retentionDays: number
}

export type MessageHistoryFeature = {
  plugin: ReturnType<typeof buildHistoryPlugin>
}

// ─── derives ───────────────────────────────────────────────────────

type HistoryDerives = {
  history: ReadonlyArray<HistoryEntry>
}

// ─── helpers ───────────────────────────────────────────────────────

const prune = (
  items: HistoryEntry[],
  maxMessages: number,
  retentionDays: number,
): HistoryEntry[] => {
  const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400
  const fresh = items.filter((e) => e.date >= cutoffSec)
  return fresh.slice(-maxMessages)
}

// ─── feature factory ───────────────────────────────────────────────

export const messageHistory = (opts: MessageHistoryOptions): MessageHistoryFeature => {
  if (opts.maxMessages <= 0) throw new Error('messageHistory: maxMessages must be > 0')
  if (opts.retentionDays <= 0) throw new Error('messageHistory: retentionDays must be > 0')

  const plugin = buildHistoryPlugin({
    sessionPlugin: opts.session,
    maxMessages: opts.maxMessages,
    retentionDays: opts.retentionDays,
  })

  return { plugin }
}

// ─── plugin builder ────────────────────────────────────────────────

const buildHistoryPlugin = (args: {
  sessionPlugin: HistorySessionPluginRef
  maxMessages: number
  retentionDays: number
}) => {
  const { sessionPlugin, maxMessages, retentionDays } = args

  return new Plugin<{}, DeriveDefinitions & { global: HistoryDerives }>(
    '@adriangalilea/utils/bot/message-history',
  )
    .extend(sessionPlugin)
    // Record incoming messages with text. Service messages, edits,
    // and callback queries don't append — only direct user input.
    .on('message', async (ctx, next) => {
      if (ctx.text !== undefined) {
        const entry: HistoryEntry = {
          messageId: ctx.id,
          date: ctx.payload.date,
          text: ctx.text,
        }
        const cur = ctx.session.history?.items ?? []
        ctx.session.history = {
          items: [...prune(cur, maxMessages, retentionDays), entry].slice(
            -maxMessages,
          ),
        }
      }
      return next()
    })
    // Pruned read-only view for handlers downstream.
    .derive(['message', 'callback_query'], (ctx): HistoryDerives => ({
      history: prune(
        ctx.session.history?.items ?? [],
        maxMessages,
        retentionDays,
      ) as ReadonlyArray<HistoryEntry>,
    }))
}
