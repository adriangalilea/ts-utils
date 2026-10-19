# @adriangalilea/llm

Multi-provider LLM caller on the Vercel AI SDK — the policy layer the SDK doesn't ship. `createLlm({ providers, health? })` → `.stream(req)` (typed events: `delta` / `reasoning` / `reset` / `tool-call` / `end`) and `.complete(req)`. Worker-safe.

Part of [ts-utils](https://github.com/adriangalilea/ts-utils). It logs and traces through `@adriangalilea/utils/log` ([`@adriangalilea/utils`](https://github.com/adriangalilea/ts-utils/tree/main/packages/utils#readme)). The Telegram side of an LLM chatbot is `@adriangalilea/bot/llm` ([`@adriangalilea/bot`](https://github.com/adriangalilea/ts-utils/tree/main/packages/bot#readme)).

## Installation

```bash
pnpm add @adriangalilea/llm ai @ai-sdk/openai-compatible @ai-sdk/anthropic @openrouter/ai-sdk-provider
```

Peers: `ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`, and `zod` when you pass zod schemas.

## Usage

```typescript
import { createLlm } from '@adriangalilea/llm'

const llm = createLlm({
  providers: [
    { id: 'openrouter', type: 'openrouter', apiKey, defaultModel: 'deepseek/deepseek-chat', priority: 0 },
    { id: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: key2, defaultModel: 'deepseek-chat', priority: 1 },
  ],
  health: env.KEY_HEALTH, // optional KV namespace
})
const { text, usage } = await llm.complete({ prompt })
```

```typescript
import { tool } from '@adriangalilea/llm'
import { z } from 'zod'

const events = llm.stream({
  prompt,
  tools: { not_covered: tool({ description: '…', inputSchema: z.object({}) }) },
})
for await (const e of events) {
  if (e.kind === 'delta') draft.append(e.text)
  else if (e.kind === 'reset') draft.clear()
  else if (e.kind === 'tool-call') handle(e.toolName, e.input)
}
```

## Failover

Priority-ordered across OpenAI-compatible, Anthropic-compatible, and OpenRouter endpoints; multiple keys per provider (health tracked per key fingerprint); per-key circuit breaker with exponential cool-down persisted in any KV-shaped `HealthStore`; an attempt that dies after emitting yields `reset` (discard, next candidate regenerates); empty completions count as failures.

## Accounting

Tokens summed across billed attempts; `costUsd` is the ACTUAL charge (OpenRouter usage accounting via `providerMetadata`, or a `cost` field on the raw usage frame) — never a price-table estimate.

## Knobs

Per-model temperature (none configured, none sent: the model samples its own way, and Claude 5.5 takes none), maxTokens caps, `disableThinking` mapped to each dialect.

## Tools

AI SDK `tool()` + `toolChoice` pass through (re-exported).

**Tool loop:** tools with an `execute` run when called, and `stopWhen` (the AI SDK's stop conditions, re-exported: `stepCountIs`, `hasToolCall`, or any function of the steps) calls the model again with their results until one holds; the result's `messages` are every turn the call added (the model's and its tools' results), to append to the conversation; usage sums every step. `prepareStep` (the AI SDK's step hook) may replace what the model reads from a step on, which carries forward: a conversation kept inside its window; and it may say how much the model reasons on that step (`reasoning`, mapped to the provider's own option: openai-compatible, OpenRouter, and Anthropic's adaptive thinking at that effort), over the request's `reasoning`: a loop that thinks only where its task gets hard.

**Anthropic prompt cache:** every anthropic request marks its prompt for the cache, since Anthropic caches only what a request asks it to; a tool loop unmarked would read its whole conversation again, at full price, on every step.

`requestTimeoutMs` times each request to a model, never the tools between them (a tool may wait on a person). Once a tool has run, a failure is the call's own: no other provider is tried, since its tools would act again. The AI SDK runs a turn's calls at once; tools that must run in order share a `SerialJobExecutor` (re-exported).

## Trace

Each call is a `chat` span (kind `inference`) under `log` (a logger or span you pass; the root logger otherwise), and each provider tried is an `attempt` span inside it with OpenTelemetry's gen_ai fields (provider, model, `server.address`, input, cached and output tokens), `cost_usd` when the gateway reports one, `ttft_ms` and `decode_ms`; each model call of a tool loop is a `step` span inside the attempt, with its calls, its finish reason, its tokens and its own `ttft_ms`/`decode_ms` (a turn's tools run as their calls stream in, so a step's decode includes them).

## Structured output

`schema` (zod, or `jsonSchema(…, { validate })`) returns the answer parsed and validated as `object`; an answer that fails it fails its provider and the next is tried. A provider with `structuredOutputs: true` enforces the schema while decoding; otherwise the schema is stated in the instructions.

## Failures

An `LlmError` carries `failures`, one per provider tried, typed: `off-schema` (the model answered, not in the schema's shape: its `text`, and `cut` when its token cap stopped it), `empty`, or `failed` (the call itself: its message and HTTP `status`), so a caller tells an answer it can send back to the model from a server that is down.

## License

MIT
