/**
 * GramIO LLM toolkit — the Telegram side of an LLM chatbot. The model side
 * (providers, failover, usage accounting, tools) lives in
 * `@adriangalilea/utils/llm`; this module renders its event stream into a
 * chat and remembers conversations:
 *
 *   `streamChatReply(ctx, events)` — OUTPUT. Consumes an
 *       `AsyncIterable<LlmStreamEvent>` and paints it with Telegram's native
 *       message-draft streaming (`sendMessageDraft`: ephemeral ~30s previews,
 *       animated in place per draft_id), then persists the finished text via
 *       `ctx.send`, entity-split across the 4096 limit by `@gramio/split`.
 *       Reasoning models get a "thinking" phase: reasoning streams into the
 *       draft preview and evaporates by default, or persists as an expandable
 *       blockquote. A `reset` event (provider failover upstream) repaints the
 *       draft from scratch — full-frame previews make that one cheap frame.
 *       Drafts are a PRIVATE-chat capability (and the bot needs forum topic
 *       mode enabled in BotFather); elsewhere the preview phase is skipped and
 *       only the final send happens.
 *
 *   The draft LIFECYCLE (throttle, anti-expiry keepalive, serialized
 *       full-frame sends, reset, quiesce, forensics) is `bot/draft`'s
 *       `createDraftPreview` — dependency-light on purpose; import it from
 *       there when your producer pushes deltas or your rendering / persist
 *       paths are your own. This module supplies the markdown render and the
 *       split-send persist on top.
 *
 *   `ctx.llm.add / .get / …` — HISTORY. Per-(user, thread) conversation
 *       buffer in OpenAI `ChatMessage` shape, persisted in the shared
 *       `@gramio/session` record under the `llm` field, so the `botMenu`
 *       🗑 Forget button wipes it together with everything else.
 *
 * Peer deps: `gramio`, `@gramio/session`, `@gramio/format`, `@gramio/split`,
 * `marked`.
 *
 * @example  chatbot turn: history → llm.stream → streamed reply
 * import { createLlm } from '@adriangalilea/utils/llm'
 * import { streamChatReply, llmHistory, toModelMessages } from '@adriangalilea/utils/bot/llm'
 *
 * const llm = createLlm({ providers })
 * const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })
 *
 * bot.extend(userSession).extend(chat.plugin).on('message', async (ctx) => {
 *   ctx.llm.add({ role: 'user', content: ctx.text ?? '' })
 *   const { content } = await streamChatReply(ctx, llm.stream({
 *     instructions: 'You are helpful.',
 *     messages: toModelMessages(ctx.llm.get()),
 *   }))
 *   ctx.llm.add({ role: 'assistant', content })
 * })
 */

import { expandableBlockquote, type FormattableString } from "@gramio/format";
import { markdownToFormattable } from "@gramio/format/markdown";
import type { session } from "@gramio/session";
import { splitMessage } from "@gramio/split";
import {
	type Bot,
	type DeriveDefinitions,
	type MessageContext,
	Plugin,
} from "gramio";

import type {
	LlmStreamEvent,
	LlmToolCall,
	LlmUsage,
	ModelMessage,
} from "../llm/index.js";
import type { Polyglot } from "../say/index.js";
import { createDraftPreview } from "./draft.js";
import type { MenuItem } from "./menu.js";

// ─── OUTPUT: render an LLM event stream into the chat ──────────────

export interface StreamChatReplyOptions {
	/**
	 * What happens to a reasoning model's thinking text.
	 * `preview` (default) — streams into the ephemeral draft, evaporates when
	 * the answer starts. `message` — additionally persists as an expandable
	 * blockquote message before the answer. `hidden` — never rendered, not
	 * even in the draft (the answer just takes longer to start).
	 */
	reasoning?: "preview" | "message" | "hidden";
	/** Ms between draft repaints. Default 1000. */
	throttleMs?: number;
	/**
	 * Extra params for the finalizing `ctx.send` calls (e.g. `reply_markup`).
	 * Applied to the LAST part when the reply splits across messages, so a
	 * keyboard lands at the end.
	 */
	messageParams?: Parameters<MessageContext<Bot>["send"]>[1];
}

