// tg-md fixture test: the dialect contract, assertable offline.
// Run: pnpm test:tg-md
import assert from "node:assert/strict";
import {
	markdownToRichHtml,
	markdownToTelegramHtml,
	tidyRichMarkdown,
	toPlainText,
} from "../src/tg-md/index.js";

// ── the load-bearing rules ──────────────────────────────────────────

// snake_case survives: `_` is never emphasis.
assert.equal(
	markdownToTelegramHtml("keep snake_case_here intact"),
	"keep snake_case_here intact",
);

// digits survive the stash/restore round-trip (the invisible-sentinel regression).
assert.equal(markdownToTelegramHtml("54% vs 45% at 1/3"), "54% vs 45% at 1/3");
assert.equal(markdownToTelegramHtml("`c` and 54"), "<code>c</code> and 54");

// unmatched markers stay literal; tags always balance.
assert.equal(
	markdownToTelegramHtml("a **stray and *open"),
	"a **stray and *open",
);

// untrusted link schemes drop to their label.
assert.equal(markdownToTelegramHtml("[x](javascript:alert)"), "x");
assert.equal(
	markdownToTelegramHtml("[x](tg://user?id=1)"),
	'<a href="tg://user?id=1">x</a>',
);
// known quirk, documented: a `)` inside the URL ends the match early, so the
// tail paren stays literal — never breaks a message, just an ugly char.
assert.equal(markdownToTelegramHtml("[x](javascript:alert(1))"), "x)");

// ── structure: HTML target ──────────────────────────────────────────

assert.equal(markdownToTelegramHtml("# Title"), "<b><u>Title</u></b>");
assert.equal(markdownToTelegramHtml("## Head\nbody"), "<b>Head</b>\n\nbody");
assert.equal(markdownToTelegramHtml("###### footer line"), "footer line");
assert.equal(markdownToTelegramHtml("- one\n- two"), "• one\n• two");
assert.equal(
	markdownToTelegramHtml("> a\n> b"),
	"<blockquote>a\nb</blockquote>",
);

// ── new dialect: strike, spoiler, expandable quote, fences ──────────

assert.equal(markdownToTelegramHtml("~~gone~~"), "<s>gone</s>");
assert.equal(
	markdownToTelegramHtml("||secret||"),
	"<tg-spoiler>secret</tg-spoiler>",
);
assert.equal(
	markdownToTelegramHtml(">! long\n> tail"),
	"<blockquote expandable>long\ntail</blockquote>",
);
assert.equal(
	markdownToTelegramHtml("before\n```ts\nconst x = 1 < 2\n```\nafter"),
	"before\n<pre>const x = 1 &lt; 2</pre>\nafter",
);
// unclosed fence still closes (balanced by construction).
assert.equal(markdownToTelegramHtml("```\ntrailing"), "<pre>trailing</pre>");
// a whole-reply fence is unwrapped by tidy, not treated as a code block.
assert.equal(tidyRichMarkdown("```md\n# t\n```"), "# t");

// ── structure: rich target ──────────────────────────────────────────

assert.equal(markdownToRichHtml("# T\nbody"), "<h1>T</h1>\nbody");
assert.equal(markdownToRichHtml("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
assert.equal(
	markdownToRichHtml(">! spoiler quote"),
	"<blockquote expandable>spoiler quote</blockquote>",
);
// embedded fence → <pre>; a WHOLE-message fence is tidy-unwrapped instead (above).
assert.equal(
	markdownToRichHtml("intro\n```\nx < y\n```"),
	"intro\n<pre>x &lt; y</pre>",
);
assert.equal(
	markdownToRichHtml("# T\nbody", "https://cdn.x/y.jpg"),
	'<h1>T</h1>\n\n<img src="https://cdn.x/y.jpg"/>\n\nbody',
);
// covers only splice for well-formed http(s) URLs.
assert.equal(markdownToRichHtml("# T", "not a url"), "<h1>T</h1>");

// ── plain fallback ──────────────────────────────────────────────────

assert.equal(
	toPlainText("# T\n- a\n> q\n**b** ~~s~~ ||sp|| [l](https://x)"),
	"T\n• a\n> q\nb s sp l",
);

console.log("✓ tg-md: dialect contract holds");
