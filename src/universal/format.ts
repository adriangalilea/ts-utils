/**
 * Pure number formatting. No currency coupling — money formatting (usd, btc,
 * money(value, code), …) lives in ./currency, which owns the symbol/decimals
 * knowledge and its 133KB crypto-symbol dataset. Keeping this module pure is
 * what lets a browser bundle import `compact` without shipping that dataset.
 *
 * Named exports only (no namespace object): a namespace keeps every function
 * — and its imports — alive in the bundle; named imports tree-shake.
 */

/** Compact notation: 1.2K, 3.4M, … (Intl, en). */
export function compact(value: number): string {
	return new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

/** Percentage with smart decimals: 2 below 0.1, 0 at ≥100, else 1. */
export function percentage(value: number): string {
	let decimals = 1;
	if (Math.abs(value) < 0.1) {
		decimals = 2;
	} else if (Math.abs(value) >= 100) {
		decimals = 0;
	}
	return `${value.toFixed(decimals)}%`;
}

/** Thousands separators: 1,234,567.89 (optionally fixed decimals). */
export function withCommas(value: number, decimals?: number): string {
	const fixed =
		decimals !== undefined ? value.toFixed(decimals) : value.toString();
	const parts = fixed.split(".");
	parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return parts.join(".");
}
