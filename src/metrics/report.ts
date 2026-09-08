import type { DailyMetric } from "./sqlite.js";

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
