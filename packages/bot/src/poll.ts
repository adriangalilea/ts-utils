/**
 * Long polling, as a transport this package owns: the twin of `bot/worker`'s
 * webhook. Both hand each update to gramio's own update queue; neither leaves
 * the transport to gramio.
 *
 *   `longPoll(bot, opts?)` → `{ stop() }` — starts the bot (plugins, `getMe`,
 *     `onStart` hooks) and polls `getUpdates` until `stop()`.
 *
 * Why not gramio's `bot.start()`: its poll sends `getUpdates` with no deadline,
 * so a connection that dies without a reset leaves one request pending forever
 * and the bot deaf while its process looks healthy (a bot held 278 updates for
 * four days that way, its timers still logging). A long poll's duration is
 * known before it is sent: Telegram answers within its `timeout`. Every request
 * here carries that bound plus the time an answer takes to arrive, so a dead
 * connection fails like any other network error and the next poll goes out.
 * The same signal covers the body: an answer whose headers arrive and whose
 * body never finishes fails too. Upstream: gramiojs/gramio#35 (open, no fix in
 * 0.15.1). When gramio bounds its own poll, this module goes and its callers
 * return to `bot.start()`.
 *
 * Otherwise it is gramio's poll, behaviour for behaviour: the same
 * `allowed_updates` (gramio's default list plus the opt-in types the handlers
 * register), the webhook deleted when Telegram refuses to poll beside one,
 * `retry_after` honoured, and batches fed to `bot.updates.queue`, so
 * `bot.stop()` still waits for handlers in flight. Failures back off, doubling
 * up to a ceiling, instead of retrying every second through an outage.
 *
 * Worker-safe by construction (fetch and timers only), though a Worker has no
 * use for it: Workers receive webhooks.
 */

import { log as root } from "@adriangalilea/utils/log";
import {
	AllowedUpdatesFilter,
	type AnyBot,
	detectOptInUpdates,
	type TelegramUpdate,
} from "gramio";
import { guardToken, telegramFailure } from "./token-safe.js";

const log = root.scope("bot").scope("poll");

/**
 * Time an answer takes to arrive once Telegram sends it: a batch of at most 100
 * updates over a slow line. A poll's deadline is its `timeout` plus this.
 */
const ANSWER_MS = 15_000;
/** First wait after a failed poll; doubles per failure up to `BACKOFF_MAX_MS`. */
const BACKOFF_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

type BotApiResponse =
	| { ok: true; result: TelegramUpdate[] }
	| {
			ok: false;
			error_code: number;
			description?: string;
			parameters?: { retry_after?: number };
	  };

export type LongPollOptions = {
	/** Seconds Telegram holds a `getUpdates` open when nothing arrives. Default 30, gramio's own. */
	timeout?: number;
};

export type LongPoll = {
	/** Ends the poll in flight and the loop; resolves once the loop has exited. */
	stop(): Promise<void>;
};

export async function longPoll(
	bot: AnyBot,
	opts: LongPollOptions = {},
): Promise<LongPoll> {
	const timeout = opts.timeout ?? 30;
	const optIn = detectOptInUpdates(bot.updates.composer.registeredEvents());
	const allowedUpdates =
		optIn.length > 0
			? [...AllowedUpdatesFilter.default.add(...optIn)]
			: undefined;

	// Before the first request: getMe at start must not fail with the token in it.
	guardToken(bot);
	// gramio's "updates arrive from outside" mode: init, getMe, onStart hooks,
	// and no poll of its own (no setWebhook either: `true` registers nothing).
	await bot.start({ webhook: true });

	const { api } = bot.options;
	const url = `${api.baseURL}${bot.options.token}/${api.useTest ? "test/" : ""}`;
	const stopping = new AbortController();

	const call = async (
		method: string,
		params: object,
		deadlineMs: number,
	): Promise<BotApiResponse> => {
		const headers = new Headers(api.fetchOptions?.headers);
		headers.set("content-type", "application/json");
		try {
			const response = await fetch(url + method, {
				...api.fetchOptions,
				method: "POST",
				headers,
				body: JSON.stringify(params),
				// One signal for the whole exchange, body included: the deadline, or stop().
				signal: AbortSignal.any([
					AbortSignal.timeout(deadlineMs),
					stopping.signal,
				]),
			});
			return (await response.json()) as BotApiResponse;
		} catch (err) {
			throw telegramFailure(method, err);
		}
	};

	const wait = (ms: number) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			stopping.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});

	const loop = async () => {
		let offset = 0;
		let failures = 0;
		const failed = async (what: string, fields: object, waitMs?: number) => {
			failures++;
			const ms =
				waitMs ?? Math.min(BACKOFF_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
			log.warn(what, { ...fields, failures, retry_in_ms: ms });
			await wait(ms);
		};

		while (!stopping.signal.aborted) {
			let answer: BotApiResponse;
			try {
				answer = await call(
					"getUpdates",
					{ offset, timeout, allowed_updates: allowedUpdates },
					timeout * 1000 + ANSWER_MS,
				);
			} catch (err) {
				if (stopping.signal.aborted) break;
				await failed("getUpdates failed", { err });
				continue;
			}

			if (!answer.ok) {
				if (
					answer.error_code === 409 &&
					answer.description?.includes("deleteWebhook")
				) {
					log.warn("a webhook is registered; deleting it to poll", {
						description: answer.description,
					});
					await call("deleteWebhook", {}, ANSWER_MS).catch((err) =>
						log.error("deleteWebhook failed", { err }),
					);
					continue;
				}
				const retryAfter = answer.parameters?.retry_after;
				await failed(
					"getUpdates refused",
					{ code: answer.error_code, description: answer.description },
					retryAfter ? retryAfter * 1000 : undefined,
				);
				continue;
			}

			if (failures > 0) {
				log.success("polling again", { after_failures: failures });
				failures = 0;
			}
			const last = answer.result.at(-1);
			if (last) {
				offset = last.update_id + 1;
				bot.updates.queue.addBatch(answer.result);
			}
		}
	};

	log.ready("polling", {
		username: bot.info?.username,
		allowed_updates: allowedUpdates ?? "telegram default",
	});
	const running = loop();

	return {
		async stop() {
			stopping.abort();
			await running;
		},
	};
}
