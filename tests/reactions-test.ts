/**
 * Assert-based checks for `bot/reactions` — the arbitration guarantees must
 * hold or independent features clobber each other's reactions again (the
 * exact bug: a side-feature's 🤷 landing over a successful summary's 🫡).
 *
 *   pnpm test:reactions
 */
import { strict as assert } from "node:assert";
import { type ReactionCtx, reactionPolicy } from "../src/bot/reactions.js";

function fakeCtx(chatId: number, id: number): ReactionCtx & { calls: string[] } {
	const calls: string[] = [];
	return {
		chatId,
		id,
		calls,
		react: (emoji: string) => {
			calls.push(emoji);
			return Promise.resolve();
		},
	};
}

const policy = () =>
	reactionPolicy({
		working: { emoji: "🫡", rank: 1 },
		offTopic: { emoji: "🤷", rank: 2 },
		failed: { emoji: "👎", rank: 3 },
		done: { emoji: "🫡", rank: 4 },
		outOfCredits: { emoji: "🙏", rank: 5 },
	});

// The motivating bug: after done, a side-feature's shrug must NOT land.
{
	const p = policy();
	const ctx = fakeCtx(1, 10);
	const r = p.for(ctx);
	assert.equal(await r.set("working"), true);
	assert.equal(await r.set("done"), true); // same emoji → no second API call
	assert.equal(await r.set("offTopic"), false); // outranked → rejected
	assert.deepEqual(ctx.calls, ["🫡"]); // exactly ONE api call, zero flicker
	assert.equal(r.state(), "done");
}

// On a fresh message the same shrug applies (the reply-handler case).
{
	const p = policy();
	const ctx = fakeCtx(1, 11);
	assert.equal(await p.for(ctx).set("offTopic"), true);
	assert.deepEqual(ctx.calls, ["🤷"]);
}

// Idempotent: re-setting the current state makes no API call.
{
	const p = policy();
	const ctx = fakeCtx(1, 12);
	const r = p.for(ctx);
	await r.set("working");
	assert.equal(await r.set("working"), true);
	assert.deepEqual(ctx.calls, ["🫡"]);
}

// Higher rank with a DIFFERENT emoji does react (working → failed → outOfCredits).
{
	const p = policy();
	const ctx = fakeCtx(1, 13);
	const r = p.for(ctx);
	await r.set("working");
	await r.set("failed");
	await r.set("outOfCredits");
	assert.deepEqual(ctx.calls, ["🫡", "👎", "🙏"]);
	assert.equal(await r.set("done"), false); // done (4) < outOfCredits (5)
}

// Messages are isolated; two handles for the SAME message share state.
{
	const p = policy();
	const a = fakeCtx(1, 14);
	const b = fakeCtx(1, 14); // same message, different ctx object (another handler)
	const c = fakeCtx(2, 14); // different chat
	await p.for(a).set("done");
	assert.equal(await p.for(b).set("offTopic"), false); // arbitrated across handlers
	assert.equal(await p.for(c).set("offTopic"), true); // other chat unaffected
}

// react() failures are swallowed and the state still advances.
{
	const p = policy();
	const ctx: ReactionCtx = { chatId: 1, id: 15, react: () => Promise.reject(new Error("boom")) };
	const r = p.for(ctx);
	assert.equal(await r.set("failed"), true);
	assert.equal(r.state(), "failed");
}

// Unknown states scream (a typo must not silently no-op).
{
	const p = policy();
	await assert.rejects(() => p.for(fakeCtx(1, 16)).set("nope" as never), /unknown reaction state/);
}

console.log("✓ reactions-test: arbitration, idempotency, no-flicker, isolation hold");
