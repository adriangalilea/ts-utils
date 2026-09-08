import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { renderMetrics } from "../src/metrics/cli.js";
import { defineMetrics, type Measurement } from "../src/metrics/index.js";
import { summarizeMetrics } from "../src/metrics/report.js";
import {
	METRICS_SCHEMA,
	type MetricsDatabase,
	readMetrics,
	sqliteMetricsWriter,
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
	latency: { kind: "timing", label: "latency", unit: "ms" },
} as const;
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
const db: MetricsDatabase = {
	async execute({ sql, args }) {
		return { rows: sqlite.prepare(sql).all(...args) };
	},
	async batch(statements) {
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
const stored = defineMetrics(spec, {
	write: sqliteMetricsWriter(db, "ui"),
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
	write: sqliteMetricsWriter(db, "other"),
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
sqlite.close();
console.log(
	"Metrics: validation, failure isolation, dimensions, UTC buckets, atomic upserts, identity and project separation passed",
);
