// Currency — split by dependency weight so tree-shaking works at file
// granularity. The 133KB crypto-symbol dataset is imported ONLY by
// ./classify.ts; a bundler resolving `import { usd } from '…/currency'`
// through this barrel keeps usd.ts and drops everything else
// (`sideEffects: false`). The one-file era made that impossible: usd and
// isCrypto shared a module, so printing "$0.43" shipped 13k tickers.
//
//   symbols.ts   display symbols for the majors        dataset-free
//   usd.ts       usd / usdIntlOptions / usdDecimals    dataset-free (guaranteed)
//   percent.ts   percentage/bps arithmetic             dataset-free
//   classify.ts  isCrypto/isFiat/normalize/…           THE dataset importer
//   decimals.ts  getOptimalDecimals                    dataset via classify
//   money.ts     money/btc/eth                         dataset via decimals

export * from "./classify.js";
export * from "./decimals.js";
export * from "./money.js";
export * from "./percent.js";
export * from "./symbols.js";
export * from "./usd.js";

import {
	areEquivalent,
	getVariations,
	isCrypto,
	isFiat,
	isStablecoin,
	normalize,
} from "./classify.js";
import { getOptimalDecimals } from "./decimals.js";
import { btc, eth, money } from "./money.js";
import {
	basisPointsToPercent,
	formatBasisPoints,
	percentageChange,
	percentageDiff,
	percentageOf,
	percentToBasisPoints,
} from "./percent.js";
import { CurrencySymbols, getSymbol } from "./symbols.js";
import { usd, usdIntlOptions } from "./usd.js";

// Namespace convenience — importing it opts into EVERYTHING (dataset
// included); prefer named imports in bundle-sensitive code.
export const currency = {
	getSymbol,
	getOptimalDecimals,
	normalize,
	areEquivalent,
	getVariations,
	isCrypto,
	isStablecoin,
	isFiat,
	percentageOf,
	percentageChange,
	percentageDiff,
	basisPointsToPercent,
	percentToBasisPoints,
	formatBasisPoints,
	usd,
	usdIntlOptions,
	btc,
	eth,
	money,
	symbols: CurrencySymbols,
};
