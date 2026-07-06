/**
 * Foundational helpers for NODE bots — the library's deliberately
 * Node-only corner (process signals, KEV env resolution). Worker bots
 * use the worker-safe subpaths instead: `bot/session` (namespaced
 * sessions) and `bot/notify` (admin DMs) hold the pieces that used to
 * live here but never needed an OS.
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
 *   `botSession` / `prefixStorage` — re-exported from `bot/session` so
 *     Node consumers keep one import; the implementation is worker-safe
 *     and lives there.
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
import type { Plugin as PluginType } from "gramio";
import { type AnyBot, Plugin } from "gramio";
import { kev } from "../platform/kev.js";
import { notifyAdmins } from "./notify.js";

export { botSession, prefixStorage } from "./session.js";

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

	// `once` (not `on`) so a second Ctrl-C falls through to the default
	// handler and force-kills if our graceful path is itself stuck.
	process.once("SIGINT", () => void stop("SIGINT"));
	process.once("SIGTERM", () => void stop("SIGTERM"));

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
		bot.onStart(({ info }) =>
			notifyAdmins(bot, [adminId], `@${info.username} started.`),
		);
		bot.onStop(({ info }) =>
			notifyAdmins(bot, [adminId], `@${info.username} shutting down.`),
		);
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

// Re-export so the bot subpath consumers don't need to import from
// `@gramio/session` separately when wiring custom advanced cases.
export type { PluginType };
