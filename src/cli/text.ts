/**
 * Shared text primitives for terminal presentation: ANSI-aware measurement,
 * clipping, padding, and the semantic `ui` palette. Both the static layer
 * (`cli/index` — table/kv/tree) and the live layer (`cli/live` — pinned
 * region/spinner) build on these; keeping them here avoids an import cycle.
 */

import { ANSI_RE, BOLD, DIM, fg, RESET } from "../universal/ansi.js";

export { ANSI_RE };

// The palette makes ONE whether-to-color decision for both cli layers, and
// cli writes to both streams (static output → stdout, live regions → stderr),
// so color requires BOTH to be TTYs: any redirection means some cli string
// may land in a file, and a file never gets escapes. NO_COLOR / FORCE_COLOR
// override. `ansi` stays the always-on vocabulary underneath.
const colorEnabled: boolean = process.env.FORCE_COLOR
	? true
	: process.env.NO_COLOR || process.env.TERM === "dumb"
		? false
		: process.stdout.isTTY === true && process.stderr.isTTY === true;

const paint = (open: string) =>
	colorEnabled
		? (s: string): string => `${open}${s}${RESET}`
		: (s: string): string => s;

export const bold = paint(BOLD);
export const dim = paint(DIM);
export const red = paint(fg(1));
export const green = paint(fg(2));
export const yellow = paint(fg(3));
export const cyan = paint(fg(6));
export const gray = paint(fg(8));

// biome-ignore lint/suspicious/noControlCharactersInRegex: split on ANSI escapes, keeping them
const ANSI_SPLIT_RE = /(\x1b\[[0-9;]*m)/;

// Grapheme clusters, not code points: what the terminal renders as ONE symbol
// (ZWJ emoji 👨‍👩‍👧, flags 🇪🇸, skin tones) is several code points — counting
// pieces breaks alignment. Each cluster then takes the cells a terminal gives
// it: two for East Asian wide/fullwidth characters and emoji-presentation
// symbols, one otherwise (py-utils measures the same way).
const GRAPHEMES = new Intl.Segmenter();

// East Asian Wide/Fullwidth blocks (the wcwidth core table): Hangul Jamo, CJK
// radicals through Yi, Hangul syllables, compatibility ideographs, vertical
// and fullwidth forms, the supplementary ideographic planes.
const WIDE: [number, number][] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|️/u;

/** Terminal cells one grapheme cluster occupies. */
function cells(grapheme: string): number {
	const cp = grapheme.codePointAt(0) ?? 0;
	if (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
	return EMOJI_PRESENTATION.test(grapheme) ? 2 : 1;
}

/** Visible width of a string in terminal cells — ANSI escapes stripped. */
export const width = (s: string): number => {
	let w = 0;
	for (const g of GRAPHEMES.segment(s.replace(ANSI_RE, "")))
		w += cells(g.segment);
	return w;
};

/**
 * Truncate to `n` visible cells (ellipsis at the cut), ANSI-aware: escape
 * sequences pass through so styling survives, and open styles are closed
 * with a final reset. A wide character never straddles the cut. Plain
 * strings work too — this is THE truncate.
 */
export function clip(s: string, n: number): string {
	if (width(s) <= n) return s;
	let out = "";
	let used = 0;
	let cut = false;
	let styled = false;
	for (const part of s.split(ANSI_SPLIT_RE)) {
		if (part === "") continue;
		if (part.startsWith("\x1b")) {
			out += part;
			styled = true;
			continue;
		}
		for (const g of GRAPHEMES.segment(part)) {
			if (cut) break;
			const w = cells(g.segment);
			if (used + w <= n - 1) {
				out += g.segment;
				used += w;
			} else {
				out += "…";
				cut = true;
			}
		}
	}
	// close any open style, without doubling a reset the input already ends on
	return styled && !out.endsWith("\x1b[0m") ? `${out}\x1b[0m` : out;
}

export const padEndV = (s: string, n: number): string =>
	s + " ".repeat(Math.max(0, n - width(s)));
export const padStartV = (s: string, n: number): string =>
	" ".repeat(Math.max(0, n - width(s))) + s;

/** Semantic palette — use these, not raw colors, so intent stays consistent. */
export const ui = {
	head: (s: string) => bold(s),
	accent: (s: string) => cyan(s),
	muted: (s: string) => dim(s),
	ok: (s: string) => green(s),
	warn: (s: string) => yellow(s),
	bad: (s: string) => red(s),
	/** ids / refs — de-emphasized monospace-ish */
	ref: (s: string) => gray(s),
};
