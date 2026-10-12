/**
 * visits: a site's own route keeps its pages in visits. Proves, over
 * node:sqlite: a page's batch becomes a visit, a page row and its lines; a
 * soft page within the gap joins the visit and its end fills the row; a
 * page past the gap, from another caller, or on the next UTC day starts a new
 * visit (the day's salt goes with the day); every refusal is named by line;
 * a crawler is dropped whole; another site's page is refused; readVisits
 * reads the places in order with the outside referrer, leaving a probe out
 * unless asked; old rows are pruned on the day's first write.
 *
 * Run: pnpm test:visits
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { MetricsDriver } from "../src/metrics/sqlite.js";
import {
	readVisit,
	readVisits,
	VISITS_SCHEMA,
	visitsRoute,
} from "../src/visits/index.js";

const sqlite = new DatabaseSync(":memory:");
for (const s of VISITS_SCHEMA) sqlite.exec(s);
const db: MetricsDriver = {
	async query({ sql, args }) {
		return sqlite.prepare(sql).all(...args) as Record<string, unknown>[];
	},
	async transact(statements) {
		sqlite.exec("BEGIN");
		try {
			for (const { sql, args } of statements) sqlite.prepare(sql).run(...args);
			sqlite.exec("COMMIT");
		} catch (e) {
			sqlite.exec("ROLLBACK");
			throw e;
		}
	},
};
const count = (table: string) =>
	(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
		.n;

let clock = Date.parse("2026-10-13T10:00:00.000Z");
const route = visitsRoute({
	db,
	site: "untitled.garden",
	services: ["garden-web"],
	staff: (request) => request.headers.get("x-staff") === "1",
	now: () => clock,
});

// --- lines, in the contract's key order ---------------------------------------
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
let ids = 1;
const trace = () => hex(ids++, 32);
const span = () => hex(ids++, 16);
const time = () => new Date(clock).toISOString();

function start(
	t: string,
	s: string,
	fields: object,
	msg = "page",
	parent?: string,
) {
	return JSON.stringify({
		time: time(),
		level: "info",
		verb: "wait",
		msg,
		service: "garden-web",
		phase: "start",
		trace_id: t,
		span_id: s,
		...(parent ? { parent_id: parent } : {}),
		fields,
	});
}
function end(
	t: string,
	s: string,
	fields: object,
	msg = "page",
	parent?: string,
) {
	return JSON.stringify({
		time: time(),
		level: "info",
		verb: "success",
		msg,
		service: "garden-web",
		phase: "end",
		trace_id: t,
		span_id: s,
		...(parent ? { parent_id: parent } : {}),
		status: "ok",
		dur_ms: 1234.5,
		fields,
	});
}
function info(
	t: string,
	s: string,
	msg: string,
	fields: object,
	service = "garden-web",
) {
	return JSON.stringify({
		time: time(),
		level: "info",
		verb: "info",
		msg,
		service,
		trace_id: t,
		span_id: s,
		fields,
	});
}

const page = (path: string, place: string, more: object = {}) => ({
	host: "untitled.garden",
	path,
	nav: "navigate",
	viewport: "desktop",
	place,
	...more,
});

function post(
	lines: string[],
	headers: Record<string, string> = {},
): Promise<Response> {
	return route(
		new Request("https://untitled.garden/api/events", {
			method: "POST",
			headers: {
				"content-type": "text/plain;charset=UTF-8",
				"cf-connecting-ip": "203.0.113.7",
				"user-agent": "Mozilla/5.0 (Macintosh) Safari/605",
				"cf-ipcountry": "es",
				origin: "https://untitled.garden",
				...headers,
			},
			body: lines.join("\n"),
		}),
	);
}

// --- a page's first batch ---------------------------------------------------------
const t1 = trace();
const p1 = span();
const f1 = span();
let res = await post([
	start(
		t1,
		p1,
		page("/", "studio", { referrer: "news.ycombinator.com", source: "hn" }),
	),
	start(t1, f1, { method: "GET", path: "/lore", kind: "rsc" }, "fetch", p1),
	end(
		t1,
		f1,
		{ method: "GET", path: "/lore", kind: "rsc", status: 200 },
		"fetch",
		p1,
	),
	info(t1, p1, "main action", { label: "download" }),
]);
assert.equal(res.status, 204, await res.clone().text());
assert.equal(count("visits_visit"), 1);
assert.equal(count("visits_page"), 1);
assert.equal(
	count("visits_event"),
	3,
	"the fetch span's two events and the named event",
);
const [v1] = sqlite.prepare("SELECT * FROM visits_visit").all() as Record<
	string,
	unknown
>[];
assert.equal(v1?.referrer, "news.ycombinator.com");
assert.equal(v1?.country, "ES");
assert.equal(v1?.pages, 1);
assert.ok(
	!JSON.stringify(sqlite.prepare("SELECT * FROM visits_visit").all()).includes(
		"203.0.113.7",
	),
	"the IP is never stored",
);

// --- the page ends and a soft page starts, two minutes later: the same visit ------
clock += 2 * 60_000;
const t2 = trace();
const p2 = span();
res = await post([
	end(t1, p1, {
		...page("/", "studio"),
		reached: ["hero", "features"],
		lcp_ms: 820,
	}),
	start(t2, p2, page("/lore", "lore", { nav: "soft", from: "/" })),
]);
assert.equal(res.status, 204, await res.clone().text());
assert.equal(count("visits_visit"), 1, "a page within the gap joins the visit");
const pages = sqlite
	.prepare("SELECT * FROM visits_page ORDER BY seq")
	.all() as Record<string, unknown>[];
assert.deepEqual(
	pages.map((p) => [p.seq, p.place]),
	[
		[1, "studio"],
		[2, "lore"],
	],
);
assert.equal(pages[0]?.dur_ms, 1234.5);
assert.equal(pages[0]?.reached, '["hero","features"]');
assert.equal(pages[0]?.lcp_ms, 820);

// --- past the gap: a new visit; another caller: a new visit -------------------------
clock += 31 * 60_000;
res = await post([start(trace(), span(), page("/chill", "chill"))]);
assert.equal(res.status, 204);
assert.equal(count("visits_visit"), 2, "past the gap is a new visit");
clock += 60_000;
res = await post([start(trace(), span(), page("/", "studio"))], {
	"cf-connecting-ip": "198.51.100.9",
});
assert.equal(count("visits_visit"), 3, "another caller is another visit");

// --- refusals, each named by its line ------------------------------------------------
const tKept = t2;
res = await post([
	"not json at all",
	info(tKept, p2, "hello", {}, "someone-else"),
	info(tKept, p2, "signed up", { email: "a@b.c" }),
	JSON.stringify({
		time: time(),
		level: "info",
		verb: "info",
		msg: "loose",
		service: "garden-web",
	}),
	info(trace(), span(), "orphan", {}),
	info(tKept, p2, "fine", {}),
]);
assert.equal(res.status, 400);
const answer = (await res.json()) as {
	accepted: number;
	rejected: { line: number; why: string }[];
};
assert.equal(answer.accepted, 1);
assert.deepEqual(
	answer.rejected.map((r) => r.line),
	[1, 2, 3, 4, 5],
	JSON.stringify(answer.rejected),
);
assert.match(answer.rejected[2]?.why ?? "", /like a person: email/);
assert.match(answer.rejected[4]?.why ?? "", /no page of this trace/);

// --- a crawler, another site, a probe --------------------------------------------------
const before = count("visits_page");
res = await post([start(trace(), span(), page("/", "studio"))], {
	"user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
});
assert.equal(res.status, 204);
assert.equal(count("visits_page"), before, "a crawler is dropped whole");
res = await post([start(trace(), span(), page("/", "studio"))], {
	origin: "https://elsewhere.example",
});
assert.equal(res.status, 403);
res = await post(
	[start(trace(), span(), page("/", "studio", { probe: true }))],
	{
		"cf-connecting-ip": "192.0.2.1",
	},
);
assert.equal(res.status, 204);
clock += 60_000;
res = await post([start(trace(), span(), page("/", "studio"))], {
	"cf-connecting-ip": "192.0.2.2",
	"x-staff": "1",
});
assert.equal(res.status, 204);

// --- reading -----------------------------------------------------------------------------
let visits = await readVisits(db, {
	site: "untitled.garden",
	days: 1,
	now: clock,
});
assert.deepEqual(
	visits.map((v) => [v.places, v.referrer ?? null]),
	[
		[["studio", "lore"], "news.ycombinator.com"],
		[["chill"], null],
		[["studio"], null],
	],
	"places in order, the probe and the staff left out",
);
visits = await readVisits(db, {
	site: "untitled.garden",
	days: 1,
	flagged: true,
	now: clock,
});
assert.equal(visits.length, 5);
assert.deepEqual(
	visits
		.filter((v) => v.probe || v.staff)
		.map((v) => [v.probe, v.staff])
		.sort(),
	[
		[false, true],
		[true, false],
	],
	"a page's own probe flag, and the route's staff answer",
);
const one = await readVisit(db, String(v1?.id));
assert.equal(one.pages.length, 2);
assert.equal(
	one.lines.length,
	4,
	"the fetch span, the named event, the line kept from the refused batch",
);

// --- the next UTC day: a new salt, a new visit even within the gap -------------------
const saltBefore = (
	sqlite.prepare("SELECT salt FROM visits_salt").get() as { salt: string }
).salt;
clock = Date.parse("2026-10-14T00:05:00.000Z");
res = await post([start(trace(), span(), page("/", "studio"))], {
	"cf-connecting-ip": "192.0.2.1",
});
assert.equal(res.status, 204);
const salts = sqlite.prepare("SELECT day, salt FROM visits_salt").all() as {
	day: string;
	salt: string;
}[];
assert.deepEqual(
	salts.map((s) => s.day),
	["2026-10-14"],
	"yesterday's salt is gone",
);
assert.notEqual(salts[0]?.salt, saltBefore);
assert.equal(count("visits_caller"), 1, "yesterday's callers are gone");

// --- pruning: rows past the window go on the day's first write ----------------------------
sqlite
	.prepare(
		"INSERT INTO visits_visit (id, site, day, started, last, pages, probe, staff) VALUES ('old', 'untitled.garden', '2026-01-01', 0, 0, 1, 0, 0)",
	)
	.run();
clock = Date.parse("2026-10-15T09:00:00.000Z");
await post([start(trace(), span(), page("/", "studio"))]);
assert.equal(
	(
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM visits_visit WHERE id = 'old'")
			.get() as { n: number }
	).n,
	0,
	"a visit past VISIT_DAYS is pruned",
);
assert.equal(
	(
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM visits_visit WHERE probe = 1")
			.get() as { n: number }
	).n,
	1,
	"a probe is kept FLAGGED_DAYS",
);

console.log(
	"✓ visits: batches, the gap, callers, days, refusals, crawlers, origins, reading and pruning hold",
);
