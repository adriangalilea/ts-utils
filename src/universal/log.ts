/**
 * The logger: one stream of events, written the same way by go-utils,
 * ts-utils and py-utils. The contract is the utils README
 * (github.com/adriangalilea/utils); this file is the TypeScript side of it.
 *
 * Writing
 *     Every verb takes a message, then optional fields:
 *         log.warn("retrying", { attempt: 2 })
 *         log.error("charge failed", { err })
 *     The message says what happened, the fields say with what. Fields are a
 *     plain object; anything else panics.
 *
 * Verbs print at fixed levels
 *     error ⨯ · fail ⨯ (error) · warn ⚠ · warnOnce ⚠ (warn) · info · success ✓
 *     · wait ○ · ready ▶ · step • (info) · debug ◦ (debug) · trace » (trace).
 *     warnOnce fires once per message and scope (memory bounded).
 *
 * Scopes
 *     log.scope("api").scope("auth") carries ["api", "auth"]. Its threshold
 *     is read live from API_AUTH_LOG_LEVEL, then API_LOG_LEVEL, then
 *     LOG_LEVEL, then setLogLevel(), then info. Levels:
 *     silent < error < warn < info < debug < trace.
 *
 * Spans
 *     A span is a piece of work written as two events (start, end) and a
 *     span is a logger: what is written through it carries its span_id and
 *     trace_id, nothing else does. There is no ambient context.
 *         await log.span("sync", { repo }, async (s) => {
 *           s.info("cloned", { files })
 *           await s.span("build", async (c) => { ... })
 *           s.set({ pushed: true })
 *         })
 *     span returns what fn returns; a throw ends the span failed (the error
 *     in fields.err) and rethrows. The open form, for work that does not fit
 *     a block: const s = log.begin("upload", { size }) ... s.end() or
 *     s.end(err). Ending twice, or set() after the end, panics.
 *     Whether a span is shown is decided once, at begin, by its start's level
 *     against its scope's threshold; the end follows, so a hidden span writes
 *     no end. A failure is never lost to that: a hidden span that fails
 *     writes one fail line (its name; its fields with err and dur_ms) as a
 *     line of the nearest shown span. What a hidden span holds attaches to the nearest
 *     shown span, a joined remote one included: its lines carry that id, its
 *     children and its traceparent() name it. With no shown ancestor its
 *     lines carry no ids. A viewer never meets a missing parent.
 *
 * Traces cross processes explicitly
 *     s.traceparent() is the W3C value to hand on (HTTP header, or the
 *     TRACEPARENT env of a child). log.join(value) returns a logger whose
 *     spans are children of that remote span; its lines outside a span carry
 *     no ids. null/undefined returns the logger itself; a malformed value is
 *     ignored with one warn per distinct value. TRACEPARENT in the
 *     environment at process start is joined by every root span.
 *
 * Renderings
 *     json: one event per line, keys in the contract's order, fields sorted
 *     at every depth. human: symbols, colour (TTY, NO_COLOR, FORCE_COLOR),
 *     fields dim as key=value, an error's stack under its line once (a span
 *     failing with the error a span inside it failed with shows the message;
 *     json writes it on both ends), spans as
 *     "○ name" ... "✓ name 254ms" with what they hold indented.
 *     Default: Node/Bun/Deno human when stderr is a TTY, else json; browser
 *     human; Worker json.
 *
 * Configuration
 *     Each variable has a setter; the setter is the program's default and the
 *     variable, read live, overrides it: LOG_FORMAT=human|json (setLogFormat),
 *     LOG_TIME=1|0 (setLogTime, a dim local HH:MM:SS before human lines, off
 *     by default), LOG_LEVEL and {SCOPE}_LOG_LEVEL (setLogLevel), LOG_SERVICE
 *     (setLogService). Values match without regard to case, an empty variable
 *     is unset, an unknown value panics. The service defaults to the entry
 *     script's name without extension; in a Worker or browser it must be
 *     set, or the first json event panics.
 *
 * Sinks
 *     Node/Bun/Deno write every event through console.error: stderr is the
 *     log, stdout stays data, and cli/live's console patch keeps lines above
 *     a live region. Browsers and Workers use the level's console method.
 *
 * The wire shape is exported as LogEvent, and parseEvent(line) reads one back.
 */

import { assert, panic, SourcedError } from "../offensive.js";
import { runtime } from "../runtime.js";
import { BOLD, DIM, fg, RESET } from "./ansi.js";

