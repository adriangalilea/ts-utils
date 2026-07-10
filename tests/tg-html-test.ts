// tg-html contract tests, ported from the standalone tghtml package's suite and
// extended with the honesty fixes (stray angle brackets escape instead of
// vanishing; unknown tags drop their markup instead of leaking fragments).
// Run: pnpm test:tg-html
import assert from "node:assert/strict";
import { transform } from "../src/tg-html/index.js";

let pass = 0;
const eq = (name: string, input: string, expected: string) => {
	assert.equal(transform(input), expected, name);
	pass++;
	console.log("  PASS", name);
};

// ── supported tags pass through ──
eq(
	"preserves supported tags",
	"<b>Bold text</b> <i>Italic text</i>",
	"<b>Bold text</b> <i>Italic text</i>",
);
eq(
	"preserves nesting",
	"<b>Bold <i>and italic</i> text</b>",
	"<b>Bold <i>and italic</i> text</b>",
);
eq(
	"deep nesting",
	'<b>bold <i>italic bold <s>italic bold strikethrough <span class="tg-spoiler">italic bold strikethrough spoiler</span></s> <u>underline italic bold</u></i> bold</b>',
	'<b>bold <i>italic bold <s>italic bold strikethrough <span class="tg-spoiler">italic bold strikethrough spoiler</span></s> <u>underline italic bold</u></i> bold</b>',
);

// ── structure renders typographically ──
eq(
	"blocks get blank lines",
	"<div>This is a div</div> <p>This is a paragraph</p>",
	"This is a div\n\nThis is a paragraph",
);
eq(
	"supported tags survive containers",
	"<div><b>Bold text</b> in a div</div>",
	"<b>Bold text</b> in a div",
);
eq(
	"headings",
	"<h1>Main Title</h1><h2>Subtitle</h2>",
	"<b><u>Main Title</u></b>\n\n<b>Subtitle</b>",
);
eq(
	"paragraph spacing",
	"<p>First paragraph</p><p>Second paragraph</p>",
	"First paragraph\n\nSecond paragraph",
);
eq(
	"lists become bullets",
	"<ul><li>Item 1</li><li>Item 2</li></ul>",
	"• Item 1\n• Item 2",
);
eq(
	"content around lists keeps spacing",
	"<div>Introduction</div><ul><li>Item 1</li><li>Item 2</li></ul><p>Conclusion</p>",
	"Introduction\n\n• Item 1\n• Item 2\n\nConclusion",
);
eq(
	"multiple blocks",
	"<div>First block</div><div>Second block</div><p>A paragraph</p><ul><li>List item</li></ul>",
	"First block\n\nSecond block\n\nA paragraph\n\n• List item",
);

// ── spoilers ──
eq(
	"spoiler tag converts",
	"<spoiler>Spoiler alert</spoiler>",
	"<tg-spoiler>Spoiler alert</tg-spoiler>",
);
eq(
	"tg-spoiler passes",
	"<tg-spoiler>Spoiler alert</tg-spoiler>",
	"<tg-spoiler>Spoiler alert</tg-spoiler>",
);
eq(
	"span.tg-spoiler passes",
	'<span class="tg-spoiler">spoiler</span>',
	'<span class="tg-spoiler">spoiler</span>',
);
eq(
	"other spans unwrap",
	'<span class="invalid-class">Text content</span>',
	"Text content",
);

// ── links ──
eq(
	"scheme-less hrefs get https",
	'<a href="example.com">Link</a>',
	'<a href="https://example.com">Link</a>',
);
eq(
	"http(s) preserved",
	'<a href="https://example.com">HTTPS Link</a> <a href="http://example.org">HTTP Link</a>',
	'<a href="https://example.com">HTTPS Link</a> <a href="http://example.org">HTTP Link</a>',
);
eq(
	"tg:// preserved",
	'<a href="tg://user?id=123456789">User</a>',
	'<a href="tg://user?id=123456789">User</a>',
);
eq(
	"single-quoted attrs work",
	"<a href='test.com'>Link</a>",
	'<a href="https://test.com">Link</a>',
);

// ── code / quotes / emoji ──
eq(
	"code blocks keep language class",
	'<pre><code class="language-python">print("Hello World")</code></pre>',
	'<pre><code class="language-python">print("Hello World")</code></pre>',
);
eq(
	"blockquote newlines survive",
	"<blockquote>Quoted text\nSecond line</blockquote>",
	"<blockquote>Quoted text\nSecond line</blockquote>",
);
eq(
	"expandable blockquote",
	"<blockquote expandable>Expandable quote\nLine 2</blockquote>",
	'<blockquote expandable="">Expandable quote\nLine 2</blockquote>',
);
eq(
	"custom emoji",
	'<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>',
	'<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>',
);

