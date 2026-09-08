import { table, ui } from "../cli/index.js";
import {
	type DailyMetric,
	type MetricChange,
	type MetricComparison,
	summarizeMetrics,
} from "./report.js";

/** Neutral deltas: increasing a metric does not necessarily mean improvement. */
export function renderMetricComparison(
	comparisons: readonly MetricComparison[],
): string {
	if (!comparisons.length) return "No recorded measurements in either window.";
	const number = (n: number) =>
		new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
	const signed = (n: number) => `${n > 0 ? "+" : ""}${number(n)}`;
	const delta = (value: MetricChange) =>
		`${signed(value.absolute)} (${value.percent === null ? "no baseline" : `${signed(value.percent)}%`})`;
	const groups = new Map<string, MetricComparison[]>();
	for (const row of comparisons) {
		const key = JSON.stringify([row.project, row.key]);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => {
			const timing = group[0].kind === "timing";
			const average = (n: number | null | undefined) =>
				n == null ? "—" : `${number(n)} ${group[0].unit}`.trim();
			return [
				ui.head(
					`${group[0].project} · ${group[0].label}${timing ? " (samples)" : ""}`,
				),
				table(
					group.map((r) => [
						Object.entries(r.dimensions)
							.map(([k, v]) => `${k}=${v}`)
							.join(" · ") || "all",
						number(r.current?.count ?? 0),
						number(r.previous?.count ?? 0),
						delta(r.countChange),
						...(timing
							? [
									average(r.current?.average),
									average(r.previous?.average),
									r.averageChange ? delta(r.averageChange) : "—",
								]
							: []),
					]),
					{
						head: [
							"breakdown",
							"current",
							"previous",
							"change",
							...(timing ? ["avg current", "avg previous", "avg change"] : []),
						],
						align: [
							"l",
							"r",
							"r",
							"r",
							...(timing ? ["r" as const, "r" as const, "r" as const] : []),
						],
					},
				),
			].join("\n");
		})
		.join("\n\n");
}

/** Render declarations stored beside observations; adding a metric requires no panel edit. */
export function renderMetrics(
	rows: readonly DailyMetric[],
	options: { daily?: boolean } = {},
): string {
	if (!rows.length) return "No recorded measurements in this window.";
	const lines: string[] = [];
	const totals = summarizeMetrics(rows);
	const groups = new Map<string, typeof totals>();
	for (const total of totals) {
		const key = JSON.stringify([total.project, total.key]);
		const group = groups.get(key) ?? [];
		group.push(total);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const timing = group[0].kind === "timing";
		const number = (n: number) =>
			new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
		lines.push(ui.head(`${group[0].project} · ${group[0].label}`));
		const source = options.daily
			? rows
					.filter(
						(r) => r.project === group[0].project && r.key === group[0].key,
					)
					.map((r) => ({ ...r, average: r.count ? r.sum / r.count : null }))
			: group;
		lines.push(
			table(
				source.map((r) => [
					...(options.daily ? ["day" in r ? String(r.day) : ""] : []),
					Object.entries(r.dimensions)
						.map(([k, v]) => `${k}=${v}`)
						.join(" · ") || "all",
					number(r.count),
					...(timing ? [`${number(r.average ?? 0)} ${r.unit}`.trim()] : []),
				]),
				{
					head: [
						...(options.daily ? ["day"] : []),
						"breakdown",
						timing ? "samples" : "count",
						...(timing ? ["average"] : []),
					],
					align: [
						...(options.daily ? ["l" as const] : []),
						"l",
						"r",
						...(timing ? ["r" as const] : []),
					],
				},
			),
		);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
