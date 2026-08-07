/**
 * The Cloudflare Worker cap for a GramIO bot: everything between "I have a
 * `Bot` with features" and "it serves Telegram traffic in production", so a
 * bot file never hand-rolls a fetch handler. The workerd twin of `bot/kit`'s
 * `gracefulStart` (which owns the Node long-poll lifecycle).
 *
 * Endpoints (all on the worker root):
 *
 *   POST /                webhook — `X-Telegram-Bot-Api-Secret-Token` checked,
 *                         acked immediately; the update (+ storage flush) rides
 *                         `ctx.waitUntil`, errors DM the admins (throttled).
 *                         With `durableUpdates` set, the update is instead
 *                         PERSISTED into a per-conversation TelegramUpdateRunner
 *                         Durable Object BEFORE the ack, and a DO alarm owns the
 *                         full update: slow transcript/LLM work is not cancelled
 *                         ~30s after Telegram receives its acknowledgement, and
 *                         a non-2xx (nothing persisted) makes Telegram retry.
 *   POST /setup           registers the webhook with `allowed_updates` DERIVED
 *                         from the bot's handlers (a new handler type never
 *                         fires until /setup reruns — deploys should end here).
 *                         Body may carry `{sha, author, message}`: the deploy
 *                         DM then names the commit that went live.
 *   POST /deploy-started  the "what is shipping" DM — curl it from your deploy
 *                         script on the STILL-LIVE version the moment a deploy
 *                         starts. Body `{sha, author, message, etaSeconds?}`.
 *   POST /pause           deleteWebhook (traffic truly stops; Telegram queues
 *                         ~24h) — operator-authed.
 *   POST /resume          re-register the webhook — operator-authed.
 *   GET  /webhook-status  `{mode, paused, webhook, ...statusExtra}` — operator-authed.
 *   GET  /                liveness: `ok (<mode>)`.
 *
 * Auth: `/setup` + `/deploy-started` take `Bearer <webhookSecret>`; the
 * operator verbs take `Bearer <operatorSecret>` and 404 when it's unset.
 * Consumer endpoints go in `routes` (tried first, return null to fall through).
 *
 * Usage — the resolver receives the Worker env and returns the runtime (build
 * & memoize your bot inside it):
 *
 *   export default { fetch: botWorkerFetch(async (env) => ({
 *     bot: await getBot(env),
 *     webhookSecret: env.WEBHOOK_SECRET,
 *     operatorSecret: env.SEND_SECRET,
 *     mode: env.MODE,
 *     adminIds: () => readAdminIds(env),
 *     flush,
 *   })) }
 */
import { buildAllowedUpdates } from "gramio";
import { scope } from "../universal/log.js";
import {
	type AlertThrottle,
	alertAdminError,
	alertThrottle,
	notifyAdmins,
} from "./notify.js";
import {
	telegramUpdateId,
	telegramUpdatePartition,
} from "./update-identity.js";

const log = scope("bot/worker");

/** The slice of a gramio `Bot` the worker cap drives — structural, so versions don't pin. */
export type WorkerBot = {
	info?: { username?: string };
	updates: { handleUpdate(update: unknown): Promise<unknown> };
	api: {
		setWebhook(params: {
			url: string;
			secret_token: string;
			allowed_updates: string[];
		}): Promise<unknown>;
		deleteWebhook(): Promise<unknown>;
		getWebhookInfo(): Promise<{ url?: string; [k: string]: unknown }>;
		/** For the lifecycle DMs (notifyAdmins rides the same bot). */
		sendMessage(params: { chat_id: number; text: string }): Promise<unknown>;
	};
};

type WaitUntilCtx = { waitUntil(promise: Promise<unknown>): void };

const MESSAGE_KEYS = [
	"message",
	"edited_message",
	"channel_post",
	"edited_channel_post",
	"business_message",
	"edited_business_message",
] as const;

type EchoCheckMessage = {
	from?: { id?: number };
	forward_origin?: { sender_user?: { id?: number } };
};

/**
 * True when the update is the bot's own voice: a message it authored, or a forward of one of
 * its messages (forward_origin type "user" pointing back at it). Replies TO the bot are NOT
 * echoes — they're the conversation.
 */
