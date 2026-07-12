/**
 * tg-md — the opinionated Telegram-Markdown formatter (xtldr's house style,
 * grown from theSummaryBot's tg-html lineage). ONE input dialect, the
 * markdown LLMs actually emit, rendered to every shape a bot sends:
 *
 *   markdownToRichHtml(md, coverUrl?)  rich-message HTML (Bot API 10.1): real
 *                                      headings/lists, optional cover <img>
 *                                      spliced after the title
 *   markdownToTelegramHtml(md)         strict parse_mode=HTML subset: # title
 *                                      -> bold underlined line, ## headings ->
 *                                      bold lines with breathing room, ######
 *                                      footer -> quiet plain line, bullets -> •
 *   toPlainText(md)                    last-ditch fallback (quotes keep their
 *                                      > marker so they still read as quotes)
 *   tidyRichMarkdown(md)               strip the stray ```fence``` models add
 *
 * The dialect contract, load-bearing and deliberate:
 *   - `_` is NEVER emphasis — snake_case in model output survives verbatim.
 *     Only `*italic*` / `**bold**` are honored.
 *   - Every tag is balanced by construction: a render can never produce a
 *     message Telegram rejects; unmatched markers stay literal.
 *   - Pure functions of the whole string — safe for full-frame draft repaints
 *     (bot/draft): malformed mid-stream markdown degrades to literal text
 *     this frame and renders correctly the next.
 *
 * Typography (heading air, bullet glyph, the title underline) IS the opinion;
 * it becomes configurable when a second consumer needs a different look, not
 * before. Zero deps, worker-safe.
 */

/** Unwrap a leading/trailing ```…``` code fence (some models add one) and trim. */
export function tidyRichMarkdown(raw: string): string {
	const trimmed = raw.trim();
	const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Render the model's rich Markdown into Telegram's strict `parse_mode=HTML` subset,
 * which has no headings or lists:
 *   `#` title                   -> a bold UNDERLINED line + blank line (the wordmark look)
 *   `##`..`#####` headings      -> a bold line + blank line after (air between head and body)
 *   `######` footer heading     -> a bold line, no forced air (it's the last line)
 *   bullets   (`- `/`* `/`+ `)  -> a `• ` prefix
 *   blockquote (`> `)           -> `<blockquote>` (consecutive lines merged)
 *   `**bold**`/`*italic*`       -> `<b>`/`<i>`; `` `code` `` -> `<code>`; links -> `<a>`
 * Only `*`-based emphasis is honored (never `_`), so `snake_case` survives. Every tag
 * is balanced, so Telegram can't reject the message; unmatched markers stay literal.
 * The spacing is the legacy tghtml contract (now @adriangalilea/utils/tg-html): every
 * heading is followed by a blank line so sections breathe — a heading hugging its
 * bullets reads as a wall.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const lines = tidyRichMarkdown(markdown).split(/\r?\n/);
	const out: string[] = [];
	let quote: string[] = [];

	const flushQuote = () => {
		if (quote.length) {
			out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
			quote = [];
		}
	};

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");

		const q = /^\s{0,3}>\s?(.*)$/.exec(line);
		if (q) {
			quote.push(inlineMd(q[1]));
			continue;
		}
		flushQuote();

		if (!line.trim()) {
			out.push("");
			continue;
		}

		const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = inlineMd(heading[2]);
			// ###### is the source footer: metadata, not a heading — it renders as a quiet
			// plain line (the legacy look), never bold.
			if (level === 1) out.push(`<b><u>${text}</u></b>`, "");
			else if (level === 6) out.push(text);
			else out.push(`<b>${text}</b>`, "");
			continue;
		}

		const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			out.push(`• ${inlineMd(bullet[1])}`);
			continue;
		}

		out.push(inlineMd(line));
	}
	flushQuote();

	return tidyHtml(out.join("\n"));
}

/**
 * Render the model's rich Markdown into rich-message HTML (the `rich_message.html`
 * field, Bot API 10.1), which supports tags `parse_mode=HTML` lacks, so headings and
 * lists survive as real structure instead of flattening:
 *   headings  (`#`..`######`)  -> `<h1>`..`<h6>` (level = count of `#`)
 *   bullets   (`- `/`* `/`+ `)  -> `<ul><li>…</li></ul>` (consecutive items merged)
 *   blockquote (`> `)           -> `<blockquote>` (consecutive lines merged)
 * Inline emphasis/code/links reuse {@link inlineMd}. Every tag is balanced, so Telegram
 * can't reject the message; unmatched markers stay literal.
 *
 * `coverUrl` (rich path only) embeds a cover image as a standalone `<img>` block right after
 * the title heading (title, cover, then body), matching the rich-message photo block, which
 * accepts HTTP(S) URLs only. Ignored unless it's a well-formed http(s) URL. The strict-HTML and
 * plain fallbacks have no image support, so they never carry a cover.
 */
