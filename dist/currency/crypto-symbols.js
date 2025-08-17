import { cryptoSymbolsData } from './crypto-symbols-data.js';
/**
 * Set of all known cryptocurrency symbols
 * Contains ${symbolCount} symbols from CoinGecko API
 * Last updated: ${lastUpdated}
 * Run 'npm run update-crypto' to refresh
 */
export const cryptoSymbols = new Set(cryptoSymbolsData);
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
export function isCryptoSymbol(symbol) {
    return cryptoSymbols.has(symbol.toUpperCase());
}
//# sourceMappingURL=crypto-symbols.js.map