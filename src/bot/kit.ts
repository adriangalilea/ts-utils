/**
 * Foundational helpers every bot wants.
 *
 *   `gracefulStart(bot, opts?)` — wires SIGINT/SIGTERM to bot.stop(),
 *     runs an optional shutdown hook, force-kills if it hangs. DMs the
 *     admin on start/stop by default (`@<bot> started.` /
 *     `@<bot> shutting down.`) when `KEV.TELEGRAM_ADMIN_ID` is set —
 *     pass `notifyAdmin: false` to disable.
 *
 *   `adminContext({ adminId? })` — reads admin Telegram id from KEV
 *     (`TELEGRAM_ADMIN_ID`) with optional hardcoded fallback. Decorates
 *     every context with `ctx.adminId` (number) and `ctx.isAdmin`
 *     (boolean). Throws at startup if neither source provides an id.
 *
 *   `botSession(opts)` — drop-in replacement for `@gramio/session`'s
 *     `session()` that AUTOMATICALLY namespaces every key with the
 *     calling bot's id (parsed from `ctx.bot.options.token`). When
 *     several bots share one Redis instance, each writes to a disjoint
 *     keyspace (`bot-<id>:<senderId>`) with no manual wiring. Every
 *     plugin in this package (`accessControl`, `botMenu`,
 *     `llmHistory`, …) derives the SAME prefix from `ctx.bot` for its
 *     own storage access, so the whole package stays isolated by
 *     construction. Use this instead of `session()` — full stop.
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/storage`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { adminContext, gracefulStart, botSession } from '@adriangalilea/utils/bot/kit'
 *
 * const storage = redisStorage()                          // share across bots, safe
 * const userSession = botSession({ storage, initial: () => ({}) })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext({ adminId: 190202471 }))         // KEV wins, 190… is fallback
 *   .extend(userSession)
 *   .command('whoami', (ctx) => ctx.send(`admin? ${ctx.isAdmin}`))
 *
 * await gracefulStart(bot, { onShutdown: () => db.end() })
 */
import { session, type SessionOptions } from "@gramio/session";
import type { Storage } from "@gramio/storage";
import type { Plugin as PluginType } from "gramio";
import { type AnyBot, Plugin } from "gramio";
import { kev } from "../platform/kev.js";

// ─── gracefulStart ─────────────────────────────────────────────────

export type GracefulStartOptions = {
	/** Runs after `bot.stop()` resolves, before `process.exit`. Close DBs, flush logs. */
	onShutdown?: () => Promise<void> | void;
	/** Process exit code on graceful shutdown. Default 0. */
	exitCode?: number;
	/** Hard-kill after this many ms if shutdown hangs. Default 10000. */
	forceExitAfterMs?: number;
	/** Logger. Default `console.log`. Set `false` to silence. */
	log?: ((msg: string) => void) | false;
	/**
	 * DM the admin on `bot.start()` and `bot.stop()` so you see lifecycle
	 * events on your own Telegram. Body: `@<bot-username> started.` and
	 * `@<bot-username> shutting down.` (the `username` comes from the
	 * `info` passed to gramio's `onStart` / `onStop` hooks — no extra
	 * `getMe` call).
	 *
	 *   - `undefined` (default) — auto: read admin id from
	 *                `KEV.TELEGRAM_ADMIN_ID` (same source `adminContext`
	 *                uses). Silently skips if unset, so this is safe to
	 *                leave on for bots without the env var.
	 *   - `true`   — same as default, but throws at start if KEV.TELEGRAM_ADMIN_ID
	 *                is missing. Use when you require the heartbeat.
	 *   - `number` — explicit Telegram user id to ping (bypasses KEV).
	 *   - `false`  — disable entirely.
	 *
	 * Only graceful shutdowns notify — `process.exit(1)` from a crash or
	 * the force-kill timer doesn't run `onStop`. Use this as an "I am
	 * alive" heartbeat, not as crash detection.
	 */
	notifyAdmin?: boolean | number;
};

