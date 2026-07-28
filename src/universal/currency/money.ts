// Symbol-aware money formatting. Reaches the dataset only through
// getOptimalDecimals' unknown-ticker fallback and isFiat/isStablecoin —
// callers passing arbitrary codes accept that; USD-only rendering belongs
// to ./usd.ts.

import { NO_DATA, type Numberish } from "../format.js";
import { isFiat, isStablecoin } from "./classify.js";
import { getOptimalDecimals } from "./decimals.js";
import { getSymbol } from "./symbols.js";

/** Bitcoin with optimal decimals: 0.00001234 ₿ */
export function btc(value: Numberish): string {
	if (value == null) return NO_DATA;
	return `${value.toFixed(getOptimalDecimals(value, "BTC"))} ₿`;
}

/** Ethereum with optimal decimals: 0.123 Ξ */
export function eth(value: Numberish): string {
	if (value == null) return NO_DATA;
	return `${value.toFixed(getOptimalDecimals(value, "ETH"))} Ξ`;
}

/**
 * Format a value in any currency: symbol before for fiat/stablecoins
 * (`$12.34`), after for crypto (`0.5 ₿`), optimal decimals + thousands
 * grouping either way (en-pinned — SSR-hydration-safe).
 */
export function money(value: Numberish, currencyCode: string): string {
	if (value == null) return NO_DATA;
	const decimals = getOptimalDecimals(value, currencyCode);
	const symbol = getSymbol(currencyCode);
	const formatted = new Intl.NumberFormat("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	}).format(Math.abs(value));
	if (isFiat(currencyCode) || isStablecoin(currencyCode)) {
		return value < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
	}
	return value < 0 ? `-${formatted} ${symbol}` : `${formatted} ${symbol}`;
}
