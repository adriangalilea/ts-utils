/**
 * Set of all known cryptocurrency symbols
 * Contains ${symbolCount} symbols from CoinGecko API
 * Last updated: ${lastUpdated}
 * Run 'npm run update-crypto' to refresh
 */
export declare const cryptoSymbols: Set<string>;
/**
 * Check if a symbol is a known cryptocurrency
 * @param symbol - The symbol to check (case-insensitive)
 * @returns true if the symbol is in the crypto list
 *
 * @example
 * isCryptoSymbol("BTC") // true
 * isCryptoSymbol("btc") // true
 * isCryptoSymbol("ETH") // true
 * isCryptoSymbol("DOGE") // true
 */
export declare function isCryptoSymbol(symbol: string): boolean;
//# sourceMappingURL=crypto-symbols.d.ts.map