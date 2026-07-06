/**
 * `cli` — terminal presentation: aligned tables, key/value blocks, trees, a
 * semantic palette, and live output (pinned region, spinner, progress bar).
 * Separate from `format` (which is universal value formatting, for every
 * layer) — this is terminal-scoped output.
 *
 * Colors come from `universal/log` and auto-disable on non-TTY / NO_COLOR, so a
 * `table()` renders colored in a terminal and as plain aligned text in a pipe,
 * log file, or a bot's monospace block — correct everywhere.
 *
 * Alignment is ANSI-aware: padding is computed on the *visible* width (escape
 * codes stripped), so colored cells line up.
 *
 * @example
 * import { table, kv, ui, indent } from '@adriangalilea/utils/cli'
 *
 * console.log(table(
 *   [['Ada', ui.accent('ada@x.com'), ui.muted('work')],
 *    ['Bo',  ui.accent('bo@y.com'),  ui.muted('home')]],
 *   { head: ['name', 'email', 'label'] },
 * ))
 */

import { padEndV, padStartV, ui, width } from "./text.js";

export * from "./live.js";
export { clip, ui, width } from "./text.js";

export interface TableOpts {
	/** Column headers (bolded). */
	head?: string[];
	/** Per-column alignment; default all left. */
	align?: ("l" | "r")[];
	/** Spaces between columns (default 2). */
	gap?: number;
	/** Left indent for the whole table (default 0). */
	indent?: number;
}

/**
 * Render rows as aligned columns. Cells may be pre-colored — widths use visible
 * length so colored columns still line up. The last left-aligned column isn't
 * right-padded (no trailing whitespace).
 */
export function table(rows: string[][], opts: TableOpts = {}): string {
	const gap = " ".repeat(opts.gap ?? 2);
	const lead = " ".repeat(opts.indent ?? 0);
	const body = opts.head ? [opts.head, ...rows] : rows;
	const cols = Math.max(0, ...body.map((r) => r.length));
	const w = Array.from({ length: cols }, (_, c) =>
		Math.max(0, ...body.map((r) => width(r[c] ?? ""))),
	);

	const line = (r: string[]): string => {
		const cells = Array.from({ length: cols }, (_, c) => {
			const cell = r[c] ?? "";
			const colWidth = w[c] ?? 0;
			const isLast = c === cols - 1;
			const right = opts.align?.[c] === "r";
			if (right) return padStartV(cell, colWidth);
			return isLast ? cell : padEndV(cell, colWidth);
		});
		return lead + cells.join(gap).replace(/\s+$/, "");
	};

	const out: string[] = [];
	if (opts.head) out.push(line(opts.head.map((h) => ui.head(h))));
	for (const r of rows) out.push(line(r));
	return out.join("\n");
}

/** Key/value block (aligned keys), e.g. for a detail view. */
export function kv(
	pairs: [string, string][],
	opts: { indent?: number; gap?: number } = {},
): string {
	const lead = " ".repeat(opts.indent ?? 0);
	const gap = " ".repeat(opts.gap ?? 2);
	const w = Math.max(0, ...pairs.map(([k]) => width(k)));
	return pairs
		.map(([k, v]) => `${lead}${ui.muted(padEndV(k, w))}${gap}${v}`)
		.join("\n");
}

/** Indent every line of a (possibly multi-line) string by `n` spaces. */
export const indent = (s: string, n: number): string =>
	s
		.split("\n")
		.map((l) => " ".repeat(n) + l)
		.join("\n");

/** A labeled node with child lines drawn under it. */
export function tree(
	label: string,
	children: string[],
	opts: { indent?: number } = {},
): string {
	const lead = " ".repeat(opts.indent ?? 0);
	return [lead + label, ...children.map((c) => `${lead}  ${c}`)].join("\n");
}
