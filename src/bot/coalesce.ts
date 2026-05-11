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
import { Plugin } from "gramio";

// Current guess. Real Telegram clients split at natural boundaries
// (newline / paragraph / sentence) before the 4096 cap, but we don't
// yet have a solid dataset of where they actually land. Adjust as
// real-world data comes in. Single source of truth — both
// `isCoalescent` and the middleware read from here.
const DEFAULT_MIN_LEADING_LENGTH = 3750;
// Debounced per fragment (each continuation resets the timer), so this
// is the MAX inter-fragment gap, not total wait. 2000ms tolerates slow
// clients / huge pastes (≥12 fragments). Real-world gaps inside a burst
// are usually <100ms; the ceiling only matters when the client throttles.
const DEFAULT_WINDOW_MS = 2000;
const DEFAULT_ACROSS_USERS = false;

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

export const isCoalescent = (
	prev: CoalesceFragment,
	curr: CoalesceFragment,
	opts: CoalesceCriteria = {},
): boolean => {
	const minLeadingLength = opts.minLeadingLength ?? DEFAULT_MIN_LEADING_LENGTH;
	const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
	const acrossUsers = opts.acrossUsers ?? DEFAULT_ACROSS_USERS;

	if (prev.chatId !== curr.chatId) return false;
	if (!acrossUsers && prev.userId !== curr.userId) return false;
	if (prev.text.length < minLeadingLength) return false;
	if (curr.dateMs - prev.dateMs > windowMs) return false;
	return true;
};

// ─── middleware ────────────────────────────────────────────────────

type FragmentBuffer = {
	text: string;
	timer: ReturnType<typeof setTimeout>;
	/** Synchronous trigger for the timer's flush logic. */
	flush: () => void;
};

export const coalesceLongMessages = (
	opts: CoalesceLongMessagesOptions = {},
) => {
	const minLeadingLength = opts.minLeadingLength ?? DEFAULT_MIN_LEADING_LENGTH;
	const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
	const acrossUsers = opts.acrossUsers ?? DEFAULT_ACROSS_USERS;
	const log = opts.log ?? false;

	const dbg = (msg: string) => {
		if (log) console.error(`[coalesce] ${msg}`);
	};

	// Keyed per `<chatId>:<userId>` (or `<chatId>` when acrossUsers).
	// Buffer lives only as long as fragments are still arriving — gets
	// deleted on flush.
	const buffers = new Map<string, FragmentBuffer>();

	const keyFor = (chatId: number, userId: number) =>
		acrossUsers ? `${chatId}` : `${chatId}:${userId}`;

	return new Plugin("@adriangalilea/utils/bot/coalesce").use(
		async (ctx, next) => {
			if (!ctx.is("message") || ctx.text === undefined) return next();

			const key = keyFor(ctx.chat.id, ctx.from.id);
			const existing = buffers.get(key);

			if (existing) {
				// Continuation fragment — fold into the held buffer and reset
				// the timer. No length check on continuations: once a buffer
				// is open, anything within the window joins (the tail of a
				// split is typically short). We don't call next(); this update
				// is swallowed. The first fragment held by `existing.flush`
				// will eventually fire next() with the combined text.
				dbg(
					`join key=${key} len=${ctx.text.length} buffered=${existing.text.length}→${existing.text.length + ctx.text.length}`,
				);
				clearTimeout(existing.timer);
				existing.text += ctx.text;
				existing.timer = setTimeout(existing.flush, windowMs);
				return;
			}

			if (ctx.text.length < minLeadingLength) {
				// Short message → can never be the leading fragment of a real
				// client split. Zero-latency passthrough.
				dbg(
					`passthrough key=${key} len=${ctx.text.length} (<${minLeadingLength})`,
				);
				return next();
			}

			// Suspicious leading fragment: hold + start the wait window.
			// Returns a Promise that only resolves after the buffer flushes
			// (next() of THIS ctx is called with the combined text). This
			// keeps gramio's middleware chain awaiting until we're done.
			dbg(
				`open key=${key} len=${ctx.text.length} (≥${minLeadingLength}, wait ${windowMs}ms)`,
			);
			return new Promise<void>((resolve, reject) => {
				const buffered: FragmentBuffer = {
					text: ctx.text!,
					timer: setTimeout(() => buffered.flush(), windowMs),
					flush: () => {
						// Detach from the map FIRST so any fragment arriving mid-flush
						// starts a fresh buffer instead of re-entering this one.
						dbg(`flush key=${key} total=${buffered.text.length}`);
						buffers.delete(key);

						// gramio's MessageContext exposes `text` as an accessor
						// with both `get` and `set` — assignment is the supported
						// way to override. We don't touch `entities`: fragment-1
						// entities reference fragment-1 text only, but plain-text
						// consumers (the sensible use of this plugin) ignore them.
						// Formatted-input consumers should disable the plugin.
						ctx.text = buffered.text;
						// Hand off to the rest of the chain. Resolve outer Promise
						// once the chain (and any downstream awaits) settles, so
						// gramio considers this middleware fully done.
						Promise.resolve(next()).then(() => resolve(), reject);
					},
				};
				buffers.set(key, buffered);
			});
		},
	);
};
