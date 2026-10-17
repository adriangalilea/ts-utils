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
 *   - **A tool loop that never acts twice.** `stopWhen` runs the AI SDK's
 *     loop (tools with `execute`, called again with their results); once a
 *     tool has run, a failure ends the call instead of failing over, since
 *     another provider would replay the tools from scratch.
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
	asSchema,
	type FlexibleSchema,
	type JSONSchema7,
	type LanguageModel,
	type ModelMessage,
	NoObjectGeneratedError,
	Output,
	type PrepareStepFunction,
	type PrepareStepResult,
	type StopCondition,
	streamText,
	type ToolCallRepairFunction,
	type ToolChoice,
	ToolChoiceViolationError,
	type ToolSet,
} from "ai";
import { type Logger, log as root, type Span } from "../universal/log.js";

const log = root.scope("llm").scope("health");

// One import surface for consumers: the tool helper, the tool loop's stop
// conditions, the serial executor a loop's ordered tools share, and their types.
export {
	hasToolCall,
	jsonSchema,
	type ModelMessage,
	SerialJobExecutor,
	type StopCondition,
	stepCountIs,
	type Tool,
	type ToolSet,
	tool,
} from "ai";

/** Whether a JSON Schema takes a list or an object (alone or among `anyOf`/`oneOf`). */
const structured = (s: JSONSchema7 | boolean | undefined): boolean => {
	if (typeof s !== "object") return false;
	const types = Array.isArray(s.type) ? s.type : [s.type];
	if (types.includes("array") || types.includes("object")) return true;
	return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some(structured);
};

/** JSON parsed, or undefined. */
const parsed = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * A tool call's input mended where the model wrote a list or an object as a string of
 * JSON: `"found": "[…]"`, and the string that swallowed the fields after it,
 * `"found": "[…], \"verdict\": \"…\"}"` (verdict then missing). Each such field of the
 * schema is read as JSON in its place: alone, else as the rest of the object it was cut
 * from, whose fields come back beside it. Null when nothing mends. A local model ended
 * a task this way and, told "expected array, received string", sent the same call until
 * its budget ran out, sure the tool was caching its input.
 */
export function mended(input: string, schema: JSONSchema7): string | null {
	const value = parsed(input);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const fields = schema.properties ?? {};
	const out: Record<string, unknown> = { ...value };
	let changed = false;
	for (const [key, held] of Object.entries(value)) {
		if (typeof held !== "string" || !structured(fields[key])) continue;
		const alone = parsed(held);
		if (typeof alone === "object" && alone !== null) {
			out[key] = alone;
			changed = true;
			continue;
		}
		const rest = parsed(`{${JSON.stringify(key)}:${held}`);
		if (typeof rest !== "object" || rest === null) continue;
		for (const [k, v] of Object.entries(rest)) {
			if (k === key || !(k in out)) out[k] = v;
		}
		changed = true;
	}
	return changed ? JSON.stringify(out) : null;
}

/** The repair every tool loop runs on a call whose input failed its schema (`mended`). */
const repair: ToolCallRepairFunction<ToolSet> = async ({
	toolCall,
	tools,
	inputSchema,
}) => {
	if (!(toolCall.toolName in tools)) return null;
	const input = mended(
		toolCall.input,
		await inputSchema({ toolName: toolCall.toolName }),
	);
	return input === null ? null : { ...toolCall, input };
};

/** Every anthropic request marks its prompt for Anthropic's prompt cache: unlike the
 *  other dialects' servers, Anthropic caches only what a request asks it to, so a tool
 *  loop unmarked reads its whole conversation again, at full price, on every step. A
 *  prompt under the model's minimum cacheable size is not cached and costs nothing
 *  more; a first write costs a quarter more than reading it fresh. */
const ANTHROPIC_CACHE = { cacheControl: { type: "ephemeral" } } as const;

/** How much a model reasons before it answers: the AI SDK's level ("none" turns it
 *  off, where the provider can). */
export type Reasoning = NonNullable<
	Parameters<typeof streamText>[0]["reasoning"]
>;

/**
 * The tool loop's step hook: the AI SDK's, whose result may also say how much the
 * model reasons on that step (`reasoning`), mapped to the provider's own option.
 */
