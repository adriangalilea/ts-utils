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
// pieces breaks alignment.
// TODO: East-Asian width — CJK and wide emoji occupy TWO terminal cells but
// count as one here, so CJK-heavy columns can drift a cell; needs a wcwidth
// range table.
const GRAPHEMES = new Intl.Segmenter();

/** Visible width of a string — ANSI escapes stripped, counted by grapheme cluster. */
export const width = (s: string): number =>
	[...GRAPHEMES.segment(s.replace(ANSI_RE, ""))].length;

/**
 * Truncate to `n` visible graphemes (ellipsis at the cut), ANSI-aware: escape
 * sequences pass through so styling survives, and open styles are closed
 * with a final reset. Plain strings work too — this is THE truncate.
 */
export function clip(s: string, n: number): string {
	if (width(s) <= n) return s;
	let out = "";
	let vis = 0;
	let styled = false;
	for (const part of s.split(ANSI_SPLIT_RE)) {
		if (part === "") continue;
		if (part.startsWith("\x1b")) {
			out += part;
			styled = true;
			continue;
		}
		for (const g of GRAPHEMES.segment(part)) {
			if (vis < n - 1) {
				out += g.segment;
				vis++;
			} else if (vis === n - 1) {
				out += "…";
				vis++;
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
