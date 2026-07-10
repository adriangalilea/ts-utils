/**
 * `tg-html` — transform arbitrary (LLM-emitted) HTML into Telegram-compatible
 * `parse_mode=HTML` with opinionated, consistent spacing.
 *
 * Telegram's HTML subset has no headings, lists, or block layout — send it
 * `<h1>`/`<ul>` and the API rejects the whole message. This module accepts the
 * HTML a model naturally writes and renders the structure typographically:
 *
 *   h1                        → <b><u>…</u></b> + blank line
 *   h2…h6                     → <b>…</b> + blank line
 *   p/div/section/article/…   → content + blank line
 *   ul/ol/li                  → `• ` bullets, blank line after the list
 *   br                        → newline
 *   blockquote                → kept (newlines inside preserved), newline after
 *   b/i/u/s/code/pre/a/…      → kept, attributes filtered to Telegram's allow-list
 *   spoiler / span.tg-spoiler → <tg-spoiler>
 *   unknown letter-tags       → dropped, content kept (hallucinated markup)
 *   stray < >                 → escaped, never eaten
 *
 * Zero dependencies, no DOM: a single-pass tokenizer over a small recursive
 * renderer, safe everywhere (Workers included). Successor of the standalone
 * `tghtml` package (jsr:@adriangalilea/tghtml, now archived), with its lossy
 * edge cases fixed: `x<5 and y>10` escapes instead of vanishing, and unknown
 * tags drop their markup instead of leaking `small…/small` fragments.
 *
 * @example
 * import { transform } from '@adriangalilea/utils/tg-html'
 *
 * transform('<h1>Title</h1><ul><li>Point</li></ul>')
 * // '<b><u>Title</u></b>\n\n• Point'
 */

// Tags Telegram's parse_mode=HTML accepts verbatim.
const TELEGRAM_TAGS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"ins",
	"s",
	"strike",
	"del",
	"span",
	"tg-spoiler",
	"a",
	"code",
	"pre",
	"blockquote",
	"tg-emoji",
]);

// Attributes kept per tag; everything else is dropped.
const TELEGRAM_ATTRS: Record<string, readonly string[]> = {
	a: ["href"],
	span: ["class"],
	blockquote: ["expandable"],
	code: ["class"],
	"tg-emoji": ["emoji-id"],
};

// Structural tags this module renders typographically (they can't reach Telegram).
const STRUCTURAL = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"div",
	"section",
	"article",
	"header",
	"footer",
	"ul",
	"ol",
	"li",
	"br",
	"spoiler",
	// Document wrappers a model sometimes emits around its answer; rendered transparent.
	"html",
	"head",
	"body",
]);

// Void tags: never expect a closing counterpart.
const VOID_TAGS = new Set(["br", "meta", "hr", "img", "input"]);

// ─── parsing ────────────────────────────────────────────────────────

interface ElementNode {
	kind: "element";
	tag: string;
	attrs: Record<string, string>;
	children: Node[];
}
interface TextNode {
	kind: "text";
	text: string;
}
type Node = ElementNode | TextNode;

// A tag token must start with a letter (like real HTML): `<1mb>` or `<5` is text, not markup.
const TAG_RE =
	/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTR_RE =
	/([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of raw.matchAll(ATTR_RE)) {
		attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
	}
	return attrs;
}

