/**
 * The pending-update queue of a webhook-less bot token, handled with the respect a
 * destroy-on-read resource deserves. Telegram's `getUpdates` CONFIRMS (discards) every update
 * older than the offset it is called with — reading is destructive, and a queue drained
 * carelessly is gone forever. Two safety properties are the whole point:
 *
 *   PEEK is free. `getUpdates` WITHOUT an offset confirms nothing: webhook state, the pending
 *   count, and the head of the queue are all inspectable, repeatably, at zero risk.
 *
 *   DRAIN is write-before-confirm. Each raw batch is handed to the caller's `onBatch` (persist
 *   it there — disk, db, anywhere durable) and AWAITED before the next `getUpdates` call
 *   advances the offset, because that next call IS the confirmation. A crash mid-drain loses
 *   nothing: re-run, and the unconfirmed tail re-delivers. The drain ends only after the queue
 *   stays silent across several consecutive long-polls, never on the first empty response.
 *
 * Framework-free: plain `fetch` against the Bot API, injectable for tests. A 409 means the
 * token has a webhook registered or another poller is competing — surfaced as a typed error,
 * never retried silently.
 */
import { SourcedError } from "../offensive.js";

/** A raw Bot API update. Only `update_id` is load-bearing here; everything else passes through. */
export interface TelegramUpdate {
	update_id: number;
	[key: string]: unknown;
}

export interface QueuePeek {
	/** The registered webhook URL, or null when the token polls (getUpdates works). */
	webhookUrl: string | null;
	/** Updates waiting server-side (`getWebhookInfo.pending_update_count`). */
	pending: number;
	/** The first updates in the queue, verbatim. Empty when a webhook is registered (polling
	 *  would 409) — the count above still tells the story. */
	head: TelegramUpdate[];
}

export interface DrainResult {
	drained: number;
	batches: number;
	lastUpdateId?: number;
}

export interface UpdateQueueOptions {
	token: string;
	/** Transport override for tests. Defaults to global fetch. */
	fetch?: typeof globalThis.fetch;
	/** Bot API origin override (local Bot API servers). */
	apiRoot?: string;
}

/** Peek/drain/count over one bot token's pending-update queue. See the module doc for the
 *  destroy-on-read contract each verb upholds. */
export function updateQueue(options: UpdateQueueOptions) {
	const doFetch = options.fetch ?? globalThis.fetch;
	const root = options.apiRoot ?? "https://api.telegram.org";

	const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
		const res = await doFetch(`${root}/bot${options.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params ?? {}),
		});
		const body = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
		if (!body.ok) {
			throw new SourcedError({
				source: "telegram",
				operation: method,
				message:
					body.error_code === 409
						? `${body.description ?? "409"} (a webhook is registered, or another poller is competing)`
						: (body.description ?? "unknown error"),
				status: body.error_code ?? res.status,
			});
		}
		return body.result as T;
	};

	return {
		/** Raw `getWebhookInfo`. */
		webhookInfo(): Promise<Record<string, unknown>> {
			return call("getWebhookInfo");
		},

		/** Updates waiting server-side, without touching any of them. */
		async count(): Promise<number> {
			const info = await call<{ pending_update_count?: number }>("getWebhookInfo");
			return info.pending_update_count ?? 0;
		},

		/** Non-destructive look: webhook state, pending count, and the first `limit` updates,
		 *  verbatim. Confirms NOTHING — repeat as often as you like. */
		async peek({ limit = 1 }: { limit?: number } = {}): Promise<QueuePeek> {
			const info = await call<{ url?: string; pending_update_count?: number }>("getWebhookInfo");
			const webhookUrl = info.url ? info.url : null;
			// With a webhook registered getUpdates would 409; the count already tells the story.
			const head = webhookUrl ? [] : await call<TelegramUpdate[]>("getUpdates", { limit, timeout: 0 });
			return { webhookUrl, pending: info.pending_update_count ?? 0, head };
		},

		/**
		 * Drain the queue, one-chance-safe. `onBatch` receives each raw batch and is AWAITED
		 * before the offset advances — persist there, because the next `getUpdates` call is the
		 * confirmation that destroys the batch server-side. An `onBatch` throw aborts the drain
		 * with nothing confirmed beyond what `onBatch` already accepted; re-running resumes at
		 * the unconfirmed tail. Ends after `quietPolls` consecutive empty long-polls.
		 */
		async drain({
			onBatch,
			limit = 100,
			timeoutS = 10,
			quietPolls = 3,
		}: {
			onBatch: (updates: TelegramUpdate[]) => void | Promise<void>;
			limit?: number;
			timeoutS?: number;
			quietPolls?: number;
		}): Promise<DrainResult> {
			let offset: number | undefined;
			let drained = 0;
			let batches = 0;
			let lastUpdateId: number | undefined;
			let quiet = 0;
			while (quiet < quietPolls) {
				const batch = await call<TelegramUpdate[]>("getUpdates", { offset, limit, timeout: timeoutS });
				if (batch.length === 0) {
					quiet += 1;
					continue;
				}
				quiet = 0;
				await onBatch(batch); // persist FIRST…
				lastUpdateId = batch[batch.length - 1].update_id;
				offset = lastUpdateId + 1; // …the NEXT call confirms
				drained += batch.length;
				batches += 1;
			}
			return { drained, batches, lastUpdateId };
		},
	};
}