export function isSelfEcho(update: unknown, selfId: number): boolean {
	const u = update as Record<string, EchoCheckMessage | undefined> | null;
	for (const key of MESSAGE_KEYS) {
		const m = u?.[key];
		if (!m) continue;
		if (m.from?.id === selfId) return true;
		if (m.forward_origin?.sender_user?.id === selfId) return true;
	}
	return false;
}

/** The slice of a Durable Object namespace binding the durable ingress touches. */
export type UpdateRunnerNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): {
		fetch(input: string, init?: RequestInit): Promise<Response>;
	};
};

export type DurableUpdates = {
	/** The namespace bound to the class built by {@link telegramUpdateRunner}. */
	namespace: UpdateRunnerNamespace;
	/**
	 * Route SELECTED updates outside their conversation queue — for a time-critical
	 * callback that must not wait behind slow work already running for its chat.
	 * Return a partition name, or null/undefined for the default
	 * `telegramUpdatePartition` (one Durable Object per conversation).
	 */
	partition?: (update: unknown) => string | null | undefined;
};

export type BotWorkerRuntime = {
	bot: WorkerBot;
	/** Telegram webhook secret; unset → webhook/setup respond 500 (a misconfigured prod must scream). */
	webhookSecret?: string;
	/**
	 * The bot's own user id (the digits before the token's colon). When set, updates that are
	 * the bot's OWN VOICE echoed back — a message it authored (channels/business echo their own
	 * posts) or a FORWARD of one of its messages (a forwarded summary still carries live links) —
	 * are acked and dropped before dispatch: a bot must never listen to itself, or it loops.
	 */
	selfId?: number;
	/** Bearer for /pause, /resume, /webhook-status; unset → those 404 (surface disabled). */
	operatorSecret?: string;
	/** Deployment label echoed in responses/DMs (e.g. the wrangler env name). */
	mode?: string;
	/** Live admin resolver for the lifecycle DMs + error alerts. Default: nobody (DMs off). */
	adminIds?: () => Promise<readonly number[]>;
	/** Awaited inside waitUntil after each update — hand `d1Storage`'s flush here. */
	flush?: () => Promise<void>;
	/** Extra fields merged into /webhook-status (e.g. a live feature flag). */
	statusExtra?: () => Promise<Record<string, unknown>>;
	/** Consumer endpoints, tried BEFORE the built-ins. Return null to fall through. */
	routes?: (
		request: Request,
		url: URL,
		ctx: WaitUntilCtx,
	) => Promise<Response | null> | Response | null;
	/** Error-alert throttle (share one to share its budget). Default: own 60s window. */
	errorThrottle?: AlertThrottle;
	/** Durable webhook ingress: persist-before-ack into per-conversation runner DOs. */
	durableUpdates?: DurableUpdates;
};

/**
 * Build the Worker `fetch` handler. `resolve` runs per request — memoize your
 * bot construction inside it (the classic `let botPromise` pattern) so the
 * isolate builds once.
 */
