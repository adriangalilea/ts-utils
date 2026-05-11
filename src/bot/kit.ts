/**
 * Foundational helpers every bot wants. Two things:
 *
 *   `gracefulStart(bot, opts?)` — wires SIGINT/SIGTERM to bot.stop(),
 *     runs an optional shutdown hook, force-kills if it hangs.
 *
 *   `adminContext({ adminId? })` — reads admin Telegram id from KEV
 *     (`TELEGRAM_ADMIN_ID`) with optional hardcoded fallback. Decorates
 *     every context with `ctx.adminId` (number) and `ctx.isAdmin`
 *     (boolean). Throws at startup if neither source provides an id.
 *
 * Peer deps: `gramio`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext({ adminId: 190202471 }))   // KEV wins, 190… is fallback
 *   .command('whoami', (ctx) => ctx.send(`admin? ${ctx.isAdmin}`))
 *
 * await gracefulStart(bot, { onShutdown: () => db.end() })
 */
import type { AnyBot } from "gramio";
import { Plugin } from "gramio";
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
