/**
 * LLM streaming for GramIO bots — both halves of the pipeline:
 *
 *   `streamChat(response)`   — INPUT: parse OpenAI-compatible SSE
 *                              (OpenAI, vllm, mlx-lm, llama.cpp, Together,
 *                              Groq, …) into a typed `AsyncGenerator` of
 *                              `{ type: 'content' | 'reasoning', text }`.
 *
 *   `ctx.startStream()`      — OUTPUT: debounced `editMessageText` to
 *                              Telegram. Local Markdown parse via
 *                              `@gramio/format` so malformed mid-stream
 *                              markup degrades to plain text instead of
 *                              failing. Splits at 4000 chars on
 *                              paragraph / line / word boundary.
 *
 * The two compose into the canonical bot pipeline:
 *
 *     fetch(...) ──streamChat──> {content, reasoning} chunks ──ctx.startStream──> Telegram
 *
 * Peer deps: `gramio`, `@gramio/format`, `marked`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { llmStream, streamChat } from '@adriangalilea/utils/bot/llm-stream'
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(llmStream())
 *   .on('message', async (ctx) => {
 *     const response = await fetch(process.env.LLM_URL!, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({
 *         model: process.env.LLM_MODEL,
 *         messages: [{ role: 'user', content: ctx.text ?? '' }],
 *         stream: true,
 *       }),
 *     })
 *     const stream = ctx.startStream()
 *     for await (const chunk of streamChat(response)) {
 *       if (chunk.type === 'content') await stream.append(chunk.text)
 *       // chunk.type === 'reasoning' is also yielded for thinking models
 *     }
 *     await stream.end()
 *   })
 *
 * bot.start()
 */
import { Plugin } from 'gramio'
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
      onError: opts.onError ?? ((e) => console.error('[llm-stream]', e)),
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
  new Plugin('@adriangalilea/utils/bot/llm-stream').derive('message', (ctx) => ({
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
