/**
 * Multi-provider LLM caller with priority failover — the policy layer the
 * Vercel AI SDK deliberately doesn't ship.
 *
 * The AI SDK owns the transport: HTTP, SSE parsing, provider dialects
 * (OpenAI-compatible, Anthropic-messages, OpenRouter), tool calling,
 * streaming. This module owns the policy on top:
 *
 *   - **Priority failover across providers AND keys.** Several declarations
 *     may share one `id` to register multiple API keys for the same provider;
 *     on failure the loop prefers another healthy key of the same `id` before
 *     moving to the next `id` by priority.
 *   - **Per-key circuit breaker.** Failures cool a key down with exponential
 *     backoff (rate-limit / auth / transient classed separately), persisted in
 *     an optional {@link HealthStore} (Cloudflare KV satisfies it
 *     structurally). Without a store the loop degrades to per-request
 *     failover.
 *   - **Reset semantics for live previews.** A provider that dies mid-stream
 *     forfeits its output: the consumer gets `{kind: 'reset'}` (drop
 *     everything rendered so far) and the next candidate regenerates from
 *     scratch. Telegram draft previews repaint per frame, so a reset is one
 *     cheap frame.
 *   - **Usage accounting that feeds a ledger.** Tokens are summed across every
 *     billed attempt (a failover means more than one billed request).
 *     `costUsd` is the ACTUAL charge when the gateway reports one —
 *     OpenRouter's usage accounting (`providerMetadata.openrouter.usage.cost`)
 *     or a `cost` field on the provider's raw usage frame — never a price
 *     table estimate.
 *
 * Worker-safe: fetch/WebStreams only, no `node:*`. Peer deps: `ai`,
 * `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`,
 * `@openrouter/ai-sdk-provider` (install all four; they are small and the
 * provider used is picked per {@link ProviderConfig.type} at runtime).
 *
 * @example one-shot with failover
 * import { createLlm } from '@adriangalilea/utils/llm'
 *
 * const llm = createLlm({
 *   providers: [
 *     { id: 'openrouter', type: 'openrouter', apiKey, defaultModel: 'deepseek/deepseek-chat', priority: 0 },
 *     { id: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: key2, defaultModel: 'deepseek-chat', priority: 1 },
 *   ],
 *   health: env.KEY_HEALTH, // optional KV namespace
 * })
 * const { text, usage } = await llm.complete({ prompt })
 *
 * @example streaming with tools
 * import { tool } from '@adriangalilea/utils/llm'
 * import { z } from 'zod'
 *
 * const events = llm.stream({
 *   prompt,
 *   tools: { not_covered: tool({ description: '…', inputSchema: z.object({}) }) },
 * })
 * for await (const e of events) {
 *   if (e.kind === 'delta') draft.append(e.text)
 *   else if (e.kind === 'reset') draft.clear()
 *   else if (e.kind === 'tool-call') handle(e.toolName, e.input)
 * }
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
	APICallError,
	type LanguageModel,
	type ModelMessage,
	streamText,
	type ToolChoice,
	type ToolSet,
} from "ai";

// One import surface for consumers: the tool helper and its types ride along.
export {
	jsonSchema,
	type ModelMessage,
	type Tool,
	type ToolSet,
	tool,
} from "ai";

// ─── Config ────────────────────────────────────────────────────────

/**
 * One provider declaration. Multiple declarations MAY share an `id` to
 * register several API keys for the same provider; key health is tracked per
 * key (fingerprinted, never the secret), so one dead key never sidelines its
 * siblings.
 */
