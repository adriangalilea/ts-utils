// USD formatting — deliberately dataset-free. Printing dollars needs no
// symbol lookup and no crypto classification, so this module must never
// import ./classify.ts: it is the module a client bundle pulls to render a
// price, and the 133KB ticker dataset has no business riding along.
// getOptimalDecimals (./decimals.ts) delegates its USD/stables case to
// usdDecimals, so the policy has exactly one home.

import { NO_DATA, type Numberish, sigDecimals } from "../format.js";

/** The USD decimals policy: 2 for dollars, more as the value shrinks, significant-digit floor below a cent. */
export function usdDecimals(value: number): number {
	if (value === 0) return 2;
	const absValue = Math.abs(value);
	if (absValue < 0.01) return sigDecimals(absValue);
	if (absValue < 0.1) return 4;
	if (absValue < 1) return 3;
	return 2;
}

export interface UsdOptions {
	/** Fixed decimal places, overriding the optimal-decimals policy. */
	decimals?: number;
	/** Compact notation for market-cap-scale money: $60.9M. */
	compact?: boolean;
}

/**
 * The USD decimals POLICY as Intl.NumberFormatOptions, for consumers that
 * format internally — animated numbers (NumberFlow), chart axes, table cell
 * renderers. One policy serves strings and widgets alike; `usd()` below is
 * just this policy applied. Value-dependent: recompute when the value moves.
 */
export function usdIntlOptions(
	value: number,
	opts: UsdOptions = {},
): Intl.NumberFormatOptions {
	if (opts.compact) {
		return {
			style: "currency",
			currency: "USD",
			notation: "compact",
			maximumFractionDigits: 1,
		};
	}
	const decimals = opts.decimals ?? usdDecimals(value);
	return {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	};
}

/**
 * $1,234.56 with optimal decimals (grouped, en-pinned — SSR-hydration-safe);
 * sub-cent values keep 2 significant digits ($0.00000043) instead of rounding
 * to $0.000000. `{compact: true}` → $60.9M; `{decimals}` overrides the policy.
 */
export function usd(value: Numberish, opts: UsdOptions = {}): string {
	if (value == null) return NO_DATA;
	return new Intl.NumberFormat("en-US", usdIntlOptions(value, opts)).format(
		value,
	);
}
