/**
 * GramIO LLM toolkit — three primitives that together form a complete
 * Telegram LLM-chatbot pipeline:
 *
 *   `streamChat(response)`   — INPUT. Parses OpenAI-compatible SSE
 *                              (OpenAI, vllm, mlx-lm, llama.cpp,
 *                              Together, Groq, …) into a typed
 *                              `AsyncGenerator` of `{type, text}` with
 *                              `content` / `reasoning` separation.
 *
 *   `ctx.startStream()`      — OUTPUT. Debounced `editMessageText` to
 *                              Telegram, local Markdown parse via
 *                              `@gramio/format`, 4000-char split on
 *                              paragraph / line / word boundary.
 *
 *   `ctx.llm.add / .get / …` — HISTORY. Per-(user, thread) conversation
 *                              buffer in OpenAI `ChatMessage` shape.
 *                              Persisted in the shared `@gramio/session`
 *                              record under the `llm` field, so the
 *                              `botMenu` 🗑 Forget button wipes it
 *                              together with everything else (one
 *                              record, one delete, no per-plugin
 *                              registry).
 *
 * The trio composes:
 *
 *     fetch(...) ──streamChat──> chunks ──ctx.startStream──> Telegram
 *           ▲                                                   │
 *           └──── ctx.llm.get() ◀──── ctx.llm.add(assistant) ◀──┘
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/format`, `marked`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { session } from '@gramio/session'
 * import {
 *   llmStream, llmHistory, streamChat,
 * } from '@adriangalilea/utils/bot/llm'
 *
 * const userSession = session({ storage, key: 'session', initial: () => ({}) })
 * const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(userSession)
 *   .extend(llmStream())
 *   .extend(chat.plugin)
 *   .on('message', async (ctx) => {
 *     ctx.llm.add({ role: 'user', content: ctx.text ?? '' })
 *     const messages = ctx.llm.get()
 *
 *     const response = await fetch(process.env.LLM_URL!, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({
 *         model: process.env.LLM_MODEL,
 *         messages: [{ role: 'system', content: 'You are helpful.' }, ...messages],
 *         stream: true,
 *       }),
 *     })
 *
 *     const stream = ctx.startStream()
 *     let assistant = ''
 *     for await (const chunk of streamChat(response)) {
 *       if (chunk.type === 'content') {
 *         assistant += chunk.text
 *         await stream.append(chunk.text)
 *       }
 *     }
 *     await stream.end()
 *     ctx.llm.add({ role: 'assistant', content: assistant })
 *   })
 *
 * bot.start()
 */
import { type DeriveDefinitions, Plugin } from 'gramio'
import { session } from '@gramio/session'
import { markdownToFormattable } from '@gramio/format/markdown'

// ─── INPUT: OpenAI-compatible SSE parser ───────────────────────────

/**
 * A single chunk yielded by `streamChat`. Two kinds:
 *
 *   - `content`   — the visible reply text the user should see
 *   - `reasoning` — chain-of-thought / "thinking" text from reasoning
 *                   models. Empty unless the model emits it.
 *
 * Most callers care about `content` only. Render `reasoning` separately
 * (collapsed, italicized) if you want to surface thinking.
 */
export type LLMChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }

/** OpenAI chat-completions chunk delta. Lifted into a real type so
 *  the parser's `any`-casts are contained to one spot. */
type OpenAIDelta = {
  content?: string
  reasoning?: string
  reasoning_content?: string
}
type OpenAIChunk = { choices?: Array<{ delta?: OpenAIDelta }> }

/**
 * Parse an OpenAI-compatible chat-completions SSE response into a
 * typed `AsyncGenerator<LLMChunk>`. Reads `response.body` once.
 *
 * Recognised reasoning aliases (as of 2026): `reasoning_content`
 * (vllm, qwen3, DeepSeek-R1, gpt-oss harmony) and `reasoning` (some
 * mlx-lm forks, gemma builds). If a model surfaces a new key, add it
 * here — single source of truth for the field.
 *
 * Constrained-SSE assumption: lines are `\n`-delimited and each event
 * is `data: <json>` or `data: [DONE]`. This matches every OpenAI-compat
 * server in the wild but is NOT the full SSE spec (no comments, no
 * multi-line `data:`, no `retry`/`id` fields). Swap to
 * `eventsource-parser` if you hit a producer that needs them.
 *
 * Malformed JSON lines are silently skipped; the generator ends when
 * the stream closes.
 *
 * @param response  the `fetch` `Response` from a `stream: true` chat
 *                  completion call. Must not be already consumed.
 * @throws if `response.body` is null (non-streaming response).
 *
 * @example  framework-agnostic — parser doesn't know about Telegram
 * const res = await fetch(url, { method: 'POST', body })
 * for await (const chunk of streamChat(res)) {
 *   if (chunk.type === 'content') process.stdout.write(chunk.text)
 * }
 */
