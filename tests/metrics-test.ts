import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { renderMetricComparison, renderMetrics } from "../src/metrics/cli.js";
import { d1Driver } from "../src/metrics/d1.js";
import { defineMetrics, type Measurement } from "../src/metrics/index.js";
import { libsqlDriver } from "../src/metrics/libsql.js";
import {
	compareMetrics,
	metricWindows,
	summarizeMetrics,
} from "../src/metrics/report.js";
import {
	METRICS_SCHEMA,
	type MetricsDriver,
	metricsWriter,
	readAudience,
	readMetrics,
} from "../src/metrics/sqlite.js";

const samples: Measurement[] = [];
const errors: unknown[] = [];
const spec = {
	copies: {
		kind: "counter",
		label: "copies",
		perUser: true,
		dimensions: { component: ["chat", "glass"] },
	},
	opens: { kind: "counter", label: "opens", perUser: true },
	latency: { kind: "timing", label: "latency", unit: "ms" },
} as const;
const overlaps = [["copies", "opens"]] as const;
const metrics = defineMetrics(spec, {
	write: async (m) => {
		samples.push(m);
	},
	now: () => new Date("2026-09-08T23:59:59Z"),
	onError: (e) => errors.push(e),
});
await metrics.copies.bump({ user: "actor", dimensions: { component: "chat" } });
assert.equal(samples[0].day, "2026-09-08");
assert.equal(samples[0].user, "actor");
await metrics.latency.record(125);
assert.equal(samples[1].sum, 125);
await metrics.copies.bump({ n: NaN, dimensions: { component: "chat" } });
await metrics.copies.bump({ n: -1, dimensions: { component: "chat" } });
await metrics.latency.record(Infinity);
await metrics.copies.bump({ dimensions: { component: "unknown" } });
await metrics.copies.bump();
await metrics.latency.record(1, { dimensions: { surprise: "value" } });
assert.equal(samples.length, 2);
assert.equal(errors.length, 6);
assert.throws(() =>
	defineMetrics(
		{ describe: { kind: "counter", label: "collision" } },
		{ write: async () => {} },
	),
);
assert.throws(() =>
	defineMetrics(
		{ a: { kind: "counter", label: "a" } },
		{ write: async () => {}, overlaps: [["a", "a"]] },
	),
);
for (const write of [
	() => {
		throw new Error("sync");
	},
	async () => {
		throw new Error("async");
	},
]) {
	const failed = defineMetrics(
		{ a: { kind: "counter", label: "a" } },
		{
			write,
			onError: () => {
				throw new Error("reporter");
			},
		},
	);
	await assert.doesNotReject(failed.a.bump());
}
const description = metrics.describe();
description.metrics[0].label = "mutated";
assert.equal(metrics.describe().metrics[0].label, "copies");

