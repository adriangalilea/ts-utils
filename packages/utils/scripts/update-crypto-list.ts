#!/usr/bin/env tsx
/**
 * Downloads the latest cryptocurrency symbols from the CoinGecko API into
 * src/universal/currency/crypto-symbols-data.ts.
 *
 * Usage: pnpm update-crypto
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/universal/currency",
);

async function downloadCryptoSymbols() {
	console.log("Fetching cryptocurrency list from CoinGecko...");

	try {
		const response = await fetch("https://api.coingecko.com/api/v3/coins/list");
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const coins = (await response.json()) as Array<{
			id: string;
			symbol: string;
			name: string;
		}>;

		// Exclude list for problematic/invalid symbols
		const excludeSymbols = new Set([
			"", // Empty string
			"!", // Just exclamation mark
			'"　"', // Quotes with full-width space
			"　", // Just full-width space
		]);

		// Extract and uppercase all symbols, remove duplicates and excluded ones
		const symbols = [...new Set(coins.map((coin) => coin.symbol.toUpperCase()))]
			.filter((symbol) => !excludeSymbols.has(symbol))
			.sort();

		const now = new Date().toISOString();

		// Generate TypeScript file content
		const tsContent = `/**
 * Generated on ${now}
 * ${symbols.length.toLocaleString()} cryptocurrency symbols from CoinGecko API
 * 
 * Run 'pnpm update-crypto' to refresh this list
 */

export const cryptoSymbolsData: readonly string[] = [
${symbols.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}
]

export const lastUpdated = "${now}"
export const symbolCount = ${symbols.length}
`;

		// Write to file
		const outputPath = join(OUT_DIR, "crypto-symbols-data.ts");
		writeFileSync(outputPath, tsContent, "utf-8");

		console.log(`✅ Generated ${outputPath}`);
		console.log(`   ${symbols.length.toLocaleString()} symbols`);
		console.log(`   Last updated: ${now}`);
	} catch (error) {
		console.error("❌ Error downloading crypto symbols:", error);
		process.exit(1);
	}
}

await downloadCryptoSymbols();
