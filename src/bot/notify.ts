/**
 * Admin notifications — best-effort DMs to the bot's operator(s).
 * Worker-safe: no env, no process; the caller passes the admin ids
 * (from wherever its runtime keeps them: KEV on Node, D1/env on a
 * Worker).
 *
 * Everything here is FIRE-AND-FORGET BY CONTRACT: a notification must
 * never take the bot down, so failures are logged (console.error —
 * visible in a Worker tail and a Node terminal alike) and swallowed.
 *
 *   `notifyAdmins(bot, adminIds, text, extra?)` — DM each admin.
 *   `alertAdminError(bot, adminIds, label, error, throttle?)` — DM a
 *     truncated `🚨 label\nName: message`, rate-limited through a
 *     caller-owned throttle so a failure storm can't flood anyone.
 *   `alertThrottle(ms?)` — make that throttle (per-process on Node,
 *     per-isolate on a Worker; own one per subsystem if you want
 *     independent budgets).
 *
 * @example
 * import { alertAdminError, alertThrottle, notifyAdmins } from '@adriangalilea/utils/bot/notify'
 *
 * const errorAlerts = alertThrottle()          // 60s budget, module-level
 * bot.onError(({ kind, error }) => void alertAdminError(bot, adminIds, `error [${kind}]`, error, errorAlerts))
 * await notifyAdmins(bot, adminIds, `@${bot.info.username} deployed.`)
 */

/** The one API surface a notification needs — satisfied by any gramio `Bot`. */
export type NotifyBot = {
	api: {
		sendMessage: (params: {
			chat_id: number;
			text: string;
		}) => Promise<unknown>;
	};
};

/** Telegram's hard per-message limit; longer texts are truncated, never split. */
const MAX_CHARS = 4096;

/**
 * DM `text` to every admin id, best-effort: each failure is logged and
 * swallowed (one unreachable admin must not block the rest, and a
 * notification must never throw into the calling flow). `extra` merges
 * into the sendMessage params (reply_markup, link_preview_options, …).
 */
export async function notifyAdmins(
	bot: NotifyBot,
	adminIds: readonly number[],
	text: string,
	extra?: Record<string, unknown>,
): Promise<void> {
	const body = text.slice(0, MAX_CHARS);
	await Promise.all(
		adminIds
			.filter((id) => id > 0)
			.map((id) =>
				bot.api
					.sendMessage({ ...extra, chat_id: id, text: body })
					.catch((e) => console.error(`[bot/notify] admin ${id} failed:`, e)),
			),
	);
}

/**
 * Rate-limit state for {@link alertAdminError}, owned by the CALLER so
 * scope is explicit (per-process on Node, per-isolate on a Worker) and
 * independent subsystems can hold independent budgets.
 */
export type AlertThrottle = { ms: number; lastAt: number };

/** A fresh throttle: at most one alert per `ms` (default 60s). */
export const alertThrottle = (ms = 60_000): AlertThrottle => ({
	ms,
	lastAt: 0,
});

/**
 * DM the admins a truncated error (`🚨 label\nName: message`), gated by
 * `throttle` so a failure storm sends one alert per window, not one per
 * failure. No throttle = every call sends.
 */
export async function alertAdminError(
	bot: NotifyBot,
	adminIds: readonly number[],
	label: string,
	error: unknown,
	throttle?: AlertThrottle,
): Promise<void> {
	if (throttle) {
		const now = Date.now();
		if (now - throttle.lastAt < throttle.ms) return;
		throttle.lastAt = now;
	}
	const message =
		error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	await notifyAdmins(bot, adminIds, `🚨 ${label}\n${message}`);
}
