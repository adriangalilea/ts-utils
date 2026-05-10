/**
 * LLM streaming output for GramIO bots.
 *
 * Sends a placeholder, then debounces `editMessageText` calls as the
 * LLM produces chunks. Markdown is parsed locally with
 * `markdownToFormattable` — invalid markup degrades to plain text
 * instead of failing (Telegram's `parse_mode` would reject the whole
 * message). Splits at 4000 chars by promoting the next chunk to a
 * fresh message at a paragraph/line/word boundary.
 *
 * Peer deps: `gramio`, `@gramio/format`, `marked`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { llmStream } from '@adriangalilea/utils/bot/llm-stream'
 * import Anthropic from '@anthropic-ai/sdk'
 *
 * const claude = new Anthropic()
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(llmStream())
 *   .on('message', async (ctx) => {
 *     const stream = ctx.startStream()
 *     const sse = await claude.messages.stream({
 *       model: 'claude-opus-4-5',
 *       max_tokens: 1024,
 *       messages: [{ role: 'user', content: ctx.text ?? '' }],
 *     })
 *     for await (const chunk of sse) {
 *       if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
 *         await stream.append(chunk.delta.text)
 *       }
 *     }
 *     await stream.end()
 *   })
 *
 * bot.start()
 */
import { Plugin } from 'gramio';
export type StreamOptions = {
    /** Debounce window between edits, in ms. Default 800. */
    debounceMs?: number;
    /** Initial placeholder shown until the first chunk arrives. Default "…". */
    placeholder?: string;
    /** Parse buffer as markdown. Default true. Set false for plain text streaming. */
    markdown?: boolean;
    /** Called on edit/send errors after internal recovery (rate limits, etc.). */
    onError?: (err: unknown) => void;
};
export declare class MarkdownStreamer {
    private buffer;
    private currentMessageId?;
    private firstSendPromise?;
    private debounceTimer?;
    private inFlight;
    private dirty;
    private ended;
    private chatId;
    private bot;
    private opts;
    constructor(ctx: {
        chat: {
            id: number;
        };
        bot: MarkdownStreamer['bot'];
    }, opts: StreamOptions);
    /** Append a chunk. Schedules a debounced edit. */
    append(text: string): Promise<void>;
    /** Flush any pending edit and close the stream. Idempotent. */
    end(): Promise<void>;
    private scheduleFlush;
    private flushNow;
}
/**
 * GramIO plugin. Adds `ctx.startStream(opts?)` on every message context.
 *
 * Defaults set here apply to every stream; per-call options in
 * `ctx.startStream({...})` override them.
 */
export declare const llmStream: (defaults?: StreamOptions) => Plugin<{}, import("gramio").DeriveDefinitions & {
    message: {
        startStream: (opts?: StreamOptions) => MarkdownStreamer;
    };
}, {}>;
//# sourceMappingURL=llm-stream.d.ts.map