export interface ProviderConfig {
	id: string;
	/**
	 * Wire dialect. `openai` = any OpenAI-compatible endpoint (DeepSeek,
	 * vllm, mlx-lm, gateways). `anthropic` = the Anthropic messages API and
	 * compatible gateways (GLM/Zhipu, Moonshot). `openrouter` = OpenRouter
	 * with typed usage accounting (actual billed cost). An `openai` entry
	 * whose baseUrl points at openrouter.ai is upgraded to `openrouter`
	 * automatically so pre-existing configs keep their cost reporting.
	 */
	type: "openai" | "anthropic" | "openrouter";
	/** Base URL. Defaults: OpenAI-compat has none (required), anthropic → api.anthropic.com, openrouter → openrouter.ai/api/v1. */
	baseUrl?: string;
	/** Omit for auth-less endpoints (a local vllm/mlx-lm/llama.cpp server). */
	apiKey?: string;
	/** Optional allow-list of model names; when present, defaultModel must be in it. */
	models?: string[];
	defaultModel: string;
	/** Lower tries first. Default 99. */
	priority?: number;
	/** Upper bound on output tokens for this provider; caps the per-request ask. */
	maxTokens?: number;
	/** Per-model temperature overrides, keyed by model name. */
	temperatures?: Record<string, number>;
	/** Fallback temperature for models not in `temperatures`. */
	temperature?: number;
	/** Operator kill switch: skip this declaration entirely. */
	disabled?: boolean;
	/**
	 * Suppress reasoning/thinking output. Reasoning models otherwise burn the
	 * output budget on thinking. anthropic → `thinking: {type: 'disabled'}`;
	 * openrouter → `reasoning: {enabled: false}`; openai → a raw
	 * `thinking: {type: 'disabled'}` body field (the DeepSeek-style flag;
	 * plain OpenAI ignores unknown fields).
	 */
	disableThinking?: boolean;
}

/**
 * Minimal persistence for the circuit breaker. Structurally satisfied by
 * Cloudflare's `KVNamespace`. Absent → per-request failover only.
 */
export interface HealthStore {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<unknown>;
	delete(key: string): Promise<unknown>;
}

export interface LlmOptions {
	providers: ProviderConfig[];
	health?: HealthStore;
	/** Per-attempt hard timeout in ms. Default 120_000. */
	requestTimeoutMs?: number;
}

// ─── Results ───────────────────────────────────────────────────────

/**
 * Token accounting for one completed call: tokens summed across every billed
 * attempt (failovers included); `costUsd` the gateway-reported actual charge
 * when available. `provider`/`model` name the attempt that finished the
 * response.
 */
export interface LlmUsage {
	promptTokens: number;
	completionTokens: number;
	costUsd?: number;
	provider: string;
	model: string;
}

/**
 * One event of a streamed call. `reset` orders the consumer to discard
 * everything streamed so far — a fresh full response follows from another
 * provider. `usage` is absent when no provider reported it.
 */
export type LlmStreamEvent =
	| { kind: "delta"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "reset" }
	| { kind: "tool-call"; toolName: string; input: unknown }
	| { kind: "end"; usage: LlmUsage | null };

export interface LlmToolCall {
	toolName: string;
	input: unknown;
}

export interface LlmResult {
	text: string;
	reasoning: string;
	toolCalls: LlmToolCall[];
	usage: LlmUsage | null;
}

export class LlmError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "LlmError";
	}
}

// ─── Request ───────────────────────────────────────────────────────