export async function* streamChat(
  response: Response,
): AsyncGenerator<LLMChunk> {
  if (!response.body) throw new Error('streamChat: response.body is null')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      let parsed: OpenAIChunk
      try {
        parsed = JSON.parse(data) as OpenAIChunk
      } catch {
        continue
      }
      const delta = parsed.choices?.[0]?.delta
      if (!delta) continue
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'reasoning', text: reasoning }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'content', text: delta.content }
      }
    }
  }
}

// ─── OUTPUT: Telegram streamer ─────────────────────────────────────

const MAX_LEN = 4000 // Telegram caps at 4096; leave headroom for entity offsets
const DEFAULT_DEBOUNCE_MS = 800

export type StreamOptions = {
  /** Debounce window between edits, in ms. Default 800. */
  debounceMs?: number
  /** Initial placeholder shown until the first chunk arrives. Default "…". */
  placeholder?: string
  /** Parse buffer as markdown. Default true. Set false for plain text streaming. */
  markdown?: boolean
  /** Called on edit/send errors after internal recovery (rate limits, etc.). */
  onError?: (err: unknown) => void
}

export class MarkdownStreamer {
  private buffer = ''
  private currentMessageId?: number
  private firstSendPromise?: Promise<void>
  private debounceTimer?: ReturnType<typeof setTimeout>
  private inFlight = false
  private dirty = false
  private ended = false

  private chatId: number
  private threadId?: number
  // Match gramio's `bot.api` shape structurally. `text` accepts string or any
  // `Formattable` (from `@gramio/format`) — both stringify safely. We don't
  // import gramio's full Bot type to keep the streamer testable in isolation.
  private bot: {
    api: {
      sendMessage: (p: {
        chat_id: number
        message_thread_id?: number
        text: string | { toString(): string }
      }) => Promise<{ message_id: number }>
      editMessageText: (p: {
        chat_id: number
        message_id: number
        text: string | { toString(): string }
      }) => Promise<unknown>
    }
  }
  private opts: Required<StreamOptions>

  constructor(
    ctx: {
      chat: { id: number }
      threadId?: number
      bot: MarkdownStreamer['bot']
    },
    opts: StreamOptions,
  ) {
    this.chatId = ctx.chat.id
    // Captured so the streamed reply stays in the same thread.
    // We call bot.api.sendMessage directly (no ctx.send), so the
    // SendMixin's auto-thread doesn't help us here.
    this.threadId = ctx.threadId
    this.bot = ctx.bot
    this.opts = {
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      placeholder: opts.placeholder ?? '…',
      markdown: opts.markdown ?? true,
      onError: opts.onError ?? ((e) => console.error('[bot/llm:stream]', e)),
    }
  }

