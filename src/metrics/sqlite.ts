import type { Measurement, MetricsSchema, MetricsStore } from "./index.js";
import {
	type ActiveActors,
	type Audience,
	type DailyMetric,
	type MetricsReport,
	metricWindows,
} from "./report.js";

export type SqlValue = string | number;
export interface SqlStatement {
	sql: string;
	args: SqlValue[];
}

/** Reads need one verb. `metrics/d1-rest` is a reader only: a REST call cannot transact. */
export interface MetricsReader {
	/** The rows of one read statement. */
	query(statement: SqlStatement): Promise<Iterable<Record<string, unknown>>>;
}

/**
 * The SQLite dialect below needs exactly two verbs from a store. `metrics/libsql` and
 * `metrics/d1` implement them with each driver's native calls; any driver that speaks
 * SQLite (node:sqlite, bun:sqlite, better-sqlite3) does the same in a few lines.
 */
export interface MetricsDriver extends MetricsReader {
	/** Every statement or none: a constraint failure in any of them rolls the batch back. */
	transact(statements: SqlStatement[]): Promise<unknown>;
}

/**
 * Every table the store touches: what an ingestion credential must be granted
 * (read, add, update; never delete) and what a report credential reads.
 */
export const METRICS_TABLES = [
	"metric_definition",
	"metric_project",
	"metric_daily",
	"metric_user_daily",
] as const;

