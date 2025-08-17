/**
 * Format utilities for numbers and currencies
 */
declare class FormatOps {
    /**
     * Format a number with specified decimal places
     */
    number(value: number, decimals: number): string;
    /**
     * Format a value as USD with optimal decimals
     */
    usd(value: number): string;
    /**
     * Format a value as Bitcoin with optimal decimals
     */
    btc(value: number): string;
    /**
     * Format a value as Ethereum with optimal decimals
     */
    eth(value: number): string;
    /**
     * Auto format a value with the appropriate currency symbol and decimals
     */
    auto(value: number, currencyCode: string): string;
    /**
     * Format a percentage with smart decimal places
     */
    percentage(value: number): string;
    /**
     * Format a value with thousands separators
     */
    withCommas(value: number, decimals?: number): string;
    /**
     * Format a value in compact notation (1.2K, 3.4M, etc)
     */
    compact(value: number): string;
}
export declare const format: FormatOps;
export declare const Format: FormatOps;
export default format;
//# sourceMappingURL=format.d.ts.map