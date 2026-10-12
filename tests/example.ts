import {
	compact,
	currency,
	log,
	percentage,
	withCommas,
} from "../src/index.js";

console.log("\n=== Logger Examples ===\n");

// A message, then optional fields
log.wait("loading resources");
log.step("resolving config", { path: "./config.toml" });
log.info("listening", { port: 8080 });
log.success("migrated", { tables: 12 });
log.warn("retrying", { attempt: 2 });
log.error("charge failed", { err: new Error("card declined") });
log.fail("deploy failed");
log.trace("selector fired");
log.ready("server ready");

// Once per message and scope
log.warnOnce("config uses a deprecated key");
log.warnOnce("config uses a deprecated key");

// Scoped logger: lines carry [api], level reads API_LOG_LEVEL first
const api = log.scope("api");
api.info("request received", { path: "/charge" });
api.scope("auth").warn("token expiring", { in_s: 30 }); // [api auth]

// A span: what is written through it is indented under it and carries its id
await log.span("sync", { repo: "ui" }, async (s) => {
	s.info("cloned", { files: 3 });
	await s.span("build", async (c) => {
		c.step("compiling");
		await new Promise((r) => setTimeout(r, 50));
	});
	s.set({ pushed: true });
});

console.log("\n=== Currency Examples ===\n");

// Currency type checking
console.log('isCrypto("BTC"):', currency.isCrypto("BTC"));
console.log('isCrypto("XBT"):', currency.isCrypto("XBT")); // Alternative for BTC
console.log('isCrypto("WBTC"):', currency.isCrypto("WBTC")); // Wrapped BTC
console.log('isCrypto("USD"):', currency.isCrypto("USD"));
console.log('isStablecoin("USDT"):', currency.isStablecoin("USDT"));
console.log('isStablecoin("BTC"):', currency.isStablecoin("BTC"));
console.log('isFiat("USD"):', currency.isFiat("USD"));
console.log('isFiat("EUR"):', currency.isFiat("EUR"));
console.log('isFiat("BTC"):', currency.isFiat("BTC"));

// Currency symbols
console.log("\nCurrency Symbols:");
console.log("BTC:", currency.getSymbol("BTC"));
console.log("ETH:", currency.getSymbol("ETH"));
console.log("USD:", currency.getSymbol("USD"));
console.log("EUR:", currency.getSymbol("EUR"));
console.log("JPY:", currency.getSymbol("JPY"));

// Optimal decimals
console.log("\nOptimal Decimals:");
console.log(
	"0.00001234 BTC:",
	currency.getOptimalDecimals(0.00001234, "BTC"),
	"decimals",
);
console.log(
	"1234.56 USD:",
	currency.getOptimalDecimals(1234.56, "USD"),
	"decimals",
);
console.log(
	"0.123 ETH:",
	currency.getOptimalDecimals(0.123, "ETH"),
	"decimals",
);
console.log(
	"999999 JPY:",
	currency.getOptimalDecimals(999999, "JPY"),
	"decimals",
);

// Format examples
console.log("\nFormat Examples:");
console.log("USD:", currency.usd(1234.56));
console.log("BTC:", currency.btc(0.00001234));
console.log("ETH:", currency.eth(0.123));
console.log("Money USD:", currency.money(1234.56, "USD"));
console.log("Percentage:", percentage(12.5));
console.log("With commas:", withCommas(1234567.89, 2));
console.log("Compact:", compact(1234567));

// Percentage calculations
console.log("\nPercentage Calculations:");
console.log("25 is", `${currency.percentageOf(25, 100)}% of 100`);
console.log(
	"Change from 100 to 150:",
	`${currency.percentageChange(100, 150)}%`,
);
console.log(
	"Difference between 100 and 150:",
	`${currency.percentageDiff(100, 150)}%`,
);

// Basis points
console.log("\nBasis Points:");
console.log("100 bps =", `${currency.basisPointsToPercent(100)}%`);
console.log("2.5% =", currency.percentToBasisPoints(2.5), "bps");
console.log("Formatted:", currency.formatBasisPoints(50));

// Wait for timer to complete
setTimeout(() => {
	console.log("\n✨ Example completed!");
}, 150);
