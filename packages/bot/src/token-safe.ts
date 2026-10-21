/**
 * The bot token is part of every Bot API URL (`…/bot<token>/<method>`,
 * `…/file/bot<token>/<path>`), and Bun hangs the request URL on every fetch
 * error as `path`. So any error the runtime prints itself prints the token: a
 * crash at startup, gramio's default error handler (`console.error` of the raw
 * error and the whole context), a caller's `console.error(err)`. The Studio's
 * bots wrote theirs into their logs every time they started without network.
 *
 * The rule this module owns: no error leaves this package carrying a request
 * URL, and no failure reaches the runtime's printer.
 *
 *   `telegramFailure(method, err)` — a transport failure as a `SourcedError`
 *     (source `telegram`, the method as operation, the transport's code and
 *     message). No cause: the cause is the error that holds the URL. Every
 *     fetch this package makes to the Bot API throws through it.
 *   `guardToken(bot)` — the same for every call gramio makes (`onApiCall`,
 *     getMe at start included), and every failed update logged through
 *     `utils/log`, which writes an error's type, message, stack and cause and
 *     never its other fields. Telegram's own refusals (`TelegramError`) pass
 *     through untouched: they carry the method and params, never the URL.
 *
 * The transports call `guardToken` before the first request (`bot/poll`, and
 * `createBot` for the bots it builds), so a bot is covered without a line of
 * its own. Not covered: `downloadFile` bypasses `onApiCall`; its failure is
 * still raw if the bot catches and prints it itself (thrown out of a handler,
 * it reaches the logged `onError` here). A Worker's fetch errors carry no URL.
 */

import { log as root } from "@adriangalilea/utils/log";
import { SourcedError } from "@adriangalilea/utils/offensive";
import { type AnyBot, TelegramError } from "gramio";

const log = root.scope("bot");

/** A transport failure of one Bot API method, stripped of the request URL. */
export function telegramFailure(method: string, err: unknown): SourcedError {
	const code = (err as { code?: unknown } | null)?.code;
	const message = err instanceof Error ? err.message : String(err);
	return new SourcedError({
		source: "telegram",
		operation: method,
		message:
			typeof code === "string" && code !== "" ? `${code}: ${message}` : message,
	});
}

const guarded = new WeakSet<AnyBot>();

/** Installs the rule on `bot`, once; see the module doc. */
export function guardToken(bot: AnyBot): void {
	if (guarded.has(bot)) return;
	guarded.add(bot);
	bot.onApiCall(async (call, next) => {
		try {
			return await next();
		} catch (err) {
			if (err instanceof TelegramError) throw err;
			throw telegramFailure(call.method, err);
		}
	});
	bot.onError(({ context, kind, error }) => {
		log.error("update failed", {
			kind,
			update_type: context.updateType,
			update_id: context.updateId,
			err: error,
		});
	});
}
