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

// The escapes that take no cells: a style (`ESC [ … m`) and a hyperlink's open and
// close (`ESC ] 8 ; ; url ST`, ST being `ESC \` or BEL).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
export const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The string minus its ANSI escapes, styles and hyperlinks (their words stay). */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * What the environment says about colour, before any TTY is asked: true forced
 * on, false forced off, undefined for the TTY to decide. The one rule every
 * library keeps (utils' README, "Rendering"; its harness checks it):
 * `FORCE_COLOR` decides when not empty (`0` or `false` off, anything else on),
 * then `NO_COLOR` not empty turns it off, as does `TERM=dumb`. An empty variable
 * is an unset one (force-color.org, no-color.org). Takes the values rather than
 * reading them: this module reads no environment.
 */
export function colorAsked(env: {
	FORCE_COLOR?: string;
	NO_COLOR?: string;
	TERM?: string;
}): boolean | undefined {
	if (env.FORCE_COLOR)
		return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
	if (env.NO_COLOR || env.TERM === "dumb") return false;
	return undefined;
}

/** `text` as a hyperlink to `url` (OSC 8), always on: a terminal that knows the
 *  escape makes the words clickable, one that does not shows the words alone. */
export function link(text: string, url: string): string {
	assert(
		[...url].every((c) => c.charCodeAt(0) >= 0x20),
		"link: a url with a control character:",
		url,
	);
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

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
