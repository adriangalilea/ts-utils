/**
 * Bot-namespaced session storage — worker-safe (no env, no process, no
 * signals; runs identically on Node and Cloudflare Workers).
 *
 *   `botSession(opts)` — drop-in replacement for `@gramio/session`'s
 *     `session()` that AUTOMATICALLY namespaces every key with the
 *     calling bot's id (parsed from `ctx.bot.options.token`). When
 *     several bots share one storage instance, each writes to a
 *     disjoint keyspace (`bot-<id>:<senderId>`) with no manual wiring.
 *     Every plugin in this package (`accessControl`, `botMenu`,
 *     `llmHistory`, …) derives the SAME prefix from `ctx.bot` for its
 *     own storage access, so the whole package stays isolated by
 *     construction. Use this instead of `session()` — full stop.
 *
 *   `prefixStorage(storage, prefix)` — escape hatch that prepends a
 *     fixed prefix to every key of any `@gramio/storage` adapter.
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/storage`.
 *
 * @example
 * import { redisStorage } from '@gramio/storage-redis'
 * import { botSession } from '@adriangalilea/utils/bot/session'
 *
 * const storage = redisStorage()                          // share across bots, safe
 * const userSession = botSession({ storage, initial: () => ({}) })
 * bot.extend(userSession)
 */
import { type SessionOptions, session } from "@gramio/session";
import type { Storage } from "@gramio/storage";
import { botId } from "./keys.js";

// ─── botSession ────────────────────────────────────────────────────

/**
 * Drop-in replacement for `@gramio/session`'s `session()` that forces
 * the storage key to include the calling bot's id. Equivalent to
 * passing `getSessionKey: (ctx) => bot-${id}:${senderId}` explicitly,
 * but baked in so no consumer can forget.
 *
 * Returns a plain `@gramio/session` plugin — same shape, same derives,
 * fully interchangeable in `.extend(userSession)` chains and plugin
 * options like `accessControl({ session: userSession, … })`.
 *
 * `getSessionKey` can still be overridden for advanced cases (e.g. a
 * per-chat session in groups); the override is wrapped so it still
 * receives the `bot-<id>:` prefix. Don't override unless you know what
 * you're doing — every plugin in this package expects the
 * `bot-<id>:<userId>` shape for cross-user storage reads.
 */
export const botSession = <
	Data = unknown,
	Key extends string = "session",
	Lazy extends boolean = false,
>(
	opts: SessionOptions<Data, Key, Lazy>,
): ReturnType<typeof session<Data, Key, Lazy>> => {
	const userKeyer = opts.getSessionKey;
	type AnyCtx = {
		bot: unknown;
		senderId?: number;
	};
	return session<Data, Key, Lazy>({
		...opts,
		// The session plugin types `getSessionKey` against `ContextType<BotLike, Events>`
		// — too narrow for our generic wrapper. We only need `bot.info.id` +
		// `senderId`, both of which gramio guarantees on every event the session
		// plugin processes (bot.info is populated by bot.start / bot.init before
		// any handler fires). Structural cast at the boundary keeps the public
		// API generic-friendly without forcing consumers to specify Event unions.
		getSessionKey: (async (ctxRaw) => {
			const ctx = ctxRaw as AnyCtx;
			const prefix = `bot-${botId(ctx)}:`;
			if (userKeyer) {
				const inner = await (
					userKeyer as (c: AnyCtx) => string | Promise<string>
				)(ctx);
				return `${prefix}${inner}`;
			}
			return `${prefix}${ctx.senderId ?? ""}`;
		}) as SessionOptions<Data, Key, Lazy>["getSessionKey"],
	}) as ReturnType<typeof session<Data, Key, Lazy>>;
};

// ─── prefixStorage (escape hatch) ──────────────────────────────────

/**
 * Wraps any `@gramio/storage` adapter so every key gets a fixed
 * `${prefix}` prepended.
 *
 * **You almost never need this.** The library's plugins are isolated
 * by bot id automatically when you wire `botSession` (see above) —
 * `prefixStorage` exists for edge cases:
 *
 *   - Sharing a Redis instance with a NON-bot system, and you want a
 *     top-level prefix on top of the bot-id namespace.
 *   - Migrating from an older deployment that used a custom prefix.
 *
 * In those cases the wrapper composes cleanly with `botSession`'s
 * internal prefix: final keys look like `${prefix}bot-<id>:<userId>`.
 */
export const prefixStorage = (storage: Storage, prefix: string): Storage => {
	const k = (key: string | number | symbol): string =>
		`${prefix}${String(key)}`;
	return {
		get: (key) => storage.get(k(key)),
		has: (key) => storage.has(k(key)),
		set: (key, value) => storage.set(k(key), value),
		delete: (key) => storage.delete(k(key)),
	};
};