export function botWorkerFetch<Env>(
	resolve: (env: Env) => Promise<BotWorkerRuntime> | BotWorkerRuntime,
): (request: Request, env: Env, ctx: WaitUntilCtx) => Promise<Response> {
	const fallbackThrottle = alertThrottle();
	return async (request, env, ctx) => {
		const url = new URL(request.url);
		try {
			const rt = await resolve(env);
			const { bot } = rt;
			const mode = rt.mode ?? "?";
			const adminIds = rt.adminIds ?? (async () => []);
			const throttle = rt.errorThrottle ?? fallbackThrottle;
			const webhookSecret = rt.webhookSecret?.trim();

			// Consumer routes first — the escape hatch for bot-specific endpoints.
			if (rt.routes) {
				const handled = await rt.routes(request, url, ctx);
				if (handled) return handled;
			}

			if (request.method === "GET" && url.pathname === "/") {
				return new Response(`ok (${mode})`);
			}

			if (request.method === "POST" && url.pathname === "/") {
				if (!webhookSecret)
					return new Response("webhookSecret is required", { status: 500 });
				if (
					request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
					webhookSecret
				) {
					return new Response("Unauthorized", { status: 401 });
				}
				let update: unknown;
				try {
					update = await request.json();
				} catch {
					return new Response("Bad Request", { status: 400 });
				}
				// The bot never listens to itself (see isSelfEcho): ack and drop.
				if (rt.selfId !== undefined && isSelfEcho(update, rt.selfId)) {
					return new Response("OK");
				}
				// Durable ingress: persist into the partition's runner DO, THEN ack.
				// A non-2xx tells Telegram to retry; never acknowledge an update
				// that was not persisted.
				if (rt.durableUpdates) {
					const partition =
						rt.durableUpdates.partition?.(update) ??
						telegramUpdatePartition(update);
					if (!partition) return new Response("Bad Request", { status: 400 });
					const { namespace } = rt.durableUpdates;
					try {
						const queued = await namespace
							.get(namespace.idFromName(partition))
							.fetch("https://telegram-update-runner/enqueue", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(update),
							});
						if (!queued.ok) {
							log.error(`update enqueue failed · ${queued.status}`);
							return new Response("update queue unavailable", {
								status: 503,
							});
						}
						return new Response("OK");
					} catch (error) {
						log.error(
							"update enqueue failed:",
							error instanceof Error ? error.message : error,
						);
						return new Response("update queue unavailable", { status: 503 });
					}
				}
				// Ack Telegram immediately, then keep the Worker alive for the slow
				// work (avoids GramIO's 30s webhook timeout).
				ctx.waitUntil(
					(async () => {
						await bot.updates.handleUpdate(update);
						if (rt.flush) await rt.flush();
					})().catch(async (error) => {
						log.error(
							"update failed:",
							error instanceof Error ? error.message : error,
						);
						// awaited so the DM rides the same waitUntil, not a frozen isolate
						await alertAdminError(
							bot,
							await adminIds(),
							"webhook update failed",
							error,
							throttle,
						);
					}),
				);
				return new Response("OK");
			}

			// Deploy narration, step 1 of 2: what is SHIPPING (curled on the still-live version).
			if (request.method === "POST" && url.pathname === "/deploy-started") {
				if (!webhookSecret)
					return new Response("webhookSecret is required", { status: 500 });
				if (
					bearerToken(request.headers.get("Authorization")) !== webhookSecret
				) {
					return new Response("forbidden", { status: 403 });
				}
				const meta = await request.json().catch(() => ({}));
				const commit = parseCommitMeta(meta);
				const eta = etaSeconds(meta);
				log.info(
					`deploy started${commit ? ` · ${describeCommit(commit)}` : ""}`,
				);
				ctx.waitUntil(
					adminIds().then((ids) =>
						notifyAdmins(
							bot,
							ids,
							`🛳 <b>@${bot.info?.username}</b> deploying${eta ? ` <i>(~${eta}s)</i>` : ""}…${commitHtml(commit)}`,
							DEPLOY_DM_PARAMS,
						),
					),
				);
				return new Response("ok");
			}

			// Deploy narration, step 2 of 2: what went LIVE — and the load-bearing
			// webhook re-registration (allowed_updates derives from the handlers).
			if (request.method === "POST" && url.pathname === "/setup") {
				if (!webhookSecret)
					return new Response("webhookSecret is required", { status: 500 });
				const token =
					bearerToken(request.headers.get("Authorization")) ??
					request.headers.get("X-Setup-Token");
				if (token !== webhookSecret)
					return new Response("forbidden", { status: 403 });
				const commit = parseCommitMeta(await request.json().catch(() => ({})));
				const allowedUpdates = await registerWebhook(
					bot,
					url.origin,
					webhookSecret,
				);
				log.success(
					`deployed${commit ? ` · ${describeCommit(commit)}` : ""} — webhook registered`,
				);
				ctx.waitUntil(
					adminIds().then((ids) =>
						notifyAdmins(
							bot,
							ids,
							`🚀 <b>@${bot.info?.username}</b> deployed · webhook registered${commitHtml(commit)}`,
							DEPLOY_DM_PARAMS,
						),
					),
				);
				return new Response(
					`[${mode}] webhook set to ${url.origin}/ (updates: ${allowedUpdates.join(", ")})`,
				);
			}

			// The operator tap: pause = deleteWebhook (Telegram queues ~24h),
			// resume = re-register, status = getWebhookInfo (+statusExtra).
			if (
				url.pathname === "/pause" ||
				url.pathname === "/resume" ||
				url.pathname === "/webhook-status"
			) {
				const secret = rt.operatorSecret?.trim();
				if (!secret) return json({ error: "operator API disabled" }, 404);
				if (request.headers.get("Authorization") !== `Bearer ${secret}`) {
					return json({ error: "unauthorized" }, 401);
				}
				if (request.method === "POST" && url.pathname === "/pause") {
					await bot.api.deleteWebhook();
					ctx.waitUntil(
						adminIds().then((ids) =>
							notifyAdmins(
								bot,
								ids,
								`⏸️ @${bot.info?.username} [${mode}] paused — webhook deleted, Telegram queues ~24h.`,
							),
						),
					);
				} else if (request.method === "POST" && url.pathname === "/resume") {
					if (!webhookSecret)
						return new Response("webhookSecret is required", { status: 500 });
					await registerWebhook(bot, url.origin, webhookSecret);
					ctx.waitUntil(
						adminIds().then((ids) =>
							notifyAdmins(
								bot,
								ids,
								`▶️ @${bot.info?.username} [${mode}] resumed — webhook re-registered.`,
							),
						),
					);
				} else if (
					!(request.method === "GET" && url.pathname === "/webhook-status")
				) {
					return new Response("Not Found", { status: 404 });
				}
				const info = await bot.api.getWebhookInfo();
				const extra = rt.statusExtra ? await rt.statusExtra() : {};
				return json({ mode, paused: !info.url, ...extra, webhook: info });
			}

			return new Response("Not Found", { status: 404 });
		} catch (error) {
			log.error(
				"worker request failed:",
				error instanceof Error ? error.message : error,
			);
			return new Response("internal error", { status: 500 });
		}
	};
}