export function markdownToRichHtml(
	markdown: string,
	coverUrl?: string,
): string {
	const lines = tidyRichMarkdown(markdown).split(/\r?\n/);
	const out: string[] = [];
	let quote: string[] = [];
	let bullets: string[] = [];

	const flushQuote = () => {
		if (quote.length) {
			out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
			quote = [];
		}
	};
	const flushBullets = () => {
		if (bullets.length) {
			out.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`);
			bullets = [];
		}
	};

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");

		const q = /^\s{0,3}>\s?(.*)$/.exec(line);
		if (q) {
			flushBullets();
			quote.push(inlineMd(q[1]));
			continue;
		}

		const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			flushQuote();
			bullets.push(inlineMd(bullet[1]));
			continue;
		}

		flushQuote();
		flushBullets();

		if (!line.trim()) {
			out.push("");
			continue;
		}

		const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
			continue;
		}

		out.push(inlineMd(line));
	}
	flushQuote();
	flushBullets();

	insertCover(out, coverUrl);

	return out
		.join("\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Insert a cover `<img>` block into the rendered rich-HTML lines: right after the title heading
 * (so it reads title → cover → body), or at the very top when there's no title. Anchors on `<h1>`
 * only, since the summary's title is `#` (h1) while section headings are `##` (h2) and the source
 * footer is `######` (h6): matching any `<h[1-6]>` would splice the cover below the footer when the
 * model omits the title. A blank line surrounds it so it stays its own block (media blocks can't be
 * inline). No-op unless `url` is a well-formed http(s) URL, since the rich photo block accepts only those.
 */
function insertCover(out: string[], url: string | undefined): void {
	if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) return;
	const img = `<img src="${escapeAttr(url.trim())}"/>`;
	const titleAt = out.findIndex((line) => /^<h1>/.test(line));
	const at = titleAt === -1 ? 0 : titleAt + 1;
	out.splice(at, 0, "", img, "");
}

/** Normalize rendered HTML: strip trailing whitespace, collapse blank-line runs. Blank lines
 *  around lists stay — that air is the layout (the legacy look); only runs of 3+ collapse. */
function tidyHtml(html: string): string {
	return html
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Inline Markdown to Telegram HTML for one line. Code spans and links are pulled out
 * first (so their contents aren't escaped twice or treated as emphasis) and stashed;
 * the rest is escaped, `**bold**`/`*italic*` become tags, then the fragments are restored.
 */
function inlineMd(text: string): string {
	const tokens: string[] = [];
	const stash = (html: string): string => {
		tokens.push(html);
		return `${tokens.length - 1}`;
	};

	// Code spans first: their contents are literal (no emphasis, no nested links).
	let s = text.replace(/`([^`]+)`/g, (_, code: string) =>
		stash(`<code>${escapeHtml(code)}</code>`),
	);
	// Then links: drop the href unless it's a trusted scheme, keeping the label.
	s = s.replace(
		/\[([^\]]*)\]\(([^)\s]+)\)/g,
		(_, label: string, url: string) => {
			const safe = /^(https?:|tg:|mailto:)/i.test(url) ? url : null;
			return stash(
				safe
					? `<a href="${escapeAttr(safe)}">${escapeHtml(label)}</a>`
					: escapeHtml(label),
			);
		},
	);

	s = escapeHtml(s);
	s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"); // bold before italic so `**` wins over `*`
	s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1<i>$2</i>");

	return s.replace(/(\d+)/g, (_, i: string) => tokens[Number(i)]);
}

/** Escape text/code content for Telegram HTML. */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an href for a Telegram HTML attribute. */
function escapeAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Strip Markdown to plain text: the fallback when Telegram rejects the rich message.
 * Removes heading/bullet markers and emphasis, unwraps links to their text, but KEEPS
 * the `>` blockquote marker on every quote line so quotes still read as quotes with no
 * formatting to lean on. Best-effort, not a full parser.
 */
export function toPlainText(markdown: string): string {
	return tidyRichMarkdown(markdown)
		.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, "$1") // fenced code -> its contents
		.replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
		.replace(/^\s{0,3}>\s?/gm, "> ") // normalize blockquote markers, keep them
		.replace(/^(\s*)[-*+]\s+/gm, "$1• ") // bullet markers -> •
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
		.replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
		.replace(/(\*|_)(.*?)\1/g, "$2") // italic
		.replace(/`([^`]*)`/g, "$1") // inline code
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
