/**
 * The bot-id key namespace — a PERSISTED CONTRACT, not a convenience.
 *
 * `bot-<id>:<userId>` / `bot-<id>:<subKey>` is the shape of every storage
 * key this library writes: `botSession` keying, the menu's Forget/Export,
 * access-control records, payments charge indexes. Those keys live in the
 * consumer's Redis/D1/SQLite rows, so the shape must never drift — change
 * it and every deployed bot orphans its state. This module is the single
 * owner; everything else derives from here.
 *
 * Pure functions of `ctx.bot.info.id` (no env, no fs) — Worker-safe by
 * construction, guarded by test:worker-safe.
 */

// ─── bot-id-namespaced keys ────────────────────────────────────────//
// gramio fills `bot.info` from `getMe()` during `bot.init` / `bot.start`,
// so by the time any handler runs `ctx.bot.info.id` is the bot's stable
// numeric id. We use it to prefix every storage key the library writes:
// `bot-<id>:<userId>` (per-user) or `bot-<id>:<subKey>` (bot-side).
//
// Why this exists: `@gramio/session` defaults `getSessionKey` to
// `String(senderId)`. If two bots share one Redis (the canonical
// "personal bot fleet" setup), every user id collides across bots and
// the last writer wins — silently corrupting state and leaking
// neighbouring bots' data on /export. Putting the bot id in the key
// removes the collision entirely without forcing the user to remember
// to wrap storage manually.

/**
 * Returns the calling bot's numeric id from `ctx.bot.info.id`. Throws
 * if called before `bot.start()` / `bot.init()` populates it — should
 * never happen from inside an event handler, where gramio guarantees
 * `bot.info` is set.
 *
 * Note on the structural cast: gramio's `BotLike` (the interface
 * contexts are typed against) intentionally omits `info` to decouple
 * Context types from the full Bot class. At runtime `ctx.bot` IS the
 * full Bot, so the cast is sound — just papering over a deliberate
 * type-vs-runtime gap.
 */
export const botId = (ctx: { bot: unknown }): number => {
	const id = (ctx.bot as { info?: { id: number } }).info?.id;
	if (id === undefined)
		throw new Error(
			"bot/keys: ctx.bot.info.id is undefined — botId() called before bot.start()/bot.init() ran.",
		);
	return id;
};

/**
 * Computes the storage key for an arbitrary user under the CALLING
 * bot's namespace. Use whenever a plugin needs to read or write
 * **another user's** session record from inside a handler (typical:
 * admin approves a stranger, /forget wipes a stranger after a takedown
 * request). For the current user, the session plugin handles keying
 * automatically when wired via `botSession`.
 */
export const botStorageKey = (ctx: { bot: unknown }, userId: number): string =>
	`bot-${botId(ctx)}:${userId}`;

/**
 * Static-key variant — namespace an arbitrary sub-key (e.g. an admin
 * index, a feature flag, a counter) under the calling bot's prefix.
 * Use this for bot-side state that isn't keyed by a specific user.
 *
 *   botSubKey(ctx, 'ac:index')   →  'bot-<id>:ac:index'
 *   botSubKey(ctx, 'metrics')    →  'bot-<id>:metrics'
 */
export const botSubKey = (ctx: { bot: unknown }, subKey: string): string =>
	`bot-${botId(ctx)}:${subKey}`;