  /** Append a chunk. Schedules a debounced edit. */
  async append(text: string): Promise<void> {
    if (this.ended) throw new Error('stream already ended')
    if (!text) return

    // first chunk: send the placeholder so we have a message_id to edit.
    // Serialized via firstSendPromise so concurrent appends don't double-send.
    if (this.currentMessageId === undefined && !this.firstSendPromise) {
      this.firstSendPromise = (async () => {
        const sent = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          ...(this.threadId !== undefined && { message_thread_id: this.threadId }),
          text: this.opts.placeholder,
        })
        this.currentMessageId = sent.message_id
      })()
    }
    if (this.firstSendPromise) await this.firstSendPromise

    // overflow: freeze current message at last good split, start a new one.
    const next = this.buffer + text
    if (next.length > MAX_LEN) {
      const splitAt = findSplit(next, MAX_LEN)
      const head = next.slice(0, splitAt)
      const tail = next.slice(splitAt).trimStart()

      this.buffer = head
      this.dirty = true
      await this.flushNow() // commits head into current message

      this.buffer = ''
      this.currentMessageId = undefined
      this.firstSendPromise = undefined
      this.dirty = false
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = undefined
      }

      if (tail) await this.append(tail)
      return
    }

    this.buffer = next
    this.dirty = true
    this.scheduleFlush()
  }

  /** Flush any pending edit and close the stream. Idempotent. */
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    while (this.inFlight) await sleep(50)
    if (this.dirty) await this.flushNow()
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = undefined
      if (this.inFlight) {
        this.scheduleFlush()
        return
      }
      await this.flushNow()
      if (this.dirty && !this.ended) this.scheduleFlush()
    }, this.opts.debounceMs)
  }

  private async flushNow(): Promise<void> {
    if (!this.dirty) return
    if (this.currentMessageId === undefined) {
      // No active message yet — likely the first send is still in flight
      // or the recovery path cleared it. Caller's next append() will
      // re-create one.
      return
    }
    this.inFlight = true
    this.dirty = false
    const snapshot = this.buffer
    try {
      const payload = this.opts.markdown ? markdownToFormattable(snapshot) : snapshot
      await this.bot.api.editMessageText({
        chat_id: this.chatId,
        message_id: this.currentMessageId,
        text: payload,
      })
    } catch (e) {
      const msg = String((e as { message?: string } | undefined)?.message ?? e)
      if (msg.includes('message is not modified')) {
        // identical content — fine
      } else if (msg.includes('message to edit not found')) {
        // message gone (deleted by user, etc.) — restart with a fresh send
        this.currentMessageId = undefined
        this.firstSendPromise = undefined
        this.dirty = true
      } else {
        this.dirty = true
        this.opts.onError(e)
      }
    } finally {
      this.inFlight = false
    }
  }
}

/**
 * GramIO plugin. Adds `ctx.startStream(opts?)` on every message context.
 *
 * Defaults set here apply to every stream; per-call options in
 * `ctx.startStream({...})` override them.
 */
export const llmStream = (defaults: StreamOptions = {}) =>
  new Plugin('@adriangalilea/utils/bot/llm/stream').derive('message', (ctx) => ({
    // gramio's `message` scope guarantees `ctx.chat`. `ctx.bot.api` is on
    // every Context. Structural compat → no cast needed.
    startStream: (opts: StreamOptions = {}) =>
      new MarkdownStreamer(ctx, { ...defaults, ...opts }),
  }))

function findSplit(text: string, maxLen: number): number {
  // Prefer paragraph break, then line, then space. Reject splits in the
  // first half — better to truncate at maxLen than to leave a stub.
  for (const sep of ['\n\n', '\n', ' ']) {
    const idx = text.lastIndexOf(sep, maxLen)
    if (idx > maxLen / 2) return idx
  }
  return maxLen
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── HISTORY: per-thread conversation buffer ───────────────────────

/**
 * Multimodal content shape from OpenAI's chat-completions spec. Either
 * a plain string or an ordered array of typed parts. Image URLs cover
 * both http(s) and Telegram `getFile` resolved paths.
 */
export type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

/**
 * One turn in the conversation. The library does NOT filter by role —
 * if you persist `system` turns, they ride along on every `get()`.
 * Most callers prepend their system prompt fresh each request and only
 * persist `user` / `assistant`.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent
  /** Unix seconds when added — used for retention pruning. */
  date: number
}

/** Per-thread shards of `ChatMessage`s, persisted in the session. */
type ChatRecord = {
  shards: { [threadKey: string]: ChatMessage[] }
}

/** Loose session shape — this plugin only touches the `llm` field. */
type LLMSessionLike = { llm?: ChatRecord }

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type LLMSessionPluginRef = ReturnType<typeof session<LLMSessionLike, 'session'>>

export type LLMHistoryOptions = {
  /**
   * Shared session plugin. This plugin extends it for type flow;
   * gramio's runtime dedup ensures the session derive runs once.
   */
  session: LLMSessionPluginRef
  /** Ring buffer cap **per thread**. Oldest entries dropped past this. */
  maxTurns: number
  /** Entries older than this (in days) are dropped on read. */
  retentionDays: number
}

export type LLMHistoryFeature = {
  plugin: ReturnType<typeof buildHistoryPlugin>
}

/**
 * Methods decorated onto `ctx.llm`. All synchronous — reads/writes the
 * session record via `@gramio/session`'s Proxy, which auto-persists.
 *
 * Thread isolation is automatic: every method operates on the shard
 * for `ctx.threadId` (or `'general'` when no thread). Different threads
 * = different conversations, no leakage.
 */
