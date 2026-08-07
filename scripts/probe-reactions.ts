#!/usr/bin/env bun
// Discover which emoji Telegram actually accepts as message reactions.
//
// The Bot API does not enumerate them: `getChat().available_reactions` is
// populated ONLY when a chat restricts its reactions, and is null when a chat
// allows "all" — which is the common case. So the set has to be established the
// way Telegram will answer it anyway: by asking, once, and writing down what it
// said. That is what this script does, and `src/bot/reactions.ts` is its output.
//
// Idempotent: it sets one reaction at a time on a message you nominate, reads
// the verdict, and clears the reaction when it finishes (including on Ctrl-C),
// so the chat is left exactly as it was found. Re-run it whenever Telegram's
// set is suspected to have moved.
//
//   BOT_TOKEN=… bun scripts/probe-reactions.ts <chat_id> <message_id>
//
// Nominate one of the BOT'S OWN messages: reactions flicker on it while the
// probe runs, and that is politer than doing it to a person's message.

const token = process.env.BOT_TOKEN
const [chatId, messageId] = process.argv.slice(2)

if (!token || !chatId || !messageId) {
  console.error("usage: BOT_TOKEN=… bun scripts/probe-reactions.ts <chat_id> <message_id>")
  process.exit(2)
}

// Everything worth knowing the answer for: the set Telegram documents, plus the
// ones a language model reaches for unprompted (👋 for a greeting above all).
// A candidate that fails is as useful a result as one that passes.
const CANDIDATES = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
  // Commonly attempted, believed NOT to be reactions — probed so the result is
  // evidence rather than folklore.
  "👋", "😊", "🙂", "😄", "✅", "🤖", "💪", "🙌", "😅", "🥳", "😂", "❓", "‼",
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ApiResult = { ok: boolean; description?: string; parameters?: { retry_after?: number } }

// Telegram rate-limits reaction changes hard (observed retry_after up to 41s).
// A 429 is NOT a verdict on the emoji — treating it as one silently poisons the
// whole result, which is exactly what happened on the first run — so it is
// waited out and the same candidate retried until Telegram gives a real answer.
const api = async (method: string, body: unknown): Promise<ApiResult> => {
  for (;;) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = (await response.json()) as ApiResult
    const retryAfter = result.parameters?.retry_after
    if (response.status !== 429 && retryAfter === undefined) return result
    const wait = (retryAfter ?? 5) + 1
    process.stderr.write(`  rate-limited, waiting ${wait}s\n`)
    await sleep(wait * 1000)
  }
}

const clear = () => api("setMessageReaction", { chat_id: chatId, message_id: Number(messageId), reaction: [] })

process.on("SIGINT", async () => {
  await clear()
  process.exit(130)
})

const accepted: string[] = []
const refused: { emoji: string; why: string }[] = []

for (const emoji of CANDIDATES) {
  const result = await api("setMessageReaction", {
    chat_id: chatId,
    message_id: Number(messageId),
    reaction: [{ type: "emoji", emoji }],
  })
  if (result.ok) accepted.push(emoji)
  else refused.push({ emoji, why: result.description ?? "unknown" })
  process.stderr.write(`${result.ok ? "ok  " : "no  "} ${emoji}\n`)
  // Paced to stay under the reaction rate limit; api() waits out a 429 anyway.
  await sleep(1200)
}

await clear()

console.log(`probed ${CANDIDATES.length} candidates against ${chatId}/${messageId}`)
console.log(`accepted ${accepted.length}: ${accepted.join(" ")}`)
console.log(`refused ${refused.length}: ${refused.map((r) => r.emoji).join(" ")}`)
console.log(`\nreasons: ${[...new Set(refused.map((r) => r.why))].join(" | ")}`)
console.log(`\n// gathered ${new Date().toISOString().slice(0, 10)} by scripts/probe-reactions.ts`)
console.log(`export const TELEGRAM_REACTIONS = ${JSON.stringify(accepted)} as const`)
