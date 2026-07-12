/**
 * Telegram message-draft painter — the lifecycle primitive under
 * `bot/llm`'s `streamChatReply`, dependency-light on purpose (gramio types +
 * `@gramio/format` types only) so a bot with its own rendering pipeline pulls
 * no markdown machinery into its bundle.
 *
 * `createDraftPreview(ctx, { render, throttleMs? })` owns the whole draft
 * lifecycle: throttled FULL-FRAME repaints (drafts replace, never append),
 * the anti-expiry keepalive under Telegram's ~30s draft TTL, serialized
 * sends, reset, quiesce, and {@link streamForensics} (render-regression +
 * upstream-reset warnings, also exported standalone for edit-based viewers).
 * `render` is required: a painter doesn't know markdown — it paints whatever
 * frame you render, plain (`sendMessageDraft`) or rich (`sendRichMessageDraft`).
 * Previews exist in PRIVATE chats only; elsewhere every method no-ops.
 */

import type { FormattableString } from "@gramio/format";
import type { Bot, MessageContext } from "gramio";

// Telegram animates draft repaints; one frame per second is smooth and stays
// clear of rate limits.
const THROTTLE_MS = 1000;
// A streamed draft is ephemeral: Telegram drops it after ~30s. A quiet stretch
// (LLM latency, an upstream failover) sends no frames, so the preview would
// age out mid-generation. Re-emit the current frame comfortably under the TTL.
const KEEPALIVE_MS = 20_000;

// Non-zero, ever-incrementing draft id per stream so a chat's concurrent /
// sequential previews don't share an animation timeline. Per-isolate;
// collisions across isolates are harmless (draft ids are chat-scoped).
let draftSeq = 0;

/**
 * Jitter forensics for a streamed preview: a healthy stream only GROWS. A
 * render that shrinks while the accumulated markdown grew means the
 * partial-markdown tail parsed differently between frames (the renderer);
 * accumulated text shrinking is an upstream provider reset. Neither warning
 * firing while a user still sees back-and-forth points at their CLIENT's own
 * draft rendering. Built into {@link createDraftPreview}; exported standalone
 * for edit-based viewers that repaint outside the painter.
 */
export function streamForensics(label: string) {
	let lastAccLen = 0;
	let lastRenderedLen = 0;
	return {
		/** Call per outgoing frame with the accumulated-markdown and rendered lengths. */
		frame(accLen: number, renderedLen: number) {
			if (renderedLen < lastRenderedLen && accLen >= lastAccLen)
				console.warn(
					`[bot/llm] ${label} render regressed · rendered ${lastRenderedLen}→${renderedLen} · acc ${accLen}`,
				);
			lastAccLen = accLen;
			lastRenderedLen = renderedLen;
		},
		/** Call from the upstream reset path with the length being dropped. */
		reset(droppedChars: number) {
			console.warn(
				`[bot/llm] ${label} reset (provider failover) · dropped ${droppedChars} chars`,
			);
		},
	};
}

/**
 * One rendered preview frame. `text` goes out via `sendMessageDraft` (a
 * FormattableString carries entities; a raw string may carry `parseMode`);
 * `rich` goes out via `sendRichMessageDraft` (Telegram's rich-message HTML).
 */
export type DraftFrame =
	| {
			kind: "text";
			text: string | FormattableString;
			parseMode?: "HTML" | "MarkdownV2" | "Markdown";
	  }
	| { kind: "rich"; html: string };

export interface DraftPreviewOptions {
	/** Ms between repaints. Default 1000. */
	throttleMs?: number;
	/**
	 * Render one FULL frame from the accumulated markdown — drafts replace,
	 * never append, which is what makes resets and phase switches one cheap
	 * frame. Return null to skip (nothing renderable yet).
	 */
	render: (markdown: string) => DraftFrame | null;
	/** Forensics label. Default `draft <id>`. */
	label?: string;
}

/**
 * A live message-draft preview: the push-driven primitive under
 * {@link streamChatReply}, exposed for callers whose producer pushes deltas
 * (rather than handing over an event iterable) or whose render/persist paths
 * are their own. Owns the whole draft lifecycle: throttled full-frame
 * repaints, the anti-expiry keepalive, serialized sends, reset, and quiesce.
 * Previews exist in PRIVATE chats only — elsewhere every method no-ops and
 * the caller's persist path is all that happens.
 */