export interface ChatReplyResult {
	/** Full assistant markdown, concatenated from `delta` events. */
	content: string;
	/** Full reasoning text. Empty for non-thinking models. */
	reasoning: string;
	/** Tool calls the model made (the caller executes them; nothing is rendered). */
	toolCalls: LlmToolCall[];
	/** End-of-stream usage accounting, when the provider reported it. */
	usage: LlmUsage | null;
	/** The persisted message(s), in order. Empty when the model produced no text (tool-call-only turns). */
	messages: MessageContext<Bot>[];
}

/**
 * Render an LLM event stream into the chat: live draft previews while
 * generating (via {@link createDraftPreview}), entity-split persisted
 * message(s) when done. See the module doc for the full contract. Returns the
 * transcript pieces plus the sent messages.
 */
export async function streamChatReply(
	ctx: MessageContext<Bot>,
	events: AsyncIterable<LlmStreamEvent>,
	opts: StreamChatReplyOptions = {},
): Promise<ChatReplyResult> {
	const reasoningMode = opts.reasoning ?? "preview";
	const preview = createDraftPreview(ctx, {
		throttleMs: opts.throttleMs,
		render: (markdown) => ({
			kind: "text",
			text: markdownToFormattable(markdown),
		}),
	});

	let content = "";
	let reasoning = "";
	const toolCalls: LlmToolCall[] = [];
	let usage: LlmUsage | null = null;

	try {
		for await (const event of events) {
			if (event.kind === "delta") {
				// Answer taking over from thinking: persist the blockquote first so
				// it lands ABOVE the final answer message, then the answer owns the
				// preview (a phase switch is one cheap full-frame repaint).
				if (content === "") {
					if (reasoning && reasoningMode === "message")
						await persistReasoning(ctx, reasoning);
					preview.set("");
				}
				content += event.text;
				preview.append(event.text);
			} else if (event.kind === "reasoning") {
				reasoning += event.text;
				if (!content && reasoningMode !== "hidden") preview.append(event.text);
			} else if (event.kind === "reset") {
				content = "";
				reasoning = "";
				toolCalls.length = 0;
				preview.reset();
			} else if (event.kind === "tool-call") {
				toolCalls.push({ toolName: event.toolName, input: event.input });
			} else {
				usage = event.usage;
			}
		}
	} catch (err) {
		await preview.abort();
		throw err;
	}

	content = content.trim();
	reasoning = reasoning.trim();

	// A reasoning-only or tool-call-only turn persists nothing; the ephemeral
	// draft expires on its own.
	if (content === "") {
		await preview.abort();
		if (reasoning && reasoningMode === "message")
			await persistReasoning(ctx, reasoning);
		return { content, reasoning, toolCalls, usage, messages: [] };
	}

	// One last complete frame (TTL reset right before the persist), then the
	// real, notifying send(s) consume the ephemeral draft in place.
	await preview.finish(content);

	// Collect the entity-correct parts first, then send with params on the
	// last one — splitMessage's sequential action callback stays the sender
	// so ordering is preserved.
	const parts: FormattableString[] = [];
	await splitMessage(markdownToFormattable(content), (part) => {
		parts.push(part);
	});
	const messages: MessageContext<Bot>[] = [];
	for (let i = 0; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		messages.push(
			await ctx.send(parts[i], isLast ? opts.messageParams : undefined),
		);
	}

	return { content, reasoning, toolCalls, usage, messages };
}

// Reasoning markdown → one expandable-blockquote message. Malformed mid-stream
// markdown degrades to plain text inside the quote instead of failing the send.
async function persistReasoning(
	ctx: MessageContext<Bot>,
	reasoning: string,
): Promise<void> {
	const rendered = expandableBlockquote(markdownToFormattable(reasoning));
	if (rendered.text.trim().length === 0) return;
	await ctx.send(rendered).catch(() => {});
}

// ─── HISTORY: per-thread conversation buffer ───────────────────────

/**
 * Multimodal content shape from OpenAI's chat-completions spec. Either
 * a plain string or an ordered array of typed parts. Image URLs cover
 * both http(s) and Telegram `getFile` resolved paths.
 */
export type ChatContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image_url"; image_url: { url: string } }
	  >;

/**
 * One turn in the conversation. The library does NOT filter by role —
 * if you persist `system` turns, they ride along on every `get()`.
 * Most callers prepend their system prompt fresh each request and only
 * persist `user` / `assistant`.
 */
export type ChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: ChatContent;
	/** Unix seconds when added — used for retention pruning. */
	date: number;
};

