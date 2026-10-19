import type { MetricsStore } from "./index.js";
import { type MetricsDriver, metricsStore } from "./sqlite.js";

/** The slice of Cloudflare D1 the metrics driver touches, typed structurally: no workers-types dependency. */
export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Binding {
	prepare(sql: string): D1Statement;
	/** D1 runs a batch as one transaction: a failing statement rolls back the whole sequence. */
	batch(statements: D1Statement[]): Promise<unknown>;
}

/** One project's store over a D1 binding: what a Worker hands to `defineMetrics`. */
export const d1Store = (db: D1Binding, project: string): MetricsStore =>
	metricsStore(d1Driver(db), project);

/** A D1 binding as a metrics driver. */
export function d1Driver(db: D1Binding): MetricsDriver {
	return {
		query: async ({ sql, args }) =>
			(
				await db
					.prepare(sql)
					.bind(...args)
					.all()
			).results,
		transact: (statements) =>
			db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.args))),
	};
}