export type LLMHistoryApi = {
  /** Append one message to the CURRENT thread's shard. */
  add: (message: Omit<ChatMessage, 'date'> & { date?: number }) => void
  /** Pruned snapshot of the CURRENT thread, oldest-first. */
  get: () => ReadonlyArray<ChatMessage>
  /** Wipe the CURRENT thread's shard. */
  clear: () => void
  /**
   * Full sharded map, pruned. Use for /export or admin views. Keys are
   * thread ids (or `'general'`) → ordered messages.
   */
  all: () => Readonly<{ [threadKey: string]: ReadonlyArray<ChatMessage> }>
  /** Wipe ALL threads for this user. */
  clearAll: () => void
}

type LLMHistoryDerives = { llm: LLMHistoryApi }

const GENERAL_THREAD = 'general'

const threadKey = (ctx: {
  threadId?: number
  message?: { threadId?: number }
}): string => {
  // Message events: ctx.threadId. Callback events: ctx.message.threadId.
  const tid = ctx.threadId ?? ctx.message?.threadId
  return tid !== undefined ? String(tid) : GENERAL_THREAD
}

const prune = (
  items: ChatMessage[],
  maxTurns: number,
  retentionDays: number,
): ChatMessage[] => {
  const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400
  const fresh = items.filter((m) => m.date >= cutoffSec)
  return fresh.slice(-maxTurns)
}

const pruneAll = (
  shards: ChatRecord['shards'],
  maxTurns: number,
  retentionDays: number,
): ChatRecord['shards'] => {
  const out: ChatRecord['shards'] = {}
  for (const k of Object.keys(shards)) {
    const pruned = prune(shards[k], maxTurns, retentionDays)
    if (pruned.length > 0) out[k] = pruned
  }
  return out
}

/**
 * Per-(user, thread) LLM conversation history. Opt-in. Persists in the
 * shared `@gramio/session` record under `llm`, so 🗑 Forget from
 * `botMenu` wipes it together with everything else — one record, one
 * delete, no per-plugin registry.
 *
 * @example
 * const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })
 * bot.extend(chat.plugin)
 *    .on('message', (ctx) => {
 *      ctx.llm.add({ role: 'user', content: ctx.text ?? '' })
 *      const messages = ctx.llm.get()        // ChatMessage[] for current thread
 *      // ... call LLM with messages, then:
 *      ctx.llm.add({ role: 'assistant', content: reply })
 *    })
 */
export const llmHistory = (opts: LLMHistoryOptions): LLMHistoryFeature => {
  if (opts.maxTurns <= 0) throw new Error('llmHistory: maxTurns must be > 0')
  if (opts.retentionDays <= 0) throw new Error('llmHistory: retentionDays must be > 0')

  const plugin = buildHistoryPlugin({
    sessionPlugin: opts.session,
    maxTurns: opts.maxTurns,
    retentionDays: opts.retentionDays,
  })

  return { plugin }
}

const buildHistoryPlugin = (args: {
  sessionPlugin: LLMSessionPluginRef
  maxTurns: number
  retentionDays: number
}) => {
  const { sessionPlugin, maxTurns, retentionDays } = args

  return new Plugin<{}, DeriveDefinitions & { global: LLMHistoryDerives }>(
    '@adriangalilea/utils/bot/llm/history',
  )
    .extend(sessionPlugin)
    .derive(['message', 'callback_query'], (ctx): LLMHistoryDerives => {
      const key = threadKey(ctx)

      // Always operate against a freshly-pruned view. Writes go to the
      // pruned base so stale entries never resurface after a read.
      const readShards = (): ChatRecord['shards'] =>
        pruneAll(ctx.session.llm?.shards ?? {}, maxTurns, retentionDays)

      const writeShards = (shards: ChatRecord['shards']): void => {
        ctx.session.llm = { shards }
      }

      return {
        llm: {
          add: (message) => {
            const shards = readShards()
            const cur = shards[key] ?? []
            const entry: ChatMessage = {
              role: message.role,
              content: message.content,
              date: message.date ?? Math.floor(Date.now() / 1000),
            }
            shards[key] = [...cur, entry].slice(-maxTurns)
            writeShards(shards)
          },
          get: () =>
            (readShards()[key] ?? []) as ReadonlyArray<ChatMessage>,
          clear: () => {
            const shards = readShards()
            delete shards[key]
            writeShards(shards)
          },
          all: () =>
            readShards() as Readonly<{
              [threadKey: string]: ReadonlyArray<ChatMessage>
            }>,
          clearAll: () => {
            writeShards({})
          },
        },
      }
    })
}