/** Run explicitly during provisioning, never on a user's request. */
export const METRICS_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS metric_definition (project TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, help TEXT NOT NULL, unit TEXT NOT NULL, per_user INTEGER NOT NULL, PRIMARY KEY(project, key))`,
	`CREATE TABLE IF NOT EXISTS metric_project (project TEXT NOT NULL, overlaps TEXT NOT NULL, PRIMARY KEY(project))`,
	`CREATE TABLE IF NOT EXISTS metric_daily (project TEXT NOT NULL, key TEXT NOT NULL, dimensions TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL CHECK(count >= 0), sum REAL NOT NULL CHECK(sum >= 0), PRIMARY KEY(project, key, dimensions, day))`,
	`CREATE TABLE IF NOT EXISTS metric_user_daily (project TEXT NOT NULL, key TEXT NOT NULL, dimensions TEXT NOT NULL, day TEXT NOT NULL, user TEXT NOT NULL, count INTEGER NOT NULL CHECK(count >= 0), sum REAL NOT NULL CHECK(sum >= 0), PRIMARY KEY(project, key, dimensions, day, user))`,
	`CREATE INDEX IF NOT EXISTS metric_user_identity ON metric_user_daily(project, user)`,
] as const;

const PROJECT = /^[a-z][a-z0-9-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertProject(project: string) {
	if (!PROJECT.test(project)) throw new Error("metrics: invalid project");
}

/**
 * A refused statement names the tables the batch touched: a scoped credential that
 * predates a table in METRICS_SCHEMA fails here, and the log should say which grant.
 */
async function granted<T>(
	work: Promise<T>,
	tables: readonly string[],
): Promise<T> {
	try {
		return await work;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not authorized|SQLITE_AUTH/i.test(message))
			throw new Error(
				`metrics: the credential lacks a grant on ${tables.join(" or ")} (${message})`,
				{ cause: error },
			);
		throw error;
	}
}

function assertRange(range: { from: string; to: string }) {
	for (const day of [range.from, range.to]) {
		if (!DAY.test(day) || new Date(day).toISOString().slice(0, 10) !== day)
			throw new Error("metrics: invalid UTC date");
	}
	if (range.from > range.to) throw new Error("metrics: reversed date range");
}

/** One project's store over a SQLite driver. */
export function metricsStore(
	driver: MetricsDriver,
	project: string,
): MetricsStore {
	assertProject(project);
	return {
		async declare(schema: MetricsSchema) {
			const statements: SqlStatement[] = schema.metrics.map((m) => ({
				// NOT NULL makes a changed kind/unit fail the whole atomic batch. Labels, help
				// and the per-user flag may evolve; historical measurements keep their meaning.
				sql: `INSERT INTO metric_definition VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET kind=CASE WHEN kind=excluded.kind THEN kind ELSE NULL END, label=excluded.label, help=excluded.help, unit=CASE WHEN unit=excluded.unit THEN unit ELSE NULL END, per_user=excluded.per_user`,
				args: [
					project,
					m.key,
					m.kind,
					m.label,
					m.help ?? "",
					m.unit ?? "",
					m.perUser ? 1 : 0,
				],
			}));
			// One row per project, replaced whole: an ingestion credential can add and update
			// but never delete, so the declared set is a value, not a table to reconcile.
			statements.push({
				sql: `INSERT INTO metric_project VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET overlaps=excluded.overlaps`,
				args: [project, JSON.stringify(schema.overlaps)],
			});
			await granted(driver.transact(statements), [
				"metric_definition",
				"metric_project",
			]);
		},
		async write(m: Measurement) {
			const dimensions = JSON.stringify(m.dimensions);
			const statements: SqlStatement[] = [
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
			await granted(
				driver.transact(statements),
				m.user === undefined
					? ["metric_daily"]
					: ["metric_daily", "metric_user_daily"],
			);
		},
	};
}

/** What one project declared, as the store holds it: the reader needs no declaring code. */
export async function readSchema(
	reader: MetricsReader,
	project: string,
): Promise<MetricsSchema> {
	assertProject(project);
	const [definitions, projects] = await Promise.all([
		reader.query({
			sql: `SELECT key, kind, label, help, unit, per_user FROM metric_definition WHERE project = ? ORDER BY key`,
			args: [project],
		}),
		reader.query({
			sql: `SELECT overlaps FROM metric_project WHERE project = ?`,
			args: [project],
		}),
	]);
	const [row] = Array.from(projects);
	const overlaps: Array<{ from: string; to: string }> = row
		? JSON.parse(String(row.overlaps))
		: [];
	return {
		metrics: Array.from(definitions, (r) => ({
			key: String(r.key),
			kind: String(r.kind) as "counter" | "timing",
			label: String(r.label),
			...(r.help ? { help: String(r.help) } : {}),
			...(r.unit ? { unit: String(r.unit) } : {}),
			...(Number(r.per_user) ? { perUser: true } : {}),
		})),
		overlaps,
	};
}

/** Inclusive UTC dates. Errors propagate: unavailable data must never read as zero. */
export async function readMetrics(
	reader: MetricsReader,
	range: { from: string; to: string; project?: string },
): Promise<DailyMetric[]> {
	assertRange(range);
	if (range.project !== undefined) assertProject(range.project);
	const rows = await reader.query({
		sql: `SELECT d.*, s.label, s.kind, s.help, s.unit FROM metric_daily d JOIN metric_definition s USING(project, key) WHERE day >= ? AND day <= ? ${range.project ? "AND project = ?" : ""} ORDER BY project, key, dimensions, day`,
		args: [range.from, range.to, ...(range.project ? [range.project] : [])],
	});
	return Array.from(rows, (r) => ({
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

/**
 * Who did it, over one project's opt-in per-user rows, all dimensions folded: one row per
 * declared per-user metric (zeros when nobody touched it in the window) with distinct
 * actors, actors with more than one sample on a single day, actors seen on more than one
 * day; then every declared unordered overlap.
 */
export async function readAudience(
	reader: MetricsReader,
	range: { from: string; to: string; project: string },
	schema: MetricsSchema,
): Promise<Audience> {
	assertRange(range);
	assertProject(range.project);
	const perKey = new Map(
		Array.from(
			await reader.query({
				sql: `WITH per_day AS (SELECT key, user, day, SUM(count) AS count FROM metric_user_daily WHERE project = ? AND day >= ? AND day <= ? GROUP BY key, user, day), per_user AS (SELECT key, user, COUNT(*) AS days, MAX(count) AS peak FROM per_day GROUP BY key, user) SELECT key, COUNT(*) AS uniques, SUM(CASE WHEN peak > 1 THEN 1 ELSE 0 END) AS repeat_users, SUM(CASE WHEN days > 1 THEN 1 ELSE 0 END) AS returning_users FROM per_user GROUP BY key`,
				args: [range.project, range.from, range.to],
			}),
			(r) => [String(r.key), r] as const,
		),
	);
	const metrics = schema.metrics
		.filter((m) => m.perUser)
		.map((m) => {
			const r = perKey.get(m.key);
			return {
				project: range.project,
				key: m.key,
				uniques: Number(r?.uniques ?? 0),
				repeatUsers: Number(r?.repeat_users ?? 0),
				returningUsers: Number(r?.returning_users ?? 0),
			};
		});
	const actors = `SELECT DISTINCT user FROM metric_user_daily WHERE project = ? AND key = ? AND day >= ? AND day <= ?`;
	const overlaps: Audience["overlaps"] = [];
	for (const pair of schema.overlaps) {
		const [row] = Array.from(
			await reader.query({
				sql: `WITH a AS (${actors}), b AS (${actors}) SELECT (SELECT COUNT(*) FROM a) AS from_users, (SELECT COUNT(*) FROM a WHERE user IN (SELECT user FROM b)) AS both_users`,
				args: [
					range.project,
					pair.from,
					range.from,
					range.to,
					range.project,
					pair.to,
					range.from,
					range.to,
				],
			}),
		);
		overlaps.push({
			project: range.project,
			from: pair.from,
			to: pair.to,
			fromUsers: Number(row?.from_users ?? 0),
			bothUsers: Number(row?.both_users ?? 0),
		});
	}
	return { metrics, overlaps };
}

/**
 * Distinct actors per day and over the window, every per-user key, one project or all:
 * the daily-active and window-active figures a distribution report shows.
 */
export async function readActive(
	reader: MetricsReader,
	range: { from: string; to: string; project?: string },
): Promise<ActiveActors[]> {
	assertRange(range);
	if (range.project !== undefined) assertProject(range.project);
	const scope = range.project ? "AND project = ?" : "";
	const args = [
		range.from,
		range.to,
		...(range.project ? [range.project] : []),
	];
	const [daily, window] = await Promise.all([
		reader.query({
			sql: `SELECT project, key, day, COUNT(DISTINCT user) AS users FROM metric_user_daily WHERE day >= ? AND day <= ? ${scope} GROUP BY project, key, day ORDER BY project, key, day`,
			args,
		}),
		reader.query({
			sql: `SELECT project, key, COUNT(DISTINCT user) AS users FROM metric_user_daily WHERE day >= ? AND day <= ? ${scope} GROUP BY project, key ORDER BY project, key`,
			args,
		}),
	]);
	const out = new Map<string, ActiveActors>();
	for (const r of window)
		out.set(`${r.project}\0${r.key}`, {
			project: String(r.project),
			key: String(r.key),
			daily: [],
			window: Number(r.users),
		});
	for (const r of daily)
		out
			.get(`${r.project}\0${r.key}`)
			?.daily.push({ day: String(r.day), users: Number(r.users) });
	return [...out.values()];
}

/** Everything a panel renders for one project over the last `days` UTC days, in one call. */
export async function readReport(
	reader: MetricsReader,
	options: {
		project: string;
		days: number;
		includeToday?: boolean;
		now?: Date;
	},
): Promise<MetricsReport> {
	const { current, partial } = metricWindows(options.days, {
		now: options.now,
		includeToday: options.includeToday,
	});
	const range = { ...current, project: options.project };
	const schema = await readSchema(reader, options.project);
	const [daily, audience] = await Promise.all([
		readMetrics(reader, range),
		readAudience(reader, range, schema),
	]);
	return {
		project: options.project,
		window: { ...current, partial },
		schema,
		daily,
		audience,
	};
}
