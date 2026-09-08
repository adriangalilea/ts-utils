import type { Measurement } from "./index.js";

/** Structural libSQL interface; callers own connections and credentials. */
export interface MetricsDatabase {
	execute(statement: {
		sql: string;
		args: Array<string | number>;
	}): Promise<{ rows: Iterable<Record<string, unknown>> }>;
	batch(
		statements: Array<{ sql: string; args: Array<string | number> }>,
		mode: "write",
	): Promise<unknown>;
}

/** Run explicitly during provisioning, never on a user's request. */
export const METRICS_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS metric_definition (project TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, help TEXT NOT NULL, unit TEXT NOT NULL, PRIMARY KEY(project, key))`,
	`CREATE TABLE IF NOT EXISTS metric_daily (project TEXT NOT NULL, key TEXT NOT NULL, dimensions TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL CHECK(count >= 0), sum REAL NOT NULL CHECK(sum >= 0), PRIMARY KEY(project, key, dimensions, day))`,
	`CREATE TABLE IF NOT EXISTS metric_user_daily (project TEXT NOT NULL, key TEXT NOT NULL, dimensions TEXT NOT NULL, day TEXT NOT NULL, user TEXT NOT NULL, count INTEGER NOT NULL CHECK(count >= 0), sum REAL NOT NULL CHECK(sum >= 0), PRIMARY KEY(project, key, dimensions, day, user))`,
	`CREATE INDEX IF NOT EXISTS metric_user_identity ON metric_user_daily(project, user)`,
] as const;

export function sqliteMetricsWriter(db: MetricsDatabase, project: string) {
	if (!/^[a-z][a-z0-9-]*$/.test(project))
		throw new Error("metrics: invalid project");
	return async (m: Measurement) => {
		const dimensions = JSON.stringify(m.dimensions);
		const statements = [
			{
				sql: `INSERT INTO metric_definition VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET kind=excluded.kind, label=excluded.label, help=excluded.help, unit=excluded.unit`,
				args: [
					project,
					m.key,
					m.spec.kind,
					m.spec.label,
					m.spec.help ?? "",
					m.spec.unit ?? "",
				],
			},
			{
				sql: `INSERT INTO metric_daily VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, key, dimensions, day) DO UPDATE SET count=count+excluded.count, sum=sum+excluded.sum`,
				args: [project, m.key, dimensions, m.day, m.count, m.sum],
			},
		];
		if (m.user !== undefined)
			statements.push({
				sql: `INSERT INTO metric_user_daily VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, key, dimensions, day, user) DO UPDATE SET count=count+excluded.count, sum=sum+excluded.sum`,
				args: [
					project,
					m.key,
					dimensions,
					m.day,
					String(m.user),
					m.count,
					m.sum,
				],
			});
		await db.batch(statements, "write");
	};
}

export interface DailyMetric {
	project: string;
	key: string;
	label: string;
	kind: string;
	help: string;
	unit: string;
	dimensions: Record<string, string>;
	day: string;
	count: number;
	sum: number;
}

/** Inclusive UTC dates. Errors propagate: unavailable data must never read as zero. */
export async function readMetrics(
	db: MetricsDatabase,
	range: { from: string; to: string; project?: string },
): Promise<DailyMetric[]> {
	for (const day of [range.from, range.to]) {
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
			new Date(day).toISOString().slice(0, 10) !== day
		)
			throw new Error("metrics: invalid UTC date");
	}
	if (range.from > range.to) throw new Error("metrics: reversed date range");
	const result = await db.execute({
		sql: `SELECT d.*, s.label, s.kind, s.help, s.unit FROM metric_daily d JOIN metric_definition s USING(project, key) WHERE day >= ? AND day <= ? ${range.project ? "AND project = ?" : ""} ORDER BY project, key, dimensions, day`,
		args: [range.from, range.to, ...(range.project ? [range.project] : [])],
	});
	return Array.from(result.rows, (r) => ({
		project: String(r.project),
		key: String(r.key),
		label: String(r.label),
		kind: String(r.kind),
		help: String(r.help),
		unit: String(r.unit),
		dimensions: JSON.parse(String(r.dimensions)),
		day: String(r.day),
		count: Number(r.count),
		sum: Number(r.sum),
	}));
}
