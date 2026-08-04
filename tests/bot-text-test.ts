// bot/text contract: deterministic fitting under Telegram's 4096 limit
// (footer-preserving, surrogate-safe) and the not-modified edit no-op.
// Run: pnpm test:bot-text
import assert from "node:assert/strict";
import { fitTelegramText, isNotModified } from "../src/bot/text.js";

// Long text fits, keeps its short source footer, and marks the cut.
const footer = "\n\nSource: https://example.com/article";
const fitted = fitTelegramText(`${"word ".repeat(1200)}${footer}`, {
	maxChars: 256,
	preserveFinalBlock: true,
});
assert.ok(fitted.length <= 256);
assert.ok(fitted.includes("…"));
assert.ok(fitted.endsWith(footer));

// A surrogate pair is never split at the truncation boundary.
const emoji = fitTelegramText(`${"a".repeat(20)}😀tail`, { maxChars: 22 });
assert.ok(emoji.length <= 22);
assert.equal(/[\uD800-\uDBFF]$/.test(emoji), false);

// Text within the limit passes through untouched.
assert.equal(
	fitTelegramText("already short", { maxChars: 32 }),
	"already short",
);

// Telegram's edit no-op is recognized in Error and string shapes alike.
assert.equal(isNotModified(new Error("400: message is not modified")), true);
assert.equal(isNotModified("Bad Request: message is not modified"), true);
assert.equal(isNotModified(new Error("message to edit not found")), false);

console.log("✅ bot/text contract holds");
