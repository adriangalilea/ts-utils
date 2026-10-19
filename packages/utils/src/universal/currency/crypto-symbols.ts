import { cryptoSymbolsData } from "./crypto-symbols-data.js";

// The Set builds on FIRST LOOKUP, not at import: the dataset is ~133KB and
// most consumers of the currency module never ask "is this crypto?". Laziness
// costs one `??=`; eagerness costs every import a startup parse of 8k symbols.
let cryptoSymbols: Set<string> | undefined;

/**
 * Check if a symbol is a known cryptocurrency (case-insensitive).
 * Backed by the CoinGecko list in crypto-symbols-data.ts —
 * run 'npm run update-crypto' to refresh.
 *
 * @example
 * isCryptoSymbol("BTC") // true
 * isCryptoSymbol("btc") // true
 * isCryptoSymbol("DOGE") // true
 */
export function isCryptoSymbol(symbol: string): boolean {
	cryptoSymbols ??= new Set(cryptoSymbolsData);
	return cryptoSymbols.has(symbol.toUpperCase());
}
