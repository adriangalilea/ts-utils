/**
 * Assert-based checks for the `cli/text` primitives — width/clip must stay
 * grapheme-aware and ANSI-transparent or every table in every consumer drifts.
 *
 *   pnpm test:text
 */
import { strict as assert } from "node:assert";
import { clip, width } from "../src/cli/text.js";

// width: graphemes, not code points
assert.equal(width("hello"), 5);
assert.equal(width("👨‍👩‍👧"), 1); // ZWJ family — 5 code points, one visible symbol
assert.equal(width("🇪🇸 flag"), 6); // flag pair counts as one
assert.equal(width("café"), 4);

// width: ANSI-transparent
assert.equal(width("\x1b[32mok\x1b[0m"), 2);
assert.equal(width("\x1b[1m\x1b[36mbold cyan\x1b[0m"), 9);

// clip: plain
assert.equal(clip("plain text here", 6), "plain…");
assert.equal(clip("short", 10), "short");

// clip: grapheme boundary — never cuts inside an emoji
assert.equal(clip("👨‍👩‍👧abcdef", 4), "👨‍👩‍👧ab…");

// clip: styled input stays styled, exactly one closing reset
assert.equal(clip("\x1b[36mhello world\x1b[0m", 8), "\x1b[36mhello w…\x1b[0m");
assert.equal(
	clip("\x1b[36mhello\x1b[0m world", 8),
	"\x1b[36mhello\x1b[0m w…\x1b[0m",
);

console.log("✓ text-test: width/clip hold");
