/**
 * Raw ANSI escape primitives — ALWAYS ON, no TTY detection, no env checks.
 * The vocabulary, not the policy: ./log and ../cli decide WHETHER to color
 * (TTY, NO_COLOR, FORCE_COLOR) and build semantics on top; this module is for
 * output whose consumer renders ANSI regardless of what stdout is — Claude
 * Code status lines, tmux status strings, files a terminal will cat. A
 * TTY-gated palette emits nothing through those pipes, which is exactly wrong.
 *
 * 256-color escapes (`fg`/`bg`) over 24-bit as the house default: the xterm
 * cube is stable across every terminal/multiplexer, while 24-bit gets
 * quantized or dropped by tmux/screen configs. `rgb` exists for when the
 * consumer is known to render truecolor.
 */

import { assert } from "../offensive.js";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const UNDERLINE = "\x1b[4m";

/** Foreground, xterm-256 palette index. */
export function fg(n: number): string {
	assert(Number.isInteger(n) && n >= 0 && n <= 255, "xterm-256 index:", n);
	return `\x1b[38;5;${n}m`;
}

/** Background, xterm-256 palette index. */
export function bg(n: number): string {
	assert(Number.isInteger(n) && n >= 0 && n <= 255, "xterm-256 index:", n);
	return `\x1b[48;5;${n}m`;
}

/** Foreground, 24-bit — only when the consumer is known to render truecolor. */
export function rgb(r: number, g: number, b: number): string {
	assert(
		[r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
		"rgb components:",
		r,
		g,
		b,
	);
	return `\x1b[38;2;${r};${g};${b}m`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** The string minus its ANSI style escapes. */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * The house's semantic roles, each as the escape that opens it: what `cli`'s
 * `ui` paints with whenever it paints. The one map of role to colour, so what
 * a CLI prints and a page drawing that CLI's output (a terminal on a landing)
 * cannot disagree.
 */
export const ROLES = {
	head: BOLD,
	accent: fg(6),
	muted: DIM,
	ok: fg(2),
	warn: fg(3),
	bad: fg(1),
	/** ids / refs: de-emphasized */
	ref: fg(8),
} as const;

export type Role = keyof typeof ROLES;

/** `s` in a role, always on: for a consumer that renders ANSI whatever stdout is. */
export const inRole = (role: Role, s: string): string =>
	`${ROLES[role]}${s}${RESET}`;