export interface DraftPreview {
	/** Accumulated markdown of the current attempt. */
	readonly text: string;
	/** Append a delta and schedule a repaint. */
	append(text: string): void;
	/** Replace the buffer (phase switches); schedules a repaint. */
	set(markdown: string): void;
	/** Upstream failover: drop the buffer with a forensics note; the next tokens repaint from scratch. */
	reset(): void;
	/** Force a repaint of the current frame (render inputs changed, e.g. a cover arrived). */
	repaint(): void;
	/**
	 * Paint one last complete frame and stop. Call right before persisting:
	 * the preview shows the finished text (not a throttle-stale partial) and
	 * its ~30s TTL resets, so the handoff to the real message can't blank.
	 */
	finish(markdown?: string): Promise<void>;
	/** Stop painting without a final frame; the ephemeral draft expires on its own. */
	abort(): Promise<void>;
}

export function createDraftPreview(
	ctx: MessageContext<Bot>,
	opts: DraftPreviewOptions,
): DraftPreview {
	const active = ctx.chat.type === "private";
	const chatId = ctx.chat.id;
	const threadId = ctx.threadId;
	const draftId = ++draftSeq;
	const throttle = opts.throttleMs ?? THROTTLE_MS;
	const render = opts.render;
	const forensics = streamForensics(opts.label ?? `draft ${draftId}`);

	let acc = "";
	let dirty = false;
	let stopped = !active;
	let lastFlushAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flushing: Promise<unknown> | undefined;
	let keepalive: ReturnType<typeof setInterval> | undefined;

	// Send the current accumulated markdown as one full frame. Best-effort: a
	// rejected preview (rate limit, empty render) is swallowed — the caller's
	// persist path is what matters.
	const sendFrame = async () => {
		const frame = render(acc);
		if (frame === null) return;
		if (frame.kind === "rich") {
			forensics.frame(acc.length, frame.html.length);
			await ctx.bot.api
				.sendRichMessageDraft({
					chat_id: chatId,
					draft_id: draftId,
					rich_message: { html: frame.html },
					...(threadId !== undefined ? { message_thread_id: threadId } : {}),
				})
				.catch(() => {});
			return;
		}
		const rendered =
			typeof frame.text === "string" ? frame.text : frame.text.text;
		forensics.frame(acc.length, rendered.length);
		await ctx.bot.api
			.sendMessageDraft({
				chat_id: chatId,
				draft_id: draftId,
				text: frame.text,
				...(frame.parseMode ? { parse_mode: frame.parseMode } : {}),
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
			})
			.catch(() => {});
	};

	const flush = async () => {
		if (!dirty || stopped) return;
		if (flushing) await flushing.catch(() => {});
		if (!dirty || stopped) return;
		dirty = false;
		lastFlushAt = Date.now();
		flushing = sendFrame();
		await flushing.catch(() => {});
		flushing = undefined;
		if (dirty && !stopped) schedule();
	};

	const schedule = () => {
		dirty = true;
		if (stopped || timer) return;
		const wait = Math.max(0, throttle - (Date.now() - lastFlushAt));
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, wait);
	};

	// Start the anti-expiry heartbeat once streaming has actually begun. Each
	// tick reuses the normal flush path to re-paint the current frame, but only
	// when the stream has gone quiet — an in-flight or pending flush already
	// refreshes the draft.
	const ensureKeepalive = () => {
		if (keepalive || stopped) return;
		keepalive = setInterval(() => {
			if (stopped || dirty || timer || flushing || !acc.trim()) return;
			schedule();
		}, KEEPALIVE_MS);
	};

	// Stop scheduling and let any in-flight frame settle. Shared by finish and abort.
	const quiesce = async () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (keepalive) {
			clearInterval(keepalive);
			keepalive = undefined;
		}
		if (flushing) await flushing.catch(() => {});
	};

	return {
		get text() {
			return acc;
		},
		append(text) {
			if (stopped) return;
			acc += text;
			ensureKeepalive();
			schedule();
		},
		set(markdown) {
			acc = markdown;
			if (!stopped) schedule();
		},
		reset() {
			forensics.reset(acc.length);
			acc = "";
		},
		repaint() {
			if (!stopped && acc.trim()) schedule();
		},
		async finish(markdown) {
			if (markdown !== undefined) acc = markdown;
			const wasActive = !stopped;
			await quiesce();
			if (wasActive) await sendFrame().catch(() => {});
		},
		abort: quiesce,
	};
}