/**
 * Convert stored history into the AI SDK's `ModelMessage` shape for
 * `llm.stream({ messages })`. Text and image parts map 1:1; `tool` turns are
 * dropped (tool plumbing belongs to the current request, not replayed
 * history); an assistant turn's parts flatten to text.
 */
export function toModelMessages(
	history: ReadonlyArray<ChatMessage>,
): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const m of history) {
		if (m.role === "tool") continue;
		if (m.role === "assistant" || m.role === "system") {
			out.push({ role: m.role, content: flattenText(m.content) });
		} else {
			out.push({
				role: "user",
				content:
					typeof m.content === "string"
						? m.content
						: m.content.map((part) =>
								part.type === "text"
									? ({ type: "text", text: part.text } as const)
									: ({ type: "image", image: part.image_url.url } as const),
							),
			});
		}
	}
	return out;
}

const flattenText = (content: ChatContent): string =>
	typeof content === "string"
		? content
		: content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")
				.trim();

/** Per-thread shards of `ChatMessage`s, persisted in the session. */
type ChatRecord = {
	shards: { [threadKey: string]: ChatMessage[] };
};

/** Loose session shape — this plugin only touches the `llm` field. */
type LLMSessionLike = { llm?: ChatRecord };

/** @internal — kept unexported so it doesn't clash with peers' refs. */
type LLMSessionPluginRef = ReturnType<
	typeof session<LLMSessionLike, "session">
>;

export type LLMHistoryOptions = {
	/**
	 * Shared session plugin. This plugin extends it for type flow;
	 * gramio's runtime dedup ensures the session derive runs once.
	 */
	session: LLMSessionPluginRef;
	/** Ring buffer cap **per thread**. Oldest entries dropped past this. */
	maxTurns: number;
	/** Entries older than this (in days) are dropped on read. */
	retentionDays: number;
	/**
	 * Override the labels of the `menuItem` (the "🗑 Delete this thread"
	 * button rendered inside a `botMenu`). Defaults are polyglot
	 * literals covering en + es.
	 */
	menuLabels?: {
		/** Button label. Default: `{ en: '🗑 Delete this thread', es: '🗑 Borrar este hilo' }`. */
		item?: Polyglot<string>;
		/**
		 * Toast shown when `deleteForumTopic` succeeded — the Telegram
		 * thread (with all its messages) is actually gone.
		 * Default: `{ en: '🗑 Thread deleted.', es: '🗑 Hilo borrado.' }`.
		 */
		deleted?: Polyglot<string>;
		/**
		 * Toast shown when the thread COULD NOT be deleted (no `threadId`
		 * available, the API rejected, etc.) but the LLM history was
		 * still wiped. Tells the user what really happened — the thread
		 * stays visible but the bot has forgotten the conversation.
		 * Default: `{ en: '🧹 History cleared — couldn't delete the thread.',
		 *           es: '🧹 Historial limpio — no se pudo borrar el hilo.' }`.
		 */
		historyOnly?: Polyglot<string>;
		/** Confirmation overlay text. Default explains the full-delete scope. */
		confirmPrompt?: Polyglot<string>;
	};
};

export type LLMHistoryFeature = {
	plugin: ReturnType<typeof buildHistoryPlugin>;
	/**
	 * Drop-in `MenuItem` for `botMenu({ items: [...] })`: a "delete this
	 * thread" button that BOTH wipes `ctx.llm` for the current
	 * (user, thread) shard AND calls `deleteForumTopic` to remove the
	 * Telegram thread (and all its messages) from the chat. Sibling
	 * threads stay intact. Falls back to history-only clear when there is
	 * no `threadId` (general/non-threaded chats) or Telegram rejects
	 * the deletion (e.g. forum supergroup without admin rights).
	 */
	menuItem: MenuItem;
};

/**
 * Methods decorated onto `ctx.llm`. All synchronous — reads/writes the
 * session record via `@gramio/session`'s Proxy, which auto-persists.
 *
 * Thread isolation is automatic: every method operates on the shard
 * for `ctx.threadId` (or `'general'` when no thread). Different threads
 * = different conversations, no leakage.
 */
