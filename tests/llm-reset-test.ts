// Failover repaint contract: an attempt that reached the consumer ONLY through
// tool events (tool-input-delta / tool-call) and then died must still order a
// `reset` before the replacement provider streams — otherwise stale tool calls
// mix with the next attempt's response (the xtldr followup bug, reported by
// Melon 2026-08-07). Providers are faked via ProviderConfig.fetch, no network.
// Run: pnpm test:llm-reset
import assert from "node:assert/strict";
import { jsonSchema, tool } from "ai";
// (jsonSchema also declares the structured-output tests' schema)
import { createLlm, LlmError, stepCountIs } from "../src/llm/index.js";
import { setLogFormat } from "../src/universal/log.js";

/** A test that held, said; the summary counts them. */
let passed = 0;
const pass = (what: string): void => {
	passed++;
	console.log(`  PASS ${what}`);
};

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
pass(
	`reset follows a tool-only failed attempt (${kinds.join(" → ")})`,
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
pass("the call and each attempt are spans with gen_ai fields");

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
pass("extraBody and a system message reach the server");

// Structured output: a server answering `text`, recording what it was sent.
const answering =
	(
		text: string,
		into: { body?: Record<string, unknown> },
	): typeof globalThis.fetch =>
	async (_url, init) => {
		into.body = JSON.parse(String(init?.body));
		return sse([
			JSON.stringify({
				id: "s",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake",
				choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
			}),
			JSON.stringify({
				id: "s",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
		]);
	};
// A plain JSON Schema checks nothing by itself: `validate` is what refuses a wrong shape
// (a zod schema validates on its own)
const step = jsonSchema<{ ref: string }>(
	{
		type: "object",
		properties: { ref: { type: "string" } },
		required: ["ref"],
		additionalProperties: false,
	},
	{
		validate: (value) =>
			typeof (value as { ref?: unknown })?.ref === "string"
				? { success: true, value: value as { ref: string } }
				: {
						success: false,
						error: new Error(`no ref in ${JSON.stringify(value)}`),
					},
	},
);
{
	const seen: { body?: Record<string, unknown> } = {};
	const enforcing = createLlm({
		providers: [
			{
				id: "enforcing",
				type: "openai",
				baseUrl: "http://fake.d/v1",
				defaultModel: "fake",
				structuredOutputs: true,
				fetch: answering('{"ref":"e3"}', seen),
			},
		],
	});
	const r = await enforcing.complete({ prompt: "which?", schema: step });
	assert.deepEqual(r.object, { ref: "e3" });
	const format = seen.body?.response_format as {
		type: string;
		json_schema?: { schema: unknown };
	};
	assert.equal(format.type, "json_schema", JSON.stringify(format));
	assert.deepEqual(
		(format.json_schema?.schema as { required: string[] }).required,
		["ref"],
	);
	pass(
		"a structuredOutputs provider gets the schema and the answer comes back parsed",
	);
}
{
	const seen: { body?: Record<string, unknown> } = {};
	const plain = createLlm({
		providers: [
			{
				id: "plain",
				type: "openai",
				baseUrl: "http://fake.e/v1",
				defaultModel: "fake",
				fetch: answering('{"ref":"e4"}', seen),
			},
		],
	});
	const r = await plain.complete({ prompt: "which?", schema: step });
	assert.deepEqual(r.object, { ref: "e4" });
	assert.equal(
		(seen.body?.response_format as { type: string }).type,
		"json_object",
	);
	const system = (
		seen.body?.messages as { role: string; content: string }[]
	).find((m) => m.role === "system");
	assert.ok(
		system?.content.includes('"required":["ref"]'),
		`the schema is not stated: ${JSON.stringify(seen.body?.messages)}`,
	);
	pass(
		"a provider without structuredOutputs is told the schema in its instructions",
	);
}
{
	const wrong: { body?: Record<string, unknown> } = {};
	const right: { body?: Record<string, unknown> } = {};
	const pair = createLlm({
		providers: [
			{
				id: "wrong",
				type: "openai",
				baseUrl: "http://fake.f/v1",
				defaultModel: "fake",
				priority: 1,
				fetch: answering('{"verb":"click"}', wrong),
			},
			{
				id: "right",
				type: "openai",
				baseUrl: "http://fake.g/v1",
				defaultModel: "fake",
				priority: 2,
				fetch: answering('{"ref":"e5"}', right),
			},
		],
	});
	const r = await pair.complete({ prompt: "which?", schema: step });
	assert.deepEqual(r.object, { ref: "e5" });
	assert.equal(r.usage === null || r.usage.provider === "right", true);
	pass(
		"an answer that does not match the schema fails its provider, the next answers",
	);
}
// The tool loop: a server that calls the tool on its first request and answers in
// words once it has the tool's result; `dies` tears its second request down.
const looping =
	(
		requests: Record<string, unknown>[],
		dies = false,
	): typeof globalThis.fetch =>
	async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push(body);
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			JSON.stringify({
				id: "l",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake",
				choices: [{ index: 0, delta, finish_reason: finish }],
			});
		const usage = JSON.stringify({
			id: "l",
			object: "chat.completion.chunk",
			created: 0,
			model: "fake",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		});
		if (requests.length === 1)
			return sse([
				chunk(
					{
						tool_calls: [
							{
								index: 0,
								id: "call_loop",
								type: "function",
								function: { name: "add_quote", arguments: '{"text":"hal"}' },
							},
						],
					},
					null,
				),
				chunk({}, "tool_calls"),
				usage,
			]);
		if (dies)
			return sse([chunk({ content: "half" }, null)], { dieAfter: true });
		return sse([chunk({ content: "added" }, null), chunk({}, "stop"), usage]);
	};
const executed: unknown[] = [];
const ACTING = {
	add_quote: tool({
		description: "test tool",
		inputSchema: jsonSchema<{ text: string }>({
			type: "object",
			properties: { text: { type: "string" } },
		}),
		execute: async (input) => {
			executed.push(input);
			return "quoted";
		},
	}),
};
{
	events.length = 0;
	console.error = (...a: unknown[]): void => {
		events.push(JSON.parse(String(a[0])) as Record<string, unknown>);
	};
	const requests: Record<string, unknown>[] = [];
	const loop = createLlm({
		providers: [
			{
				id: "loop",
				type: "openai",
				baseUrl: "http://fake.h/v1",
				defaultModel: "fake",
				fetch: looping(requests),
			},
		],
	});
	const r = await loop.complete({
		prompt: "quote hal",
		tools: ACTING,
		stopWhen: stepCountIs(5),
	});
	console.error = print;
	assert.deepEqual(executed, [{ text: "hal" }]);
	assert.equal(requests.length, 2);
	assert.equal(r.text, "added");
	assert.deepEqual(
		r.messages.map((m) => m.role),
		["assistant", "tool", "assistant"],
	);
	assert.equal(r.usage?.promptTokens, 20, "a loop's usage is every step's");
	const steps = (events as Ev[]).filter(
		(e) => e.phase === "end" && e.msg === "step",
	);
	assert.deepEqual(
		steps.map((s) => s.fields?.calls),
		['add_quote {"text":"hal"}', undefined],
	);
	pass(
		"a tool loop runs the tool, calls again with its result, and returns the turns it added",
	);
}
{
	executed.length = 0;
	console.error = () => {};
	const [first, second]: Record<string, unknown>[][] = [[], []];
	const pair = createLlm({
		providers: [
			{
				id: "acted",
				type: "openai",
				baseUrl: "http://fake.i/v1",
				defaultModel: "fake",
				priority: 1,
				fetch: looping(first, true),
			},
			{
				id: "fresh",
				type: "openai",
				baseUrl: "http://fake.j/v1",
				defaultModel: "fake",
				priority: 2,
				fetch: looping(second),
			},
		],
	});
	const failed = await pair
		.complete({ prompt: "quote hal", tools: ACTING, stopWhen: stepCountIs(5) })
		.then(
			() => null,
			(e: unknown) => e,
		);
	console.error = print;
	assert.ok(failed instanceof LlmError, `no LlmError: ${String(failed)}`);
	assert.equal(second.length, 0, "a provider was tried after a tool acted");
	assert.deepEqual(executed, [{ text: "hal" }]);
	pass(
		"a loop that fails after its tool acted is not replayed on another provider",
	);
}
{
	// A step that must call a tool and answers text instead answered nothing it could:
	// typed empty, so a caller tells its model to act, never reads a broken provider
	executed.length = 0;
	console.error = () => {};
	const requests: Record<string, unknown>[] = [];
	const required = createLlm({
		providers: [
			{
				id: "required",
				type: "openai",
				baseUrl: "http://fake.r/v1",
				defaultModel: "fake",
				fetch: looping(requests),
			},
		],
	});
	const failed = await required
		.complete({
			prompt: "quote hal",
			tools: ACTING,
			toolChoice: "required",
			stopWhen: stepCountIs(5),
		})
		.then(
			() => null,
			(e: unknown) => e,
		);
	console.error = print;
	assert.ok(failed instanceof LlmError, `no LlmError: ${String(failed)}`);
	assert.deepEqual(
		failed.failures.map((f) => f.kind),
		["empty"],
		"a reply with no tool call where one was required is empty",
	);
	assert.deepEqual(executed, [{ text: "hal" }]);
	pass(
		"a reply that calls no tool where one is required fails as empty",
	);
}
{
	// A tool slower than the request timeout: the timeout is each request's, the
	// tools between requests are not timed by it (a tool may wait on a person)
	const requests: Record<string, unknown>[] = [];
	const slow = createLlm({
		requestTimeoutMs: 100,
		providers: [
			{
				id: "slow-tool",
				type: "openai",
				baseUrl: "http://fake.k/v1",
				defaultModel: "fake",
				fetch: looping(requests),
			},
		],
	});
	const r = await slow.complete({
		prompt: "quote hal",
		tools: {
			add_quote: tool({
				description: "test tool",
				inputSchema: jsonSchema<{ text: string }>({
					type: "object",
					properties: { text: { type: "string" } },
				}),
				execute: async () => {
					await new Promise((resolve) => setTimeout(resolve, 300));
					return "quoted";
				},
			}),
		},
		stopWhen: stepCountIs(5),
	});
	assert.equal(r.text, "added");
	pass(
		"a tool slower than the request timeout does not abort the loop",
	);
}
{
	// prepareStep's messages replace what the model reads from that step on; the
	// result is still the turns the call added
	const requests: Record<string, unknown>[] = [];
	const kept = createLlm({
		providers: [
			{
				id: "kept",
				type: "openai",
				baseUrl: "http://fake.l/v1",
				defaultModel: "fake",
				fetch: looping(requests),
			},
		],
	});
	const r = await kept.complete({
		messages: [{ role: "user", content: "quote hal, a long story" }],
		tools: ACTING,
		stopWhen: stepCountIs(5),
		prepareStep: ({ stepNumber, messages }) =>
			stepNumber === 1
				? {
						messages: messages.map((m) =>
							m.role === "user" ? { ...m, content: "quote hal" } : m,
						),
					}
				: {},
	});
	const second = JSON.stringify(requests[1]?.messages);
	assert.ok(
		second.includes('"quote hal"') && !second.includes("a long story"),
		`the second request read: ${second}`,
	);
	assert.deepEqual(
		r.messages.map((m) => m.role),
		["assistant", "tool", "assistant"],
	);
	pass(
		"prepareStep's messages reach the next request, the result keeps the turns added",
	);
}
{
	// The request's reasoning reaches the server as the dialect says it, and a step's
	// reasoning is that step's alone
	const requests: Record<string, unknown>[] = [];
	const reasoning = createLlm({
		providers: [
			{
				id: "reasoning",
				type: "openai",
				baseUrl: "http://fake.m/v1",
				defaultModel: "fake",
				fetch: looping(requests),
			},
		],
	});
	await reasoning.complete({
		prompt: "quote hal",
		tools: ACTING,
		stopWhen: stepCountIs(5),
		reasoning: "none",
		prepareStep: ({ stepNumber }) =>
			stepNumber === 1 ? { reasoning: "low" } : undefined,
	});
	assert.deepEqual(
		requests.map((r) => r.reasoning_effort),
		["none", "low"],
	);
	pass(
		"reasoning reaches the server per call, and a step's for that step alone",
	);
}
console.log(`\n${passed} passed`);
