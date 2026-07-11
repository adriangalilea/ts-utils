// bot/user contract tests: the conditional [name] [@username] [id] composition,
// both gramio spellings. Run: pnpm test:user
import assert from "node:assert/strict";
import { userLabel } from "../src/bot/user.js";

let pass = 0;
const ok = (name: string, fn: () => void) => {
	fn();
	pass++;
	console.log("  PASS", name);
};

ok("full identity", () => {
	assert.equal(
		userLabel({ id: 42, username: "ada", firstName: "Ada", lastName: "Lovelace" }),
		"Ada Lovelace (@ada · 42)",
	);
});

ok("each missing piece drops, never pads", () => {
	assert.equal(userLabel({ id: 42, firstName: "Ada" }), "Ada (42)");
	assert.equal(userLabel({ id: 42, username: "ada" }), "@ada (42)");
	assert.equal(userLabel({ id: 42 }), "id 42");
	assert.equal(userLabel({ username: "ada" }), "@ada");
	assert.equal(userLabel({ firstName: "Ada" }), "Ada");
	assert.equal(userLabel({}), "unknown");
});

ok("raw payload spelling (first_name/last_name) reads the same", () => {
	assert.equal(
		userLabel({ id: 42, username: "ada", first_name: "Ada", last_name: "Lovelace" }),
		"Ada Lovelace (@ada · 42)",
	);
	// camelCase wins when both spellings are present (a wrapper carries both).
	assert.equal(userLabel({ id: 1, firstName: "Wrapper", first_name: "Raw" }), "Wrapper (1)");
});

console.log(`\n${pass} passed`);
