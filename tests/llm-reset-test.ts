// Failover repaint contract: an attempt that reached the consumer ONLY through
// tool events (tool-input-delta / tool-call) and then died must still order a
// `reset` before the replacement provider streams — otherwise stale tool calls
// mix with the next attempt's response (the xtldr followup bug, reported by
// Melon 2026-08-07). Providers are faked via ProviderConfig.fetch, no network.
// Run: pnpm test:llm-reset
import assert from "node:assert/strict";
import { jsonSchema, tool } from "ai";
import { createLlm } from "../src/llm/index.js";

// The request must DECLARE tools or the SDK's parser never surfaces tool parts.
const TOOLS = {
	add_quote: tool({
		description: "test tool",
		inputSchema: jsonSchema<Record<string, unknown>>({ type: "object", properties: { text: { type: "string" } } }),
	}),
};

const sse = (chunks: string[], opts: { dieAfter?: boolean } = {}) => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const c of chunks) controller.enqueue(enc.encode(`data: ${c}\n\n`));
			// Death must be ASYNC: erroring synchronously can outrun the SSE parser
			// draining the queued chunks, and then no tool part ever forms.
			if (opts.dieAfter)
				setTimeout(() => controller.error(new Error("connection torn down")), 20);
			else {
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			}
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};

// Provider A: streams one tool_calls argument delta, then the connection dies.
const fetchA: typeof globalThis.fetch = async () =>
	sse(
		[
			JSON.stringify({
				id: "a1",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "add_quote", arguments: '{"text":"hal' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
		],
		{ dieAfter: true },
	);

// Provider B: a clean text completion.
const fetchB: typeof globalThis.fetch = async () =>
	sse([
		JSON.stringify({
			id: "b1",
			object: "chat.completion.chunk",
			created: 0,
			model: "fake",
			choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "b1",
			object: "chat.completion.chunk",
			created: 0,
			model: "fake",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
	]);

const llm = createLlm({
	providers: [
		{ id: "dying", type: "openai", baseUrl: "http://fake.a/v1", defaultModel: "fake", priority: 1, fetch: fetchA },
		{ id: "healthy", type: "openai", baseUrl: "http://fake.b/v1", defaultModel: "fake", priority: 2, fetch: fetchB },
	],
});

const kinds: string[] = [];
for await (const ev of llm.stream({ prompt: "hi", tools: TOOLS, toolChoice: "auto" })) kinds.push(ev.kind);

// The dying attempt must have surfaced its tool traffic, then a reset, then B's text.
const resetAt = kinds.indexOf("reset");
const toolAt = kinds.findIndex((k) => k === "tool-input-delta" || k === "tool-call");
const deltaAt = kinds.indexOf("delta");
assert.notEqual(toolAt, -1, `no tool event reached the consumer: ${kinds.join(",")}`);
assert.notEqual(resetAt, -1, `no reset after a tool-only failed attempt: ${kinds.join(",")}`);
assert.ok(toolAt < resetAt && resetAt < deltaAt, `order wrong: ${kinds.join(",")}`);
assert.equal(kinds.at(-1), "end");
console.log(`  PASS reset follows a tool-only failed attempt (${kinds.join(" → ")})`);
console.log("\n1 passed");
