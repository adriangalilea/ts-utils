/**
 * Per-user rolling message history for GramIO bots — opt-in, with
 * retention, **sharded by thread**.
 *
 * Each user has one session record. Inside that record, `history` keeps
 * a separate ring buffer per thread:
 *
 *     storage[userId].history.shards = {
 *       'general':   [ ...entries from no-thread messages ],
 *       '12345':     [ ...entries from message_thread_id=12345 ],
 *       '98765':     [ ...entries from message_thread_id=98765 ],
 *     }
 *
 * This makes the plugin compatible with both forum-supergroup topics
 * and BotFather's Threaded Mode for private chats (which is the whole
 * point of those features: parallel conversations with separate
 * context). `ctx.history` returns ONLY the slice for the current
 * thread; `ctx.allHistory` returns the full sharded map when you need
 * a cross-thread view (e.g. for `/export`).
 *
 * Thread key: `String(ctx.threadId)`, or `'general'` when no thread.
 *
 * ## What this plugin owns
 *
 *   - Appends each incoming user message to the shard for its thread
 *   - Prunes per-shard by `retentionDays` and `maxMessages`
 *   - Exposes `ctx.history` (current thread's pruned slice) and
 *     `ctx.allHistory` (full map) to handlers
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
 *   maxMessages: 100,         // cap per-thread
 *   retentionDays: 7,
 * })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(userSession)
 *   .extend(history.plugin)
 *   .command('replay', (ctx) => {
 *     const last = ctx.history.slice(-3).map((e) => e.text).join('\n---\n')
 *     return ctx.send(last || '(no history in this thread)')
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

/**
 * Per-thread shards. Key is `String(ctx.threadId)` or `'general'`
 * when no thread. Each shard is an independently capped + pruned
 * ring buffer.
 */
export type HistoryRecord = {
  shards: { [threadKey: string]: HistoryEntry[] }
}

const GENERAL_THREAD = 'general'

const threadKey = (ctx: {
  threadId?: number
  message?: { threadId?: number }
}): string => {
  // Message events: ctx.threadId. Callback events: ctx.message.threadId.
  const tid = ctx.threadId ?? ctx.message?.threadId
  return tid !== undefined ? String(tid) : GENERAL_THREAD
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
  /** Ring buffer cap **per thread**. Oldest entries dropped when exceeded. */
  maxMessages: number
  /** Entries older than this (in days) are dropped on read. */
  retentionDays: number
}

export type MessageHistoryFeature = {
  plugin: ReturnType<typeof buildHistoryPlugin>
}

// ─── derives ───────────────────────────────────────────────────────

type HistoryDerives = {
  /** Pruned snapshot for the CURRENT thread only. */
  history: ReadonlyArray<HistoryEntry>
  /**
   * Pruned snapshot of all threads, keyed by thread (`'general'` or
   * stringified threadId). Use for cross-thread views (e.g. /export).
   */
  allHistory: Readonly<{ [threadKey: string]: ReadonlyArray<HistoryEntry> }>
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

const pruneAll = (
  shards: HistoryRecord['shards'],
  maxMessages: number,
  retentionDays: number,
): HistoryRecord['shards'] => {
  const out: HistoryRecord['shards'] = {}
  for (const k of Object.keys(shards)) {
    const pruned = prune(shards[k], maxMessages, retentionDays)
    if (pruned.length > 0) out[k] = pruned
  }
  return out
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
    // Record incoming messages with text into their thread's shard.
    // Service messages, edits, and callback queries don't append —
    // only direct user input.
    .on('message', async (ctx, next) => {
      if (ctx.text !== undefined) {
        const entry: HistoryEntry = {
          messageId: ctx.id,
          date: ctx.payload.date,
          text: ctx.text,
        }
        const key = threadKey(ctx)
        const shards = { ...(ctx.session.history?.shards ?? {}) }
        const cur = shards[key] ?? []
        shards[key] = [
          ...prune(cur, maxMessages, retentionDays),
          entry,
        ].slice(-maxMessages)
        ctx.session.history = { shards }
      }
      return next()
    })
    // Read-only views for handlers downstream.
    .derive(['message', 'callback_query'], (ctx): HistoryDerives => {
      const shards = ctx.session.history?.shards ?? {}
      const allPruned = pruneAll(shards, maxMessages, retentionDays)
      const key = threadKey(ctx)
      return {
        history: (allPruned[key] ?? []) as ReadonlyArray<HistoryEntry>,
        allHistory: allPruned as Readonly<{
          [threadKey: string]: ReadonlyArray<HistoryEntry>
        }>,
      }
    })
}