export interface ChatRequest {
	/** Single user message. Exactly one of `prompt` / `messages`. */
	prompt?: string;
	/** Full conversation. Exactly one of `prompt` / `messages`. */
	messages?: ModelMessage[];
	/** System instructions. */
	instructions?: string;
	/** Output-token budget for this request; provider `maxTokens` caps it. Default 4096. */
	maxTokens?: number;
	tools?: ToolSet;
	toolChoice?: ToolChoice<ToolSet>;
	abortSignal?: AbortSignal;
	/**
	 * OpenAI-dialect only: raw request-body fields spread into the JSON body
	 * (`seed`, `enable_thinking`, `chat_template_kwargs`, …) — the escape hatch
	 * for self-hosted endpoints with bespoke knobs. Applied to `openai` and
	 * `openrouter` attempts; `anthropic` attempts ignore it (that API validates
	 * its body — no arbitrary fields).
	 */
	extraBody?: Record<string, unknown>;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const REQUEST_TIMEOUT_MS = 120_000;

// ─── Circuit breaker ───────────────────────────────────────────────
// Base cool-down per failure class; the window grows exponentially with the
// consecutive failure count, capped at one hour. A key past its recovery time
// probes again; jitter spreads concurrent probes so a fleet doesn't hammer a
// just-recovered key in one synchronized burst.

const RATE_LIMIT_BASE_MS = 60_000; // 429: providers' rate windows are ~a minute
const TRANSIENT_BASE_MS = 30_000; // 5xx / timeout / network: usually clears quickly
const AUTH_BASE_MS = 300_000; // 401/403: a revoked key won't self-heal, start at 5 min
const BACKOFF_CAP_MS = 3_600_000;
const RECOVERY_JITTER_MS = 10_000;

interface KeyHealth {
	status: "failed" | "rate_limited";
	updatedAt: number;
	recoveryAt: number;
	failures: number;
}

type FailureClass = "rate_limited" | "auth" | "client" | "transient";

// Classify a failed attempt by HTTP status. `client` (our own bad request,
// 4xx except 408/429) must not blacklist a healthy key.
function classifyError(e: unknown): FailureClass {
	const status = APICallError.isInstance(e)
		? e.statusCode
		: e instanceof LlmError
			? e.status
			: undefined;
	if (status === undefined) return "transient"; // network/DNS/TLS/timeout
	if (status === 429) return "rate_limited";
	if (status === 401 || status === 403) return "auth";
	if (status >= 400 && status < 500 && status !== 408) return "client";
	return "transient";
}

// Stable, non-reversible fingerprint of an API key (FNV-1a → base36): health
// is tracked PER KEY without ever writing the secret into a store key or log.
function keyFingerprint(apiKey: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < apiKey.length; i++) {
		h ^= apiKey.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

const keyId = (p: ProviderConfig): string =>
	`${p.id}:${keyFingerprint(p.apiKey ?? "")}`;

// ─── The caller ────────────────────────────────────────────────────

export function createLlm(opts: LlmOptions): Llm {
	return new Llm(opts);
}

interface Candidate {
	provider: ProviderConfig;
	health: KeyHealth | null;
}

// Outcome of one provider attempt.
interface Attempt {
	ok: boolean;
	emitted: boolean; // any delta/reasoning reached the consumer
	error?: unknown;
	usage: {
		promptTokens: number;
		completionTokens: number;
		costUsd?: number;
	} | null;
}

export class Llm {
	constructor(private readonly opts: LlmOptions) {
		if (opts.providers.length === 0)
			throw new LlmError("llm: no providers configured");
	}

	/** One-shot: run {@link stream} to completion and collect the pieces. */
	async complete(req: ChatRequest): Promise<LlmResult> {
		let text = "";
		let reasoning = "";
		const toolCalls: LlmToolCall[] = [];
		let usage: LlmUsage | null = null;
		for await (const event of this.stream(req)) {
			if (event.kind === "delta") text += event.text;
			else if (event.kind === "reasoning") reasoning += event.text;
			else if (event.kind === "reset") {
				text = "";
				reasoning = "";
				toolCalls.length = 0;
			} else if (event.kind === "tool-call")
				toolCalls.push({ toolName: event.toolName, input: event.input });
			else usage = event.usage;
		}
		return { text: text.trim(), reasoning: reasoning.trim(), toolCalls, usage };
	}

	/**
	 * Stream one response with failover. Attempts candidates in priority order
	 * (healthy keys first, same-`id` siblings preferred after a failure); an
	 * attempt that fails after emitting output yields `reset` so the consumer
	 * starts over. Throws {@link LlmError} when every candidate is exhausted.
	 * An attempt that finishes with no text and no tool calls counts as failed
	 * — an empty completion is a provider bug, not an answer.
	 */
	async *stream(req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
		if ((req.prompt === undefined) === (req.messages === undefined))
			throw new LlmError("llm: pass exactly one of prompt/messages");

		const errors: string[] = [];
		const queue = await this.buildQueue(errors);
		let preferId: string | undefined;
		let totalPrompt = 0;
		let totalCompletion = 0;
		let totalCost: number | undefined;

		while (queue.length > 0) {
			let idx = 0;
			if (preferId !== undefined) {
				const sameIdx = queue.findIndex((c) => c.provider.id === preferId);
				if (sameIdx !== -1) idx = sameIdx;
			}
			const { provider, health } = queue.splice(idx, 1)[0];

			const attempt = yield* this.runAttempt(provider, req);
			if (attempt.usage) {
				totalPrompt += attempt.usage.promptTokens;
				totalCompletion += attempt.usage.completionTokens;
				if (attempt.usage.costUsd !== undefined)
					totalCost = (totalCost ?? 0) + attempt.usage.costUsd;
			}

			if (attempt.ok) {
				// Recovery: DELETE the health key (absence == healthy), clearing the failure counter.
				if (health) await this.clearHealth(keyId(provider));
				yield {
					kind: "end",
					usage:
						totalPrompt || totalCompletion || totalCost !== undefined
							? {
									promptTokens: totalPrompt,
									completionTokens: totalCompletion,
									...(totalCost !== undefined ? { costUsd: totalCost } : {}),
									provider: provider.id,
									model: provider.defaultModel,
								}
							: null,
				};
				return;
			}

			// The caller's own signal aborting is not a provider failure: don't
			// penalize the key, don't sweep the remaining candidates with an
			// already-dead signal.
			if (req.abortSignal?.aborted) throw new LlmError("llm: aborted");

			const msg =
				attempt.error instanceof Error
					? attempt.error.message
					: String(attempt.error);
			errors.push(`${provider.id}: ${msg}`);
			await this.recordFailure(
				keyId(provider),
				provider.id,
				health,
				classifyError(attempt.error),
				msg,
			);

			// Whatever this attempt painted is now stale; order a repaint before
			// the next attempt streams a fresh response.
			if (attempt.emitted) yield { kind: "reset" };
			preferId = provider.id;
		}

		if (errors.length === 0)
			throw new LlmError(
				"llm: all providers unavailable (disabled or cooling down after failures)",
			);
		throw new LlmError(`llm: all providers failed: ${errors.join("; ")}`);
	}

	// Stream one provider attempt, translating AI SDK parts to LlmStreamEvents.
	private async *runAttempt(
		provider: ProviderConfig,
		req: ChatRequest,
	): AsyncGenerator<LlmStreamEvent, Attempt> {
		let emitted = false;
		let sawContent = false;
		let usage: Attempt["usage"] = null;
		try {
			const result = streamText({
				model: this.modelFor(provider, req),
				...(req.prompt !== undefined
					? { prompt: req.prompt }
					: { messages: req.messages as ModelMessage[] }),
				...(req.instructions !== undefined
					? { instructions: req.instructions }
					: {}),
				temperature: resolveTemperature(provider),
				maxOutputTokens: resolveMaxTokens(provider, req.maxTokens),
				maxRetries: 0, // retry policy lives in the failover loop, not the transport
				abortSignal: withTimeout(
					req.abortSignal,
					this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
				),
				...(req.tools ? { tools: req.tools } : {}),
				...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
				...this.providerOptionsFor(provider, req),
			});

			for await (const part of result.stream) {
				if (part.type === "text-delta") {
					emitted = true;
					sawContent = true;
					yield { kind: "delta", text: part.text };
				} else if (part.type === "reasoning-delta") {
					emitted = true;
					yield { kind: "reasoning", text: part.text };
				} else if (part.type === "tool-call") {
					sawContent = true;
					yield {
						kind: "tool-call",
						toolName: part.toolName,
						input: part.input,
					};
				} else if (part.type === "finish-step") {
					usage = {
						promptTokens: part.usage.inputTokens ?? 0,
						completionTokens: part.usage.outputTokens ?? 0,
						...(extractCost(part.providerMetadata, part.usage.raw) !== undefined
							? { costUsd: extractCost(part.providerMetadata, part.usage.raw) }
							: {}),
					};
				} else if (part.type === "error") {
					// The AI SDK stream never throws; failures arrive as parts.
					return { ok: false, emitted, error: part.error, usage };
				} else if (part.type === "abort") {
					return {
						ok: false,
						emitted,
						error: new LlmError("llm: aborted"),
						usage,
					};
				}
			}
		} catch (e) {
			return { ok: false, emitted, error: e, usage };
		}
		if (!sawContent)
			return {
				ok: false,
				emitted,
				error: new LlmError("llm: empty completion"),
				usage,
			};
		return { ok: true, emitted, usage };
	}

	// One AI SDK model instance per attempt, by wire dialect. An `openai`
	// entry pointed at openrouter.ai is upgraded to the openrouter provider so
	// legacy configs keep typed cost accounting.
	private modelFor(provider: ProviderConfig, req: ChatRequest): LanguageModel {
		const type = dialectOf(provider);
		if (type === "openrouter") {
			const openrouter = createOpenRouter({
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
				...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
			});
			return openrouter.chat(provider.defaultModel, {
				usage: { include: true }, // OpenRouter usage accounting: actual billed cost on the final chunk
				...(provider.disableThinking
					? { reasoning: { enabled: false, effort: "none" } }
					: {}),
				...(req.extraBody ? { extraBody: req.extraBody } : {}),
			});
		}
		if (type === "anthropic") {
			const anthropic = createAnthropic({
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
				...(provider.baseUrl
					? { baseURL: normalizeAnthropicBase(provider.baseUrl) }
					: {}),
			});
			return anthropic(provider.defaultModel);
		}
		if (!provider.baseUrl)
			throw new LlmError(
				`llm: provider ${provider.id} (openai) requires baseUrl`,
			);
		const compat = createOpenAICompatible({
			name: provider.id,
			baseURL: normalizeOpenAiBase(provider.baseUrl),
			...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
			includeUsage: true, // stream_options usage frame
		});
		return compat.chatModel(provider.defaultModel);
	}

	// Dialect-specific request body knobs, keyed the way each provider expects:
	// openai-compatible spreads providerOptions[name] raw into the JSON body,
	// which carries both the disableThinking flag and the request's extraBody.
	private providerOptionsFor(
		provider: ProviderConfig,
		req: ChatRequest,
	): Pick<Parameters<typeof streamText>[0], "providerOptions"> {
		const type = dialectOf(provider);
		if (type === "anthropic")
			return provider.disableThinking
				? { providerOptions: { anthropic: { thinking: { type: "disabled" } } } }
				: {};
		if (type === "openai") {
			const body = {
				...(provider.disableThinking ? { thinking: { type: "disabled" } } : {}),
				...req.extraBody,
			};
			return Object.keys(body).length > 0
				? { providerOptions: { [provider.id]: body } }
				: {};
		}
		return {}; // openrouter: settings + extraBody ride the model instance in modelFor
	}

	// Ordered attemptable keys: available now first (priority order), then
	// jitter-deferred recovering keys as a deterministic fallback. Disabled and
	// misconfigured declarations are dropped with a recorded reason.
	private async buildQueue(errors: string[]): Promise<Candidate[]> {
		const sorted = [...this.opts.providers].sort(
			(a, b) => (a.priority ?? 99) - (b.priority ?? 99),
		);
		const available: Candidate[] = [];
		const deferred: Candidate[] = [];
		for (const provider of sorted) {
			if (provider.disabled) continue;
			if (!provider.id || !provider.defaultModel) {
				errors.push(`${provider.id || "(no id)"}: missing id or defaultModel`);
				continue;
			}
			if (
				Array.isArray(provider.models) &&
				provider.models.length > 0 &&
				!provider.models.includes(provider.defaultModel)
			) {
				errors.push(
					`${provider.id}: defaultModel "${provider.defaultModel}" is not in models`,
				);
				continue;
			}
			const health = await this.getHealth(keyId(provider));
			const state = healthState(health);
			if (state === "down") continue;
			if (state === "probe-deferred") deferred.push({ provider, health });
			else available.push({ provider, health });
		}
		return [...available, ...deferred];
	}

	// Health plumbing is advisory and best-effort: a KV hiccup (or no store at
	// all) must never break a chat request.
	private async getHealth(storeKey: string): Promise<KeyHealth | null> {
		if (!this.opts.health) return null;
		try {
			const raw = await this.opts.health.get(`health:${storeKey}`);
			return raw ? (JSON.parse(raw) as KeyHealth) : null;
		} catch {
			return null;
		}
	}

	private async recordFailure(
		storeKey: string,
		label: string,
		prev: KeyHealth | null,
		cls: FailureClass,
		errMsg: string,
	): Promise<void> {
		if (cls === "client") {
			console.error(
				`[llm:health] ${label} rejected our request (${errMsg}); not marking unhealthy`,
			);
			return;
		}
		const now = Date.now();
		const failures = (prev?.failures ?? 0) + 1;
		const base =
			cls === "rate_limited"
				? RATE_LIMIT_BASE_MS
				: cls === "auth"
					? AUTH_BASE_MS
					: TRANSIENT_BASE_MS;
		const backoff = Math.min(base * 2 ** (failures - 1), BACKOFF_CAP_MS);
		const health: KeyHealth = {
			status: cls === "rate_limited" ? "rate_limited" : "failed",
			updatedAt: now,
			recoveryAt: now + backoff,
			failures,
		};
		// TTL outlives the jittered recovery window so the failure counter keeps
		// escalating a persistently-dead key, yet self-heals to "healthy" (key
		// absent) if traffic stops.
		const ttl = Math.ceil((backoff + RECOVERY_JITTER_MS) / 1000) + 60;
		if (this.opts.health) {
			try {
				await this.opts.health.put(
					`health:${storeKey}`,
					JSON.stringify(health),
					{ expirationTtl: ttl },
				);
			} catch {
				// best-effort
			}
		}
		const until = new Date(health.recoveryAt).toISOString();
		console.error(
			`[llm:health] ${label} ${cls} (${errMsg}); cooling down until ${until} (failure #${failures})`,
		);
	}

	private async clearHealth(storeKey: string): Promise<void> {
		if (!this.opts.health) return;
		try {
			await this.opts.health.delete(`health:${storeKey}`);
		} catch {
			// best-effort
		}
	}
}

// The wire dialect actually used for an attempt: an `openai` entry pointed at
// openrouter.ai upgrades to the openrouter provider so legacy configs keep
// typed cost accounting.
function dialectOf(provider: ProviderConfig): ProviderConfig["type"] {
	return provider.type === "openai" &&
		provider.baseUrl?.includes("openrouter.ai")
		? "openrouter"
		: provider.type;
}

// 'available' = use/probe now; 'probe-deferred' = past recovery but jitter
// says wait (fallback tail); 'down' = still inside the cool-down window.
function healthState(
	health: KeyHealth | null,
): "available" | "probe-deferred" | "down" {
	if (!health) return "available";
	const now = Date.now();
	if (now < health.recoveryAt) return "down";
	const jitter = Math.random() * RECOVERY_JITTER_MS;
	return now >= health.recoveryAt + jitter ? "available" : "probe-deferred";
}

function resolveTemperature(provider: ProviderConfig): number {
	const preferred = [
		provider.temperatures?.[provider.defaultModel],
		provider.temperature,
	].find((t): t is number => typeof t === "number" && Number.isFinite(t));
	const base = preferred ?? DEFAULT_TEMPERATURE;
	// Anthropic accepts [0, 1]; everything OpenAI-shaped accepts [0, 2].
	const ceiling = provider.type === "anthropic" ? 1 : 2;
	return Math.max(0, Math.min(base, ceiling));
}

function resolveMaxTokens(
	provider: ProviderConfig,
	requested?: number,
): number {
	const ask = requested ?? DEFAULT_MAX_TOKENS;
	return provider.maxTokens ? Math.min(ask, provider.maxTokens) : ask;
}

// Combine the caller's abort signal (client disconnect) with a hard per-attempt
// timeout so a stalled upstream can't wedge the request forever.
function withTimeout(
	external: AbortSignal | undefined,
	ms: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return external ? AbortSignal.any([external, timeout]) : timeout;
}

// The Anthropic provider appends /v1/messages relative to its base; tolerate a
// pasted base that already carries /v1 or trailing slashes.
function normalizeAnthropicBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// The OpenAI-compatible provider appends /chat/completions; tolerate a pasted
// full URL.
function normalizeOpenAiBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * Actual billed cost for one attempt, when the gateway reports one. Typed via
 * the OpenRouter provider's metadata; falls back to a numeric `cost` on the
 * raw usage frame (OpenAI-compatible gateways that do usage accounting).
 */
function extractCost(
	providerMetadata: unknown,
	rawUsage: unknown,
): number | undefined {
	const or = (
		providerMetadata as
			| { openrouter?: { usage?: { cost?: unknown } } }
			| undefined
	)?.openrouter?.usage?.cost;
	if (typeof or === "number") return or;
	const raw = (rawUsage as { cost?: unknown } | undefined)?.cost;
	return typeof raw === "number" ? raw : undefined;
}
