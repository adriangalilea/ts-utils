import type { MetricsSchema } from "./index.js";

/** Store-independent daily observations, shared by adapters and renderers. */
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

/** Per key, from opt-in per-user rows: keys nobody touched in the window are absent. */
export interface AudienceMetric {
	project: string;
	key: string;
	/** Distinct actors. */
	uniques: number;
	/** Actors with more than one sample on a single day. */
	repeatUsers: number;
	/** Actors seen on more than one day. */
	returningUsers: number;
}

/** Unordered: how many of `from`'s actors also touched `to`, in the same window. */
export interface AudienceOverlap {
	project: string;
	from: string;
	to: string;
	fromUsers: number;
	bothUsers: number;
}

export interface Audience {
	metrics: AudienceMetric[];
	overlaps: AudienceOverlap[];
}

export interface MetricsWindow {
	from: string;
	to: string;
	/** The window ends on the current, incomplete UTC day. */
	partial: boolean;
}

/** One project, one window, everything a panel renders; the schema comes from the store. */
export interface MetricsReport {
	project: string;
	window: MetricsWindow;
	schema: MetricsSchema;
	daily: DailyMetric[];
	audience: Audience;
}

export interface MetricTotal {
	project: string;
	key: string;
	label: string;
	kind: string;
	unit: string;
	dimensions: Record<string, string>;
	count: number;
	sum: number;
	average: number | null;
}

export interface MetricChange {
	absolute: number;
	/** Null when a percentage has no nonzero baseline. */
	percent: number | null;
}

export interface MetricComparison {
	project: string;
	key: string;
	label: string;
	kind: string;
	unit: string;
	dimensions: Record<string, string>;
	current: MetricTotal | null;
	previous: MetricTotal | null;
	countChange: MetricChange;
	averageChange: MetricChange | null;
}

/** Adjacent equal-length UTC windows; completed days by default. */
export function metricWindows(
	days: number,
	options: { now?: Date; includeToday?: boolean } = {},
) {
	if (!Number.isInteger(days) || days < 1 || days > 3660)
		throw new Error("metrics: window must be 1–3660 days");
	const day = 86_400_000;
	const today = Date.parse(
		(options.now ?? new Date()).toISOString().slice(0, 10),
	);
	const end = today - (options.includeToday ? 0 : day);
	const iso = (value: number) => new Date(value).toISOString().slice(0, 10);
	return {
		current: { from: iso(end - (days - 1) * day), to: iso(end) },
		previous: {
			from: iso(end - (2 * days - 1) * day),
			to: iso(end - days * day),
		},
		partial: options.includeToday === true,
	};
}

const seriesKey = (row: Pick<DailyMetric, "project" | "key" | "dimensions">) =>
	JSON.stringify([
		row.project,
		row.key,
		Object.entries(row.dimensions).sort(([a], [b]) => a.localeCompare(b)),
	]);

/** Compare recorded observations; absent series have zero counts, never zero latency. */
export function compareMetrics(
	current: readonly DailyMetric[],
	previous: readonly DailyMetric[],
): MetricComparison[] {
	const now = new Map(
		summarizeMetrics(current).map((row) => [seriesKey(row), row]),
	);
	const before = new Map(
		summarizeMetrics(previous).map((row) => [seriesKey(row), row]),
	);
	const change = (a: number, b: number): MetricChange => ({
		absolute: a - b,
		percent: b === 0 ? (a === 0 ? 0 : null) : ((a - b) / b) * 100,
	});
	return [...new Set([...now.keys(), ...before.keys()])]
		.map((key) => {
			const a = now.get(key) ?? null;
			const b = before.get(key) ?? null;
			const metadata = a ?? b;
			if (!metadata) throw new Error("metrics: missing comparison series");
			if (a && b && (a.kind !== b.kind || a.unit !== b.unit))
				throw new Error(
					`metrics: changed meaning for ${metadata.project}.${metadata.key}; use a new key`,
				);
			return {
				project: metadata.project,
				key: metadata.key,
				label: metadata.label,
				kind: metadata.kind,
				unit: metadata.unit,
				dimensions: metadata.dimensions,
				current: a,
				previous: b,
				countChange: change(a?.count ?? 0, b?.count ?? 0),
				averageChange:
					a?.average != null && b?.average != null
						? change(a.average, b.average)
						: null,
			};
		})
		.sort(
			(a, b) =>
				a.project.localeCompare(b.project) ||
				a.key.localeCompare(b.key) ||
				Math.abs(b.countChange.absolute) - Math.abs(a.countChange.absolute) ||
				seriesKey(a).localeCompare(seriesKey(b)),
		);
}

/** One report shape for terminal and web. No product names or metric lists. */
export function summarizeMetrics(rows: readonly DailyMetric[]): MetricTotal[] {
	const totals = new Map<string, MetricTotal>();
	for (const row of rows) {
		const dimensions = Object.fromEntries(
			Object.entries(row.dimensions).sort(([a], [b]) => a.localeCompare(b)),
		);
		const key = JSON.stringify([row.project, row.key, dimensions]);
		const total = totals.get(key) ?? {
			project: row.project,
			key: row.key,
			label: row.label,
			kind: row.kind,
			unit: row.unit,
			dimensions,
			count: 0,
			sum: 0,
			average: null,
		};
		if (total.kind !== row.kind || total.unit !== row.unit)
			throw new Error(
				`metrics: changed meaning for ${row.project}.${row.key}; use a new key`,
			);
		total.count += row.count;
		total.sum += row.sum;
		total.average =
			total.kind === "timing" && total.count > 0
				? total.sum / total.count
				: null;
		totals.set(key, total);
	}
	return [...totals.values()].sort(
		(a, b) =>
			a.project.localeCompare(b.project) ||
			a.key.localeCompare(b.key) ||
			b.count - a.count ||
			JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
	);
}
