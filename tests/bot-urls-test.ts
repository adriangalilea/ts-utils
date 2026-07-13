/**
 * Assert-based checks for `bot/urls` — the Telegram-entity layer must honor
 * what the platform parsed: text_link hrefs surface (invisible to any text
 * scanner), UTF-16 spans slice exactly, and command detection is the
 * bot_command entity, never startsWith("/").
 *
 *   pnpm test:bot-urls
 */
import { strict as assert } from "node:assert";
import { cutEntities, isCommandMessage, messageTextAndEntities, urlsInMessage } from "../src/bot/urls.js";

// ── urlsInMessage: visible text + hidden text_link hrefs, one Url shape ─────

{
	// "read this and https://a.com/x?utm_source=t" where "this" hyperlinks a hidden article
	const text = "read this and https://a.com/x?utm_source=t";
	const msg = {
		text,
		entities: [{ type: "text_link", offset: 5, length: 4, url: "https://www.theverge.com/2026/story?utm_source=tg" }],
	};
	const urls = urlsInMessage(msg);
	assert.deepEqual(
		urls.map((u) => [u.href, u.raw]),
		[
			["https://www.theverge.com/2026/story", "this"], // hidden href, cleaned; raw = anchor words
			["https://a.com/x", "https://a.com/x?utm_source=t"],
		],
	);
	// The anchor's span indexes the message text, so span-cutting removes the linked words
	assert.equal(text.slice(urls[0].start, urls[0].end), "this");
}
// A text_link to a video resolves the full funnel like any URL
{
	const [u] = urlsInMessage({
		text: "watch",
		entities: [{ type: "text_link", offset: 0, length: 5, url: "https://youtu.be/dQw4w9WgXcQ?si=x" }],
	});
	assert.equal(u.site, "youtube");
	assert.equal(u.key, "youtube:dQw4w9WgXcQ");
}
// Captions carry their own entity set
assert.equal(
	urlsInMessage({
		caption: "look",
		captionEntities: [{ type: "text_link", offset: 0, length: 4, url: "https://a.com/b" }],
	})[0]?.href,
	"https://a.com/b",
);
// UTF-16 offsets: an emoji (surrogate pair) before the anchor still slices exactly
{
	const text = "🎬 watch this";
	const [u] = urlsInMessage({
		text,
		entities: [{ type: "text_link", offset: 9, length: 4, url: "https://a.com/v" }],
	});
	assert.equal(u.raw, "this");
}
// The link-preview attachment is a URL source of its own (forwarded channel posts often
// carry the URL ONLY there) — zero-width span, deduped by key against a text twin.
{
	const urls = urlsInMessage({ text: "check my latest post", linkPreviewOptions: { url: "https://a.com/post?utm_source=x" } });
	assert.deepEqual(urls.map((u) => [u.href, u.start, u.end]), [["https://a.com/post", 20, 20]]);
}
assert.equal(
	urlsInMessage({ text: "https://a.com/post", link_preview_options: { url: "https://a.com/post/" } }).length,
	1, // preview twin of the visible url dedupes by key
);

// Non-link entities are ignored; a plain message scans as before
assert.deepEqual(
	urlsInMessage({ text: "just https://a.com/x", entities: [{ type: "bold", offset: 0, length: 4 }] }).map((u) => u.href),
	["https://a.com/x"],
);

// ── isCommandMessage: the bot_command entity, not startsWith ────────────────

assert.equal(isCommandMessage({ text: "/summary https://a.com", entities: [{ type: "bot_command", offset: 0, length: 8 }] }), true);
// "/" text without the entity is NOT a command (e.g. a pasted path)
assert.equal(isCommandMessage({ text: "/etc/hosts is a file" }), false);
// A mid-message command mention is not "this message is a command"
assert.equal(isCommandMessage({ text: "try /help sometime", entities: [{ type: "bot_command", offset: 4, length: 5 }] }), false);

// ── cutEntities: exact span surgery ─────────────────────────────────────────

{
	const text = "/summary@my_bot https://a.com please";
	const entities = [
		{ type: "bot_command", offset: 0, length: 15 },
		{ type: "url", offset: 16, length: 13 },
	];
	const cut = cutEntities(text, entities, (e) => e.type === "bot_command");
	assert.equal(cut.replace(/\s+/g, " ").trim(), "https://a.com please");
}
// The predicate sees the visible slice (cut only mentions of OUR bot)
{
	const text = "@my_bot summarize, ask @other_bot too";
	const entities = [
		{ type: "mention", offset: 0, length: 7 },
		{ type: "mention", offset: 23, length: 10 },
	];
	const cut = cutEntities(text, entities, (e, slice) => e.type === "mention" && slice === "@my_bot");
	assert.equal(cut.replace(/\s+/g, " ").trim(), "summarize, ask @other_bot too");
}

// ── messageTextAndEntities: text wins, caption falls back with ITS entities ──

assert.deepEqual(messageTextAndEntities({ text: "a", entities: [{ type: "bold", offset: 0, length: 1 }] }).entities.length, 1);
assert.equal(messageTextAndEntities({ caption: "c" }).text, "c");
assert.equal(messageTextAndEntities({}).text, "");

console.log("✓ bot-urls-test: urlsInMessage/isCommandMessage/cutEntities hold");
