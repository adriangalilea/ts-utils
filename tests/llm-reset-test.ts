// Failover repaint contract: an attempt that reached the consumer ONLY through
// tool events (tool-input-delta / tool-call) and then died must still order a
// `reset` before the replacement provider streams — otherwise stale tool calls
// mix with the next attempt's response (the xtldr followup bug, reported by
// Melon 2026-08-07). Providers are faked via ProviderConfig.fetch, no network.
// Run: pnpm test:llm-reset
import assert from "node:assert/strict";
import { jsonSchema, tool } from "ai";
import { createLlm } from "../src/llm/index.js";
import { setLogFormat } from "../src/universal/log.js";

// The request must DECLARE tools or the SDK's parser never surfaces tool parts.
const TOOLS = {
	add_quote: tool({
		description: "test tool",
		inputSchema: jsonSchema<Record<string, unknown>>({
			type: "object",
			properties: { text: { type: "string" } },
		}),
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
				setTimeout(
					() => controller.error(new Error("connection torn down")),
					20,
				);
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
			choices: [
				{ index: 0, delta: { content: "recovered" }, finish_reason: null },
			],
		}),
		JSON.stringify({
			id: "b1",
			object: "chat.completion.chunk",
			created: 0,
			model: "fake",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
		JSON.stringify({
			id: "b1",
			object: "chat.completion.chunk",
			created: 0,
			model: "fake",
			choices: [],
			usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
		}),
	]);

// The trace the calls write, as json events
setLogFormat("json");
const events: Record<string, unknown>[] = [];
const print = console.error;
console.error = (...a: unknown[]): void => {
	events.push(JSON.parse(String(a[0])) as Record<string, unknown>);
};

const llm = createLlm({
	providers: [
		{
			id: "dying",
			type: "openai",
			baseUrl: "http://fake.a/v1",
			defaultModel: "fake",
			priority: 1,
			fetch: fetchA,
		},
		{
			id: "healthy",
			type: "openai",
			baseUrl: "http://fake.b/v1",
			defaultModel: "fake",
			priority: 2,
			fetch: fetchB,
		},
	],
});

const kinds: string[] = [];
for await (const ev of llm.stream({
	prompt: "hi",
	tools: TOOLS,
	toolChoice: "auto",
}))
	kinds.push(ev.kind);

// The dying attempt must have surfaced its tool traffic, then a reset, then B's text.
const resetAt = kinds.indexOf("reset");
const toolAt = kinds.findIndex(
	(k) => k === "tool-input-delta" || k === "tool-call",
);
const deltaAt = kinds.indexOf("delta");
assert.notEqual(
	toolAt,
	-1,
	`no tool event reached the consumer: ${kinds.join(",")}`,
);
assert.notEqual(
	resetAt,
	-1,
	`no reset after a tool-only failed attempt: ${kinds.join(",")}`,
);
assert.ok(
	toolAt < resetAt && resetAt < deltaAt,
	`order wrong: ${kinds.join(",")}`,
);
assert.equal(kinds.at(-1), "end");
console.error = print;
console.log(
	`  PASS reset follows a tool-only failed attempt (${kinds.join(" → ")})`,
);

// The call is one chat span; each provider tried an attempt span inside it, the
// failed one ending in error, the one that answered with its timings and tokens.
type Ev = {
	msg: string;
	phase?: string;
	status?: string;
	span_id?: string;
	parent_id?: string;
	fields?: Record<string, unknown>;
};
const ends = (events as Ev[]).filter((e) => e.phase === "end");
const chat = ends.find((e) => e.msg === "chat");
const attempts = ends.filter((e) => e.msg === "attempt");
assert.ok(chat, "no chat span");
assert.equal(chat.status, "ok");
assert.equal(chat.fields?.kind, "inference");
assert.equal(chat.fields?.["gen_ai.provider.name"], "healthy");
assert.equal(chat.fields?.["gen_ai.usage.input_tokens"], 12);
assert.deepEqual(
	attempts.map((a) => [a.parent_id, a.status, a.fields?.["server.address"]]),
	[
		[chat.span_id, "error", "fake.a"],
		[chat.span_id, "ok", "fake.b"],
	],
);
const ok = attempts[1]?.fields ?? {};
assert.ok(
	typeof ok.ttft_ms === "number" && typeof ok.decode_ms === "number",
	`no timings: ${JSON.stringify(ok)}`,
);
assert.equal(ok["gen_ai.usage.output_tokens"], 3);
console.log("  PASS the call and each attempt are spans with gen_ai fields");

// What reaches the server: extraBody's raw fields (snake_case included, which the AI
// SDK's provider options would drop) and a system message given in the OpenAI shape.
let sent: Record<string, unknown> = {};
const capturing: typeof globalThis.fetch = async (_url, init) => {
	sent = JSON.parse(String(init?.body));
	return fetchB(_url, init);
};
const probe = createLlm({
	providers: [
		{
			id: "probe",
			type: "openai",
			baseUrl: "http://fake.c/v1",
			defaultModel: "fake",
			fetch: capturing,
		},
	],
});
await probe.complete({
	messages: [
		{ role: "system", content: "You answer in JSON." },
		{ role: "user", content: "hi" },
	],
	extraBody: { reasoning_effort: "none", think: false },
});
const wire = sent.messages as { role: string; content: string }[];
assert.equal(sent.reasoning_effort, "none", JSON.stringify(sent));
assert.equal(sent.think, false, JSON.stringify(sent));
assert.ok(
	wire.some((m) => m.role === "system" && m.content.includes("JSON")),
	`the system text did not reach the server: ${JSON.stringify(wire)}`,
);
console.log("  PASS extraBody and a system message reach the server");
console.log("\n3 passed");
