import { table, ui } from "../cli/index.js";
import { type DailyMetric, summarizeMetrics } from "./report.js";

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
