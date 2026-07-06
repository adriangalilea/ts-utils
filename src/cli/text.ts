/**
 * Shared text primitives for terminal presentation: ANSI-aware measurement,
 * clipping, padding, and the semantic `ui` palette. Both the static layer
 * (`cli/index` — table/kv/tree) and the live layer (`cli/live` — pinned
 * region/spinner) build on these; keeping them here avoids an import cycle.
 */

import { bold, cyan, dim, gray, green, red, yellow } from "../universal/log.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string — ANSI escape codes stripped, counted by code point. */
export const width = (s: string): number => [...s.replace(ANSI_RE, "")].length;

// biome-ignore lint/suspicious/noControlCharactersInRegex: tokenizes into ANSI escapes + code points
const TOKEN_RE = /\x1b\[[0-9;]*m|./gsu;

/**
 * Truncate to `n` visible chars (ellipsis at the cut), ANSI-aware: escape
 * sequences pass through so styling survives, and open styles are closed
 * with a final reset. Plain strings work too — this is THE truncate.
 */
export function clip(s: string, n: number): string {
	if (width(s) <= n) return s;
	let out = "";
	let vis = 0;
	let styled = false;
	for (const t of s.match(TOKEN_RE) ?? []) {
		if (t.startsWith("\x1b")) {
			out += t;
			styled = true;
		} else if (vis < n - 1) {
			out += t;
			vis++;
		} else if (vis === n - 1) {
			out += "…";
			vis++;
		}
	}
	return styled ? `${out}\x1b[0m` : out;
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
