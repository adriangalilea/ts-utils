import { getOptimalDecimals, getSymbol, isFiat, isStablecoin } from './currency/index.js';
/**
 * Format utilities for numbers and currencies
 */
class FormatOps {
    /**
     * Format a number with specified decimal places
     */
    number(value, decimals) {
        return value.toFixed(decimals);
    }
    /**
     * Format a value as USD with optimal decimals
     */
    usd(value) {
        const decimals = getOptimalDecimals(value, 'USD');
        const formatted = Math.abs(value).toFixed(decimals);
        return value < 0 ? `-$${formatted}` : `$${formatted}`;
    }
    /**
     * Format a value as Bitcoin with optimal decimals
     */
    btc(value) {
        const decimals = getOptimalDecimals(value, 'BTC');
        return `${value.toFixed(decimals)} ₿`;
    }
    /**
     * Format a value as Ethereum with optimal decimals
     */
    eth(value) {
        const decimals = getOptimalDecimals(value, 'ETH');
        return `${value.toFixed(decimals)} Ξ`;
    }
    /**
     * Auto format a value with the appropriate currency symbol and decimals
     */
    auto(value, currencyCode) {
        const decimals = getOptimalDecimals(value, currencyCode);
        const symbol = getSymbol(currencyCode);
        const formatted = Math.abs(value).toFixed(decimals);
        // Put symbol before for fiat/stablecoins, after for crypto
        if (isFiat(currencyCode) || isStablecoin(currencyCode)) {
            return value < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
        }
        else {
            return value < 0 ? `-${formatted} ${symbol}` : `${formatted} ${symbol}`;
        }
    }
    /**
     * Format a percentage with smart decimal places
     */
    percentage(value) {
        let decimals = 1;
        if (Math.abs(value) < 0.1) {
            decimals = 2;
        }
        else if (Math.abs(value) >= 100) {
            decimals = 0;
        }
        return `${value.toFixed(decimals)}%`;
    }
    /**
     * Format a value with thousands separators
     */
    withCommas(value, decimals) {
        const fixed = decimals !== undefined ? value.toFixed(decimals) : value.toString();
        const parts = fixed.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }
    /**
     * Format a value in compact notation (1.2K, 3.4M, etc)
     */
    compact(value) {
        const formatter = new Intl.NumberFormat('en', {
            notation: 'compact',
            maximumFractionDigits: 1
        });
        return formatter.format(value);
    }
}
export const format = new FormatOps();
//# sourceMappingURL=format.js.map