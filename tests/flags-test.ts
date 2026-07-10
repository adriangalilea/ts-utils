// bot/flags contract tests: declare-once resolution (override > default),
// tier-ladder lookup, kind screaming, set/clear round-trips, per-ctx read
// coalescing. Run: pnpm test:flags
import assert from "node:assert/strict";
import { defineFlags, flagValueOk, isTierMap } from "../src/bot/flags.js";
import { SourcedError } from "../src/offensive.js";

let pass = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
	Promise.resolve(fn()).then(() => {
		pass++;
		console.log("  PASS", name);
	});

// In-memory backend with RFC 7386 null-deletes, mirroring SQLite json_patch.
const makeBackend = () => {
	let store: Record<string, unknown> = {};
	let reads = 0;
	return {
		read: async () => {
			reads++;
			return { ...store };
		},
		write: async (_ctx: unknown, patch: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(patch)) {
				if (v === null) delete store[k];
				else store[k] = v;
			}
		},
		reads: () => reads,
		raw: () => store,
		seed: (s: Record<string, unknown>) => {
			store = s;
		},
	};
};

const ctxFree = () => ({ payments: { tier: () => "free" } });
const ctxVip = (n: number) => ({ payments: { tier: () => `vip.${n}` } });

const backend = makeBackend();
const flags = defineFlags(
	{
		richText: { kind: "bool", label: "rich text", default: true },
		maxInputChars: {
			kind: "number",
			label: "input clamp",
			default: { free: 50_000, vip: 250_000 },
		},
		model: {
			kind: "string",
			label: "model",
			help: "provider/model",
			default: { free: "flash", "vip.2": "sonnet" },
		},
	},
	backend,
);

await ok("scalar default resolves", async () => {
	assert.equal(await flags.richText(ctxFree()), true);
});

await ok("tiered default: free rung", async () => {
	assert.equal(await flags.maxInputChars(ctxFree()), 50_000);
});

await ok("tiered default: bare vip covers every rung", async () => {
	assert.equal(await flags.maxInputChars(ctxVip(1)), 250_000);
	assert.equal(await flags.maxInputChars(ctxVip(2)), 250_000);
});

await ok("ladder walks down: vip.1 inherits free when only vip.2 is set", async () => {
	assert.equal(await flags.model(ctxVip(1)), "flash");
	assert.equal(await flags.model(ctxVip(2)), "sonnet");
});

await ok("no payments ctx resolves as free", async () => {
	assert.equal(await flags.maxInputChars({}), 50_000);
});

await ok("override beats default; clear restores it", async () => {
	await flags.set(ctxFree(), "richText", false);
	assert.equal(await flags.richText(ctxFree()), false);
	await flags.set(ctxFree(), "richText", null);
	assert.equal(await flags.richText(ctxFree()), true);
});

await ok("scalar override flattens a tiered default for every tier", async () => {
	await flags.set(ctxFree(), "maxInputChars", 111);
	assert.equal(await flags.maxInputChars(ctxVip(2)), 111);
	await flags.set(ctxFree(), "maxInputChars", null);
});

await ok("tiered override on a scalar default", async () => {
	await flags.set(ctxFree(), "model", { free: "flash", "vip.1": "pro" });
	assert.equal(await flags.model(ctxVip(1)), "pro");
	assert.equal(await flags.model(ctxVip(2)), "pro");
	await flags.set(ctxFree(), "model", null);
});

await ok("set screams on kind mismatch", async () => {
	await assert.rejects(
		() => flags.set(ctxFree(), "richText", 5),
		(e: unknown) => e instanceof SourcedError && e.operation === "set",
	);
});

await ok("corrupt stored override screams on read", async () => {
	backend.seed({ maxInputChars: "not a number" });
	await assert.rejects(
		() => flags.maxInputChars(ctxFree()),
		(e: unknown) => e instanceof SourcedError && e.operation === "resolve",
	);
	backend.seed({});
});

await ok("describe carries the schema panels render from", () => {
	const d = flags.describe();
	assert.deepEqual(
		d.map((x) => [x.key, x.kind, x.tiered]),
		[
			["richText", "bool", false],
			["maxInputChars", "number", true],
			["model", "string", true],
		],
	);
	assert.equal(d[2]?.help, "provider/model");
});

await ok("overrides() lists only real overrides", async () => {
	await flags.set(ctxFree(), "richText", false);
	assert.deepEqual(await flags.overrides(ctxFree()), { richText: false });
	await flags.set(ctxFree(), "richText", null);
	assert.deepEqual(await flags.overrides(ctxFree()), {});
});

await ok("reads coalesce per ctx", async () => {
	const before = backend.reads();
	const ctx = ctxFree();
	await Promise.all([flags.richText(ctx), flags.maxInputChars(ctx), flags.model(ctx)]);
	assert.equal(backend.reads() - before, 1);
});

await ok("set on the same ctx invalidates its cached read", async () => {
	const ctx = ctxFree();
	assert.equal(await flags.richText(ctx), true);
	await flags.set(ctx, "richText", false);
	assert.equal(await flags.richText(ctx), false);
	await flags.set(ctx, "richText", null);
});

await ok("get() resolves by runtime key, panics on unknown", async () => {
	assert.equal(await flags.get(ctxVip(2), "maxInputChars"), 250_000);
	assert.throws(() => void flags.get(ctxFree(), "nope" as never));
});

await ok("flagValueOk is the exported write rule external writers share", () => {
	assert.equal(flagValueOk("number", 5), true);
	assert.equal(flagValueOk("number", { free: 5, "vip.2": 9 }), true);
	assert.equal(flagValueOk("number", { free: 5, vip: "nope" }), false);
	assert.equal(flagValueOk("bool", "true"), false);
	assert.equal(isTierMap({ free: 1 }), true);
	assert.equal(isTierMap(1), false);
});

await ok("reserved names panic at construction", () => {
	assert.throws(() =>
		defineFlags({ describe: { kind: "bool", label: "x", default: true } }, backend),
	);
});

await ok("bad default panics at construction", () => {
	assert.throws(() =>
		defineFlags(
			{ x: { kind: "number", label: "x", default: "nope" as unknown as number } },
			backend,
		),
	);
});

console.log(`\nflags: ${pass} tests passed`);