const sqlite = new DatabaseSync(":memory:");
for (const sql of METRICS_SCHEMA) sqlite.exec(sql);
// node:sqlite as a driver: the same two verbs the shipped libSQL and D1 drivers implement.
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
// The shipped drivers, over fakes shaped like the real clients, so both call paths run here.
const libsqlCalls: string[] = [];
const viaLibsql = libsqlDriver({
	async execute(statement) {
		libsqlCalls.push("execute");
		return { rows: await db.query(statement) };
	},
	async batch(statements, mode) {
		libsqlCalls.push(`batch:${mode}`);
		return db.transact(statements);
	},
});
const d1Calls: string[] = [];
type FakeD1Statement = {
	sql: string;
	args: (string | number)[];
	bind(...values: unknown[]): FakeD1Statement;
	all<T>(): Promise<{ results: T[] }>;
};
const viaD1 = d1Driver({
	prepare(sql) {
		const statement: FakeD1Statement = {
			sql,
			args: [],
			bind(...values) {
				statement.args = values as (string | number)[];
				return statement;
			},
			async all<T>() {
				d1Calls.push("all");
				return { results: (await db.query(statement)) as T[] };
			},
		};
		return statement;
	},
	async batch(statements) {
		d1Calls.push(`batch:${statements.length}`);
		return db.transact(statements as FakeD1Statement[]);
	},
});
const stored = defineMetrics(spec, {
	write: metricsWriter(db, "ui"),
	overlaps,
	now: () => new Date("2026-09-08T12:00:00Z"),
	onError: (e) => {
		errors.push(e);
	},
});
await stored.copies.bump({ user: "actor", dimensions: { component: "chat" } });
await stored.copies.bump({ user: "actor", dimensions: { component: "chat" } });
await stored.copies.bump({ dimensions: { component: "glass" } });
await stored.latency.record(30);
await stored.latency.record(50);
const other = defineMetrics(spec, {
	write: metricsWriter(db, "other"),
	now: () => new Date("2026-09-08T12:00:00Z"),
});
await other.copies.bump({ dimensions: { component: "chat" } });
const rows = await readMetrics(db, {
	from: "2026-09-08",
	to: "2026-09-08",
	project: "ui",
});
assert.equal(rows.length, 3);
assert.equal(
	summarizeMetrics(rows).find((r) => r.key === "latency")?.average,
	40,
);
assert.match(renderMetrics(rows), /copies/);
assert.match(renderMetrics(rows, { daily: true }), /2026-09-08/);
assert.equal(rows.find((r) => r.dimensions.component === "chat")?.count, 2);
assert.equal(rows.find((r) => r.key === "latency")?.sum, 80);
assert.equal(
	sqlite.prepare("SELECT count FROM metric_user_daily").get()?.count,
	2,
);
assert.equal(
	(await readMetrics(db, { from: "2026-09-09", to: "2026-09-09" })).length,
	0,
);
await assert.rejects(readMetrics(db, { from: "2026-09-09", to: "2026-09-08" }));
assert.equal(errors.length, 6);

// Audience: who did it. actor copies twice on the 8th (same-day repeat), once more on the
// 10th (returned); guest and actor open on the 10th; the anonymous glass bump is nobody.
const later = defineMetrics(spec, {
	write: metricsWriter(db, "ui"),
	overlaps,
	now: () => new Date("2026-09-10T12:00:00Z"),
});
await later.copies.bump({ user: "actor", dimensions: { component: "glass" } });
await later.opens.bump({ user: "guest" });
await later.opens.bump({ user: 7 });
await later.opens.bump({ user: "actor" });
const audience = await readAudience(
	db,
	{ from: "2026-09-08", to: "2026-09-10", project: "ui" },
	stored.describe().overlaps,
);
assert.deepEqual(audience, {
	metrics: [
		{
			project: "ui",
			key: "copies",
			uniques: 1,
			repeatUsers: 1,
			returningUsers: 1,
		},
		{
			project: "ui",
			key: "opens",
			uniques: 3,
			repeatUsers: 0,
			returningUsers: 0,
		},
	],
	overlaps: [
		{ project: "ui", from: "copies", to: "opens", fromUsers: 1, bothUsers: 1 },
	],
});
assert.deepEqual(
	(
		await readAudience(
			db,
			{ from: "2026-09-10", to: "2026-09-10", project: "ui" },
			[],
		)
	).metrics.find((m) => m.key === "copies"),
	{
		project: "ui",
		key: "copies",
		uniques: 1,
		repeatUsers: 0,
		returningUsers: 0,
	},
);
assert.deepEqual(
	await readAudience(
		db,
		{ from: "2026-09-08", to: "2026-09-10", project: "other" },
		stored.describe().overlaps,
	),
	{
		metrics: [],
		overlaps: [
			{
				project: "other",
				from: "copies",
				to: "opens",
				fromUsers: 0,
				bothUsers: 0,
			},
		],
	},
);
await assert.rejects(
	readAudience(db, { from: "2026-09-08", to: "2026-09-10", project: "UI" }, []),
);

