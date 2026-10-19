/**
 * Telegram outbound-text mechanics: the message size limit, deterministic
 * fitting under it, and the "message is not modified" edit no-op classifier.
 * Dependency-free and Worker-safe.
 */

/** Telegram's post-entity character limit for one message. */
export const TELEGRAM_MAX_CHARS = 4096;

export interface FitTelegramTextOptions {
	maxChars?: number;
	/** Retain a short final paragraph, useful for a summary's source/footer block. */
	preserveFinalBlock?: boolean;
}

/** Deterministically fit plain text to Telegram's post-entity character limit. */
export function fitTelegramText(
	text: string,
	opts: FitTelegramTextOptions = {},
): string {
	const maxChars = Math.max(1, Math.floor(opts.maxChars ?? TELEGRAM_MAX_CHARS));
	if (text.length <= maxChars) return text;

	const ellipsis = maxChars >= 4 ? "\n\n…" : "…".slice(0, maxChars);
	const divider = opts.preserveFinalBlock ? text.lastIndexOf("\n\n") : -1;
	const possibleTail = divider > maxChars / 2 ? text.slice(divider) : "";
	const tail =
		possibleTail.length <= Math.min(640, Math.floor(maxChars / 3))
			? possibleTail
			: "";
	const budget = maxChars - ellipsis.length - tail.length;
	let prefix = text.slice(0, Math.max(0, budget)).trimEnd();
	// Never strand half of a UTF-16 surrogate pair at the truncation boundary.
	if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
	const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
	if (boundary >= Math.floor(prefix.length * 0.9))
		prefix = prefix.slice(0, boundary).trimEnd();
	return `${prefix}${ellipsis}${tail}`.slice(0, maxChars);
}

/**
 * Telegram rejects an edit whose result equals the current message with
 * "message is not modified". That is a no-op, not an error — the desired state
 * is already live. Callers treat it as delivered instead of falling back to a
 * degraded (e.g. plain-text) retry that WOULD differ and silently strip
 * formatting, or wrongly sending a duplicate.
 */
export function isNotModified(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /not modified/i.test(message);
}
