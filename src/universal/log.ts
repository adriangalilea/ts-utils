/**
 * Terminal-first logger with two renderings and one automatic decision.
 *
 * Two knobs, never confusing: format = how lines render, time = whether
 * lines carry time. Each defaults sensibly and independently.
 *
 * Format — LOG_FORMAT=human|record, or setLogFormat(). Default by TTY
 *     detection on the sink: a TTY gets human (symbols, color, a line meant
 *     for eyes), anything else gets record (level words, plain text, a line
 *     meant for a file read later). Detection happens on the stream actually
 *     written to (stderr), never a sibling stream.
 *
 * Time — LOG_TIME=1|0, or setLogTime(). Default: on in Node record mode,
 *     off everywhere else (human eyes don't need stamps; browser and Worker
 *     consoles stamp lines themselves). Record time opens the line with UTC
 *     RFC3339; human time prefixes a dim local HH:MM:SS (a human knows
 *     today's date).
 *
 * The record line with time on, identical across go-utils and py-utils by
 * design:
 *     2026-08-07T12:34:56Z WARN  [scope] message
 *     UTC RFC3339 seconds precision · level word padded to 5 · scope brackets
 *     only when scoped · no color, no symbols. Grep WARN, not ⚠.
 *
 * Sinks
 *     Node/Bun/Deno: every level writes to stderr through console.error, so
 *     stdout stays clean for data and cli/live's console routing keeps log
 *     lines above an active region.
 *     Browser: level-mapped console methods (debug/info/warn/error), human.
 *     Workers: level-mapped console methods, record.
 *
 * Levels vs verbs
 *     Levels filter: silent < error < warn < info < debug < trace. An unknown
 *     LOG_LEVEL is a misconfiguration and throws Panic.
 *     Verbs express outcome and are renderings, never levels:
 *     error ⨯  fail ⨯ (error) · warn ⚠ (warn) · info · success ✓ · wait ○ ·
 *     ready ▶ · step • (info) · debug ◦ (debug) · trace » (trace).
 *     In record mode a verb renders as its level word.
 *
 * Scopes
 *     log.scope('api') returns a child whose lines carry [api]; scopes nest
 *     and join: log.scope('api').scope('auth') → [api auth]. A scoped logger
 *     resolves its threshold from {SCOPE}_LOG_LEVEL (upper-cased, joined and
 *     sanitized to A-Z0-9_: API_AUTH_LOG_LEVEL, then API_LOG_LEVEL), falling
 *     back to setLogLevel(), then LOG_LEVEL, then info — read live, so one
 *     subsystem can be silenced or opened up without touching code.
 *
 * Config is env plus three runtime setters — setLogLevel(), setLogFormat(),
 *     setLogTime(). No handlers, no formatters, no init. NO_COLOR /
 *     FORCE_COLOR override color within human mode. Unknown values of any
 *     knob throw Panic. All internal memory is bounded.
 *
 * Siblings: go-utils and py-utils implement the same doctrine in their own
 * idioms; the record line format is identical by design.
 */

import { panic } from "../offensive.js";
import { runtime } from "../runtime.js";
import { BOLD, DIM, fg, RESET } from "./ansi.js";

// --- environment ---------------------------------------------------------

type Sink = "node" | "browser" | "worker";

const sink: Sink =
	runtime.isNode || runtime.isBun || runtime.isDeno
		? "node"
		: runtime.isBrowser
			? "browser"
			: "worker";

// --- format --------------------------------------------------------------

export type LogFormat = "human" | "record";

let formatOverride: LogFormat | undefined;

/** Force human or record rendering at runtime. Wins over LOG_FORMAT and auto-detection. */
export function setLogFormat(format: LogFormat): void {
	if (format !== "human" && format !== "record")
		panic("unknown log format:", format, "(want human|record)");
	formatOverride = format;
}

function currentFormat(): LogFormat {
	if (formatOverride) return formatOverride;
	const env = runtime.env("LOG_FORMAT");
	if (env === "human" || env === "record") return env;
	if (env !== undefined)
		panic("unknown LOG_FORMAT:", env, "(want human|record)");
	if (sink === "node") return runtime.stderr.isTTY ? "human" : "record";
	return sink === "browser" ? "human" : "record";
}

// --- time ----------------------------------------------------------------

let timeOverride: boolean | undefined;

/** Force time prefixes on or off at runtime. Wins over LOG_TIME and the defaults. */
export function setLogTime(on: boolean): void {
	timeOverride = on;
}

