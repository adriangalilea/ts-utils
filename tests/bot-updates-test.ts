/**
 * Assert-based checks for `bot/updates` — the destroy-on-read contract must hold:
 * peek passes NO offset (nothing confirmed, repeatable), drain persists via onBatch
 * BEFORE the offset advances (a crash re-delivers the unconfirmed tail), silence takes
 * several consecutive empty polls, and a 409 surfaces as a typed SourcedError.
 *
 *   pnpm test:bot-updates
 */
import { strict as assert } from "node:assert";
import { updateQueue } from "../src/bot/updates.js";
import { SourcedError } from "../src/offensive.js";

/** Minimal fake Bot API honoring getUpdates offset semantics: an offset CONFIRMS (destroys)
 *  everything below it. Events log interleaves server calls with test markers so ordering
 *  guarantees are assertable, not assumed. */
function fakeServer(ids: number[], { webhookUrl = "" } = {}) {
	let queue = ids.map((id) => ({ update_id: id }));
	const events: string[] = [];
	const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const method = String(url).split("/").pop() ?? "";
		const params = JSON.parse(String(init?.body ?? "{}"));
		if (method === "getWebhookInfo") {
			events.push("webhookInfo");
			return new Response(JSON.stringify({ ok: true, result: { url: webhookUrl, pending_update_count: queue.length } }));
		}
		if (method === "getUpdates") {
			if (webhookUrl) {
				return new Response(JSON.stringify({ ok: false, description: "terminated by setWebhook", error_code: 409 }));
			}
			if (params.offset !== undefined) queue = queue.filter((u) => u.update_id >= params.offset);
			events.push(params.offset === undefined ? "getUpdates(no offset)" : `getUpdates(offset=${params.offset})`);
			return new Response(JSON.stringify({ ok: true, result: queue.slice(0, params.limit ?? 100) }));
		}
		return new Response(JSON.stringify({ ok: false, description: "unknown method", error_code: 400 }));
	}) as typeof fetch;
	return { fetchImpl, events, size: () => queue.length };
}

// ── peek: no offset ever sent, nothing destroyed, repeatable ────────────────

{
	const server = fakeServer([10, 11, 12]);
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	const first = await q.peek({ limit: 2 });
	assert.equal(first.pending, 3);
	assert.equal(first.head.length, 2);
	assert.equal(first.webhookUrl, null);
	const second = await q.peek({ limit: 2 });
	assert.deepEqual(second.head, first.head); // repeatable: nothing was confirmed
	assert.equal(server.size(), 3);
	assert.ok(server.events.every((e) => !e.startsWith("getUpdates(offset")));
}

// ── peek with a webhook registered: count still reported, head empty, no 409 ─

{
	const server = fakeServer([1, 2], { webhookUrl: "https://example.invalid/hook" });
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	const peeked = await q.peek();
	assert.equal(peeked.webhookUrl, "https://example.invalid/hook");
	assert.equal(peeked.pending, 2);
	assert.deepEqual(peeked.head, []);
}

// ── drain: onBatch resolves BEFORE the confirming call, queue ends empty ────

{
	const server = fakeServer([1, 2, 3]);
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	const persisted: number[] = [];
	const result = await q.drain({
		limit: 2,
		timeoutS: 0,
		quietPolls: 2,
		onBatch: (batch) => {
			server.events.push(`persist(${batch.map((u) => u.update_id).join(",")})`);
			persisted.push(...batch.map((u) => u.update_id));
		},
	});
	assert.deepEqual(persisted, [1, 2, 3]);
	assert.equal(result.drained, 3);
	assert.equal(result.lastUpdateId, 3);
	assert.equal(server.size(), 0);
	// Every persist marker precedes the offset call that confirms its batch.
	const persistIdx = server.events.indexOf("persist(1,2)");
	const confirmIdx = server.events.indexOf("getUpdates(offset=3)");
	assert.ok(persistIdx !== -1 && confirmIdx !== -1 && persistIdx < confirmIdx);
}

// ── crash mid-drain: the unconfirmed tail survives and a re-run recovers it ─

{
	const server = fakeServer([1, 2]);
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	const persisted: number[] = [];
	await assert.rejects(
		q.drain({
			limit: 1,
			timeoutS: 0,
			onBatch: (batch) => {
				if (batch[0].update_id === 2) throw new Error("disk full");
				persisted.push(...batch.map((u) => u.update_id));
			},
		}),
	);
	assert.deepEqual(persisted, [1]);
	assert.equal(server.size(), 1); // update 2 was never confirmed — still server-side
	await q.drain({ limit: 1, timeoutS: 0, quietPolls: 1, onBatch: (batch) => persisted.push(...batch.map((u) => u.update_id)) });
	assert.deepEqual(persisted, [1, 2]); // nothing lost across the crash
}

// ── silence: exactly quietPolls consecutive empty polls end the drain ───────

{
	const server = fakeServer([]);
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	await q.drain({ timeoutS: 0, quietPolls: 3, onBatch: () => assert.fail("no batches exist") });
	assert.equal(server.events.filter((e) => e === "getUpdates(no offset)").length, 3);
}

// ── 409 (webhook or competing poller) is a typed error, never a silent retry ─

{
	const server = fakeServer([1], { webhookUrl: "https://example.invalid/hook" });
	const q = updateQueue({ token: "T", fetch: server.fetchImpl });
	await assert.rejects(
		q.drain({ timeoutS: 0, onBatch: () => {} }),
		(err: unknown) => err instanceof SourcedError && err.status === 409 && err.source === "telegram",
	);
}

console.log("✓ bot-updates-test: peek is free, drain is write-before-confirm, silence and 409 behave");
