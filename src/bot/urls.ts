/**
 * Telegram-message URL + entity parsing, on what the platform ALREADY parsed:
 * every message arrives with `entities` (bot_command, mention, url, text_link,
 * …) carrying exact UTF-16 spans — JS strings are UTF-16, so `slice(offset,
 * offset + length)` is exact. Hand-sniffing `startsWith("/")` or regex-
 * stripping `@botname` re-derives (worse) what Telegram handed over.
 *
 * The load-bearing verb is {@link urlsInMessage}: the visible text scanned by
 * `urlsIn`, PLUS `text_link` entities — hyperlinked words whose URL never
 * appears in the text, invisible to any text scanner (what forwarded
 * newsletters and rich posts carry). Everything returns the same `Url`
 * objects as the url module, spans indexing the message text (a text_link's
 * span is its anchor words), so span-based cutting works uniformly.
 *
 * Framework-agnostic by shape: gramio's MessageEntity class satisfies
 * {@link EntityLike} structurally (type/offset/length/url getters), as does
 * the raw Bot API object.
 */
import { type Url, type UrlsInOptions, urlOf, urlsIn } from "../universal/url/index.js";

/** The slice of a Telegram MessageEntity this module reads (raw API object or gramio class alike). */
export interface EntityLike {
	type: string;
	/** Offset in UTF-16 code units — JS string indexing, exactly. */
	offset: number;
	length: number;
	/** For `text_link` only: the hidden URL behind the anchor words. */
	url?: string;
}

/** The slice of a Telegram message this module reads: text or caption, with its entities. */
export interface MessageLike {
	text?: string;
	caption?: string;
	entities?: readonly EntityLike[];
	captionEntities?: readonly EntityLike[];
}

/** The message's text (or media caption), with the entity set that indexes it. */
export function messageTextAndEntities(message: MessageLike): { text: string; entities: readonly EntityLike[] } {
	return message.text !== undefined
		? { text: message.text, entities: message.entities ?? [] }
		: { text: message.caption ?? "", entities: message.captionEntities ?? [] };
}

/**
 * Every URL the message carries, in span order, fully resolved: the visible
 * text scanned by `urlsIn`, plus each `text_link` entity's hidden URL. A
 * text_link's `raw` is its visible anchor words and its span covers them, so
 * cutting link spans out of a message treats hyperlinked words as part of
 * the link, not as the user's own words. text_link URLs always carry a
 * scheme, so `requireScheme` never drops them.
 */
export function urlsInMessage(message: MessageLike, opts?: UrlsInOptions): Url[] {
	const { text, entities } = messageTextAndEntities(message);
	const out = urlsIn(text, opts);
	for (const entity of entities) {
		if (entity.type !== "text_link" || !entity.url) continue;
		const resolved = urlOf(entity.url, opts);
		if (!resolved) continue;
		out.push({
			...resolved,
			raw: text.slice(entity.offset, entity.offset + entity.length),
			start: entity.offset,
			end: entity.offset + entity.length,
		});
	}
	return out.sort((a, b) => a.start - b.start);
}

/** True when the message IS a command: a `bot_command` entity at offset 0 — Telegram's own parse, not `startsWith("/")`. */
export function isCommandMessage(message: MessageLike): boolean {
	const { entities } = messageTextAndEntities(message);
	return entities.some((e) => e.type === "bot_command" && e.offset === 0);
}

/**
 * The message text with the entity spans `shouldCut` selects replaced by a
 * space (offsets are honored exactly, so nested/adjacent formatting never
 * shifts). The predicate receives each entity and its visible slice — e.g.
 * cut `bot_command`s and mentions of your own bot, keep everything else.
 */
export function cutEntities(
	text: string,
	entities: readonly EntityLike[],
	shouldCut: (entity: EntityLike, slice: string) => boolean,
): string {
	const doomed = entities
		.filter((e) => shouldCut(e, text.slice(e.offset, e.offset + e.length)))
		.sort((a, b) => b.offset - a.offset);
	let out = text;
	for (const e of doomed) {
		out = `${out.slice(0, e.offset)} ${out.slice(e.offset + e.length)}`;
	}
	return out;
}