// allowed_updates must list the opt-in types (message_reaction, chat-member
// events) or Telegram never delivers them. Derived from the bot's registered
// handlers — which is why deploys re-register (/setup) and /resume re-derives
// instead of remembering a stale list.
async function registerWebhook(
	bot: WorkerBot,
	origin: string,
	webhookSecret: string,
): Promise<string[]> {
	const allowedUpdates = [...buildAllowedUpdates(bot as never)];
	await bot.api.setWebhook({
		url: `${origin}/`,
		secret_token: webhookSecret,
		allowed_updates: allowedUpdates,
	});
	return allowedUpdates;
}

function bearerToken(header: string | null): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
	return match?.[1]?.trim() || null;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// The commit riding in the JSON body a deploy script sends to /deploy-started
// and /setup. Every field optional (a bare curl still works); the message is
// clamped to its first line so a long body can't bloat a DM.
type CommitMeta = { sha: string; author: string; message: string };
function parseCommitMeta(meta: unknown): CommitMeta | null {
	const m = meta as { sha?: string; author?: string; message?: string } | null;
	const commit: CommitMeta = {
		sha: typeof m?.sha === "string" ? m.sha.trim().slice(0, 7) : "",
		author: typeof m?.author === "string" ? m.author.trim() : "",
		message:
			typeof m?.message === "string"
				? (m.message.split("\n")[0]?.trim().slice(0, 120) ?? "")
				: "",
	};
	return commit.sha || commit.author || commit.message ? commit : null;
}

