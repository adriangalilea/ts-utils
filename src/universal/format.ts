/**
 * Pure number formatting. No currency coupling — money formatting (usd, btc,
 * money(value, code), …) lives in ./currency, which owns the symbol/decimals
 * knowledge; its module split keeps the crypto-symbol dataset out of bundles
 * that only print money.
 *
 * Every formatter accepts `null | undefined` and renders "—" (em dash) — the
 * universal "no data" glyph. Callers pass DB fields and API values straight
 * through instead of each app re-wrapping every formatter for null.
 *
 * Every Intl call pins "en" — never the runtime default locale. In an SSR app
 * the server formats in en-US and the browser in the user's locale; a
 * runtime-default call is a text-node hydration mismatch (React #418) waiting
 * to happen. Pinning here means no consumer has to remember.
 *
 * Named exports only (no namespace object): a namespace keeps every function
 * — and its imports — alive in the bundle; named imports tree-shake.
 */

export type Numberish = number | null | undefined;

/** The "no data" glyph every formatter renders for null/undefined. */
export const NO_DATA = "—";

/** Compact notation: 1.2K, 3.4M, … (Intl, en). */
export function compact(value: Numberish): string {
	if (value == null) return NO_DATA;
	return new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

export interface PercentageOptions {
	/** Fixed decimal places. Omit for smart decimals (2 below 0.1, 0 at ≥100, else 1). */
	decimals?: number;
	/** Explicit "+" on positive values: +2.5% — for deltas (24h change, diffs). */
	sign?: boolean;
}

/** Percentage: smart decimals by default, or fixed via opts; optional +sign. */
export function percentage(
	value: Numberish,
	opts: PercentageOptions = {},
): string {
	if (value == null) return NO_DATA;
	let decimals = opts.decimals;
	if (decimals === undefined) {
		decimals = 1;
		if (Math.abs(value) < 0.1) {
			decimals = 2;
		} else if (Math.abs(value) >= 100) {
			decimals = 0;
		}
	}
	const sign = opts.sign && value > 0 ? "+" : "";
	return `${sign}${value.toFixed(decimals)}%`;
}

/** Plain fixed-decimal number, no grouping: 1.23 (lag, ratios, small counts). */
export function fixed(value: Numberish, decimals = 2): string {
	if (value == null) return NO_DATA;
	return value.toFixed(decimals);
}

/** Thousands separators: 1,234,567.89 (optionally fixed decimals). bigint-safe. */
export function withCommas(
	value: number | bigint | null | undefined,
	decimals?: number,
): string {
	if (value == null) return NO_DATA;
	const fixed =
		decimals !== undefined && typeof value === "number"
			? value.toFixed(decimals)
			: value.toString();
	const parts = fixed.split(".");
	parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return parts.join(".");
}

/**
 * Bytes → "12.7 TB", "2.0 TB", "850.0 GB", "500.0 MB". Decimal SI prefixes —
 * how drive manufacturers and SMART tools quote capacities (`df -h` too).
 * Below 1 MB the raw byte count is the honest answer.
 */
export function bytes(value: Numberish): string {
	if (value == null) return NO_DATA;
	if (value < 1e6) return `${value} B`;
	if (value < 1e9) return `${(value / 1e6).toFixed(1)} MB`;
	if (value < 1e12) return `${(value / 1e9).toFixed(1)} GB`;
	if (value < 1e15) return `${(value / 1e12).toFixed(1)} TB`;
	return `${(value / 1e15).toFixed(1)} PB`;
}

/**
 * Bits/sec → "10 Gbps", "2.5 Gbps", "100 Mbps". Network speeds use decimal SI
 * (a "1 Gbps" link moves 10^9 bits/sec, not 2^30).
 */
export function bitsPerSec(value: Numberish): string {
	if (value == null) return NO_DATA;
	if (value < 1e6) return `${value} bps`;
	if (value < 1e9) return `${(value / 1e6).toFixed(0)} Mbps`;
	return `${(value / 1e9).toFixed(1).replace(/\.0$/, "")} Gbps`;
}

/**
 * Decimals that keep 2 significant digits of a sub-cent value, capped at 10.
 * The fix for fixed-decimal erasure: a micro-priced asset (~$4.3e-7) under a
 * fixed 6-decimal floor renders "$0.000000" — the price vanishes.
 * 4.3e-7 → 8 decimals → "$0.00000043".
 */
export function sigDecimals(absValue: number): number {
	return Math.min(10, 1 - Math.floor(Math.log10(absValue)));
}