// ── escaping (the honesty fixes) ──
eq(
	"escapes < > in text",
	"<p>Value is < 30% and > 10%</p>",
	"Value is &lt; 30% and &gt; 10%",
);
eq("escapes &", "<p>Tom & Jerry</p>", "Tom &amp; Jerry");
eq(
	"escapes inside blockquotes",
	"<blockquote>Price < $100 & quality > average</blockquote>",
	"<blockquote>Price &lt; $100 &amp; quality &gt; average</blockquote>",
);
eq(
	"escapes beside valid tags",
	"<p><b>Stats:</b> GDP < 30% & growth > 5%</p>",
	"<b>Stats:</b> GDP &lt; 30% &amp; growth &gt; 5%",
);
eq(
	"numeric pseudo-tags escape, not vanish",
	"The file size is <1mb> which is small.",
	"The file size is &lt;1mb&gt; which is small.",
);
eq(
	"comparison operators escape, not vanish",
	"If x<5 and y>10 then <b>proceed</b>",
	"If x&lt;5 and y&gt;10 then <b>proceed</b>",
);
eq(
	"unknown tags drop markup, keep content",
	"<b>Important:</b> The file is small and <small>tiny</small>.",
	"<b>Important:</b> The file is small and tiny.",
);
eq(
	"br renders, invalid self-closers escape",
	"Use <br/> for breaks but <1mb/> is invalid",
	"Use\nfor breaks but &lt;1mb/&gt; is invalid",
);

// ── recovery ──
{
	const result = transform(
		"<div>Unclosed div <b>Bold text</i> Mismatched</div>",
	);
	assert.ok(result.includes("Unclosed div"), "recovery: content survives");
	assert.ok(result.includes("Bold text"), "recovery: bold content survives");
	assert.ok(result.includes("Mismatched"), "recovery: tail survives");
	pass++;
	console.log("  PASS recovers from malformed HTML");
}

// ── the real-world shape (the summary-bot look) ──
eq(
	"summary layout end to end",
	`<div><b>How Billionaires Avoid Taxes: Buy. Borrow. Die.</b></div>
<ul>
<li>Billionaires leverage <b>equity</b> (company shares) as collateral for loans instead of selling assets, avoiding capital gains taxes.</li>
<li>Banks profit from interest, so they rarely demand repayment as long as net worth grows.</li>
<li>At death, assets get a <b>"step-up cost basis"</b>—resetting their value to current market price, erasing unrealized gains and taxes.</li>
</ul>
<blockquote>"Why pay capital gains tax if you never realize the gain?"</blockquote>
<i>Generic Art Dad</i>`,
	`<b>How Billionaires Avoid Taxes: Buy. Borrow. Die.</b>

• Billionaires leverage <b>equity</b> (company shares) as collateral for loans instead of selling assets, avoiding capital gains taxes.
• Banks profit from interest, so they rarely demand repayment as long as net worth grows.
• At death, assets get a <b>"step-up cost basis"</b>—resetting their value to current market price, erasing unrealized gains and taxes.

<blockquote>"Why pay capital gains tax if you never realize the gain?"</blockquote>
<i>Generic Art Dad</i>`,
);
eq(
	"messy blockquote whitespace normalizes",
	`<blockquote>   Line with leading spaces



  Too many newlines

  \t More garbage spacing
</blockquote><p>   Next    paragraph with    spaces   </p>`,
	`<blockquote>Line with leading spaces

Too many newlines

More garbage spacing</blockquote>
Next paragraph with spaces`,
);
eq(
	"adjacent blockquotes stay adjacent",
	`<div>Some text</div>
<blockquote>First blockquote
with newlines</blockquote>

<blockquote>Second blockquote
with its own newlines</blockquote>

<i>Italic text after</i>`,
	`Some text

<blockquote>First blockquote
with newlines</blockquote>
<blockquote>Second blockquote
with its own newlines</blockquote>
<i>Italic text after</i>`,
);
eq(
	"nested formatting inside blockquotes collapses its own whitespace",
	`<div>Outside text
 with newlines

 that should be normalized</div>
<blockquote><b>Bold text</b>
 with newlines
 inside blockquote
 <i>
   and nested formatting
   with more newlines
 </i></blockquote>`,
	`Outside text with newlines that should be normalized

<blockquote><b>Bold text</b>
with newlines
inside blockquote
<i>and nested formatting with more newlines</i></blockquote>`,
);

// ── degenerate input ──
eq("empty input", "   ", "");
eq("plain text passes through", "Just some plain text", "Just some plain text");

console.log(`\n${pass} passed`);