// --- the wire format -------------------------------------------------------

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";
type EventLevel = Exclude<LogLevel, "silent">;

export type LogVerb =
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

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** What a verb, span or set() takes: a plain object, any values (serialized by the contract's table). */
export type Fields = Readonly<Record<string, unknown>>;

interface EventBase {
	readonly time: string;
	readonly level: EventLevel;
	readonly verb: LogVerb;
	readonly msg: string;
	readonly service: string;
	readonly scope?: readonly string[];
	readonly fields?: { readonly [key: string]: JsonValue };
}

/** A log line. Inside a shown span it carries the span's trace_id and span_id. */
export interface LineEvent extends EventBase {
	readonly phase?: undefined;
	readonly trace_id?: string;
	readonly span_id?: string;
	readonly parent_id?: undefined;
	readonly status?: undefined;
	readonly dur_ms?: undefined;
}

export interface SpanStartEvent extends EventBase {
	readonly level: "info";
	readonly verb: "wait";
	readonly phase: "start";
	readonly trace_id: string;
	readonly span_id: string;
	readonly parent_id?: string;
	readonly status?: undefined;
	readonly dur_ms?: undefined;
}

interface SpanEndBase extends EventBase {
	readonly phase: "end";
	readonly trace_id: string;
	readonly span_id: string;
	readonly parent_id?: string;
	/** Monotonic, milliseconds, 3 decimals. */
	readonly dur_ms: number;
}

export interface SpanOkEvent extends SpanEndBase {
	readonly level: "info";
	readonly verb: "success";
	readonly status: "ok";
}

/** A failed span's end: the error is in fields.err. */
export interface SpanFailEvent extends SpanEndBase {
	readonly level: "error";
	readonly verb: "fail";
	readonly status: "error";
}

export type SpanEndEvent = SpanOkEvent | SpanFailEvent;

/** One event of the stream, as written on the wire. Keys appear in this order. */
export type LogEvent = LineEvent | SpanStartEvent | SpanEndEvent;

const EVENT_KEYS = [
	"time",
	"level",
	"verb",
	"msg",
	"service",
	"scope",
	"phase",
	"trace_id",
	"span_id",
	"parent_id",
	"status",
	"dur_ms",
	"fields",
] as const;

// --- verbs and levels ------------------------------------------------------

const LEVELS: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
};

const VERBS: Record<
	LogVerb,
	{ level: EventLevel; symbol: string; style: string; indent: string }
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

const isLogLevel = (s: string): s is LogLevel => Object.hasOwn(LEVELS, s);
const isVerb = (s: string): s is LogVerb => Object.hasOwn(VERBS, s);

// --- configuration ---------------------------------------------------------

type Sink = "node" | "browser" | "worker";

const sink: Sink =
	runtime.isNode || runtime.isBun || runtime.isDeno
		? "node"
		: runtime.isBrowser
			? "browser"
			: "worker";

export type LogFormat = "human" | "json";

// An empty variable reads as unset: `LOG_LEVEL= cmd` is how a shell unsets one.
const env = (key: string): string | undefined => runtime.env(key) || undefined;

// Values match without regard to case, from the environment and from code alike.
function parseLevel(raw: string, source: string): LogLevel {
	const level = String(raw).toLowerCase();
	if (!isLogLevel(level))
		panic(
			`unknown ${source}:`,
			raw,
			"(want silent|error|warn|info|debug|trace)",
		);
	return level;
}

function parseFormat(raw: string, source: string): LogFormat {
	const format = String(raw).toLowerCase();
	if (format !== "human" && format !== "json")
		panic(`unknown ${source}:`, raw, "(want human|json)");
	return format;
}

// Each setter is the program's default; the variable, read live, overrides it.
let levelSetting: LogLevel | undefined;
let formatSetting: LogFormat | undefined;
let timeSetting: boolean | undefined;
let serviceSetting: string | undefined;

/** The program's default level. LOG_LEVEL and {SCOPE}_LOG_LEVEL override it. */
export function setLogLevel(level: LogLevel): void {
	levelSetting = parseLevel(level, "log level");
}

/** The program's default rendering, human or json. LOG_FORMAT overrides it. */
export function setLogFormat(format: LogFormat): void {
	formatSetting = parseFormat(format, "log format");
}

