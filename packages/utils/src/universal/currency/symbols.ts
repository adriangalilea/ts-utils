// Display symbols for the majors. Tiny and dataset-free — classification of
// the 13k-ticker long tail lives in ./classify.ts, the ONLY module that
// imports the crypto-symbol dataset.

export const CurrencySymbols = {
	BTC: "₿",
	XBT: "₿",
	ETH: "Ξ",
	USD: "$",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
	CNY: "¥",
	KRW: "₩",
	INR: "₹",
	RUB: "₽",
	TRY: "₺",
	AUD: "A$",
	CAD: "C$",
	CHF: "Fr",
	HKD: "HK$",
	SGD: "S$",
	NZD: "NZ$",
	SEK: "kr",
	NOK: "kr",
	DKK: "kr",
	PLN: "zł",
	THB: "฿",
	USDT: "₮",
	USDC: "$",
	DAI: "$",
	BUSD: "$",
} as const;

export type CurrencyCode = keyof typeof CurrencySymbols | string;

export function getSymbol(code: string): string {
	return CurrencySymbols[code as keyof typeof CurrencySymbols] || code;
}
