/**
 * Foundational helpers for NODE bots — the library's deliberately
 * Node-only corner (process signals, KEV env resolution). Worker bots
 * use the worker-safe subpaths instead: `bot/session` (namespaced
 * sessions) and `bot/notify` (admin DMs) hold the pieces that never
 * needed an OS.
 *
 *   `gracefulStart(bot, opts?)` — starts the bot long-polling through
 *     `bot/poll` (every poll bounded by a deadline), wires SIGINT/SIGTERM
 *     to stop the poll and bot.stop(), runs an optional shutdown hook,
 *     force-kills if it hangs. DMs the
 *     admin on start/stop by default (`@<bot> started.` /
 *     `@<bot> shutting down.`) when `KEV.TELEGRAM_ADMIN_ID` is set —
 *     pass `notifyAdmin: false` to disable.
 *
 * Peer dep: `gramio`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { botSession } from '@adriangalilea/bot/session'
 * import { gracefulStart } from '@adriangalilea/bot/kit'
 * import { adminContext } from '@adriangalilea/bot/admin'
 * import { kev } from '@adriangalilea/utils/platform/kev'
 *
 * const storage = redisStorage()                          // share across bots, safe
 * const userSession = botSession({ storage, initial: () => ({}) })
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext(kev.int('TELEGRAM_ADMIN_ID', 123456789)))  // env, id fallback
 *   .extend(userSession)
 *   .command('whoami', (ctx) => ctx.send(`admin? ${ctx.isAdmin}`))
 *
 * await gracefulStart(bot, { onShutdown: () => db.end() })
 */

import { kev } from "@adriangalilea/utils/kev";
import { log as root } from "@adriangalilea/utils/log";
import type { AnyBot } from "gramio";
import { notifyAdmins } from "./notify.js";
import { type LongPoll, longPoll } from "./poll.js";

const log = root.scope("bot").scope("kit");

// ─── gracefulStart ─────────────────────────────────────────────────

export type GracefulStartOptions = {
	/** Runs after `bot.stop()` resolves, before `process.exit`. Close DBs, flush logs. */
	onShutdown?: () => Promise<void> | void;
	/** Process exit code on graceful shutdown. Default 0. */
	exitCode?: number;
	/** Hard-kill after this many ms if shutdown hangs. Default 10000. */
	forceExitAfterMs?: number;
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
	const forceMs = opts.forceExitAfterMs ?? 10_000;

	let stopping = false;
	// Set once the bot is polling; a signal during startup finds none to end.
	let poll: LongPoll | undefined;

	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.wait("shutting down", { signal });

		const force = setTimeout(() => {
			log.error("forced exit, shutdown hung", { after_ms: forceMs });
			process.exit(1);
		}, forceMs);
		force.unref?.();

		try {
			await poll?.stop();
			await bot.stop();
			await opts.onShutdown?.();
			log.success("shutdown clean");
		} catch (err) {
			log.error("shutdown failed", { err });
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

	// A bot that cannot start (no network, a revoked token) says so in one log
	// line and exits for its supervisor to restart, never as a raw crash: the
	// runtime prints an uncaught error with every field it holds.
	try {
		poll = await longPoll(bot);
	} catch (err) {
		log.error("start failed", { err });
		process.exit(1);
	}
};