/** A dim local HH:MM:SS before human lines (json always carries time). LOG_TIME overrides it. */
export function setLogTime(on: boolean): void {
	if (typeof on !== "boolean") panic("setLogTime wants a boolean, got:", on);
	timeSetting = on;
}

/** The program's name in every event. LOG_SERVICE overrides it. */
export function setLogService(name: string): void {
	if (typeof name !== "string" || name.length === 0)
		panic("setLogService wants a non-empty name, got:", name);
	serviceSetting = name;
}

const scopeVar = (scope: readonly string[]): string =>
	`${scope.map((s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_")).join("_")}_LOG_LEVEL`;

// Read live on every event, so an operator can open one subsystem without a restart.
function threshold(scope: readonly string[]): number {
	for (let i = scope.length; i > 0; i--) {
		const name = scopeVar(scope.slice(0, i));
		const raw = env(name);
		if (raw !== undefined) return LEVELS[parseLevel(raw, name)];
	}
	const raw = env("LOG_LEVEL");
	if (raw !== undefined) return LEVELS[parseLevel(raw, "LOG_LEVEL")];
	return LEVELS[levelSetting ?? "info"];
}

const admits = (scope: readonly string[], level: EventLevel): boolean =>
	LEVELS[level] <= threshold(scope);

function currentFormat(): LogFormat {
	const raw = env("LOG_FORMAT");
	if (raw !== undefined) return parseFormat(raw, "LOG_FORMAT");
	if (formatSetting) return formatSetting;
	if (sink === "node") return runtime.stderr.isTTY ? "human" : "json";
	return sink === "browser" ? "human" : "json";
}

function timeEnabled(): boolean {
	const raw = env("LOG_TIME");
	if (raw === undefined) return timeSetting ?? false;
	if (raw === "1") return true;
	if (raw === "0") return false;
	return panic("unknown LOG_TIME:", raw, "(want 1|0)");
}

function service(): string {
	const named = env("LOG_SERVICE") ?? serviceSetting;
	if (named !== undefined) return named;
	const entry = runtime.entry();
	if (entry === undefined)
		panic(
			"log service unknown: a Worker or browser must set LOG_SERVICE or call setLogService()",
		);
	const base = entry.split(/[\\/]/).pop() ?? "";
	const name = base.replace(/\.[^.]*$/, "") || base;
	assert(name.length > 0, "log service: no name in entry", entry);
	return name;
}

function colorEnabled(): boolean {
	if (runtime.env("NO_COLOR")) return false;
	if (runtime.env("FORCE_COLOR")) return true;
	if (sink === "browser") return true;
	if (sink === "worker") return false;
	return runtime.stderr.isTTY && runtime.env("TERM") !== "dumb";
}

// --- ids and traceparent ---------------------------------------------------

// W3C forbids an all-zero id; at 64 bits a redraw is a formality.
function randomHex(bytes: number): string {
	for (;;) {
		const b = crypto.getRandomValues(new Uint8Array(bytes));
		if (b.some((x) => x !== 0))
			return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	}
}

interface Remote {
	readonly trace: string;
	readonly span: string;
}

const TRACEPARENT_RE =
	/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function parseTraceparent(value: string): Remote | undefined {
	const m = TRACEPARENT_RE.exec(value.trim());
	if (!m) return undefined;
	const [, version, trace, span] = m as unknown as [
		string,
		string,
		string,
		string,
	];
	if (version === "ff" || /^0+$/.test(trace) || /^0+$/.test(span))
		return undefined;
	return { trace, span };
}

// Read once at load: the environment the process started with.
const PROCESS_TRACEPARENT = env("TRACEPARENT");
const PROCESS_PARENT =
	PROCESS_TRACEPARENT === undefined
		? undefined
		: parseTraceparent(PROCESS_TRACEPARENT);
let processTraceparentWarned = false;

// --- field values ----------------------------------------------------------

// A JSON node whose objects are Maps: insertion order is kept for every key,
// which a JS object does not do for integer-like keys ("10" sorts before "2").
type Node = null | boolean | number | string | Node[] | Map<string, Node>;

// Lexicographic by code point, as Go (UTF-8 bytes) and Python sort. JS string
// comparison is by UTF-16 unit, which disagrees once a surrogate meets U+E000..U+FFFF.
const lift = (c: number): number =>
	c >= 0xd800 && c <= 0xdfff ? c + 0x2000 : c >= 0xe000 ? c - 0x800 : c;

