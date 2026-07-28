// Per-currency optimal-decimals policy. Depends on ./classify.ts (the
// dataset) ONLY for the unknown-ticker fallback — the majors resolve in the
// switch. Consumers that call this with arbitrary codes accept the dataset;
// USD-only consumers should use usdDecimals/usd from ./usd.ts, which never
// touch it.

import { sigDecimals } from "../format.js";
import { isCrypto } from "./classify.js";
import { usdDecimals } from "./usd.js";

export function getOptimalDecimals(
	value: number,
	currencyCode: string,
): number {
	if (value === 0) {
		return isCrypto(currencyCode) ? 8 : 2;
	}

	const absValue = Math.abs(value);

	switch (currencyCode) {
		case "BTC":
		case "XBT":
			if (absValue < 0.00001) return 10;
			else if (absValue < 0.0001) return 9;
			else if (absValue < 0.001) return 8;
			else if (absValue < 0.01) return 7;
			else if (absValue < 0.1) return 6;
			else if (absValue < 1) return 5;
			else return 4;

		case "ETH":
			if (absValue < 0.001) return 8;
			else if (absValue < 0.01) return 7;
			else if (absValue < 0.1) return 6;
			else if (absValue < 1) return 5;
			else return 4;

		case "USD":
		case "USDT":
		case "USDC":
		case "DAI":
		case "BUSD":
			return usdDecimals(value);

		case "EUR":
		case "GBP":
		case "CAD":
		case "AUD":
		case "CHF":
			if (absValue < 0.01) return 4;
			else if (absValue < 1000) return 2;
			else return 0;

		case "JPY":
		case "KRW":
			if (absValue < 1) return 2;
			else return 0;
	}

	if (isCrypto(currencyCode)) {
		if (absValue < 0.00001) return sigDecimals(absValue);
		else if (absValue < 0.0001) return 6;
		else if (absValue < 0.001) return 5;
		else if (absValue < 0.01) return 4;
		else if (absValue < 0.1) return 3;
		else if (absValue < 1) return 3;
		else return 2;
	} else {
		if (absValue < 0.01) return sigDecimals(absValue);
		else if (absValue < 0.1) return 3;
		else if (absValue < 1000) return 2;
		else return 0;
	}
}