export type LLMHistoryApi = {
	/** Append one message to the CURRENT thread's shard. */
	add: (message: Omit<ChatMessage, "date"> & { date?: number }) => void;
	/** Pruned snapshot of the CURRENT thread, oldest-first. */
	get: () => ReadonlyArray<ChatMessage>;
	/** Wipe the CURRENT thread's shard. */
	clear: () => void;
	/**
	 * Full sharded map, pruned. Use for /export or admin views. Keys are
	 * thread ids (or `'general'`) → ordered messages.
	 */
	all: () => Readonly<{ [threadKey: string]: ReadonlyArray<ChatMessage> }>;
	/** Wipe ALL threads for this user. */
	clearAll: () => void;
};

type LLMHistoryDerives = { llm: LLMHistoryApi };

const GENERAL_THREAD = "general";

const threadKey = (ctx: {
	threadId?: number;
	message?: { threadId?: number };
}): string => {
	// Message events: ctx.threadId. Callback events: ctx.message.threadId.
	const tid = ctx.threadId ?? ctx.message?.threadId;
	return tid !== undefined ? String(tid) : GENERAL_THREAD;
};

const prune = (
	items: ChatMessage[],
	maxTurns: number,
	retentionDays: number,
): ChatMessage[] => {
	const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400;
	const fresh = items.filter((m) => m.date >= cutoffSec);
	return fresh.slice(-maxTurns);
};

const pruneAll = (
	shards: ChatRecord["shards"],
	maxTurns: number,
	retentionDays: number,
): ChatRecord["shards"] => {
	const out: ChatRecord["shards"] = {};
	for (const k of Object.keys(shards)) {
		const pruned = prune(shards[k], maxTurns, retentionDays);
		if (pruned.length > 0) out[k] = pruned;
	}
	return out;
};

/**
 * Per-(user, thread) LLM conversation history. Opt-in. Persists in the
 * shared `@gramio/session` record under `llm`, so 🗑 Forget from
 * `botMenu` wipes it together with everything else — one record, one
 * delete, no per-plugin registry.
 *
 * @example
 * const chat = llmHistory({ session: userSession, maxTurns: 20, retentionDays: 7 })
 * bot.extend(chat.plugin)
 *    .on('message', (ctx) => {
 *      ctx.llm.add({ role: 'user', content: ctx.text ?? '' })
 *      const messages = ctx.llm.get()        // ChatMessage[] for current thread
 *      // ... call LLM with messages, then:
 *      ctx.llm.add({ role: 'assistant', content: reply })
 *    })
 */
