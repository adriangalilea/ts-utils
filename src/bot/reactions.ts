/**
 * Message-reaction arbitration: ONE owner for the bot's reaction on each
 * message. Telegram's setMessageReaction REPLACES the bot's whole reaction
 * set, so independent features reacting to the same message (an "on it" ack,
 * an outcome, a side-feature's shrug) silently clobber each other — last
 * writer wins, and the client shows flickering swaps.
 *
 * The fix is semantic states with ranks, arbitrated per message:
 *
 *   const status = reactionPolicy({
 *     working: { emoji: "🫡", rank: 1 },
 *     offTopic: { emoji: "🤷", rank: 2 },
 *     failed:  { emoji: "👎", rank: 3 },
 *     done:    { emoji: "🫡", rank: 4 },   // same emoji as working: no API call, but locks out offTopic
 *   });
 *   const r = status.for(ctx);
 *   await r.set("working");   // applied
 *   await r.set("done");      // rank bookkeeping only (same emoji) — zero API calls, zero flicker
 *   await r.set("offTopic");  // REJECTED: outranked by done — the shrug never lands
 *
 * Guarantees:
 *  - a state only applies when its rank is >= the current state's rank
 *    (equal rank may refine; strictly lower is rejected — returns false);
 *  - setting the current state again is a no-op (idempotent, no API call);
 *  - a transition between states sharing an emoji makes NO API call
 *    (rank bookkeeping without flicker);
 *  - react() failures are swallowed — reactions are decoration, they must
 *    never break the flow that set them;
 *  - state is keyed by chat:message, so one policy instance serves every
 *    message concurrently, and is bounded (reactions are transient
 *    request-lifetime coordination, not durable state).
 */

export interface ReactionStateSpec {
	/** The Telegram reaction emoji this state renders as. */
	emoji: string;
	/** Arbitration rank: a state only applies over an equal-or-lower rank. */
	rank: number;
}

/** The context surface read off the ctx: the message identity plus gramio's react().
 *  `for()` takes `unknown` and narrows structurally (gramio's react() param is an
 *  emoji-literal union, which no portable signature satisfies in strict variance) —
 *  a ctx without a callable react() screams instead of silently not reacting. */
export interface ReactionCtx {
	id?: number;
	chatId?: number;
	chat?: { id?: number };
	react(emoji: string): Promise<unknown>;
}

export interface ReactionHandle<S extends string> {
	/** The current state on this message, or null if none was set. */
	state(): S | null;
	/**
	 * Request a state. Applies (and reacts, if the emoji changes) only when
	 * not outranked by the current state. Returns whether the state holds
	 * after the call (true also for an idempotent re-set).
	 */
	set(next: S): Promise<boolean>;
}

// Transient per-isolate coordination, not durable state: bound it so a
// long-lived isolate can't grow the map without limit.
const MAX_TRACKED_MESSAGES = 512;

/** Declare the reaction vocabulary once; get per-message arbitrated handles. */
export function reactionPolicy<S extends Record<string, ReactionStateSpec>>(states: S) {
	const current = new Map<string, keyof S & string>();

	return {
		/** The arbitrated handle for THIS ctx's message (keyed chat:message). */
		for(context: unknown): ReactionHandle<keyof S & string> {
			const ctx = context as ReactionCtx;
			if (typeof ctx.react !== "function") throw new Error("reactionPolicy.for: ctx has no react()");
			const chat = ctx.chatId ?? ctx.chat?.id;
			const key = `${chat}:${ctx.id}`;
			return {
				state: () => current.get(key) ?? null,
				async set(next) {
					const spec = states[next];
					if (!spec) throw new Error(`unknown reaction state: ${String(next)}`);
					const prev = current.get(key);
					if (prev === next) return true; // idempotent
					if (prev !== undefined && spec.rank < states[prev].rank) return false; // outranked
					if (!current.has(key) && current.size >= MAX_TRACKED_MESSAGES) current.clear();
					current.set(key, next);
					// Same emoji under a new state: bookkeeping only — no API call, no flicker.
					if (prev !== undefined && states[prev].emoji === spec.emoji) return true;
					await ctx.react(spec.emoji).catch(() => {});
					return true;
				},
			};
		},
	};
}