/** Tokenize + tree-build in one pass. Mismatched closers close intervening elements (recovery). */
function parse(html: string): Node[] {
	const root: ElementNode = {
		kind: "element",
		tag: "#root",
		attrs: {},
		children: [],
	};
	const stack: ElementNode[] = [root];
	let last = 0;

	const pushText = (text: string) => {
		if (text) stack[stack.length - 1].children.push({ kind: "text", text });
	};

	for (const m of html.matchAll(TAG_RE)) {
		pushText(html.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;

		const closing = m[1] === "/";
		const tag = m[2].toLowerCase();
		const selfClosing = m[4] === "/" || VOID_TAGS.has(tag);
		const known = TELEGRAM_TAGS.has(tag) || STRUCTURAL.has(tag);

		if (!known) continue; // hallucinated markup: drop the tag, keep surrounding content

		if (closing) {
			// Close up to the matching open element, if any (recovery for mismatches).
			for (let at = stack.length - 1; at > 0; at--) {
				if (stack[at].tag === tag) {
					stack.length = at;
					break;
				}
			}
			continue;
		}

		const el: ElementNode = {
			kind: "element",
			tag,
			attrs: parseAttrs(m[3]),
			children: [],
		};
		stack[stack.length - 1].children.push(el);
		if (!selfClosing) stack.push(el);
	}
	pushText(html.slice(last));
	return root.children;
}

// ─── rendering ──────────────────────────────────────────────────────

function escapeText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
	return escapeText(s).replace(/"/g, "&quot;");
}

/** Text whitespace mode, set by the IMMEDIATE parent: blockquotes keep their line breaks,
 *  pre/code keep everything, ordinary flow collapses runs to one space. */
type Space = "collapse" | "quote" | "verbatim";

function renderText(text: string, mode: Space): string {
	const escaped = escapeText(text);
	if (mode === "verbatim") return escaped;
	if (mode === "quote") {
		return escaped
			.replace(/[ \t]+/g, " ")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n");
	}
	return escaped.replace(/\s+/g, " ");
}

function renderChildren(el: { children: Node[] }, mode: Space): string {
	let out = "";
	for (const child of el.children) {
		out +=
			child.kind === "text"
				? renderText(child.text, mode)
				: renderElement(child, mode);
	}
	return out;
}

function keptAttrs(el: ElementNode): string {
	let out = "";
	for (const name of TELEGRAM_ATTRS[el.tag] ?? []) {
		if (!(name in el.attrs)) continue;
		let value = el.attrs[name];
		// Scheme-less links get https; only http(s)/tg pass through untouched.
		if (
			el.tag === "a" &&
			name === "href" &&
			value &&
			!/^(https?|tg):/i.test(value)
		) {
			value = `https://${value}`;
		}
		out += ` ${name}="${escapeAttr(value)}"`;
	}
	return out;
}

function renderElement(el: ElementNode, mode: Space): string {
	const tag = el.tag;

	if (tag === "br") return "\n";

	if (tag === "h1")
		return `<b><u>${renderChildren(el, "collapse").trim()}</u></b>\n\n`;
	if (/^h[2-6]$/.test(tag))
		return `<b>${renderChildren(el, "collapse").trim()}</b>\n\n`;

	if (tag === "ul" || tag === "ol") {
		const items = el.children
			.filter((c): c is ElementNode => c.kind === "element" && c.tag === "li")
			.map((li) => `• ${renderChildren(li, "collapse").trim()}`);
		return `${items.join("\n")}\n\n`;
	}
	if (tag === "li") return `• ${renderChildren(el, "collapse").trim()}\n`;

	if (
		[
			"p",
			"div",
			"section",
			"article",
			"header",
			"footer",
			"html",
			"head",
			"body",
		].includes(tag)
	) {
		return `${renderChildren(el, mode).trim()}\n\n`;
	}

	if (tag === "blockquote") {
		const expandable = "expandable" in el.attrs ? ' expandable=""' : "";
		return `<blockquote${expandable}>${renderChildren(el, "quote").trim()}</blockquote>\n`;
	}

	if (tag === "spoiler")
		return `<tg-spoiler>${renderChildren(el, "collapse").trim()}</tg-spoiler>`;

	if (tag === "span") {
		// Only the spoiler span means anything to Telegram; other spans are transparent.
		if (el.attrs.class !== "tg-spoiler") return renderChildren(el, mode);
		return `<span class="tg-spoiler">${renderChildren(el, "collapse").trim()}</span>`;
	}

	if (TELEGRAM_TAGS.has(tag)) {
		// Quote mode applies to a blockquote's DIRECT text only: an inline tag inside it
		// collapses its own whitespace like anywhere else.
		const inner = tag === "pre" || tag === "code" ? "verbatim" : "collapse";
		return `<${tag}${keptAttrs(el)}>${renderChildren(el, inner).trim()}</${tag}>`;
	}

	return renderChildren(el, mode);
}

/**
 * Transform HTML into Telegram-compatible `parse_mode=HTML` with consistent
 * spacing. Never throws; pathological input degrades to escaped plain text.
 */
export function transform(html: string): string {
	if (!html.trim()) return "";
	return parse(html)
		.map((n) =>
			n.kind === "text"
				? renderText(n.text, "collapse")
				: renderElement(n, "collapse"),
		)
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n +/g, "\n")
		.trim();
}