function byCodePoint(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return lift(x) - lift(y);
	}
	return a.length - b.length;
}

function sortedObject(
	entries: Iterable<readonly [string, unknown]>,
	ancestors: Set<object>,
): Map<string, Node> {
	const kept = Array.from(entries).filter(([, v]) => v !== undefined);
	kept.sort(([a], [b]) => byCodePoint(a, b));
	return new Map(kept.map(([k, v]) => [k, toNode(v, ancestors)]));
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

const errorType = (e: Error): string => e.constructor.name || e.name;

function typeName(v: unknown): string {
	if (v === null) return "null";
	if (typeof v !== "object") return typeof v;
	return (
		(v as { constructor?: { name?: string } }).constructor?.name || "Object"
	);
}

// type, message, then when present stack, cause, and a SourcedError's
// source, operation, status, context. An error's own keys keep this order.
function errorNode(e: Error, ancestors: Set<object>): Map<string, Node> {
	const node = new Map<string, Node>([
		["type", errorType(e)],
		["message", String(e.message)],
	]);
	if (typeof e.stack === "string") node.set("stack", e.stack);
	if (e.cause !== undefined && e.cause !== null) {
		const cause = e.cause;
		node.set(
			"cause",
			cause instanceof Error
				? toNode(cause, ancestors)
				: new Map<string, Node>([
						["type", typeName(cause)],
						[
							"message",
							typeof cause === "object"
								? encode(toNode(cause, ancestors))
								: String(cause),
						],
					]),
		);
	}
	if (e instanceof SourcedError) {
		node.set("source", e.source);
		node.set("operation", e.operation);
		if (e.status !== undefined) node.set("status", e.status);
		if (Object.keys(e.context).length > 0)
			node.set("context", toNode(e.context, ancestors));
	}
	return node;
}

/** A field value as JSON, by the contract's table. */
function toNode(v: unknown, ancestors: Set<object>): Node {
	if (v === null || typeof v === "string" || typeof v === "boolean") return v;
	if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
	if (typeof v === "bigint") return v.toString();
	if (typeof v !== "object") return String(v);
	if (ancestors.has(v)) return "[circular]";
	if (v instanceof Date)
		return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
	if (v instanceof Uint8Array) return base64(v);
	if (v instanceof ArrayBuffer) return base64(new Uint8Array(v));
	ancestors.add(v);
	try {
		if (v instanceof Error) return errorNode(v, ancestors);
		if (Array.isArray(v))
			return v.map((x) => (x === undefined ? null : toNode(x, ancestors)));
		if (v instanceof Map)
			return sortedObject(
				Array.from(v, ([k, x]) => [String(k), x] as const),
				ancestors,
			);
		if (v instanceof Set)
			return Array.from(v, (x) =>
				x === undefined ? null : toNode(x, ancestors),
			);
		const toJSON = (v as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") return toNode(toJSON.call(v), ancestors);
		return sortedObject(Object.entries(v), ancestors);
	} finally {
		ancestors.delete(v);
	}
}

function encode(n: Node): string {
	if (n === null) return "null";
	if (typeof n === "string" || typeof n === "number") return JSON.stringify(n);
	if (typeof n === "boolean") return n ? "true" : "false";
	if (Array.isArray(n)) return `[${n.map(encode).join(",")}]`;
	const parts: string[] = [];
	for (const [k, v] of n) parts.push(`${JSON.stringify(k)}:${encode(v)}`);
	return `{${parts.join(",")}}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
	if (typeof v !== "object" || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

function assertFields(fields: unknown): asserts fields is Fields | undefined {
	assert(
		fields === undefined || isPlainObject(fields),
		"log fields must be a plain object (message, { key: value }), got",
		typeName(fields),
	);
}

// --- rendering -------------------------------------------------------------

/** An event before rendering: what both renderings read. */
interface Draft {
	readonly verb: LogVerb;
	readonly msg: string;
	readonly scope: readonly string[];
	readonly depth: number;
	readonly phase?: "start" | "end";
	readonly trace?: string;
	readonly span?: string;
	readonly parent?: string;
	readonly status?: "ok" | "error";
	readonly dur?: number;
	readonly fields?: Fields;
	/** human: what the line shows when it differs from fields (a span's end shows what set() added). */
	readonly shows?: Fields;
	/** human: an error a span inside this one already failed with, its stack printed there. */
	readonly printed?: Error;
}

const round3 = (ms: number): number => Math.round(ms * 1000) / 1000;

function json(d: Draft, now: Date): string {
	const level = VERBS[d.verb].level;
	let s = `{"time":"${now.toISOString()}","level":"${level}","verb":"${d.verb}","msg":${JSON.stringify(d.msg)},"service":${JSON.stringify(service())}`;
	if (d.scope.length > 0) s += `,"scope":${encode([...d.scope])}`;
	if (d.phase) s += `,"phase":"${d.phase}"`;
	if (d.trace) s += `,"trace_id":"${d.trace}"`;
	if (d.span) s += `,"span_id":"${d.span}"`;
	if (d.parent) s += `,"parent_id":"${d.parent}"`;
	if (d.status) s += `,"status":"${d.status}"`;
	if (d.dur !== undefined) s += `,"dur_ms":${round3(d.dur)}`;
	if (d.fields) {
		const node = sortedObject(Object.entries(d.fields), new Set());
		if (node.size > 0) s += `,"fields":${encode(node)}`;
	}
	return `${s}}`;
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const quoted = (s: string): string =>
	s === "" || /[\s"=]/.test(s) ? JSON.stringify(s) : s;

const errorLine = (e: Error): string =>
	e instanceof SourcedError
		? `${errorType(e)} [${e.source}:${e.operation}${e.status === undefined ? "" : ` ${e.status}`}]: ${e.message}`
		: `${errorType(e)}: ${e.message}`;

function humanValue(v: unknown): string {
	if (v instanceof Error) return quoted(errorLine(v));
	const node = toNode(v, new Set());
	return typeof node === "string" ? quoted(node) : encode(node);
}

// The stack minus its "Name: message" head (already on the line), then each cause.
function stackLines(e: Error): string[] {
	const lines: string[] = [];
	const seen = new Set<Error>();
	let at: unknown = e;
	while (at instanceof Error && !seen.has(at)) {
		seen.add(at);
		if (at !== e) lines.push(`caused by ${errorLine(at)}`);
		const stack = at.stack ?? "";
		const head = String(at);
		const body = stack.startsWith(head) ? stack.slice(head.length) : stack;
		for (const l of body.split("\n")) if (l.trim()) lines.push(l.trim());
		at = at.cause;
	}
	return lines;
}

function human(d: Draft, now: Date, clock: boolean): string {
	const v = VERBS[d.verb];
	const color = colorEnabled();
	const paint = (style: string, s: string): string =>
		color && style ? `${style}${s}${RESET}` : s;
	const pad = "  ".repeat(d.depth);
	const stamp = clock ? `${paint(DIM, now.toTimeString().slice(0, 8))} ` : "";
	const scope =
		d.scope.length > 0 ? `${paint(DIM, `[${d.scope.join(" ")}]`)} ` : "";
	const dur = d.dur === undefined ? "" : ` ${paint(DIM, humanDuration(d.dur))}`;
	const pairs = Object.entries(d.shows ?? d.fields ?? {})
		.filter(([, x]) => x !== undefined)
		.sort(([a], [b]) => byCodePoint(a, b));
	const tail =
		pairs.length > 0
			? ` ${paint(DIM, pairs.map(([k, x]) => `${k}=${humanValue(x)}`).join(" "))}`
			: "";
	const head = `${stamp}${pad}${v.indent} ${paint(v.style, v.symbol)} ${scope}${d.msg}${dur}${tail}`;
	// A stack prints once: an error passed up from an inner span shows its message only.
	const stacks = pairs.flatMap(([, x]) =>
		x instanceof Error && x !== d.printed
			? stackLines(x).map((l) => paint(DIM, `${pad}    ${l}`))
			: [],
	);
	return [head, ...stacks].join("\n");
}

type ConsoleMethod = "error" | "warn" | "info" | "debug";

const CONSOLE_METHOD: Record<EventLevel, ConsoleMethod> = {
	error: "error",
	warn: "warn",
	info: "info",
	debug: "debug",
	trace: "debug",
};

// The caller has already decided the event passes its threshold.
function emit(d: Draft): void {
	const now = new Date();
	// Every knob is read on every event, so a bad value screams whichever rendering is on.
	const format = currentFormat();
	const clock = timeEnabled();
	const text = format === "json" ? json(d, now) : human(d, now, clock);
	// Node: everything to stderr through console.error, which cli/live patches
	// to keep lines above an active region. Elsewhere the level's method, so
	// platform consoles classify the line.
	if (sink === "node") console.error(text);
	else console[CONSOLE_METHOD[VERBS[d.verb].level]](text);
}

// --- loggers and spans -----------------------------------------------------

/** Where a logger writes: its scope, and the span its lines and child spans belong to. */
interface Ctx {
	readonly scope: readonly string[];
	/** Shown spans enclosing: the human indent. */
	readonly depth: number;
	/** The trace new spans join; undefined at the root (a new trace, or TRACEPARENT's). */
	readonly trace: string | undefined;
	/** The span id new spans name as parent_id: the nearest shown span, or a joined remote one. */
	readonly parent: string | undefined;
	/**
	 * The shown span lines belong to, local or joined remote. undefined outside
	 * any span, and on a joined logger itself: only spans join, lines do not.
	 */
	readonly owner: string | undefined;
	/**
	 * Errors spans inside the enclosing local span failed with, their stacks
	 * already printed. undefined outside any local span.
	 */
	readonly caught: Set<Error> | undefined;
}

export interface Logger {
	error(message: string, fields?: Fields): void;
	fail(message: string, fields?: Fields): void;
	warn(message: string, fields?: Fields): void;
	/** warn, once per message and scope for the process. */
	warnOnce(message: string, fields?: Fields): void;
	info(message: string, fields?: Fields): void;
	success(message: string, fields?: Fields): void;
	wait(message: string, fields?: Fields): void;
	ready(message: string, fields?: Fields): void;
	/** An indented sub-step. */
	step(message: string, fields?: Fields): void;
	debug(message: string, fields?: Fields): void;
	trace(message: string, fields?: Fields): void;
	/** A child logger: events carry the scope, its level reads {SCOPE}_LOG_LEVEL first. */
	scope(name: string): Logger;
	/**
	 * Run fn inside a span and return what it returns (a Promise when fn is
	 * async). A throw or rejection ends the span failed and is rethrown.
	 */
	span<T>(name: string, fn: (s: Span) => T): T;
	span<T>(name: string, fields: Fields, fn: (s: Span) => T): T;
	/** Open a span by hand, for work that does not fit a block. End it once with end(). */
	begin(name: string, fields?: Fields): Span;
	/**
	 * A logger whose spans are children of a remote span. null/undefined
	 * returns this logger; a malformed value is ignored with one warn.
	 */
	join(traceparent: string | null | undefined): Logger;
}

export interface Span extends Logger {
	/** Fields learned while the span runs, carried on its end event. */
	set(fields: Fields): void;
	/** The W3C traceparent value to hand to a child process or request. */
	traceparent(): string;
	/** End the span: ok with no error, failed with one (in fields.err). Twice panics. */
	end(err?: unknown): void;
}

const BOUND = 1024;
const warned = new Set<string>();
const badTraceparents = new Set<string>();

function line(ctx: Ctx, verb: LogVerb, message: string, fields: unknown): void {
	assert(
		typeof message === "string",
		"log message must be a string, got",
		typeName(message),
	);
	assertFields(fields);
	if (!admits(ctx.scope, VERBS[verb].level)) return;
	emit({
		verb,
		msg: message,
		scope: ctx.scope,
		depth: ctx.depth,
		trace: ctx.owner === undefined ? undefined : ctx.trace,
		span: ctx.owner,
		fields,
	});
}

function open(ctx: Ctx, name: string, initial: Fields | undefined): Span {
	assert(
		typeof name === "string" && name.length > 0,
		"span name must be a non-empty string, got",
		typeName(name),
	);
	assertFields(initial);
	let remote: Remote | undefined;
	if (ctx.trace === undefined) {
		remote = PROCESS_PARENT;
		if (
			PROCESS_TRACEPARENT !== undefined &&
			!remote &&
			!processTraceparentWarned
		) {
			processTraceparentWarned = true;
			line(ctx, "warn", "malformed TRACEPARENT ignored", {
				traceparent: PROCESS_TRACEPARENT,
			});
		}
	}
	const trace = ctx.trace ?? remote?.trace ?? randomHex(16);
	const parent = ctx.trace === undefined ? remote?.span : ctx.parent;
	const id = randomHex(8);
	// Decided once, here: the start's level against the scope's threshold now.
	const shown = admits(ctx.scope, "info");
	const began = performance.now();
	const fields: Fields = { ...initial };
	let added: Fields = {};
	let ended = false;

	if (shown)
		emit({
			verb: "wait",
			msg: name,
			scope: ctx.scope,
			depth: ctx.depth,
			phase: "start",
			trace,
			span: id,
			parent,
			fields,
		});

	// A hidden span is transparent: its lines and children attach to the nearest
	// shown span, a joined remote one included (it is shown in its own process's
	// stream). With none, its lines carry no ids, as lines outside any span.
	const caught = new Set<Error>();
	const inner: Ctx = shown
		? {
				scope: ctx.scope,
				depth: ctx.depth + 1,
				trace,
				parent: id,
				owner: id,
				caught,
			}
		: {
				scope: ctx.scope,
				depth: ctx.depth,
				trace,
				parent,
				owner: parent,
				caught,
			};

	return Object.assign(makeLogger(inner), {
		set(more: Fields): void {
			assert(!ended, "span", name, "got set() after it ended");
			assertFields(more);
			added = { ...added, ...more };
		},
		// A hidden span hands on the nearest shown span (local or joined), its own id only with none.
		traceparent(): string {
			return `00-${trace}-${shown ? id : (parent ?? id)}-01`;
		},
		end(err?: unknown): void {
			assert(!ended, "span", name, "ended twice");
			ended = true;
			const dur = performance.now() - began;
			const failed = err !== undefined && err !== null;
			const printed = err instanceof Error && caught.has(err) ? err : undefined;
			// What spans inside this one printed stays printed for the spans around it.
			for (const e of caught) ctx.caught?.add(e);
			if (!shown) {
				// The end follows the decision made at begin: no end without its
				// start. A failure is never lost to it: one line of the nearest
				// shown span says the span failed.
				if (!failed || !admits(ctx.scope, "error")) return;
				if (err instanceof Error) ctx.caught?.add(err);
				emit({
					verb: "fail",
					msg: name,
					scope: ctx.scope,
					depth: inner.depth,
					trace: inner.owner === undefined ? undefined : trace,
					span: inner.owner,
					fields: { ...fields, ...added, err, dur_ms: round3(dur) },
					printed,
				});
				return;
			}
			if (failed && err instanceof Error) ctx.caught?.add(err);
			const shows: Fields = failed ? { ...added, err } : added;
			emit({
				verb: failed ? "fail" : "success",
				msg: name,
				scope: ctx.scope,
				depth: ctx.depth,
				phase: "end",
				trace,
				span: id,
				parent,
				status: failed ? "error" : "ok",
				dur,
				fields: { ...fields, ...shows },
				shows,
				printed,
			});
		},
	});
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	typeof (v as { then?: unknown } | null)?.then === "function";

function makeLogger(ctx: Ctx): Logger {
	const verb =
		(v: LogVerb) =>
		(message: string, fields?: Fields): void =>
			line(ctx, v, message, fields);

	function span<T>(name: string, fn: (s: Span) => T): T;
	function span<T>(name: string, fields: Fields, fn: (s: Span) => T): T;
	function span<T>(
		name: string,
		a: Fields | ((s: Span) => T),
		b?: (s: Span) => T,
	): T {
		const fn = typeof a === "function" ? a : b;
		const fields = typeof a === "function" ? undefined : a;
		assert(typeof fn === "function", "span", name, "needs a function");
		const s = open(ctx, name, fields);
		// end(null) means ok; a block that threw null still failed.
		const failed = (e: unknown): unknown => e ?? String(e);
		let result: T;
		try {
			result = fn(s);
		} catch (e) {
			s.end(failed(e));
			throw e;
		}
		if (!isThenable(result)) {
			s.end();
			return result;
		}
		return Promise.resolve(result).then(
			(v) => {
				s.end();
				return v;
			},
			(e: unknown) => {
				s.end(failed(e));
				throw e;
			},
		) as unknown as T;
	}

	const logger: Logger = {
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

		warnOnce(message: string, fields?: Fields): void {
			const key = `${ctx.scope.join("\0")}\0${message}`;
			if (warned.has(key)) return;
			if (warned.size >= BOUND) warned.clear();
			warned.add(key);
			line(ctx, "warn", message, fields);
		},

		scope(name: string): Logger {
			assert(
				typeof name === "string" && name.length > 0,
				"scope name must be a non-empty string, got",
				typeName(name),
			);
			return makeLogger({ ...ctx, scope: [...ctx.scope, name] });
		},

		span,

		begin(name: string, fields?: Fields): Span {
			return open(ctx, name, fields);
		},

		join(traceparent: string | null | undefined): Logger {
			if (traceparent === null || traceparent === undefined) return logger;
			const remote =
				typeof traceparent === "string"
					? parseTraceparent(traceparent)
					: undefined;
			if (!remote) {
				// Input from outside: one warn per distinct value, memory bounded.
				const value = String(traceparent);
				if (!badTraceparents.has(value)) {
					if (badTraceparents.size >= BOUND) badTraceparents.clear();
					badTraceparents.add(value);
					line(ctx, "warn", "malformed traceparent ignored", {
						traceparent: value,
					});
				}
				return logger;
			}
			return makeLogger({
				scope: ctx.scope,
				depth: ctx.depth,
				trace: remote.trace,
				parent: remote.span,
				owner: undefined,
				caught: ctx.caught,
			});
		},
	};
	return logger;
}

/** The root logger. */
export const log: Logger = makeLogger({
	scope: [],
	depth: 0,
	trace: undefined,
	parent: undefined,
	owner: undefined,
	caught: undefined,
});

// --- reading the stream ----------------------------------------------------

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/**
 * One line of a stream as an event, or null for a line that is not one (a
 * runtime panic, a library writing to stderr itself) so a viewer can pass it
 * through. A JSON object with a "verb" key claims to be an event: if it
 * breaks the contract's shape, that is a bug in a writer and it panics.
 */
export function parseEvent(text: string): LogEvent | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return null;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isPlainObject(value) || !Object.hasOwn(value, "verb")) return null;
	const e = value;
	const bad = (why: string): never =>
		panic("malformed log event:", why, "in", trimmed);
	const has = (k: string): boolean => Object.hasOwn(e, k);

	const keys = Object.keys(e);
	for (const k of keys)
		if (!(EVENT_KEYS as readonly string[]).includes(k))
			bad(`unknown key "${k}"`);
	const order = EVENT_KEYS.filter(has);
	if (keys.join() !== order.join()) bad(`keys out of order: ${keys.join(",")}`);

	for (const k of ["time", "level", "verb", "msg", "service"])
		if (!has(k)) bad(`missing "${k}"`);
	if (typeof e.time !== "string" || !TIME_RE.test(e.time)) bad("time");
	if (typeof e.verb !== "string" || !isVerb(e.verb)) bad("verb");
	const verb = e.verb as LogVerb;
	if (e.level !== VERBS[verb].level) bad(`level of verb ${verb}`);
	if (typeof e.msg !== "string") bad("msg");
	if (typeof e.service !== "string" || e.service.length === 0) bad("service");
	if (
		has("scope") &&
		!(
			Array.isArray(e.scope) &&
			e.scope.length > 0 &&
			e.scope.every((s) => typeof s === "string")
		)
	)
		bad("scope");
	if (
		has("trace_id") &&
		!(typeof e.trace_id === "string" && HEX32.test(e.trace_id))
	)
		bad("trace_id");
	for (const k of ["span_id", "parent_id"])
		if (has(k) && !(typeof e[k] === "string" && HEX16.test(e[k] as string)))
			bad(k);
	if (has("fields") && !isPlainObject(e.fields)) bad("fields");
	if (has("span_id") && !has("trace_id")) bad("span_id without trace_id");
	if (has("parent_id") && !has("phase")) bad("parent_id without phase");

	if (has("phase")) {
		if (e.phase !== "start" && e.phase !== "end") bad("phase");
		if (!has("trace_id") || !has("span_id")) bad("span event without ids");
	}
	if (e.phase === "start") {
		if (verb !== "wait") bad("start verb");
		if (has("status") || has("dur_ms")) bad("start with status or dur_ms");
	}
	if (e.phase === "end") {
		if (e.status !== "ok" && e.status !== "error") bad("status");
		if (typeof e.dur_ms !== "number" || !(e.dur_ms >= 0)) bad("dur_ms");
		if (verb !== (e.status === "ok" ? "success" : "fail")) bad("end verb");
	} else if (has("status") || has("dur_ms"))
		bad("status or dur_ms outside an end");
	return e as unknown as LogEvent;
}