// The shipped drivers: write through D1's prepare/bind/batch, read through libSQL's execute.
const onD1 = defineMetrics(spec, {
	write: metricsWriter(viaD1, "d1"),
	now: () => new Date("2026-09-08T12:00:00Z"),
	onError: (e) => {
		throw e;
	},
});
await onD1.opens.bump({ user: 42 });
await onD1.latency.record(9);
assert.deepEqual(d1Calls, ["batch:3", "batch:2"]);
const fromLibsql = await readMetrics(viaLibsql, {
	from: "2026-09-08",
	to: "2026-09-08",
	project: "d1",
});
assert.deepEqual(libsqlCalls, ["execute"]);
assert.equal(fromLibsql.length, 2);
assert.equal(fromLibsql.find((r) => r.key === "opens")?.count, 1);
assert.equal(
	(
		await readAudience(
			viaD1,
			{ from: "2026-09-08", to: "2026-09-08", project: "d1" },
			[],
		)
	).metrics[0]?.uniques,
	1,
);
assert.ok(d1Calls.includes("all"));
assert.deepEqual(metricWindows(14, { now: new Date("2026-09-08T23:59:59Z") }), {
	current: { from: "2026-08-25", to: "2026-09-07" },
	previous: { from: "2026-08-11", to: "2026-08-24" },
	partial: false,
});
assert.deepEqual(metricWindows(1, { now: new Date("2024-03-01T01:00:00Z") }), {
	current: { from: "2024-02-29", to: "2024-02-29" },
	previous: { from: "2024-02-28", to: "2024-02-28" },
	partial: false,
});
assert.deepEqual(
	metricWindows(2, {
		now: new Date("2026-01-01T00:00:00Z"),
		includeToday: true,
	}),
	{
		current: { from: "2025-12-31", to: "2026-01-01" },
		previous: { from: "2025-12-29", to: "2025-12-30" },
		partial: true,
	},
);
for (const n of [0, -1, 1.5, NaN, Infinity, 3661])
	assert.throws(() => metricWindows(n));
const counter = rows.find((r) => r.dimensions.component === "chat");
const timing = rows.find((r) => r.key === "latency");
assert.ok(counter && timing);
const comparison = compareMetrics(rows, [
	{ ...counter, count: 4 },
	{ ...counter, dimensions: { component: "removed" }, count: 3 },
	{ ...timing, count: 1, sum: 10 },
]);
assert.deepEqual(
	comparison.find((r) => r.dimensions.component === "chat")?.countChange,
	{ absolute: -2, percent: -50 },
);
assert.deepEqual(
	comparison.find((r) => r.dimensions.component === "removed")?.countChange,
	{ absolute: -3, percent: -100 },
);
assert.deepEqual(
	comparison.find((r) => r.dimensions.component === "glass")?.countChange,
	{ absolute: 1, percent: null },
);
assert.deepEqual(comparison.find((r) => r.key === "latency")?.averageChange, {
	absolute: 30,
	percent: 300,
});
assert.equal(compareMetrics([], [timing])[0].averageChange, null);
assert.equal(
	compareMetrics([timing], [{ ...timing, sum: 0 }])[0].averageChange?.percent,
	null,
);
assert.throws(() => compareMetrics([timing], [{ ...timing, unit: "seconds" }]));
assert.throws(() => summarizeMetrics([timing, { ...timing, unit: "seconds" }]));
const strictWriter = metricsWriter(db, "ui");
for (const changed of [
	{ kind: "counter", unit: "ms" },
	{ kind: "timing", unit: "s" },
] as const) {
	await assert.rejects(
		strictWriter({
			key: "latency",
			day: "2026-09-08",
			count: 1,
			sum: 1,
			dimensions: {},
			spec: { ...changed, label: "changed" },
		}),
	);
}
const preserved = await readMetrics(db, {
	from: "2026-09-08",
	to: "2026-09-08",
	project: "ui",
});
assert.deepEqual(
	preserved,
	rows,
	"incompatible declarations roll back metadata and observations together",
);
const canonical = compareMetrics(
	[{ ...counter, dimensions: { a: "1", b: "2" } }],
	[{ ...counter, dimensions: { b: "2", a: "1" } }],
);
assert.equal(canonical.length, 1);
assert.equal(canonical[0].countChange.absolute, 0);
assert.equal(
	compareMetrics([counter], [{ ...counter, project: "other" }]).length,
	2,
);
const rendered = renderMetricComparison(comparison);
assert.match(rendered, /no baseline/);
assert.match(rendered, /-100%/);
assert.match(rendered, /avg current/);
assert.match(renderMetricComparison([]), /either window/);
sqlite.close();
console.log(
	"Metrics: validation, failure isolation, dimensions, UTC buckets, atomic upserts, audience, libSQL and D1 drivers, project separation passed",
);
