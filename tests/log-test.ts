/**
 * Logger contract test. The record line format is shared verbatim with
 * go-utils and py-utils, so the golden assertions here are the contract:
 * a drift in timestamp shape, level padding, or scope brackets fails loudly.
 *
 * Run: pnpm test:log
 */

import { assert, Panic } from "../src/offensive.js";
import { runtime } from "../src/runtime.js";
import {
	log,
	scope,
	setLogFormat,
	setLogLevel,
	setLogTime,
} from "../src/universal/log.js";

// The logger funnels every level through console.error in Node; capture there.
const lines: string[] = [];
const origError = console.error.bind(console);
console.error = (...a: unknown[]): void => {
	lines.push(a.map(String).join(" "));
};

const last = (): string => {
	const l = lines.at(-1);
	assert(l !== undefined, "expected a log line, got none");
	return l;
};
const expectLine = (re: RegExp): void => {
	assert(re.test(last()), "line mismatch:", JSON.stringify(last()), "vs", re);
};
const expectCount = (n: number): void => {
	assert(lines.length === n, "expected", n, "lines, got", lines.length, lines);
};

runtime.setEnv("NO_COLOR", "1");

// --- record rendering: the shared golden line ---
setLogFormat("record");
setLogTime(true);

log.warn("disk almost full");
expectLine(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z WARN {2}disk almost full$/);

log.error("boom");
expectLine(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ERROR boom$/);

scope("api").scope("auth").error("token rejected");
expectLine(
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ERROR \[api auth\] token rejected$/,
);

// Verbs render as their level word in record mode.
log.success("import finished");
expectLine(/Z INFO {2}import finished$/);
log.fail("import died");
expectLine(/Z ERROR import died$/);

// --- time is orthogonal: record without stamps ---
setLogTime(false);
log.warn("no stamp");
expectLine(/^WARN {2}no stamp$/);

// --- human rendering ---
setLogFormat("human");
log.wait("connecting");
expectLine(/^ ○ connecting$/);
log.step("resolving dns");
expectLine(/^ {3}• resolving dns$/);
scope("sync").ready("listening");
expectLine(/^ ▶ \[sync\] listening$/);

// Human with time: dim local clock, but NO_COLOR strips the dim here.
setLogTime(true);
log.wait("connecting");
expectLine(/^\d{2}:\d{2}:\d{2} {2}○ connecting$/);
setLogTime(false);

// --- level filtering ---
const before = lines.length;
setLogLevel("error");
log.info("suppressed");
log.trace("suppressed");
log.error("passes");
expectCount(before + 1);
setLogLevel("info");

// --- per-scope env levels beat the global level ---
runtime.setEnv("GZIP_LOG_LEVEL", "silent");
const gzip = scope("gzip");
const beforeScope = lines.length;
gzip.error("suppressed by scope env");
expectCount(beforeScope);
runtime.setEnv("GZIP_LOG_LEVEL", "trace");
gzip.trace("opened up by scope env");
expectCount(beforeScope + 1);
runtime.deleteEnv("GZIP_LOG_LEVEL");

// --- warnOnce fires once ---
const beforeOnce = lines.length;
log.warnOnce("repeated warning");
log.warnOnce("repeated warning");
expectCount(beforeOnce + 1);

// --- unknown knob values scream ---
let threw = false;
try {
	setLogLevel("verbose" as never);
} catch (e) {
	threw = e instanceof Panic;
}
assert(threw, "unknown log level must throw Panic");

console.error = origError;
console.log(`✓ log: ${lines.length} lines asserted, record contract holds`);
