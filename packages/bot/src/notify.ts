/**
 * Admin notifications — best-effort DMs to the bot's operator(s).
 * Worker-safe: no env, no process; the caller passes the admin ids
 * (from wherever its runtime keeps them: KEV on Node, D1/env on a
 * Worker).
 *
 * Everything here is FIRE-AND-FORGET BY CONTRACT: a notification must
 * never take the bot down, so failures are logged (scope bot/notify,
 * visible in a Worker tail and a Node terminal alike) and swallowed.
 *
 *   `notifyAdmins(bot, adminIds, text, extra?)` — DM each admin.
 *   `alertAdminOnErrors(bot, adminIds, { ms? })` — DM every error the
 *     process LOGS (utils/log `onLog`), handled or not, one per distinct
 *     error per window, repeats counted. Call once at startup (`bot/worker`
 *     does it for a Worker bot with `adminIds`).
 *   `alertsSettled()` — resolves when every alert DM sent so far settled:
 *     what a Worker keeps alive with `waitUntil` or an alarm's await.
 *
 * @example
 * import { alertAdminOnErrors, notifyAdmins } from '@adriangalilea/bot/notify'
 *
 * alertAdminOnErrors(bot, adminIds)            // once; an error is alerted by logging it
 * bot.onError(({ kind, error }) => log.error("update failed", { kind, err: error }))
 * await notifyAdmins(bot, adminIds, `@${bot.info.username} deployed.`)
 */
import { type JsonValue, onLog, log as root } from "@adriangalilea/utils/log";

const log = root.scope("bot").scope("notify");

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
					.catch((err) => log.error("admin DM failed", { admin: id, err })),
			),
	);
}

/** The admins, as a list or resolved per alert (a Worker reading them from D1). */
export type AdminIds = readonly number[] | (() => Promise<readonly number[]>);

/**
 * DM the admins every error the process logs: each `level: "error"` event,
 * an error line or a failed span, whatever caught it, so a failure a bot
 * handled (fell back, answered the chat, retried) is still seen by its
 * operator, not only one that escaped to `onError`. One DM per distinct
 * error (service, scope, message and the error's own message) per `ms`
 * (default 10 minutes); repeats inside the window are counted and reported
 * with the next DM of that error, never dropped silently. Events of this
 * module's own scope are skipped: a failed admin DM is logged as an error
 * and would alert about itself. Returns the unsubscribe.
 */
export function alertAdminOnErrors(
	bot: NotifyBot,
	adminIds: AdminIds,
	{ ms = 10 * 60_000 }: { ms?: number } = {},
): () => void {
	const last = new Map<string, { at: number; repeats: number }>();
	return onLog((event) => {
		if (event.level !== "error") return;
		const scope = event.scope ?? [];
		if (scope[0] === "bot" && scope[1] === "notify") return;
		const err = errorOf(event.fields?.err);
		const key = [event.service, scope.join("/"), event.msg, err].join("\u0000");
		const now = Date.now();
		const seen = last.get(key);
		if (seen && now - seen.at < ms) {
			seen.repeats++;
			return;
		}
		last.set(key, { at: now, repeats: 0 });
		// service · scope: msg, each part once: a span named for its scope in a
		// service of the same name ("unfurl · unfurl: unfurl") reads "unfurl".
		const parts = [event.service, ...scope, event.msg].filter(
			(part, index, all) => part !== all[index - 1],
		);
		const head =
			parts.length > 1
				? `${parts.slice(0, -1).join(" · ")}: ${parts.at(-1)}`
				: parts[0];
		const again = seen?.repeats
			? `\n(${seen.repeats} more since the last alert)`
			: "";
		const text =
			[`🚨 ${head}`, err, details(event.fields)].filter(Boolean).join("\n") +
			again;
		const sending = (
			typeof adminIds === "function" ? adminIds() : Promise.resolve(adminIds)
		)
			.then((ids) =>
				notifyAdmins(bot, ids, text, {
					link_preview_options: { is_disabled: true },
				}),
			)
			.catch((err) => log.error("admin ids unavailable for an alert", { err }))
			.finally(() => inFlight.delete(sending));
		inFlight.add(sending);
	});
}

/** Alert DMs on their way, until each settles. */
const inFlight = new Set<Promise<void>>();

/**
 * Resolves once every alert DM sent so far has settled. A Worker hands it to
 * `waitUntil` (or awaits it in an alarm) so a DM is not frozen with the
 * isolate; `bot/worker` does this wherever it holds a lifetime open.
 */
export async function alertsSettled(): Promise<void> {
	while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// An event's error as "Type: message" (its stack stays in the log).
function errorOf(err: JsonValue | undefined): string {
	if (err === undefined || err === null) return "";
	if (!isRecord(err)) return String(err);
	return [err.type, err.message]
		.filter((part) => typeof part === "string")
		.join(": ");
}

function isRecord(
	value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The event's other fields, one per line, each value cut at 300 characters.
function details(
	fields: { readonly [key: string]: JsonValue } | undefined,
): string {
	if (!fields) return "";
	return Object.entries(fields)
		.filter(([key]) => key !== "err")
		.map(([key, value]) => {
			const shown = typeof value === "string" ? value : JSON.stringify(value);
			return `${key}: ${shown.length > 300 ? `${shown.slice(0, 299)}…` : shown}`;
		})
		.join("\n");
}
