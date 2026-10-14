// Tool-input repair contract (`mended`): a list or object a model wrote as a string of
// JSON is read back in its place, and fields that string swallowed come back beside it.
// The first case is a local model's real end call (Synergym invoices, 2026-10-14): told
// "expected array, received string", it sent the same call until its budget ran out.
// Run: pnpm test:llm-mend
import assert from "node:assert/strict";
import type { JSONSchema7 } from "ai";
import { mended } from "../src/llm/index.js";

/** A test that held, said; the summary counts them. */
let passed = 0;
const pass = (what: string): void => {
	passed++;
	console.log(`  PASS ${what}`);
};

const END: JSONSchema7 = {
	type: "object",
	properties: {
		why: { type: "string" },
		found: { type: "array", items: { type: "object" } },
		verdict: { type: "string" },
	},
	required: ["found", "verdict"],
};

const rows = [
	{ invoice: "F2026/000529", month: "Enero, 2026", file: "Factura.pdf" },
	{ invoice: "F2026/000530", month: "Febrero, 2026", file: "Factura (2).pdf" },
];
const verdict = "Descargué las 2 facturas nominativas.";

// The real shape: `found` a string holding the list and, after it, the verdict field
{
	const swallowed = `${JSON.stringify(rows)}, "verdict": ${JSON.stringify(verdict)}}`;
	const input = JSON.stringify({ why: "all downloaded", found: swallowed });
	const out = JSON.parse(mended(input, END) ?? "null");
	assert.deepEqual(out, { why: "all downloaded", found: rows, verdict });
	pass("a list that swallowed the next field: both back in place");
}

// The list alone as a string
{
	const input = JSON.stringify({ found: JSON.stringify(rows), verdict });
	assert.deepEqual(JSON.parse(mended(input, END) ?? "null"), {
		found: rows,
		verdict,
	});
	pass("a list written as a string: parsed in place");
}

// A field a model filled as it should stays as it is, and nothing to mend is null
assert.equal(mended(JSON.stringify({ found: rows, verdict }), END), null);
pass("a valid input: nothing to mend");

// A string where the schema asks for a string is never touched
{
	const input = JSON.stringify({ found: rows, verdict: "[1, 2]" });
	assert.equal(mended(input, END), null);
	pass("a string field holding JSON-like text: left alone");
}

// A string that is not JSON stays the model's to fix
assert.equal(
	mended(JSON.stringify({ found: "Factura.pdf", verdict }), END),
	null,
);
pass("a string that is no JSON: left for the model");

// anyOf with an array branch counts as structured
{
	const schema: JSONSchema7 = {
		type: "object",
		properties: { found: { anyOf: [{ type: "array" }, { type: "null" }] } },
	};
	const input = JSON.stringify({ found: JSON.stringify(rows) });
	assert.deepEqual(JSON.parse(mended(input, schema) ?? "null"), {
		found: rows,
	});
	pass("an anyOf with a list: parsed in place");
}

console.log(`\n${passed} passed`);