// Default: on only for Node record mode. Human lines are for eyes; browser
// and Worker consoles stamp every line themselves.
function timeEnabled(format: LogFormat): boolean {
	if (timeOverride !== undefined) return timeOverride;
	const env = runtime.env("LOG_TIME");
	if (env === "1") return true;
	if (env === "0") return false;
	if (env !== undefined) panic("unknown LOG_TIME:", env, "(want 1|0)");
	return format === "record" && sink === "node";
}

function colorEnabled(): boolean {
	if (currentFormat() === "record") return false;
	if (runtime.env("NO_COLOR")) return false;
	if (runtime.env("FORCE_COLOR")) return true;
	if (sink === "browser") return true;
	if (sink === "worker") return false;
	return runtime.stderr.isTTY && runtime.env("TERM") !== "dumb";
}

// --- levels --------------------------------------------------------------

const LEVELS = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
} as const;

export type LogLevel = keyof typeof LEVELS;
type MessageLevel = Exclude<LogLevel, "silent">;

function parseLevel(raw: string): number {
	const n = LEVELS[raw.toLowerCase() as LogLevel];
	if (n === undefined)
		panic(
			"unknown log level:",
			raw,
			"(want silent|error|warn|info|debug|trace)",
		);
	return n;
}

let levelOverride: number | undefined;

/** Set the global log level at runtime. Wins over LOG_LEVEL; per-scope env vars still win over this. */
export function setLogLevel(level: LogLevel): void {
	levelOverride = parseLevel(level);
}

const envKey = (scopes: readonly string[]): string =>
	`${scopes
		.map((s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))
		.join("_")}_LOG_LEVEL`;

// Most specific scope wins: [api auth] reads API_AUTH_LOG_LEVEL, then
// API_LOG_LEVEL, then the runtime override, then LOG_LEVEL. Read live on
// every line so a level flip needs no restart hook.
function threshold(scopes: readonly string[]): number {
	for (let i = scopes.length; i > 0; i--) {
		const raw = runtime.env(envKey(scopes.slice(0, i)));
		if (raw !== undefined) return parseLevel(raw);
	}
	if (levelOverride !== undefined) return levelOverride;
	const raw = runtime.env("LOG_LEVEL");
	return raw === undefined ? LEVELS.info : parseLevel(raw);
}

// --- verbs ---------------------------------------------------------------

type Verb =
	| "error"
	| "fail"
	| "warn"
	| "info"
	| "success"
	| "wait"
	| "ready"
	| "step"
	| "debug"
	| "trace";

const VERBS: Record<
	Verb,
	{ level: MessageLevel; symbol: string; style: string; indent: string }
> = {
	error: { level: "error", symbol: "⨯", style: BOLD + fg(1), indent: "" },
	fail: { level: "error", symbol: "⨯", style: BOLD + fg(1), indent: "" },
	warn: { level: "warn", symbol: "⚠", style: BOLD + fg(3), indent: "" },
	info: { level: "info", symbol: " ", style: "", indent: "" },
	success: { level: "info", symbol: "✓", style: BOLD + fg(2), indent: "" },
	wait: { level: "info", symbol: "○", style: BOLD + fg(7), indent: "" },
	ready: { level: "info", symbol: "▶", style: BOLD + fg(2), indent: "" },
	step: { level: "info", symbol: "•", style: DIM, indent: "  " },
	debug: { level: "debug", symbol: "◦", style: fg(8), indent: "" },
	trace: { level: "trace", symbol: "»", style: BOLD + fg(5), indent: "" },
};

const LEVEL_WORD: Record<MessageLevel, string> = {
	error: "ERROR",
	warn: "WARN ",
	info: "INFO ",
	debug: "DEBUG",
	trace: "TRACE",
};

// --- rendering -----------------------------------------------------------

const rfc3339 = (): string => `${new Date().toISOString().slice(0, 19)}Z`;
const clockTime = (): string => new Date().toTimeString().slice(0, 8);

function stringify(m: unknown): string {
	if (typeof m === "string") return m;
	if (m instanceof Error) return m.stack ?? String(m);
	try {
		return JSON.stringify(m) ?? String(m);
	} catch {
		return String(m);
	}
}

type ConsoleLevel = "error" | "warn" | "info" | "debug";

const CONSOLE_METHOD: Record<MessageLevel, ConsoleLevel> = {
	error: "error",
	warn: "warn",
	info: "info",
	debug: "debug",
	trace: "debug",
};