export const llmHistory = (opts: LLMHistoryOptions): LLMHistoryFeature => {
	if (opts.maxTurns <= 0) throw new Error("llmHistory: maxTurns must be > 0");
	if (opts.retentionDays <= 0)
		throw new Error("llmHistory: retentionDays must be > 0");

	const plugin = buildHistoryPlugin({
		sessionPlugin: opts.session,
		maxTurns: opts.maxTurns,
		retentionDays: opts.retentionDays,
	});

	const itemLabel: Polyglot<string> = opts.menuLabels?.item ?? {
		en: "🗑 Delete this thread",
		es: "🗑 Borrar este hilo",
	};
	const deletedToast: Polyglot<string> = opts.menuLabels?.deleted ?? {
		en: "🗑 Thread deleted.",
		es: "🗑 Hilo borrado.",
	};
	const historyOnlyToast: Polyglot<string> = opts.menuLabels?.historyOnly ?? {
		en: "🧹 History cleared — couldn't delete the thread.",
		es: "🧹 Historial limpio — no se pudo borrar el hilo.",
	};
	const confirmPrompt: Polyglot<string> = opts.menuLabels?.confirmPrompt ?? {
		en: "⚠️ Delete this thread?\n\nWipes the LLM history AND removes the thread (with all its messages) from this chat. Sibling threads stay intact.",
		es: "⚠️ ¿Borrar este hilo?\n\nElimina el historial LLM Y el hilo entero (con todos sus mensajes) de este chat. Los demás hilos quedan intactos.",
	};

	const menuItem: MenuItem = {
		id: "llmClear",
		label: itemLabel,
		// Destructive action → red. Consistent with `botMenu`'s 🗑 Forget.
		style: "danger",
		// One-step confirm overlay before the wipe — fully irreversible:
		// the Telegram thread and all its messages get removed. See
		// `MenuItem.confirm` for the pattern.
		confirm: { prompt: confirmPrompt },
		action: async (ctx) => {
			// MenuCtx is a static structural type — it can't know about
			// `llm` (decorated by llmHistory's own plugin) or `bot.api`
			// (gramio's runtime decoration). Pushing those through
			// generics would propagate them across the entire menu API
			// for one consumer, so the structural narrow cast here is
			// the pragmatic boundary: every field listed is `?:`-optional
			// and read defensively below. Returns the polyglot toast —
			// the menu plugin owns the single answerCallbackQuery for
			// this tap (calling ctx.answer here would be a double-answer
			// → rejected → action throws).
			const c = ctx as unknown as {
				llm?: LLMHistoryApi;
				bot?: {
					api?: {
						deleteForumTopic?: (p: {
							chat_id: number;
							message_thread_id: number;
						}) => Promise<unknown>;
					};
				};
				chat?: { id: number };
				from?: { id: number };
				threadId?: number;
				message?: { threadId?: number; chat?: { id: number } };
			};
			// Wipe the store first — always succeeds and is the source of truth
			// the LLM consults. If the Telegram-side deletion below fails
			// (no thread, missing permissions, etc.), the next message in
			// this thread still starts with a clean context.
			c.llm?.clear();
			// Both fall back via `message.{...}` because in a callback_query
			// ctx, gramio puts the chat / thread metadata on the originating
			// message — top-level `ctx.chat` / `ctx.threadId` are undefined.
			// In a command ctx the top-level fields exist directly. Symmetric
			// access covers both shapes.
			const tid = c.threadId ?? c.message?.threadId;
			const chatId = c.chat?.id ?? c.message?.chat?.id;
			const userId = c.from?.id;
			let threadDeleted = false;
			if (
				tid !== undefined &&
				chatId !== undefined &&
				c.bot?.api?.deleteForumTopic
			) {
				try {
					await c.bot.api.deleteForumTopic({
						chat_id: chatId,
						message_thread_id: tid,
					});
					threadDeleted = true;
				} catch (e) {
					// Thread already gone (404), supergroup-without-admin (400),
					// chat type doesn't support it, etc. History is already
					// cleared so the user has a clean conversation, but we
					// log so the failure isn't invisible.
					console.error(
						`[llm-history] deleteForumTopic failed (chat=${chatId} thread=${tid} user=${userId ?? "?"}):`,
						e,
					);
				}
			} else {
				console.warn(
					`[llm-history] skipping deleteForumTopic (chat=${chatId ?? "?"} thread=${tid ?? "none"} user=${userId ?? "?"}) — history cleared, thread stays visible`,
				);
			}
			return threadDeleted ? deletedToast : historyOnlyToast;
		},
	};

	return { plugin, menuItem };
};

const buildHistoryPlugin = (args: {
	sessionPlugin: LLMSessionPluginRef;
	maxTurns: number;
	retentionDays: number;
}) => {
	const { sessionPlugin, maxTurns, retentionDays } = args;

	return new Plugin<
		Record<string, never>,
		DeriveDefinitions & { global: LLMHistoryDerives }
	>("@adriangalilea/utils/bot/llm/history")
		.extend(sessionPlugin)
		.derive(["message", "callback_query"], (ctx): LLMHistoryDerives => {
			const key = threadKey(ctx);

			// Always operate against a freshly-pruned view. Writes go to the
			// pruned base so stale entries never resurface after a read.
			const readShards = (): ChatRecord["shards"] =>
				pruneAll(ctx.session.llm?.shards ?? {}, maxTurns, retentionDays);

			const writeShards = (shards: ChatRecord["shards"]): void => {
				ctx.session.llm = { shards };
			};

			return {
				llm: {
					add: (message) => {
						const shards = readShards();
						const cur = shards[key] ?? [];
						const entry: ChatMessage = {
							role: message.role,
							content: message.content,
							date: message.date ?? Math.floor(Date.now() / 1000),
						};
						shards[key] = [...cur, entry].slice(-maxTurns);
						writeShards(shards);
					},
					get: () => (readShards()[key] ?? []) as ReadonlyArray<ChatMessage>,
					clear: () => {
						const shards = readShards();
						delete shards[key];
						writeShards(shards);
					},
					all: () =>
						readShards() as Readonly<{
							[threadKey: string]: ReadonlyArray<ChatMessage>;
						}>,
					clearAll: () => {
						writeShards({});
					},
				},
			};
		});
};