export type PrepareStep = (
	options: Parameters<PrepareStepFunction<ToolSet>>[0],
) =>
	| (PrepareStepResult<ToolSet> & { reasoning?: Reasoning })
	| undefined
	| PromiseLike<
			(PrepareStepResult<ToolSet> & { reasoning?: Reasoning }) | undefined
	  >;

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
	/** Fallback temperature for models not in `temperatures`. With neither, no
	 *  temperature is sent: the model samples its own way (Claude 5.5 takes none). */
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
	/**
	 * The server enforces a JSON schema while it decodes (`response_format` of type
	 * `json_schema`), so a request's `schema` is sent to it. Without it the answer is
	 * asked for as JSON and validated after. `openai` dialect only.
	 */
	structuredOutputs?: boolean;
	/**
	 * Transport override for this provider: every request to it goes through
	 * this function instead of the global fetch. How a Worker reaches an
	 * endpoint it has no route to (a self-hosted engine behind a relay
	 * socket, a tunnel, a test double). Not serializable, so it can only be
	 * set by code, never by a config file. Honored by every dialect.
	 */
	fetch?: typeof globalThis.fetch;
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
	/** Hard timeout of each request to a model, in ms. Default 120_000. A tool
	 *  loop's tools run between requests and are not timed by it. */
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
	/** Prompt tokens the provider served from its KV/prompt cache, when it says (OpenAI `cached_tokens`). */
	cachedTokens?: number;
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
	/** A tool call's arguments arriving as text; `tool-call` follows with the parsed whole. */
	| { kind: "tool-input-delta"; toolCallId: string; delta: string }
	| { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
	| {
			kind: "end";
			usage: LlmUsage | null;
			object?: unknown;
			/** The turns this call added: the model's, and its tools' results. */
			messages: ModelMessage[];
	  };

export interface LlmToolCall {
	/** The provider's id for this call: what a later turn must echo back to replay it (ds4 keys its exact-DSML replay on it). */
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface LlmResult {
	text: string;
	reasoning: string;
	toolCalls: LlmToolCall[];
	usage: LlmUsage | null;
	/** The answer parsed and validated against `schema`, when the request gave one. */
	object?: unknown;
	/** The turns this call added, every step's: the model's, and its tools' results.
	 *  Appended to the request's `messages`, the conversation goes on from here. */
	messages: ModelMessage[];
}

/**
 * Why one provider's attempt failed, typed for a caller to act on:
 * `off-schema`, the model answered and its answer is not the schema's shape
 * (`text` what it wrote, `cut` when its token cap stopped it before the end);
 * `empty`, it answered nothing; `failed`, the call itself failed (the
 * provider's words, its HTTP status when it gave one).
 */
export type LlmFailure =
	| { kind: "off-schema"; provider: string; text: string; cut: boolean }
	| { kind: "empty"; provider: string }
	| { kind: "failed"; provider: string; message: string; status?: number };

export class LlmError extends Error {
	/** Each provider's failure in the order tried: empty for an error before any attempt. */
	readonly failures: LlmFailure[];
	constructor(
		message: string,
		readonly status?: number,
		failures: LlmFailure[] = [],
	) {
		super(message);
		this.name = "LlmError";
		this.failures = failures;
	}
}

/** An attempt's error as an `LlmFailure`: the AI SDK's own error for an answer
 *  that is not the schema's, which carries the text and why it stopped. */
function failureOf(provider: string, error: unknown): LlmFailure {
	if (NoObjectGeneratedError.isInstance(error))
		return {
			kind: "off-schema",
			provider,
			text: error.text ?? "",
			cut: error.finishReason === "length",
		};
	// A turn that had to call a tool and called none answered nothing it could: as empty
	// as no answer, which the caller tells the model, not a broken provider
	if (
		(error instanceof LlmError && error.message === EMPTY) ||
		ToolChoiceViolationError.isInstance(error)
	)
		return { kind: "empty", provider };
	const status = APICallError.isInstance(error)
		? error.statusCode
		: error instanceof LlmError
			? error.status
			: undefined;
	return {
		kind: "failed",
		provider,
		message: error instanceof Error ? error.message : String(error),
		...(status !== undefined ? { status } : {}),
	};
}

/** An attempt that streamed no content at all. */
const EMPTY = "llm: empty completion";

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
	/**
	 * The tool loop: the tools the model calls that have an `execute` run, and the
	 * model is called again with their results until one of these holds (the AI SDK's
	 * stop conditions: `stepCountIs(n)`, `hasToolCall(name)`, or any function of the
	 * steps so far). Default: one step. Each step is a `step` span in its attempt.
	 * Once a tool has run, a failure is the call's: no other provider is tried, since
	 * its tools would run again.
	 */
	stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
	/**
	 * Before each step of the tool loop: settings for it (the AI SDK's step hook),
	 * among them `messages`, which replace what the model reads from that step on
	 * (a conversation kept inside its window), and `reasoning`, how much the model
	 * reasons on that step alone. The result's `messages` stay the turns the call
	 * added, never the replaced ones.
	 */
	prepareStep?: PrepareStep;
	/** How much the model reasons before each answer, unless a step says otherwise.
	 *  A `reasoning_effort` in `extraBody` would override any step's: use this. */
	reasoning?: Reasoning;
	abortSignal?: AbortSignal;
	/**
	 * OpenAI-dialect only: raw request-body fields spread into the JSON body
	 * (`seed`, `enable_thinking`, `chat_template_kwargs`, …) — the escape hatch
	 * for self-hosted endpoints with bespoke knobs. Applied to `openai` and
	 * `openrouter` attempts; `anthropic` attempts ignore it (that API validates
	 * its body — no arbitrary fields).
	 */
	extraBody?: Record<string, unknown>;
	/**
	 * The shape the answer must have: a zod schema, or `jsonSchema(schema, { validate })`.
	 * The result's `object` is the answer parsed and checked by the schema's own
	 * validation (zod's, or `validate`; a `jsonSchema` without one only parses); an answer
	 * that fails it fails that attempt, and the next provider is tried. A provider
	 * declaring `structuredOutputs` gets the schema to enforce while it decodes.
	 */
	schema?: FlexibleSchema<unknown>;
	/**
	 * The logger or span this call belongs under. The call is a `chat` span there
	 * (kind `inference`), each provider tried an `attempt` span inside it, named
	 * with OpenTelemetry's gen_ai fields: provider, model, server, tokens, cost,
	 * time to the first token and decoding time. Default: the root logger.
	 */
	log?: Logger;
}

const DEFAULT_MAX_TOKENS = 4096;
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
		cachedTokens?: number;
		completionTokens: number;
		costUsd?: number;
	} | null;
	/** The answer parsed against the request's schema, when it gave one. */
	object?: unknown;
	/** A tool ran: what it did is done, and no other provider may do it again. */
	acted: boolean;
	/** The turns the attempt added, when it finished. */
	messages: ModelMessage[];
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
		let object: unknown;
		let messages: ModelMessage[] = [];
		for await (const event of this.stream(req)) {
			if (event.kind === "delta") text += event.text;
			else if (event.kind === "reasoning") reasoning += event.text;
			else if (event.kind === "reset") {
				text = "";
				reasoning = "";
				toolCalls.length = 0;
			} else if (event.kind === "tool-call")
				toolCalls.push({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: event.input,
				});
			else if (event.kind === "end") {
				usage = event.usage;
				object = event.object;
				messages = event.messages;
			}
		}
		return {
			text: text.trim(),
			reasoning: reasoning.trim(),
			toolCalls,
			usage,
			...(req.schema ? { object } : {}),
			messages,
		};
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
		const span = (req.log ?? root).scope("llm").begin("chat", {
			kind: "inference",
			"gen_ai.operation.name": "chat",
		});
		// A consumer that stops reading ends the span too (finally runs on return)
		let ended = false;
		try {
			for await (const event of this.failover(req, span)) {
				if (event.kind === "end" && event.usage)
					span.set({
						"gen_ai.provider.name": event.usage.provider,
						"gen_ai.request.model": event.usage.model,
						...usageFields(event.usage),
					});
				yield event;
			}
		} catch (err) {
			ended = true;
			span.end(err);
			throw err;
		} finally {
			if (!ended) span.end();
		}
	}

	private async *failover(
		req: ChatRequest,
		span: Span,
	): AsyncGenerator<LlmStreamEvent> {
		const errors: string[] = [];
		const failures: LlmFailure[] = [];
		const queue = await this.buildQueue(errors);
		let preferId: string | undefined;
		let totalPrompt = 0;
		let totalCached: number | undefined;
		let totalCompletion = 0;
		let totalCost: number | undefined;

		while (queue.length > 0) {
			let idx = 0;
			if (preferId !== undefined) {
				const sameIdx = queue.findIndex((c) => c.provider.id === preferId);
				if (sameIdx !== -1) idx = sameIdx;
			}
			const { provider, health } = queue.splice(idx, 1)[0];

			const attempt = yield* this.timedAttempt(provider, req, span);
			if (attempt.usage) {
				totalPrompt += attempt.usage.promptTokens;
				if (attempt.usage.cachedTokens !== undefined)
					totalCached = (totalCached ?? 0) + attempt.usage.cachedTokens;
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
									...(totalCached !== undefined
										? { cachedTokens: totalCached }
										: {}),
									completionTokens: totalCompletion,
									...(totalCost !== undefined ? { costUsd: totalCost } : {}),
									provider: provider.id,
									model: provider.defaultModel,
								}
							: null,
					...(req.schema ? { object: attempt.object } : {}),
					messages: attempt.messages,
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
			failures.push(failureOf(provider.id, attempt.error));
			await this.recordFailure(
				keyId(provider),
				provider.id,
				health,
				classifyError(attempt.error),
				attempt.error,
			);
			// A tool that ran has acted on the world: another provider would act again
			if (attempt.acted)
				throw new LlmError(
					`llm: ${provider.id} failed after its tools ran: ${msg}`,
					undefined,
					failures,
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
		throw new LlmError(
			`llm: all providers failed: ${errors.join("; ")}`,
			undefined,
			failures,
		);
	}

	// One provider attempt as a span: where it went, how long until its first token
	// (the prompt's processing, network included), how long it decoded after it, and
	// what it was billed.
	private async *timedAttempt(
		provider: ProviderConfig,
		req: ChatRequest,
		parent: Span,
	): AsyncGenerator<LlmStreamEvent, Attempt> {
		const server = provider.baseUrl ? hostOf(provider.baseUrl) : undefined;
		const span = parent.begin("attempt", {
			"gen_ai.provider.name": provider.id,
			"gen_ai.request.model": provider.defaultModel,
			...(server ? { "server.address": server } : {}),
		});
		const t0 = performance.now();
		let first: number | undefined;
		let ended = false;
		try {
			const run = this.runAttempt(provider, req, span);
			for (let step = await run.next(); ; step = await run.next()) {
				if (step.done) {
					const done = performance.now();
					span.set({
						...(first !== undefined
							? {
									ttft_ms: Math.round(first - t0),
									decode_ms: Math.round(done - first),
								}
							: {}),
						...(step.value.usage ? usageFields(step.value.usage) : {}),
					});
					ended = true;
					span.end(step.value.ok ? undefined : step.value.error);
					return step.value;
				}
				first ??= performance.now();
				yield step.value;
			}
		} finally {
			if (!ended) span.end();
		}
	}

	// Stream one provider attempt, translating AI SDK parts to LlmStreamEvents;
	// each step of a tool loop a `step` span under the attempt's.
	private async *runAttempt(
		provider: ProviderConfig,
		req: ChatRequest,
		parent: Span,
	): AsyncGenerator<LlmStreamEvent, Attempt> {
		let emitted = false;
		let sawContent = false;
		let acted = false;
		let usage: Attempt["usage"] = null;
		/** The step being decoded: its span, when it began, its first token, its calls. */
		let step:
			| { span: Span; t0: number; first?: number; calls: string[] }
			| undefined;
		let steps = 0;
		/** The answer parsed against the request's schema, settled once the stream ends. */
		let parsed: PromiseLike<unknown> | undefined;
		try {
			// A server that enforces no schema is only asked for JSON (the provider drops
			// the schema with a warning): the shape is stated in the instructions instead
			const stated =
				req.schema &&
				!(dialectOf(provider) === "openai" && provider.structuredOutputs)
					? `Answer with one JSON object only, matching this JSON Schema:\n${JSON.stringify(await asSchema(req.schema).jsonSchema)}`
					: "";
			const instructions = [req.instructions, stated]
				.filter((t) => t)
				.join("\n\n");
			const temperature = resolveTemperature(provider);
			const result = streamText({
				model: this.modelFor(provider, req),
				...(req.prompt !== undefined
					? { prompt: req.prompt }
					: { messages: req.messages as ModelMessage[] }),
				// A conversation in the OpenAI shape carries its system text as messages,
				// sometimes after the first turn: kept where it is
				allowSystemInMessages: true,
				...(instructions ? { instructions } : {}),
				...(req.schema
					? { output: Output.object({ schema: req.schema }) }
					: {}),
				...(temperature !== undefined ? { temperature } : {}),
				maxOutputTokens: resolveMaxTokens(provider, req.maxTokens),
				maxRetries: 0, // retry policy lives in the failover loop, not the transport
				// The failover loop consumes error parts and reports once per attempt;
				// without this no-op the SDK ALSO dumps the full APICallError to console.
				onError: () => {},
				...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
				...(req.tools ? { tools: req.tools, repairToolCall: repair } : {}),
				...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
				...(req.stopWhen ? { stopWhen: req.stopWhen } : {}),
				...(req.reasoning ? { reasoning: req.reasoning } : {}),
				...(req.prepareStep
					? { prepareStep: this.stepping(provider, req.prepareStep) }
					: {}),
				...this.providerOptionsFor(provider),
			});

			for await (const part of result.stream) {
				// A step's first token is the first thing it decodes: words, thinking, a call
				if (
					step &&
					step.first === undefined &&
					(part.type === "text-delta" ||
						part.type === "reasoning-delta" ||
						part.type === "tool-input-start" ||
						part.type === "tool-call")
				)
					step.first = performance.now();
				if (part.type === "start-step") {
					steps += 1;
					step = {
						span: parent.begin("step", { step: steps }),
						t0: performance.now(),
						calls: [],
					};
				} else if (part.type === "text-delta") {
					emitted = true;
					sawContent = true;
					yield { kind: "delta", text: part.text };
				} else if (part.type === "reasoning-delta") {
					emitted = true;
					yield { kind: "reasoning", text: part.text };
				} else if (part.type === "tool-input-delta") {
					emitted = true;
					yield {
						kind: "tool-input-delta",
						toolCallId: part.id,
						delta: part.delta,
					};
				} else if (part.type === "tool-call") {
					emitted = true;
					sawContent = true;
					step?.calls.push(`${part.toolName} ${JSON.stringify(part.input)}`);
					yield {
						kind: "tool-call",
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						input: part.input,
					};
				} else if (part.type === "tool-result" || part.type === "tool-error") {
					acted = true;
				} else if (part.type === "finish-step") {
					// A loop's usage is every step's: each is a request billed on its own
					const cost = extractCost(part.providerMetadata, part.usage.raw);
					const cached = part.usage.inputTokenDetails?.cacheReadTokens;
					const these = {
						promptTokens: part.usage.inputTokens ?? 0,
						...(cached !== undefined ? { cachedTokens: cached } : {}),
						completionTokens: part.usage.outputTokens ?? 0,
						...(cost !== undefined ? { costUsd: cost } : {}),
					};
					usage = usage
						? {
								promptTokens: usage.promptTokens + these.promptTokens,
								...(usage.cachedTokens !== undefined || cached !== undefined
									? { cachedTokens: (usage.cachedTokens ?? 0) + (cached ?? 0) }
									: {}),
								completionTokens:
									usage.completionTokens + these.completionTokens,
								...(usage.costUsd !== undefined || cost !== undefined
									? { costUsd: (usage.costUsd ?? 0) + (cost ?? 0) }
									: {}),
							}
						: these;
					if (step) {
						const done = performance.now();
						step.span.set({
							finish_reason: part.finishReason,
							...(step.calls.length > 0
								? { calls: step.calls.join("\n") }
								: {}),
							...(step.first !== undefined
								? {
										ttft_ms: Math.round(step.first - step.t0),
										decode_ms: Math.round(done - step.first),
									}
								: {}),
							...usageFields(these),
						});
						step.span.end();
						step = undefined;
					}
				} else if (part.type === "error") {
					// The AI SDK stream never throws; failures arrive as parts.
					step?.span.end(part.error);
					return {
						ok: false,
						emitted,
						acted,
						error: part.error,
						usage,
						messages: [],
					};
				} else if (part.type === "abort") {
					step?.span.end(new LlmError("llm: aborted"));
					return {
						ok: false,
						emitted,
						acted,
						error: new LlmError("llm: aborted"),
						usage,
						messages: [],
					};
				}
			}
			if (req.schema) parsed = result.output;
			if (!sawContent)
				return {
					ok: false,
					emitted,
					acted,
					error: new LlmError(EMPTY),
					usage,
					messages: [],
				};
			// Every step's turns (the last response alone holds only the last step's)
			const messages: ModelMessage[] = await result.responseMessages;
			if (!req.schema) return { ok: true, emitted, acted, usage, messages };
			// The answer parsed and checked against the schema; one that does not match
			// fails the attempt like any provider failure, and the next one is tried
			try {
				return {
					ok: true,
					emitted,
					acted,
					usage,
					object: await parsed,
					messages,
				};
			} catch (e) {
				return { ok: false, emitted, acted, error: e, usage, messages: [] };
			}
		} catch (e) {
			step?.span.end(e);
			return { ok: false, emitted, acted, error: e, usage, messages: [] };
		}
	}

	// One AI SDK model instance per attempt, by wire dialect. An `openai`
	// entry pointed at openrouter.ai resolves to the openrouter provider,
	// which is what reports a billed cost per request.
	private modelFor(provider: ProviderConfig, req: ChatRequest): LanguageModel {
		const type = dialectOf(provider);
		const fetch = timed(
			provider.fetch ?? globalThis.fetch,
			this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
		);
		if (type === "openrouter") {
			const openrouter = createOpenRouter({
				...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
				...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
				fetch,
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
				fetch,
			});
			return anthropic(provider.defaultModel);
		}
		if (!provider.baseUrl)
			throw new LlmError(
				`llm: provider ${provider.id} (openai) requires baseUrl`,
			);
		// Raw body fields are merged into the JSON as it is sent: providerOptions would
		// pass them through a schema that keeps only the knobs it knows (camelCase), and
		// silently drop the rest (`think`, `reasoning_effort`, `thinking`)
		const body = {
			...(provider.disableThinking ? { thinking: { type: "disabled" } } : {}),
			...req.extraBody,
		};
		const compat = createOpenAICompatible({
			name: provider.id,
			baseURL: normalizeOpenAiBase(provider.baseUrl),
			...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
			fetch,
			includeUsage: true, // stream_options usage frame
			supportsStructuredOutputs: provider.structuredOutputs === true,
			...(Object.keys(body).length > 0
				? {
						transformRequestBody: (args: Record<string, unknown>) => ({
							...args,
							...body,
						}),
					}
				: {}),
		});
		return compat.chatModel(provider.defaultModel);
	}

	// The anthropic dialect's thinking switch, the one knob that travels as a typed
	// provider option; the other dialects carry theirs on the model instance.
	// The caller's step hook as the AI SDK takes it: a step's `reasoning` becomes the
	// provider's own option, since the SDK's step settings have no reasoning level.
	private stepping(
		provider: ProviderConfig,
		prepare: PrepareStep,
	): PrepareStepFunction<ToolSet> {
		return async (options) => {
			const step = await prepare(options);
			if (!step?.reasoning) return step;
			const { reasoning, ...rest } = step;
			const type = dialectOf(provider);
			// anthropic: a step that reasons thinks adaptively at the effort named; one
			// that asks for none keeps the request's own setting, which the SDK maps per
			// model (Sonnet 5.5 refuses `disabled`, Opus 5.5 cannot stop thinking). Its
			// options replace the request's, so the cache mark rides along. openai-
			// compatible reads its options under the provider's name, OpenRouter under
			// its own
			const own =
				type === "anthropic"
					? {
							anthropic: {
								...ANTHROPIC_CACHE,
								...(reasoning === "none" || reasoning === "provider-default"
									? {}
									: {
											thinking: { type: "adaptive" },
											// Anthropic's lowest effort is low
											effort: reasoning === "minimal" ? "low" : reasoning,
										}),
							},
						}
					: type === "openrouter"
						? { openrouter: { reasoning: { effort: reasoning } } }
						: { [provider.id]: { reasoningEffort: reasoning } };
			return {
				...rest,
				providerOptions: { ...rest.providerOptions, ...own },
			} as PrepareStepResult<ToolSet>;
		};
	}

	private providerOptionsFor(
		provider: ProviderConfig,
	): Pick<Parameters<typeof streamText>[0], "providerOptions"> {
		const type = dialectOf(provider);
		if (type === "anthropic")
			return {
				providerOptions: {
					anthropic: {
						...ANTHROPIC_CACHE,
						...(provider.disableThinking
							? { thinking: { type: "disabled" } }
							: {}),
					},
				},
			};
		// openai: the thinking flag and extraBody are merged into the request body by
		// the model instance (modelFor); openrouter: they ride its model instance too
		return {};
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
		err: unknown,
	): Promise<void> {
		if (cls === "client") {
			log.error("request rejected, key stays healthy", {
				provider: label,
				key: storeKey,
				err,
			});
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
		log.warn("key cooling down", {
			provider: label,
			key: storeKey,
			class: cls,
			until: new Date(health.recoveryAt),
			failures,
			err,
		});
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

// The wire dialect actually used for an attempt. An `openai` entry pointed at
// openrouter.ai resolves to the openrouter provider: the wire is the same, but
// only that provider reports the billed cost of a request.
function dialectOf(provider: ProviderConfig): ProviderConfig["type"] {
	if (provider.type !== "openai" || !provider.baseUrl) return provider.type;
	try {
		const host = new URL(provider.baseUrl).hostname;
		return host === "openrouter.ai" || host.endsWith(".openrouter.ai")
			? "openrouter"
			: "openai";
	} catch {
		return "openai"; // unparsable baseUrl fails loudly at request time, not here
	}
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

function resolveTemperature(provider: ProviderConfig): number | undefined {
	const preferred = [
		provider.temperatures?.[provider.defaultModel],
		provider.temperature,
	].find((t): t is number => typeof t === "number" && Number.isFinite(t));
	if (preferred === undefined) return undefined;
	// Anthropic accepts [0, 1]; everything OpenAI-shaped accepts [0, 2].
	const ceiling = provider.type === "anthropic" ? 1 : 2;
	return Math.max(0, Math.min(preferred, ceiling));
}

function resolveMaxTokens(
	provider: ProviderConfig,
	requested?: number,
): number {
	const ask = requested ?? DEFAULT_MAX_TOKENS;
	return provider.maxTokens ? Math.min(ask, provider.maxTokens) : ask;
}

// The provider's transport with a hard timeout on each request, so a stalled
// upstream can't wedge a call forever. Per request, never per call: a tool loop's
// call spans its tools too, and a tool may wait on a person for minutes.
function timed(
	fetcher: typeof globalThis.fetch,
	ms: number,
): typeof globalThis.fetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(ms);
		return fetcher(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		});
	};
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

/** The host a provider is reached at, for a span's `server.address`. */
function hostOf(baseUrl: string): string {
	return new URL(baseUrl).host;
}

/** Token accounting as OpenTelemetry's gen_ai fields name it; cost has no
 *  convention and keeps its own name. */
function usageFields(
	usage: NonNullable<Attempt["usage"]>,
): Record<string, number> {
	return {
		"gen_ai.usage.input_tokens": usage.promptTokens,
		...(usage.cachedTokens !== undefined
			? { "gen_ai.usage.cache_read.input_tokens": usage.cachedTokens }
			: {}),
		"gen_ai.usage.output_tokens": usage.completionTokens,
		...(usage.costUsd !== undefined ? { cost_usd: usage.costUsd } : {}),
	};
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