function emit(
	scopes: readonly string[],
	verb: Verb,
	messages: unknown[],
): void {
	const v = VERBS[verb];
	if (LEVELS[v.level] > threshold(scopes)) return;

	// Node funnels every level through console.error: stderr is the log sink
	// and cli/live patches console methods to reroute lines above an active
	// region. Browser/worker use level-mapped methods so platform consoles
	// classify lines correctly.
	const method: ConsoleLevel =
		sink === "node" ? "error" : CONSOLE_METHOD[v.level];

	const format = currentFormat();

	if (format === "record") {
		const stamp = timeEnabled(format) ? `${rfc3339()} ` : "";
		const scope = scopes.length > 0 ? `[${scopes.join(" ")}] ` : "";
		console[method](
			`${stamp}${LEVEL_WORD[v.level]} ${scope}${messages.map(stringify).join(" ")}`,
		);
		return;
	}

	const color = colorEnabled();
	const dimmed = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
	const stamp = timeEnabled(format) ? `${dimmed(clockTime())} ` : "";
	const symbol = color ? `${v.style}${v.symbol}${RESET}` : v.symbol;
	const scope = scopes.length > 0 ? `${dimmed(`[${scopes.join(" ")}]`)} ` : "";
	const prefix = `${stamp}${v.indent} ${symbol} ${scope}`;
	// A single string collapses into one line; anything richer is handed to
	// console so devtools/util.inspect keep live object rendering.
	if (messages.length === 1 && typeof messages[0] === "string") {
		console[method](`${prefix}${messages[0]}`);
	} else {
		console[method](prefix.trimEnd(), ...messages);
	}
}

// --- bounded state (daemons run for months) ------------------------------

const BOUND = 1024;

const warned = new Set<string>();
const timers = new Map<string, number>();

// --- logger --------------------------------------------------------------

export interface Logger {
	error(...messages: unknown[]): void;
	fail(...messages: unknown[]): void;
	warn(...messages: unknown[]): void;
	/** warn() that fires once per distinct message for the process lifetime. */
	warnOnce(...messages: unknown[]): void;
	info(...messages: unknown[]): void;
	success(...messages: unknown[]): void;
	wait(...messages: unknown[]): void;
	ready(...messages: unknown[]): void;
	/** Indented sub-step bullet under a wait/ready line. */
	step(...messages: unknown[]): void;
	debug(...messages: unknown[]): void;
	trace(...messages: unknown[]): void;
	/** Start a duration measurement; timeEnd() reports it at trace level. */
	time(label: string): void;
	timeEnd(label: string): void;
	/** Child logger: lines carry [name], level reads {NAME}_LOG_LEVEL first. */
	scope(name: string): Logger;
}

function makeLogger(scopes: readonly string[]): Logger {
	const verb =
		(v: Verb) =>
		(...messages: unknown[]): void =>
			emit(scopes, v, messages);

	return {
		error: verb("error"),
		fail: verb("fail"),
		warn: verb("warn"),
		info: verb("info"),
		success: verb("success"),
		wait: verb("wait"),
		ready: verb("ready"),
		step: verb("step"),
		debug: verb("debug"),
		trace: verb("trace"),

		warnOnce(...messages: unknown[]): void {
			const key = scopes.join(" ") + messages.map(stringify).join(" ");
			if (warned.has(key)) return;
			if (warned.size >= BOUND) warned.clear();
			warned.add(key);
			emit(scopes, "warn", messages);
		},

		time(label: string): void {
			if (timers.size >= BOUND) timers.clear();
			timers.set(`${scopes.join(" ")}:${label}`, Date.now());
		},

		timeEnd(label: string): void {
			const key = `${scopes.join(" ")}:${label}`;
			const start = timers.get(key);
			if (start === undefined) {
				emit(scopes, "warn", [`Timer '${label}' does not exist`]);
				return;
			}
			timers.delete(key);
			const ms = Date.now() - start;
			const pretty =
				ms > 10_000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`;
			emit(scopes, "trace", [`${label}: ${pretty}`]);
		},

		scope(name: string): Logger {
			return makeLogger([...scopes, name]);
		},
	};
}

const root = makeLogger([]);

export const error = root.error;
export const fail = root.fail;
export const warn = root.warn;
export const warnOnce = root.warnOnce;
export const info = root.info;
export const success = root.success;
export const wait = root.wait;
export const ready = root.ready;
export const step = root.step;
export const debug = root.debug;
export const trace = root.trace;
export const time = root.time;
export const timeEnd = root.timeEnd;
export const scope = root.scope;

/** The root logger plus its runtime knobs, for namespace-style consumers. */
export const log: Logger & {
	setLogLevel: typeof setLogLevel;
	setLogFormat: typeof setLogFormat;
	setLogTime: typeof setLogTime;
} = {
	...root,
	setLogLevel,
	setLogFormat,
	setLogTime,
};
