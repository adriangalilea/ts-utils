// Live integration smoke for the llm module against real OpenRouter.
// Run: OPENROUTER_KEY=… pnpm test:llm
//  1. complete() — text + usage + ACTUAL billed costUsd
//  2. stream() — delta events arrive incrementally
//  3. tools — forced-relevance question triggers the not_covered tool call
//  4. failover — dead key first, real key second → answer still lands
import { createLlm, jsonSchema, tool } from "../src/llm/index.js";

const apiKey = process.env.OPENROUTER_KEY;
if (!apiKey) throw new Error("OPENROUTER_KEY missing");

const MODEL = "deepseek/deepseek-chat-v3-0324";

const llm = createLlm({
	providers: [
		{
			id: "openrouter",
			type: "openrouter",
			apiKey,
			defaultModel: MODEL,
			temperature: 0.2,
		},
	],
});

// 1 — one-shot with cost accounting
{
	const r = await llm.complete({
		prompt: "Reply with exactly: pong",
		maxTokens: 64,
	});
	console.log(
		"1 complete:",
		JSON.stringify({ text: r.text.slice(0, 40), usage: r.usage }),
	);
	if (!r.text.toLowerCase().includes("pong")) throw new Error("no pong");
	if (!r.usage || r.usage.costUsd === undefined)
		throw new Error("no costUsd — ledger would starve");
}

// 2 — streaming deltas
{
	let deltas = 0;
	let text = "";
	for await (const e of llm.stream({
		prompt: "Count from 1 to 10, comma-separated.",
		maxTokens: 64,
	})) {
		if (e.kind === "delta") {
			deltas++;
			text += e.text;
		}
	}
	console.log(
		`2 stream: ${deltas} delta events → ${JSON.stringify(text.slice(0, 40))}`,
	);
	if (deltas < 2) throw new Error("stream did not stream");
}

// 3 — the not_covered tool fires on an off-topic question
{
	const tools = {
		not_covered: tool({
			description:
				"Call this when the provided content does not cover the user's question. Do not write any answer text.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
				additionalProperties: false,
			}),
		}),
	};
	const prompt = `Answer ONLY from the content below. If the content does not cover the question, call the not_covered tool and output nothing else.\n<question>How do I make a collapsible section in Markdown?</question>\n<content>The mitochondria is the powerhouse of the cell. ATP synthesis occurs across the inner membrane.</content>`;
	const r = await llm.complete({ prompt, maxTokens: 128, tools });
	console.log(
		"3 tools:",
		JSON.stringify({ toolCalls: r.toolCalls, text: r.text.slice(0, 60) }),
	);
	if (!r.toolCalls.some((c) => c.toolName === "not_covered"))
		throw new Error("not_covered did not fire");
}

// 4 — failover: dead key (priority 0) → real key (priority 1)
{
	const flaky = createLlm({
		providers: [
			{
				id: "openrouter",
				type: "openrouter",
				apiKey: "sk-or-v1-dead",
				defaultModel: MODEL,
				priority: 0,
			},
			{
				id: "openrouter",
				type: "openrouter",
				apiKey,
				defaultModel: MODEL,
				priority: 1,
			},
		],
	});
	const r = await flaky.complete({
		prompt: "Reply with exactly: pong",
		maxTokens: 64,
	});
	console.log(
		"4 failover:",
		JSON.stringify({ text: r.text.slice(0, 20), usage: r.usage }),
	);
	if (!r.text.toLowerCase().includes("pong"))
		throw new Error("failover did not recover");
}

console.log("ALL SMOKE TESTS PASSED");
