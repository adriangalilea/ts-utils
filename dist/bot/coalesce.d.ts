/**
 * Coalesce client-split inbound messages.
 *
 * Telegram clients (Desktop / iOS / web) split a single message > 4096
 * chars into multiple `sendMessage` calls before they ever reach the
 * server. The bot receives them as **separate** `message` updates with
 * no marker linking them. This middleware joins them back into one
 * event so your handlers see the full text.
 *
 *     user pastes 8000 chars → client splits in 2 → bot gets 2 updates
 *                                                            │
 *                                                            ▼
 *                                                 coalesce middleware
 *                                                            │
 *                                                     hold + join
 *                                                            │
 *                                                            ▼
 *                                              handler sees ONE event
 *                                              with full ctx.text
 *
 * ## Detection rule (strict)
 *
 * We coalesce only when ALL hold. Otherwise fragments pass through
 * as separate events — false negatives are preferred over silently
 * merging unrelated messages.
 *
 *   1. Same chat.
 *   2. Same user (override with `acrossUsers: true`).
 *   3. Leading fragment length ≥ `minLeadingLength` (a current
 *      guess — see the type definition for the default and the
 *      reasoning). Short messages never start a real client split.
 *   4. Each subsequent fragment within `windowMs` of the previous.
 *
 * ## Known caveats
 *
 *   - `ctx.entities` is cleared on coalesced messages — per-fragment
 *     entity offsets would point at the wrong characters once joined.
 *     Plain-text consumers don't care; formatted-input consumers
 *     should disable this plugin.
 *   - In-memory buffer; doesn't survive bot restart mid-burst.
 *
 * Peer deps: `gramio`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { coalesceLongMessages } from '@adriangalilea/utils/bot/coalesce'
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(coalesceLongMessages())     // ← before .on / .command handlers
 *   .on('message', (ctx) => {
 *     // ctx.text is the full pasted text even if Telegram split it
 *     return ctx.send(`got ${ctx.text?.length} chars`)
 *   })
 *
 * @example  Power-user escape hatch
 *
 * import { isCoalescent } from '@adriangalilea/utils/bot/coalesce'
 *
 * if (isCoalescent(prev, curr)) {
 *   // do your own thing
 * }
 */
import { Plugin } from 'gramio';
export type CoalesceCriteria = {
    /**
     * Minimum length of the leading fragment to consider a possible
     * client split. Below this → never coalesce, zero latency. Once
     * the buffer is open, follow-up fragments of any size join.
     */
    minLeadingLength?: number;
    /**
     * Max ms between consecutive fragments to consider them part of
     * one client-split burst.
     */
    windowMs?: number;
    /**
     * If true, fragments from different users (same chat) can coalesce.
     * Useful for "user forwarded a multi-author conversation as one
     * logical block."
     */
    acrossUsers?: boolean;
};
export type CoalesceLongMessagesOptions = CoalesceCriteria & {
    /**
     * Log each fragment + buffer transition to stderr for debugging.
     * Off by default.
     */
    log?: boolean;
};
/**
 * Pure check: are these two fragments part of the same client-split
 * burst? Use this if you want to make your own decision instead of
 * letting the middleware do it.
 *
 * The two fragments are passed as plain objects so this function is
 * decoupled from gramio's context type. Adapt your context as needed.
 */
export type CoalesceFragment = {
    text: string;
    chatId: number;
    userId: number;
    /** Timestamp in **milliseconds** (use `Date.now()` or `msg.date * 1000`). */
    dateMs: number;
};
export declare const isCoalescent: (prev: CoalesceFragment, curr: CoalesceFragment, opts?: CoalesceCriteria) => boolean;
export declare const coalesceLongMessages: (opts?: CoalesceLongMessagesOptions) => Plugin<{}, import("gramio").DeriveDefinitions, {}>;
//# sourceMappingURL=coalesce.d.ts.map