export const gracefulStart = async (
	bot: AnyBot,
	opts: GracefulStartOptions = {},
): Promise<void> => {
	const log =
		opts.log === false ? () => {} : (opts.log ?? ((m) => console.log(m)));
	const forceMs = opts.forceExitAfterMs ?? 10_000;

	let stopping = false;

	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log(`[bot] ${signal} received, shutting down…`);

		const force = setTimeout(() => {
			console.error(`[bot] forced exit after ${forceMs}ms`);
			process.exit(1);
		}, forceMs);
		force.unref?.();

		try {
			await bot.stop();
			await opts.onShutdown?.();
			log("[bot] shutdown clean");
		} catch (e) {
			console.error("[bot] shutdown error", e);
		} finally {
			clearTimeout(force);
			process.exit(opts.exitCode ?? 0);
		}
	};

	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));

	// Publish all `.command(name, { description }, …)` registrations to
	// Telegram via `setMyCommands`. Hashes scopes internally so unchanged
	// metadata doesn't burn rate-limit budget. Hidden / un-described
	// commands are skipped.
	// See https://gramio.dev/triggers/command.html#how-synccommands-works
	bot.onStart(() => bot.syncCommands());

	// `notifyAdmin` resolution: default ON, reading KEV.TELEGRAM_ADMIN_ID
	// (same source `adminContext` uses). Silently skips when unset so the
	// default is safe; `true` makes the env var required.
	const adminId =
		opts.notifyAdmin === false
			? 0
			: typeof opts.notifyAdmin === "number"
				? opts.notifyAdmin
				: kev.int("TELEGRAM_ADMIN_ID", 0);
	if (opts.notifyAdmin === true && !adminId) {
		throw new Error(
			"gracefulStart({ notifyAdmin: true }): TELEGRAM_ADMIN_ID not set. " +
				"Pass a number explicitly, set the env var, or remove notifyAdmin.",
		);
	}
	if (adminId) {
		bot.onStart(async ({ info }) => {
			try {
				await bot.api.sendMessage({
					chat_id: adminId,
					text: `@${info.username} started.`,
				});
			} catch (e) {
				console.error("[bot] notifyAdmin (start) failed", e);
			}
		});
		bot.onStop(async ({ info }) => {
			try {
				await bot.api.sendMessage({
					chat_id: adminId,
					text: `@${info.username} shutting down.`,
				});
			} catch (e) {
				console.error("[bot] notifyAdmin (stop) failed", e);
			}
		});
	}

	await bot.start();
};

// ─── adminContext ──────────────────────────────────────────────────

export type AdminContextOptions = {
	/** Hardcoded fallback used when `KEV.TELEGRAM_ADMIN_ID` is unset. */
	adminId?: number;
};

export const adminContext = (opts: AdminContextOptions = {}) => {
	// KEV resolves: process.env → .env (project + monorepo, auto-discovered) → fallback.
	// Cached after first read. `kev.int` panics on non-int strings, so a malformed
	// env var screams immediately rather than producing NaN downstream.
	const adminId = kev.int("TELEGRAM_ADMIN_ID", opts.adminId ?? 0);

	if (!adminId) {
		throw new Error(
			"adminContext: TELEGRAM_ADMIN_ID not set and no adminId fallback. " +
				"Get your Telegram id from @UserIDentifyBot.",
		);
	}

	return new Plugin("@adriangalilea/utils/bot/admin")
		.decorate({ adminId })
		.derive((ctx) => ({
			// `senderId` is provided by gramio's SenderMixin. It's `undefined` on
			// service-style events without an actor; the strict equality below
			// gives `false` in that case, which is the right answer.
			isAdmin: "senderId" in ctx && ctx.senderId === adminId,
		}));
};

// ─── bot-id-namespaced keys ────────────────────────────────────────
//
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
			"bot/kit: ctx.bot.info.id is undefined — botId() called before bot.start()/bot.init() ran.",
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
export const botStorageKey = (
	ctx: { bot: unknown },
	userId: number,
): string => `bot-${botId(ctx)}:${userId}`;

/**
 * Static-key variant — namespace an arbitrary sub-key (e.g. an admin
 * index, a feature flag, a counter) under the calling bot's prefix.
 * Use this for bot-side state that isn't keyed by a specific user.
 *
 *   botSubKey(ctx, 'ac:index')   →  'bot-<id>:ac:index'
 *   botSubKey(ctx, 'metrics')    →  'bot-<id>:metrics'
 */
export const botSubKey = (
	ctx: { bot: unknown },
	subKey: string,
): string => `bot-${botId(ctx)}:${subKey}`;

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
 *
 * @example
 * import { redisStorage } from '@gramio/storage-redis'
 * import { botSession } from '@adriangalilea/utils/bot/kit'
 *
 * const storage = redisStorage()    // shared across N bots, safe
 *
 * const userSession = botSession({
 *   storage,
 *   key: 'session',
 *   initial: () => ({}),
 * })
 *
 * bot.extend(userSession)
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
				const inner = await (userKeyer as (c: AnyCtx) => string | Promise<string>)(
					ctx,
				);
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
	const k = (key: string | number | symbol): string => `${prefix}${String(key)}`;
	return {
		get: (key) => storage.get(k(key)),
		has: (key) => storage.has(k(key)),
		set: (key, value) => storage.set(k(key), value),
		delete: (key) => storage.delete(k(key)),
	};
};

// Re-export so the bot subpath consumers don't need to import from
// `@gramio/session` separately when wiring custom advanced cases.
export type { PluginType };
