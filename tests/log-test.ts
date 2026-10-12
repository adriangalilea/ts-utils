/**
 * Logger contract test. The event stream is shared byte for byte with
 * go-utils and py-utils (contract: github.com/adriangalilea/utils), so the
 * exact lines asserted here are the contract: key order, sorting, error
 * shape, span ids and parentage, the filtered-span rule, trace joining,
 * level resolution, and the human rendering of a span.
 *
 * Run: pnpm test:log
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, Panic, SourcedError, unwrap } from "../src/offensive.js";
import { runtime } from "../src/runtime.js";
import {
	type LogEvent,
	type Logger,
	log,
	parseEvent,
	setLogFormat,
	setLogLevel,
	setLogService,
	setLogTime,
} from "../src/universal/log.js";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const REMOTE_TRACE = "0af7651916cd43dd8448eb211c80319c";
const REMOTE_SPAN = "b7ad6b7169203331";

// --- child mode: a process started with TRACEPARENT (spawned below) ---------
if (process.env.LOG_TEST_CHILD) {
	log.info("before any span");
	log.span("first", (s) => s.info("inside"));
	log.span("second", () => {});
	process.exit(0);
}

// --- capture -----------------------------------------------------------------

const lines: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]): void => {
	assert(a.length === 1 && typeof a[0] === "string", "one string per event");
	lines.push(a[0]);
};
const take = (): string[] => lines.splice(0);
const events = (): LogEvent[] => take().map((l) => unwrap(parseEvent(l)));
const one = (): string => {
	const t = take();
	assert(t.length === 1, "expected one line, got", t.length, t.join("\n"));
	return unwrap(t[0]);
};
const untimed = (line: string): string =>
	line.replace(/^\{"time":"[^"]+"/, '{"time":"T"');
const expectLine = (want: string): void => {
	const got = untimed(one());
	assert(got === want, `line mismatch:\n  got  ${got}\n  want ${want}`);
};
const panics = (fn: () => unknown): boolean => {
	try {
		fn();
	} catch (e) {
		return e instanceof Panic;
	}
	return false;
};
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;

for (const k of ["LOG_LEVEL", "LOG_FORMAT", "LOG_TIME", "LOG_SERVICE"])
	runtime.deleteEnv(k);
runtime.setEnv("NO_COLOR", "1");
setLogFormat("json");
setLogService("svc");

// --- json: shape and key order -------------------------------------------------

log.info("ready");
expectLine(
	'{"time":"T","level":"info","verb":"info","msg":"ready","service":"svc"}',
);

log.scope("payments").warn("retrying", { attempt: 2 });
expectLine(
	'{"time":"T","level":"warn","verb":"warn","msg":"retrying","service":"svc","scope":["payments"],"fields":{"attempt":2}}',
);
log.info("t");
assert(
	/^\{"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",/.test(one()),
	"time is RFC3339 with milliseconds, UTC",
);

// Verbs print at fixed levels.
log.fail("deploy died");
expectLine(
	'{"time":"T","level":"error","verb":"fail","msg":"deploy died","service":"svc"}',
);
log.step("resolving");
expectLine(
	'{"time":"T","level":"info","verb":"step","msg":"resolving","service":"svc"}',
);

// An empty fields object has no value: the key is absent.
log.info("bare", {});
expectLine(
	'{"time":"T","level":"info","verb":"info","msg":"bare","service":"svc"}',
);

// One event is one line, whatever the message holds.
log.info("two\nlines");
expectLine(
	'{"time":"T","level":"info","verb":"info","msg":"two\\nlines","service":"svc"}',
);

// --- fields: sorted at every depth, by code point --------------------------------

log.info("sorted", {
	b: 1,
	"10": 1,
	"2": 1,
	a: { d: 1, c: 2 },
	"\u{1F600}": 1,
	"�": 1,
	é: 1,
});
expectLine(
	'{"time":"T","level":"info","verb":"info","msg":"sorted","service":"svc","fields":{"10":1,"2":1,"a":{"c":2,"d":1},"b":1,"é":1,"�":1,"\u{1F600}":1}}',
);

// --- field values by the contract's table --------------------------------------

const circ: Record<string, unknown> = { name: "c" };
circ.self = circ;
const shared = { k: 1 };
log.info("values", {
	nan: Number.NaN,
	inf: Number.POSITIVE_INFINITY,
	ninf: Number.NEGATIVE_INFINITY,
	big: 10n ** 20n,
	at: new Date(0),
	bytes: new Uint8Array([104, 105]),
	map: new Map<unknown, number>([
		["z", 1],
		[7, 2],
	]),
	set: new Set([1, 2]),
	undef: undefined,
	arr: [undefined, 1, null, "s", false],
	circ,
	twice: [shared, shared],
	url: new URL("https://a.com/x"),
	sym: Symbol("s"),
	buf: new Uint8Array([0, 255]).buffer,
	nums: [2.0, 1e-7, -0, 1e21, 0.1],
});
expectLine(
	'{"time":"T","level":"info","verb":"info","msg":"values","service":"svc","fields":{"arr":[null,1,null,"s",false],"at":"1970-01-01T00:00:00.000Z","big":"100000000000000000000","buf":"AP8=","bytes":"aGk=","circ":{"name":"c","self":"[circular]"},"inf":"Infinity","map":{"7":2,"z":1},"nan":"NaN","ninf":"-Infinity","nums":[2,1e-7,0,1e+21,0.1],"set":[1,2],"sym":"Symbol(s)","twice":[{"k":1},{"k":1}],"url":"https://a.com/x"}}',
);

// --- errors: fixed key order, causes, SourcedError ------------------------------

const cause = new Error("socket closed");
const sourced = new SourcedError({
	source: "stripe",
	operation: "charge",
	message: "declined",
	status: 402,
	cause,
	context: { b: 1, a: { y: 1, x: 2 } },
});
log.scope("stripe").error("charge failed", { err: sourced });
{
	const raw = one();
	const e = JSON.parse(raw).fields.err;
	assert(
		Object.keys(e).join() ===
			"type,message,stack,cause,source,operation,status,context",
		"error keys out of order:",
		Object.keys(e).join(),
	);
	assert(e.type === "SourcedError", "type is the class name, got", e.type);
	assert(e.message === "declined", "the message as given, got", e.message);
	assert(typeof e.stack === "string" && e.stack.includes("at "), "stack kept");
	assert(
		Object.keys(e.cause).join() === "type,message,stack" &&
			e.cause.type === "Error" &&
			e.cause.message === "socket closed",
		"cause serialized as an error",
	);
	assert(e.status === 402 && e.source === "stripe" && e.operation === "charge");
	assert(
		raw.includes('"context":{"a":{"x":2,"y":1},"b":1}'),
		"context sorted at every depth",
	);
	unwrap(parseEvent(raw));
}

// status and context appear only with a value.
log.error("lookup failed", {
	err: new SourcedError({ source: "db", operation: "get", message: "gone" }),
});
{
	const e = JSON.parse(one()).fields.err;
	assert(
		Object.keys(e).join() === "type,message,stack,source,operation",
		"bare SourcedError keys:",
		Object.keys(e).join(),
	);
}

// A subclass reports its class; a non-error cause becomes {type, message}.
class Timeout extends Error {}
log.error("slow", { err: new Timeout("5s", { cause: "upstream" }) });
{
	const e = JSON.parse(one()).fields.err;
	assert(e.type === "Timeout", "subclass name, got", e.type);
	assert(
		JSON.stringify(e.cause) === '{"type":"string","message":"upstream"}',
		"non-error cause:",
		JSON.stringify(e.cause),
	);
}

// --- spans: nesting, ids, set, return values -----------------------------------

const syncResult = await log.span("sync", { repo: "ui" }, async (s) => {
	s.info("cloned", { files: 3 });
	await s.span("build", async (c) => {
		c.warn("slow step", { ms: 1200 });
	});
	s.set({ pushed: true });
	return "done";
});
assert(syncResult === "done", "span returns what fn returns");
{
	const all = events();
	assert(all.length === 6, "sync writes six events, got", all.length);
	const [start, line, bStart, bLine, bEnd, end] = all as [
		LogEvent,
		LogEvent,
		LogEvent,
		LogEvent,
		LogEvent,
		LogEvent,
	];
	assert(
		start.phase === "start" && start.verb === "wait" && start.msg === "sync",
	);
	assert(HEX32.test(start.trace_id) && HEX16.test(start.span_id));
	assert(start.parent_id === undefined, "a root span has no parent");
	assert(JSON.stringify(start.fields) === '{"repo":"ui"}');
	assert(
		line.phase === undefined &&
			line.trace_id === start.trace_id &&
			line.span_id === start.span_id,
		"a line written through the span carries its ids",
	);
	assert(bStart.phase === "start" && bStart.parent_id === start.span_id);
	assert(
		bStart.trace_id === start.trace_id && bStart.span_id !== start.span_id,
	);
	assert(bLine.span_id === bStart.span_id);
	assert(
		bEnd.phase === "end" && bEnd.status === "ok" && bEnd.verb === "success",
	);
	assert(bEnd.parent_id === start.span_id && bEnd.fields === undefined);
	assert(end.phase === "end" && end.span_id === start.span_id);
	assert(
		JSON.stringify(end.fields) === '{"pushed":true,"repo":"ui"}',
		"end carries the span's fields with what set() added",
	);
	assert(
		typeof end.dur_ms === "number" &&
			end.dur_ms >= 0 &&
			Math.round(end.dur_ms * 1000) / 1000 === end.dur_ms,
		"dur_ms rounded to 3 decimals",
	);
}

// A sync span returns synchronously.
const n: number = log.span("calc", () => 42);
assert(n === 42, "sync span returns its value");
assert(events().length === 2);

// Lines outside a span carry no ids.
log.info("outside");
assert(untimed(one()).includes('"service":"svc"}'), "no trace ids outside");

// --- failed spans ---------------------------------------------------------------

const boom = new Error("boom");
let caught: unknown;
try {
	await log.span("deploy", async () => {
		throw boom;
	});
} catch (e) {
	caught = e;
}
assert(caught === boom, "an async span rethrows the same error");
{
	const [start, end] = events();
	assert(start?.phase === "start" && end?.phase === "end");
	assert(
		end.status === "error" && end.verb === "fail" && end.level === "error",
	);
	const err = (end.fields as { err: { type: string; message: string } }).err;
	assert(err.type === "Error" && err.message === "boom", "error in fields.err");
}
caught = undefined;
try {
	log.span("parse", { file: "a.json" }, () => {
		throw boom;
	});
} catch (e) {
	caught = e;
}
assert(caught === boom, "a sync span rethrows the same error");
{
	const end = events()[1];
	assert(end?.phase === "end" && end.status === "error");
	assert(Object.keys(end.fields ?? {}).join() === "err,file");
}
// A block that throws a nullish value still failed.
try {
	log.span("nullish", () => {
		throw null;
	});
} catch {}
assert(events()[1]?.status === "error", "throw null ends the span failed");

// --- begin / end: the open form --------------------------------------------------

{
	const up = log.begin("upload", { size: 3 });
	up.info("chunk", { n: 1 });
	const part = up.begin("part");
	part.end();
	up.set({ etag: "x" });
	up.end();
	const [start, chunk, pStart, pEnd, end] = events();
	assert(start?.phase === "start" && chunk?.span_id === start.span_id);
	assert(pStart?.parent_id === start.span_id && pEnd?.phase === "end");
	assert(end?.phase === "end" && end.status === "ok");
	assert(JSON.stringify(end.fields) === '{"etag":"x","size":3}');
	assert(
		panics(() => up.end()),
		"ending twice panics",
	);
	assert(
		panics(() => up.set({ late: 1 })),
		"set() after the end panics",
	);

	const down = log.begin("download");
	down.end(new Error("reset"));
	const failed = events()[1];
	assert(
		failed?.phase === "end" && failed.status === "error",
		"end(err) fails",
	);
	const cb = log.begin("callback");
	cb.end(null);
	assert(events()[1]?.status === "ok", "end(null) is a callback's no-error");
}

// --- filtered spans: what they hold attaches to the nearest shown span ----------

runtime.setEnv("QUIET_LOG_LEVEL", "warn");
runtime.setEnv("QUIET_LOUD_LOG_LEVEL", "info");
log.span("outer", (o) => {
	o.scope("quiet").span("mid", (m) => {
		m.warn("inside mid");
		m.info("hidden");
		m.scope("loud").span("inner", (i) => i.info("in inner"));
	});
});
{
	const [oStart, warn, iStart, iLine, iEnd, oEnd, ...rest] = events();
	assert(rest.length === 0, "mid's own events are filtered out");
	assert(oStart?.phase === "start" && oStart.msg === "outer");
	assert(
		warn?.msg === "inside mid" &&
			warn.span_id === oStart.span_id &&
			warn.trace_id === oStart.trace_id,
		"a filtered span's lines carry the nearest shown span's id",
	);
	assert(
		iStart?.phase === "start" && iStart.parent_id === oStart.span_id,
		"a filtered span's child names the nearest shown span as parent",
	);
	assert(iLine?.span_id === iStart.span_id && iEnd?.phase === "end");
	assert(oEnd?.phase === "end" && oEnd.span_id === oStart.span_id);
}
// Visibility is decided at begin: a hidden span writes no end, even failed,
// and its traceparent hands on the nearest shown span.
let midTraceparent = "";
let outerTraceparent = "";
try {
	log.span("outer", (o) => {
		outerTraceparent = o.traceparent();
		o.scope("quiet").span("mid", (m) => {
			midTraceparent = m.traceparent();
			throw boom;
		});
	});
} catch {}
{
	const [oStart, oEnd, ...rest] = events();
	assert(rest.length === 0, "a hidden span that fails writes no end");
	assert(oStart?.phase === "start" && oEnd?.phase === "end");
	assert(oEnd.status === "error");
	assert(
		midTraceparent === outerTraceparent,
		"hidden span hands on its shown ancestor",
	);
}
// A span shown at begin writes its end even if the threshold rises meanwhile.
log.span("long", () => runtime.setEnv("LOG_LEVEL", "error"));
assert(
	events()
		.map((e) => e.phase)
		.join() === "start,end",
	"end follows begin",
);
// Hidden with no shown ancestor: its own id; hidden under a join: the remote span.
let hiddenTraceparent = "";
log.span("hidden", (h) => {
	hiddenTraceparent = h.traceparent();
	h.error("in a hidden root");
	h.span("hidden child", (c) => c.error("in its hidden child"));
});
log.join(TRACEPARENT).span("hidden", (h) => {
	assert(
		h.traceparent() === TRACEPARENT,
		"hidden joined span hands on the remote",
	);
	h.error("in a hidden joined span");
});
runtime.deleteEnv("LOG_LEVEL");
{
	// Lines in a hidden span with no shown ancestor carry no ids, as lines
	// outside any span never do.
	const shown = events();
	assert(
		shown.map((e) => e.msg).join("|") ===
			"in a hidden root|in its hidden child|in a hidden joined span",
		"hidden spans write only their lines, got",
		shown.map((e) => e.msg).join("|"),
	);
	for (const e of shown)
		assert(
			e.phase === undefined &&
				e.trace_id === undefined &&
				e.span_id === undefined &&
				!untimed(JSON.stringify(e)).includes("_id"),
			"a line in a hidden span with no shown ancestor carries no ids:",
			JSON.stringify(e),
		);
}
assert(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(hiddenTraceparent));
runtime.deleteEnv("QUIET_LOG_LEVEL");
runtime.deleteEnv("QUIET_LOUD_LOG_LEVEL");

// --- join and traceparent -----------------------------------------------------------

assert(
	log.join(undefined) === log && log.join(null) === log,
	"absent joins nothing",
);
{
	const joined = log.join(TRACEPARENT);
	joined.info("not in a span");
	let handedOn = "";
	joined.span("handled", (s) => {
		s.info("in it");
		handedOn = s.traceparent();
	});
	const [outside, start, line, end] = events();
	assert(
		outside?.trace_id === undefined,
		"a joined logger's lines are outside spans",
	);
	assert(start?.phase === "start" && start.trace_id === REMOTE_TRACE);
	assert(
		start.parent_id === REMOTE_SPAN,
		"joined root span names the remote parent",
	);
	assert(line?.span_id === start.span_id && line.trace_id === REMOTE_TRACE);
	assert(end?.parent_id === REMOTE_SPAN);
	assert(handedOn === `00-${REMOTE_TRACE}-${start.span_id}-01`, handedOn);
}
for (const bad of [
	"garbage",
	"00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01",
	"00-00000000000000000000000000000000-b7ad6b7169203331-01",
	"ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
]) {
	assert(log.join(bad) === log, "a malformed traceparent returns the logger");
	assert(log.join(bad) === log);
	const [warn, ...rest] = events();
	assert(
		rest.length === 0 && warn?.verb === "warn",
		"one warn per distinct value",
	);
	assert(JSON.stringify(warn.fields) === JSON.stringify({ traceparent: bad }));
}

// TRACEPARENT at process start: every root span joins it.
const child = (env: Record<string, string>): LogEvent[] => {
	const { LOG_SERVICE: _, ...inherited } = process.env;
	const r = spawnSync(
		process.execPath,
		[...process.execArgv, fileURLToPath(import.meta.url)],
		{
			env: { ...inherited, LOG_TEST_CHILD: "1", LOG_FORMAT: "json", ...env },
			encoding: "utf8",
		},
	);
	assert(r.status === 0, "child failed:", r.stderr);
	return r.stderr
		.trim()
		.split("\n")
		.map((l) => unwrap(parseEvent(l), "child line is not an event:", l));
};
{
	const [before, fStart, fLine, fEnd, sStart, sEnd, ...rest] = child({
		TRACEPARENT,
		LOG_SERVICE: "child",
	});
	assert(rest.length === 0 && before?.trace_id === undefined);
	assert(before.service === "child", "LOG_SERVICE names the service");
	for (const s of [fStart, fEnd, sStart, sEnd]) {
		assert(s?.trace_id === REMOTE_TRACE, "root span in TRACEPARENT's trace");
		assert(s.parent_id === REMOTE_SPAN, "root span under TRACEPARENT's span");
	}
	assert(fLine?.span_id === fStart?.span_id && fLine.parent_id === undefined);
}
{
	const [before, warn, ...rest] = child({ TRACEPARENT: "nonsense" });
	assert(
		before?.msg === "before any span",
		"lines outside spans are unaffected",
	);
	assert(
		warn?.verb === "warn" && warn.msg === "malformed TRACEPARENT ignored",
		"a malformed TRACEPARENT warns at the first root span",
	);
	assert(
		warn.service === "log-test",
		"service defaults to the entry script's name",
	);
	const spans = rest.filter((e) => e.phase !== undefined);
	assert(rest.length === 5, "two spans and a line, got", rest.length);
	assert(
		spans.every((e) => e.parent_id === undefined),
		"new traces, no parent",
	);
	assert(
		rest.filter((e) => e.verb === "warn").length === 0,
		"warned only once",
	);
}

// --- level resolution: scope vars, LOG_LEVEL, setLogLevel, info ----------------

const shows = (logger: Logger): boolean => {
	logger.debug("probe");
	return take().length === 1;
};
const api = log.scope("api");
const auth = api.scope("auth");
assert(!shows(log), "default is info");
setLogLevel("debug");
assert(shows(log) && shows(auth), "setLogLevel is the program's default");
runtime.setEnv("LOG_LEVEL", "info");
assert(!shows(log) && !shows(auth), "LOG_LEVEL beats setLogLevel");
runtime.setEnv("API_LOG_LEVEL", "DEBUG");
assert(
	shows(api) && shows(auth) && !shows(log),
	"API_LOG_LEVEL opens the scope",
);
runtime.setEnv("API_AUTH_LOG_LEVEL", "error");
assert(shows(api) && !shows(auth), "the most specific scope var wins");
auth.warn("w");
auth.error("e");
assert(take().length === 1, "API_AUTH_LOG_LEVEL=error filters warn");
runtime.setEnv("API_AUTH_LOG_LEVEL", "silent");
auth.error("e");
assert(take().length === 0, "silent silences error");
runtime.setEnv("API_AUTH_LOG_LEVEL", "");
assert(shows(auth), "an empty variable is unset");
runtime.setEnv("API_LOG_LEVEL", "loud");
assert(
	panics(() => api.info("x")),
	"an unknown scope level panics",
);
for (const k of ["LOG_LEVEL", "API_LOG_LEVEL", "API_AUTH_LOG_LEVEL"])
	runtime.deleteEnv(k);
setLogLevel("info");

// --- warnOnce: once per message and scope ----------------------------------------

log.warnOnce("deprecated key");
log.warnOnce("deprecated key");
log.scope("a").warnOnce("deprecated key");
assert(take().length === 2, "warnOnce fires once per message and scope");

// --- service ----------------------------------------------------------------------

runtime.setEnv("LOG_SERVICE", "from-env");
log.info("s");
assert(
	unwrap(parseEvent(one())).service === "from-env",
	"LOG_SERVICE beats the setter",
);
runtime.deleteEnv("LOG_SERVICE");

// --- the environment wins over every setter, values match without case ------------

setLogFormat("HUMAN" as never);
runtime.setEnv("LOG_FORMAT", "Json");
log.info("f");
assert(one().startsWith('{"time":'), "LOG_FORMAT beats setLogFormat, any case");
runtime.deleteEnv("LOG_FORMAT");
log.info("f");
assert(
	one() === "   f",
	"setLogFormat is the default once LOG_FORMAT is unset",
);
setLogTime(true);
runtime.setEnv("LOG_TIME", "0");
log.info("t");
assert(one() === "   t", "LOG_TIME beats setLogTime");
runtime.deleteEnv("LOG_TIME");
setLogTime(false);
setLogFormat("json");

// --- unknown values scream ---------------------------------------------------------

assert(
	panics(() => setLogLevel("verbose" as never)),
	"unknown level",
);
assert(
	panics(() => setLogFormat("record" as never)),
	"unknown format",
);
assert(
	panics(() => setLogTime("yes" as never)),
	"setLogTime wants a boolean",
);
assert(
	panics(() => setLogService("")),
	"empty service",
);
runtime.setEnv("LOG_FORMAT", "record");
assert(
	panics(() => log.info("x")),
	"LOG_FORMAT=record is gone",
);
runtime.setEnv("LOG_FORMAT", "json");
runtime.setEnv("LOG_TIME", "yes");
assert(
	panics(() => log.info("x")),
	"unknown LOG_TIME panics in json too",
);
runtime.deleteEnv("LOG_TIME");
runtime.deleteEnv("LOG_FORMAT");
assert(
	panics(() => log.info("x", new Error("e") as never)),
	"an Error is not fields",
);
assert(
	panics(() => log.info("x", "detail" as never)),
	"a string is not fields",
);
assert(
	panics(() => log.info(42 as never)),
	"a message is a string",
);
assert(
	panics(() => log.span("x", 1 as never)),
	"a span needs a function",
);
assert(
	panics(() => log.scope("")),
	"a scope has a name",
);
take();

// --- parseEvent ------------------------------------------------------------------

assert(
	parseEvent("panic: runtime error") === null,
	"plain text passes through",
);
assert(
	parseEvent('{"level":30,"msg":"pino"}') === null,
	"foreign JSON passes through",
);
assert(parseEvent("{truncated") === null, "broken JSON passes through");
assert(parseEvent("[1,2]") === null);
const valid =
	'{"time":"2026-10-12T12:20:39.123Z","level":"warn","verb":"warn","msg":"m","service":"s"}';
assert(
	unwrap(parseEvent(`${valid}\n`)).msg === "m",
	"a trailing newline is fine",
);
for (const broken of [
	'{"verb":"info"}',
	'{"level":"warn","time":"2026-10-12T12:20:39.123Z","verb":"warn","msg":"m","service":"s"}',
	'{"time":"2026-10-12T12:20:39.123Z","level":"info","verb":"warn","msg":"m","service":"s"}',
	'{"time":"2026-10-12T12:20:39Z","level":"warn","verb":"warn","msg":"m","service":"s"}',
	'{"time":"2026-10-12T12:20:39.123Z","level":"warn","verb":"warn","msg":"m","service":"s","extra":1}',
	'{"time":"2026-10-12T12:20:39.123Z","level":"info","verb":"wait","msg":"m","service":"s","phase":"start"}',
	'{"time":"2026-10-12T12:20:39.123Z","level":"info","verb":"success","msg":"m","service":"s","phase":"end","trace_id":"0af7651916cd43dd8448eb211c80319c","span_id":"b7ad6b7169203331","status":"error","dur_ms":1}',
	'{"time":"2026-10-12T12:20:39.123Z","level":"info","verb":"info","msg":"m","service":"s","status":"ok"}',
])
	assert(
		panics(() => parseEvent(broken)),
		"a broken event panics:",
		broken,
	);

// --- human: a span, its lines indented, its end with duration ----------------------

setLogFormat("human");
log.span("sync", { repo: "ui" }, (s) => {
	s.info("cloned", { files: 3, note: "two words" });
	s.span("build", (c) => c.warn("slow step", { ms: 1200 }));
	s.set({ pushed: true });
});
log.scope("api").success("served");
{
	const got = take();
	const want = [
		/^ ○ sync repo=ui$/,
		/^ {5}cloned files=3 note="two words"$/,
		/^ {3}○ build$/,
		/^ {5}⚠ slow step ms=1200$/,
		/^ {3}✓ build \d+ms$/,
		/^ ✓ sync \d+ms pushed=true$/,
		/^ ✓ \[api\] served$/,
	];
	assert(got.length === want.length, "human span lines:", got.join("\n"));
	for (const [i, re] of want.entries())
		assert(
			re.test(unwrap(got[i])),
			"human line",
			i,
			JSON.stringify(got[i]),
			"vs",
			re,
		);
}
try {
	log.span("deploy", () => {
		throw boom;
	});
} catch {}
{
	const [, end] = take();
	const [head, firstFrame] = unwrap(end).split("\n");
	assert(/^ ⨯ deploy \d+ms err="Error: boom"$/.test(unwrap(head)), head);
	assert(
		/^ {4}at /.test(unwrap(firstFrame)),
		"the stack under the line:",
		firstFrame,
	);
}
setLogTime(true);
log.wait("connecting");
assert(
	/^\d{2}:\d{2}:\d{2} {2}○ connecting$/.test(one()),
	"LOG_TIME adds HH:MM:SS",
);
setLogTime(false);

console.error = origError;
console.log(
	"✓ log: event contract, spans, join, levels and human rendering hold",
);
