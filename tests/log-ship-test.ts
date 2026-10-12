/**
 * LOG_SHIP contract test. Shipping sends the stream's own json lines, so the
 * check is byte equality with what the console wrote, plus the wire (one
 * POST per batch, text/plain, the bearer), each trigger that sends a batch
 * (50 events, a top-level span's end, 2s, beforeExit, flushLog) and the
 * ones that must not (a nested span's end), the 64 KB ceiling, the
 * threshold, and that a refused or lost batch is one warning, never a throw.
 *
 * A collector on 127.0.0.1 records every batch; child processes prove a
 * process ships what waits when it exits on its own, under Node and Bun.
 *
 * Run: pnpm test:log-ship
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { assert, Panic, unwrap } from "../src/offensive.js";
import { runtime } from "../src/runtime.js";
import {
	flushLog,
	log,
	parseEvent,
	setLogFormat,
	setLogService,
	setLogShip,
	setLogShipToken,
} from "../src/universal/log.js";

// --- child mode: a process that writes and exits on its own ------------------
if (process.env.SHIP_TEST_CHILD) {
	log.info("child starting", { n: 1 });
	await log.span("work", async (s) => s.info("inside"));
	// Waits for the 2s timer, which must not hold the process: beforeExit sends it.
	log.warn("child done");
} else {
	await main();
}

interface Received {
	readonly auth: string | undefined;
	readonly type: string | undefined;
	readonly body: string;
}

async function main(): Promise<void> {
	// --- the collector -----------------------------------------------------------
	const received: Received[] = [];
	let answer = { status: 204, body: "" };
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			assert(req.method === "POST", "ship POSTs, got", req.method);
			received.push({
				auth: req.headers.authorization,
				type: req.headers["content-type"],
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(answer.status).end(answer.body);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;

	// --- capture -----------------------------------------------------------------
	const written: string[] = [];
	const origError = console.error;
	console.error = (...a: unknown[]): void => {
		assert(a.length === 1 && typeof a[0] === "string", "one string per event");
		written.push(a[0]);
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const takeBatches = (): Received[] => received.splice(0);
	const takeWritten = (): string[] => written.splice(0);
	const bodies = (): string[] => takeBatches().map((b) => b.body);
	const panics = (fn: () => unknown): boolean => {
		try {
			fn();
		} catch (e) {
			return e instanceof Panic;
		}
		return false;
	};

	for (const k of ["LOG_LEVEL", "LOG_FORMAT", "LOG_SERVICE", "LOG_SHIP"])
		runtime.deleteEnv(k);
	runtime.setEnv("NO_COLOR", "1");
	setLogFormat("json");
	setLogService("svc");

	// --- off by default: nothing ships, nothing is in flight ---------------------
	log.info("not shipped");
	await flushLog();
	takeWritten();
	assert(received.length === 0, "no LOG_SHIP, no batch");

	// --- the wire: the console's bytes, one POST, text/plain, the bearer -------
	setLogShip(url);
	setLogShipToken("tok-1");
	log.info("ready", { port: 1 });
	log.warn("retrying", { attempt: 2, nested: { b: 1, a: [true, null] } });
	await flushLog();
	{
		const [b, ...rest] = takeBatches();
		assert(rest.length === 0, "one flush, one batch");
		const batch = unwrap(b);
		assert(
			batch.body === takeWritten().join("\n"),
			"a batch is the written lines joined by \\n",
		);
		assert(
			batch.type === "text/plain;charset=utf-8",
			"content-type",
			batch.type,
		);
		assert(batch.auth === "Bearer tok-1", "bearer", batch.auth);
	}
	// The environment wins over code, read live.
	runtime.setEnv("LOG_SHIP_TOKEN", "tok-env");
	log.info("env token");
	await flushLog();
	assert(
		unwrap(takeBatches()[0]).auth === "Bearer tok-env",
		"LOG_SHIP_TOKEN overrides setLogShipToken",
	);
	runtime.deleteEnv("LOG_SHIP_TOKEN");
	takeWritten();

	// --- the threshold: what is not written is not shipped ---------------------
	log.debug("hidden");
	log.info("shown");
	await flushLog();
	{
		const shipped = bodies().join("\n").split("\n");
		assert(
			shipped.length === 1 &&
				unwrap(parseEvent(unwrap(shipped[0]))).msg === "shown",
			"only events past the threshold ship",
		);
		assert(takeWritten().length === 1, "and only they are written");
	}

	// --- human on the console, json on the wire ------------------------------
	setLogFormat("human");
	log.info("for a person", { k: "v" });
	await flushLog();
	{
		const shown = takeWritten();
		const shipped = unwrap(bodies()[0]);
		assert(
			shown.length === 1 && !unwrap(shown[0]).startsWith("{"),
			"human console",
		);
		const e = unwrap(parseEvent(shipped));
		assert(
			e.msg === "for a person" && e.fields?.k === "v",
			"json shipped",
			shipped,
		);
	}
	setLogFormat("json");

	// --- 50 events send at once, without waiting for the timer ---------------
	for (let i = 0; i < 50; i++) log.info("tick", { i });
	await sleep(300);
	{
		const b = takeBatches();
		assert(b.length === 1, "50 events: one batch now, got", b.length);
		assert(
			unwrap(b[0]).body.split("\n").length === 50,
			"the batch holds 50 lines",
		);
		assert(unwrap(b[0]).body === takeWritten().join("\n"), "bytes kept");
	}

	// --- a top-level span's end sends its trace; a nested one's does not -----
	log.info("before");
	const root = log.begin("request");
	root.span("db", (s) => s.info("query"));
	await sleep(300);
	assert(received.length === 0, "a nested span's end does not send");
	root.end();
	await sleep(300);
	{
		const b = takeBatches();
		assert(b.length === 1, "a root span's end sends, got", b.length);
		const lines = unwrap(b[0]).body.split("\n");
		assert(
			lines.length === 6,
			"line, request start, db start, query, db end, request end",
		);
		assert(unwrap(b[0]).body === takeWritten().join("\n"), "bytes kept");
	}
	// A request joined from its caller is top-level here: its end sends too.
	log
		.join("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
		.span("POST /vote", (s) => s.info("voted"));
	await sleep(300);
	assert(takeBatches().length === 1, "a joined top-level span's end sends");
	// A hidden root span still sends what it holds.
	runtime.setEnv("QUIET_LOG_LEVEL", "warn");
	log.scope("quiet").span("hidden", (s) => s.warn("kept"));
	runtime.deleteEnv("QUIET_LOG_LEVEL");
	await sleep(300);
	assert(
		bodies().join("\n").split("\n").length === 1,
		"a hidden root span's end sends its one shown line",
	);
	takeWritten();

	// --- 2s after the first event, with no other trigger ----------------------
	log.info("alone");
	await sleep(1000);
	assert(received.length === 0, "not before 2s");
	await sleep(1500);
	assert(
		bodies().join() === takeWritten().join(),
		"the timer sends the waiting batch",
	);

	// --- 64 KB per batch, never more ------------------------------------------
	const big = "x".repeat(20_000);
	for (let i = 0; i < 7; i++) log.info("chunk", { big, i });
	await flushLog();
	{
		const b = bodies();
		assert(b.length === 3, "7 × 20 KB: three batches, got", b.length);
		for (const body of b)
			assert(
				Buffer.byteLength(body) <= 64 * 1024,
				"a batch is at most 64 KB, got",
				Buffer.byteLength(body),
			);
		assert(b.join("\n") === takeWritten().join("\n"), "bytes and order kept");
	}
	// One event over the ceiling stays on the console and warns once.
	log.info("huge", { blob: "y".repeat(70_000) });
	log.info("huge again", { blob: "y".repeat(70_000) });
	await flushLog();
	{
		const shipped = bodies().join("\n").split("\n");
		const e = unwrap(parseEvent(unwrap(shipped[0])));
		assert(
			shipped.length === 1 &&
				e.msg === "event too large to ship" &&
				e.level === "warn",
			"an event over 64 KB is not shipped; one warning is",
		);
		assert(e.scope?.join() === "ship", "the warning's scope is ship");
		assert(
			takeWritten().length === 3,
			"both huge events and the warning are written",
		);
	}

	// --- refused and lost batches: one warning each, never a throw ------------
	answer = {
		status: 400,
		body: '{"accepted":0,"rejected":[{"line":1,"why":"x"}]}',
	};
	log.info("refused");
	log.info("refused again");
	await flushLog();
	answer = { status: 204, body: "" };
	{
		const b = takeBatches();
		// The refused batch, then the warning about it, shipped on the next pass.
		assert(b.length === 2, "the batch and the warning, got", b.length);
		const warning = unwrap(parseEvent(unwrap(b[1]).body));
		assert(
			warning.msg === "log batch refused" && warning.fields?.status === 400,
			"refusal warned",
		);
		log.info("refused once more");
		await flushLog();
		assert(takeBatches().length === 1, "a refusal warns once");
	}
	takeWritten();
	server.closeAllConnections();
	const closed = createServer();
	closed.listen(0, "127.0.0.1");
	await once(closed, "listening");
	const deadPort = (closed.address() as AddressInfo).port;
	closed.close();
	await once(closed, "close");
	setLogShip(`http://127.0.0.1:${deadPort}/ingest`);
	log.info("into the void");
	await flushLog();
	{
		const w = takeWritten().map((l) => unwrap(parseEvent(l)));
		assert(
			w.length === 2 &&
				w[1]?.msg === "log batch not delivered" &&
				w[1]?.fields?.err !== undefined,
			"a lost batch is one warning with the error",
		);
	}
	setLogShip(url);

	// --- a confused configuration screams ---------------------------------------
	assert(
		panics(() => setLogShip("ftp://x/y")),
		"a non-http URL panics",
	);
	assert(
		panics(() => setLogShip("not a url")),
		"a non-URL panics",
	);
	assert(
		panics(() => setLogShipToken("")),
		"an empty token panics",
	);
	runtime.setEnv("LOG_SHIP", "nope");
	assert(
		panics(() => log.info("x")),
		"a bad LOG_SHIP panics on the next event",
	);
	runtime.deleteEnv("LOG_SHIP");
	takeWritten();
	takeBatches();

	console.error = origError;

	// --- a process exiting on its own ships what waits (Node, Bun) ------------
	const self = fileURLToPath(import.meta.url);
	const runners: [string, string[]][] = [
		[process.execPath, [...process.execArgv, self]],
	];
	if (spawnSync("bun", ["--version"]).status === 0)
		runners.push(["bun", ["run", self]]);
	for (const [cmd, args] of runners) {
		const started = performance.now();
		const child = spawn(cmd, args, {
			env: {
				...process.env,
				SHIP_TEST_CHILD: "1",
				LOG_FORMAT: "json",
				LOG_SERVICE: "child",
				LOG_SHIP: url,
				LOG_SHIP_TOKEN: "tok-child",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		const [code] = await once(child, "close");
		const took = performance.now() - started;
		assert(code === 0, cmd, "child exited", code, stderr);
		const lines = stderr.split("\n").filter((l) => l.startsWith("{"));
		const b = takeBatches();
		assert(lines.length === 5, cmd, "child wrote 5 events, got", lines.length);
		assert(
			b.map((x) => x.body).join("\n") === lines.join("\n"),
			cmd,
			"what a child shipped is what it wrote",
		);
		assert(
			b.length === 2,
			cmd,
			"the span's end sent one batch, beforeExit the other",
		);
		assert(
			b.every((x) => x.auth === "Bearer tok-child"),
			cmd,
			"child bearer",
		);
		assert(
			took < 1900,
			cmd,
			"the 2s timer does not hold the process:",
			Math.round(took),
			"ms",
		);
	}

	server.close();
	console.log(
		`✓ log-ship: bytes, wire, triggers, 64 KB, threshold and failures hold (children: node${runners.length > 1 ? ", bun" : ""})`,
	);
}
