// Ticker classification + normalization. This is the ONLY module that
// imports the crypto-symbol dataset (133KB, 13k tickers) — keeping the
// import here is what lets a bundler drop the dataset for consumers that
// only format money (./usd.ts, ./money.ts via the majors' switch cases).

import { isCryptoSymbol } from "./crypto-symbols.js";

// Alternative ticker mappings (some exchanges use different symbols)
const cryptoAlternatives: Record<string, string> = {
	XBT: "BTC", // BitMEX and some others use XBT for Bitcoin
	IOTA: "MIOTA", // IOTA vs MIOTA
	STR: "XLM", // Stellar old ticker
	BCHABC: "BCH", // Bitcoin Cash ABC
	BCHSV: "BSV", // Bitcoin SV
	DRK: "DASH", // Darkcoin old name
	XRB: "NANO", // RaiBlocks old name
	ANT: "ANT", // Could be Aragon
	BCC: "BCH", // Bittrex used BCC for Bitcoin Cash
	MIOTA: "IOTA", // Some use MIOTA
	YOYOW: "YOYOW", // Various formats
	IOTX: "IOTX", // IoTeX
	QSH: "QASH", // QASH variations
	YOYO: "YOYOW", // YOYOW variations
	ETHOS: "BQX", // Ethos old ticker
	REP: "REP", // Augur variations
	REPV2: "REP", // Augur v2
	USDt: "USDT", // Case variations
	"USDT.e": "USDT", // Avalanche USDT
	"USDC.e": "USDC", // Avalanche USDC
	"WBTC.e": "WBTC", // Avalanche WBTC
	"DAI.e": "DAI", // Avalanche DAI
	"BTC.b": "BTC", // Avalanche BTC
	BETH: "WBETH", // Binance ETH
	STETH: "STETH", // Lido staked ETH
	WSTETH: "WSTETH", // Wrapped stETH
};

// Build reverse mapping for normalization (alternative -> normalized)
const symbolReverseMap: Map<string, string> = new Map();
for (const [alternative, normalized] of Object.entries(cryptoAlternatives)) {
	// Only map if it's actually an alternative, not the same
	if (alternative !== normalized) {
		symbolReverseMap.set(alternative.toUpperCase(), normalized);
		symbolReverseMap.set(alternative.toLowerCase(), normalized);
	}
}

export function normalize(symbol: string): string {
	const upperSymbol = symbol.toUpperCase();

	// Check if it's a known alternative
	if (cryptoAlternatives[upperSymbol]) {
		return cryptoAlternatives[upperSymbol];
	}

	// Check reverse mapping
	const normalized =
		symbolReverseMap.get(upperSymbol) ||
		symbolReverseMap.get(symbol.toLowerCase());
	if (normalized) {
		return normalized;
	}

	// Handle wrapped/bridged tokens
	const unwrapped = upperSymbol
		.replace(/^W/, "") // Remove W prefix (WBTC -> BTC)
		.replace(/\.E$/, "") // Remove .e suffix (USDT.e -> USDT)
		.replace(/\.B$/, ""); // Remove .b suffix (BTC.b -> BTC)

	if (unwrapped !== upperSymbol && cryptoAlternatives[unwrapped]) {
		return cryptoAlternatives[unwrapped];
	}

	return upperSymbol;
}

export function areEquivalent(symbol1: string, symbol2: string): boolean {
	return normalize(symbol1) === normalize(symbol2);
}

export function getVariations(symbol: string): string[] {
	const normalized = normalize(symbol);
	const variations: Set<string> = new Set([normalized]);

	// Add all known alternatives
	for (const [key, value] of Object.entries(cryptoAlternatives)) {
		if (value === normalized || key === normalized) {
			variations.add(key);
			variations.add(value);
		}
	}

	return Array.from(variations);
}

export function isCrypto(code: string): boolean {
	const upperCode = code.toUpperCase();

	// Check if it's a known alternative
	if (cryptoAlternatives[upperCode]) {
		return isCryptoSymbol(cryptoAlternatives[upperCode]);
	}

	// Check if it's a wrapped or bridged token (common patterns)
	const unwrappedCode = upperCode
		.replace(/^W/, "") // Remove W prefix (WBTC -> BTC)
		.replace(/\.E$/, "") // Remove .e suffix (USDT.e -> USDT)
		.replace(/\.B$/, ""); // Remove .b suffix (BTC.b -> BTC)

	if (unwrappedCode !== upperCode) {
		return isCryptoSymbol(unwrappedCode);
	}

	return isCryptoSymbol(upperCode);
}

export function isStablecoin(code: string): boolean {
	const stablecoins = new Set([
		"USDT",
		"USDC",
		"DAI",
		"BUSD",
		"UST",
		"TUSD",
		"USDP",
		"GUSD",
		"FRAX",
		"LUSD",
	]);
	return stablecoins.has(code);
}

export function isFiat(code: string): boolean {
	const fiats = new Set([
		"USD",
		"EUR",
		"GBP",
		"JPY",
		"CNY",
		"CAD",
		"AUD",
		"CHF",
		"HKD",
		"SGD",
		"NZD",
		"KRW",
		"SEK",
		"NOK",
		"DKK",
		"PLN",
		"THB",
		"INR",
		"RUB",
		"TRY",
		"BRL",
		"MXN",
		"ARS",
		"CLP",
		"COP",
		"PEN",
		"UYU",
		"ZAR",
		"NGN",
		"KES",
	]);
	return fiats.has(code);
}