/** One line for the operator log: `abc1234 · Author · "message"`. */
function describeCommit(c: CommitMeta): string {
	return [c.sha, c.author, c.message ? `“${c.message}”` : ""]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The deploy DMs' commit block (Telegram HTML), appended to the headline:
 * a mono sha + author line, then the message as a quote. Empty when no metadata came.
 */
function commitHtml(c: CommitMeta | null): string {
	if (!c) return "";
	const head = [
		c.sha ? `<code>${escapeHtml(c.sha)}</code>` : "",
		escapeHtml(c.author),
	]
		.filter(Boolean)
		.join(" · ");
	const quote = c.message
		? `\n<blockquote>${escapeHtml(c.message)}</blockquote>`
		: "";
	return `${head ? `\n${head}` : ""}${quote}`;
}

// HTML mode + no link preview, shared by both deploy DMs.
const DEPLOY_DM_PARAMS = {
	parse_mode: "HTML",
	link_preview_options: { is_disabled: true },
} as const;

/** The recent average deploy duration (seconds) a CI measured, when present and sane. */
function etaSeconds(meta: unknown): number | null {
	const n = Number((meta as { etaSeconds?: unknown } | null)?.etaSeconds);
	return Number.isFinite(n) && n > 0 && n < 3600 ? Math.round(n) : null;
}

// Local minimal escaper; graduates to bot/format when that module lands.
function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── durable per-conversation update runner ─────────────────────────────────

/** The slice of a Durable Object storage transaction the runner touches. */
type RunnerTxn = {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string | string[]): Promise<unknown>;
};

/** The slice of DurableObjectState the runner touches — satisfied by the real binding. */
export type UpdateRunnerState = {
	storage: RunnerTxn & {
		getAlarm(): Promise<number | null>;
		setAlarm(time: number): Promise<void>;
		transaction<T>(fn: (txn: RunnerTxn) => Promise<T>): Promise<T>;
	};
};

interface UpdateJob {
	updateId: number;
	update: unknown;
	attempts: number;
	enqueuedAt: number;
}

export interface UpdateRunnerOptions {
	/** Application retries per update before it is dropped as completed. Default 3. */
	maxAttempts?: number;
	/** Backoff (ms) before retry N+1; one entry per non-final attempt. Default [5s, 30s]. */
	retryMs?: readonly number[];
	/** Completed update ids retained for webhook de-duplication. Default 512. */
	dedupeLimit?: number;
}

const runnerLog = scope("bot/update-runner");

/** The Durable Object surface the factory-built runner class exposes. */
export type TelegramUpdateRunnerClass<Env> = new (
	state: UpdateRunnerState,
	env: Env,
) => {
	fetch(request: Request): Promise<Response>;
	alarm(): Promise<void>;
};

const HEAD_KEY = "head";
const TAIL_KEY = "tail";
const DONE_KEY = "done";
const jobKey = (sequence: number) =>
	`job:${sequence.toString().padStart(16, "0")}`;
const dedupeKey = (updateId: number) => `update:${updateId}`;

/**
 * Build the durable, per-conversation Telegram update runner class — bind it in
 * wrangler and hand its namespace to the runtime's `durableUpdates`. The webhook
 * ingress only persists a job and sets an alarm; each alarm handles ONE update
 * and checkpoints before scheduling the next. Unlike an HTTP waitUntil tail, an
 * alarm handler owns its full invocation, so slow transcript/LLM work is not
 * cancelled ~30 seconds after Telegram receives its acknowledgement.
 *
 * `resolve` is the same (memoized) runtime loader given to `botWorkerFetch`:
 *
 *   const loadRuntime = async (env: Env) => ({ bot: await getBot(env), ... })
 *   export class TelegramUpdateRunner extends telegramUpdateRunner(loadRuntime) {}
 *   export default { fetch: botWorkerFetch(loadRuntime) }
 */
