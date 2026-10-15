/**
 * Assert-based checks for the `cli/text` primitives — width/clip must stay
 * grapheme-aware and ANSI-transparent or every table in every consumer drifts.
 *
 *   pnpm test:text
 */
import { strict as assert } from "node:assert";
import { clip, width } from "../src/cli/text.js";

// width: terminal cells per grapheme, not code points
assert.equal(width("hello"), 5);
assert.equal(width("👨‍👩‍👧"), 2); // ZWJ family — 5 code points, one wide symbol
assert.equal(width("🇪🇸 flag"), 7); // flag pair is one wide symbol
assert.equal(width("café"), 4);
assert.equal(width("日本"), 4); // CJK: two cells each
assert.equal(width("✓ ok"), 4); // text-presentation symbol: one cell

// width: ANSI-transparent
assert.equal(width("\x1b[32mok\x1b[0m"), 2);
assert.equal(width("\x1b[1m\x1b[36mbold cyan\x1b[0m"), 9);

// clip: plain
assert.equal(clip("plain text here", 6), "plain…");
assert.equal(clip("short", 10), "short");

// clip: grapheme boundary — never cuts inside an emoji, never splits a wide char
assert.equal(clip("👨‍👩‍👧abcdef", 4), "👨‍👩‍👧a…");
assert.equal(clip("日本語テキスト", 5), "日本…");

// clip: styled input stays styled, exactly one closing reset
assert.equal(clip("\x1b[36mhello world\x1b[0m", 8), "\x1b[36mhello w…\x1b[0m");
assert.equal(
	clip("\x1b[36mhello\x1b[0m world", 8),
	"\x1b[36mhello\x1b[0m w…\x1b[0m",
);

console.log("✓ text-test: width/clip hold");
