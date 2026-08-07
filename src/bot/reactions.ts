/**
 * The emoji Telegram accepts as message reactions.
 *
 * ## Why this is a list and not an API call
 *
 * The Bot API does not enumerate them. `getChat().available_reactions` is
 * populated ONLY when a chat restricts its own reactions; a chat that allows
 * all of them returns `null`, which is the common case. So a caller that wants
 * to know the set — to offer it to a language model, to validate input, to
 * build a picker — has no method to ask.
 *
 * ## Where these came from
 *
 * Measured, not copied from documentation: `scripts/probe-reactions.ts` sets
 * each candidate on a real message and records Telegram's verdict. Re-run it to
 * refresh this list.
 *
 *     BOT_TOKEN=… bun scripts/probe-reactions.ts <chat_id> <message_id>
 *
 * Gathered **2026-08-07**: 86 candidates probed, 73 accepted, 13 refused with
 * `Bad Request: REACTION_INVALID`.
 *
 * The refusals are worth knowing, because they are the ones people (and models)
 * reach for by instinct:
 *
 *     👋 😊 🙂 😄 ✅ 🤖 💪 🙌 😅 🥳 😂 ❓ ‼
 *
 * **There is no wave.** A greeting has to be answered with something from the
 * accepted set — 🤝 🫡 🤗 😁 — or with words.
 */
export const TELEGRAM_REACTIONS = [
	"👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉",
	"🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚",
	"🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕",
	"😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍",
	"🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘",
	"💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
] as const;

export type TelegramReaction = (typeof TELEGRAM_REACTIONS)[number];

/** Probed and refused on the date above — kept so callers can explain a rejection. */
export const REFUSED_REACTIONS = [
	"👋", "😊", "🙂", "😄", "✅", "🤖", "💪", "🙌", "😅", "🥳", "😂", "❓", "‼",
] as const;

const ACCEPTED = new Set<string>(TELEGRAM_REACTIONS);

/** Whether Telegram will accept this emoji as a reaction. */
export const isReaction = (emoji: string): emoji is TelegramReaction =>
	ACCEPTED.has(emoji);

/**
 * The set a chat will actually accept: what `getChat` reports when the room
 * restricts its reactions, otherwise the full measured set. Pass
 * `chat.available_reactions` straight through.
 */
export const reactionsFor = (
	available?: { type: string; emoji?: string }[] | null,
): readonly string[] =>
	available
		? available
				.filter((reaction) => reaction.type === "emoji" && reaction.emoji)
				.map((reaction) => reaction.emoji as string)
		: TELEGRAM_REACTIONS;