export function telegramUpdateRunner<Env>(
	resolve: (env: Env) => Promise<BotWorkerRuntime> | BotWorkerRuntime,
	options: UpdateRunnerOptions = {},
): TelegramUpdateRunnerClass<Env> {
	const maxAttempts = options.maxAttempts ?? 3;
	const retryMs = options.retryMs ?? [5_000, 30_000];
	const dedupeLimit = options.dedupeLimit ?? 512;
	const fallbackThrottle = alertThrottle();

	return class TelegramUpdateRunner {
		constructor(
			private readonly state: UpdateRunnerState,
			private readonly env: Env,
		) {}

		async fetch(request: Request): Promise<Response> {
			if (
				request.method !== "POST" ||
				new URL(request.url).pathname !== "/enqueue"
			) {
				return new Response("not found", { status: 404 });
			}
			const update = await request.json().catch(() => null);
			const updateId = telegramUpdateId(update);
			if (updateId === null)
				return new Response("invalid Telegram update", { status: 400 });

			const enqueued = await this.state.storage.transaction(async (txn) => {
				if (await txn.get(dedupeKey(updateId))) return false;
				const tail = ((await txn.get<number>(TAIL_KEY)) ?? 0) + 1;
				const head = await txn.get<number>(HEAD_KEY);
				await txn.put(jobKey(tail), {
					updateId,
					update,
					attempts: 0,
					enqueuedAt: Date.now(),
				} satisfies UpdateJob);
				await txn.put(TAIL_KEY, tail);
				if (head === undefined) await txn.put(HEAD_KEY, tail);
				await txn.put(dedupeKey(updateId), "queued");
				return true;
			});
			// A duplicate delivery is also a recovery kick: if the first attempt
			// committed the job but failed while arming its alarm, Telegram's retry
			// must repair that gap before we acknowledge it.
			if (
				(await this.state.storage.get<number>(HEAD_KEY)) !== undefined &&
				(await this.state.storage.getAlarm()) === null
			) {
				await this.state.storage.setAlarm(Date.now());
			}
			return new Response(JSON.stringify({ enqueued, duplicate: !enqueued }), {
				headers: { "content-type": "application/json" },
			});
		}

		async alarm(): Promise<void> {
			const sequence = await this.state.storage.get<number>(HEAD_KEY);
			if (sequence === undefined) return;
			const key = jobKey(sequence);
			const job = await this.state.storage.get<UpdateJob>(key);
			if (!job) {
				await this.finish(sequence, null);
				await this.scheduleNext();
				return;
			}

			let rt: BotWorkerRuntime | undefined;
			try {
				rt = await resolve(this.env);
				await rt.bot.updates.handleUpdate(job.update);
				if (rt.flush) await rt.flush();
			} catch (error) {
				job.attempts += 1;
				runnerLog.error(
					`queued update ${job.updateId} failed · attempt ${job.attempts}/${maxAttempts}:`,
					error instanceof Error ? error.message : error,
				);
				if (rt) {
					const runtime = rt;
					await (runtime.adminIds?.() ?? Promise.resolve([]))
						.then((ids) =>
							alertAdminError(
								runtime.bot,
								ids,
								`queued Telegram update ${job.updateId} failed`,
								error,
								runtime.errorThrottle ?? fallbackThrottle,
							),
						)
						.catch(() => {});
				}
				if (job.attempts >= maxAttempts) {
					await this.finish(sequence, job.updateId);
					await this.scheduleNext();
					return;
				}
				await this.state.storage.put(key, job);
				await this.state.storage.setAlarm(
					Date.now() + (retryMs[job.attempts - 1] ?? retryMs.at(-1) ?? 30_000),
				);
				return;
			}

			// Checkpointing sits outside the processing catch: if storage/alarm
			// scheduling itself fails, let the platform retry the alarm from durable
			// state instead of misclassifying the completed Telegram update as an
			// application failure and rebuilding a retired job.
			await this.finish(sequence, job.updateId);
			runnerLog.info(
				`queued update ${job.updateId} completed · ${Date.now() - job.enqueuedAt}ms`,
			);
			await this.scheduleNext();
		}

		/** Retire the head job and retain a bounded completed-id window for webhook de-duplication. */
		private async finish(
			sequence: number,
			updateId: number | null,
		): Promise<void> {
			await this.state.storage.transaction(async (txn) => {
				await txn.delete(jobKey(sequence));
				if (updateId !== null) {
					await txn.put(dedupeKey(updateId), "done");
					const done = (await txn.get<number[]>(DONE_KEY)) ?? [];
					done.push(updateId);
					while (done.length > dedupeLimit) {
						const expired = done.shift();
						if (expired !== undefined) await txn.delete(dedupeKey(expired));
					}
					await txn.put(DONE_KEY, done);
				}
				const tail = (await txn.get<number>(TAIL_KEY)) ?? sequence;
				if (sequence >= tail) {
					await txn.delete([HEAD_KEY, TAIL_KEY]);
				} else {
					await txn.put(HEAD_KEY, sequence + 1);
				}
			});
		}

		private async scheduleNext(): Promise<void> {
			if ((await this.state.storage.get<number>(HEAD_KEY)) !== undefined) {
				await this.state.storage.setAlarm(Date.now());
			}
		}
	};
}
