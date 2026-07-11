/**
 * Group-chat identity — chat-type predicates and the group-admin check. Worker-safe
 * (no env, no OS).
 *
 * Telegram's Bot API has no "is this user a group admin?" primitive and neither does
 * gramio: the raw material is `getChatMember` returning a member whose `status` may be
 * `"creator"` or `"administrator"`. Every bot with an admin-gated group setting re-rolls
 * that check; this module rolls it ONCE.
 *
 * These take minimum structural ctx shapes (the `bot/ctx.ts` philosophy) that real
 * gramio contexts AND `bot/menu`'s `MenuCtx` satisfy by duck typing — a menu action
 * gates with `isGroupAdmin(ctx)`, no cast. `ctx.bot` stays `unknown` for exactly that
 * assignability (MenuCtx's own choice); a ctx whose bot has no `api.getChatMember`
 * PANICS — a miswire screams, it doesn't read as "not admin".
 *
 * `isGroupAdmin` FAILS CLOSED on the API call itself: a `getChatMember` rejection (user
 * never seen in the chat, network, the bot removed mid-tap) answers `false`, never
 * throws — it is a permission gate, and a gate that throws breaks the surface it guards
 * (a menu tap's single answerCallbackQuery, a command reply). That rejection is the
 * messy real world; denial is the only honest answer to "I couldn't verify".
 *
 * Anonymous-admin caveat: an admin posting anonymously wears the group's own identity
 * in `message.from` (the GroupAnonymousBot), so a MESSAGE from them fails this check.
 * Callback taps always carry the real user, so inline-button gates (the settings case)
 * are unaffected.
 *
 * @example
 * // Gate a group-wide toggle: the bot's own admins always may, otherwise the
 * // tapper must hold power over THIS group. (Policy composes at the call site.)
 * if (!ctx.isAdmin && !(await isGroupAdmin(ctx))) return tr("groupAdminsOnly")
 *
 * @example
 * // Cross-chat: is user 42 an admin of chat -100123?
 * await isGroupAdmin(ctx, { chatId: -100123, userId: 42 })
 */
import { assert } from "../offensive.js";

/** Minimum ctx shape the chat-type predicates read. */
export type ChatTypeCtx = {
	chat?: { type?: string };
};

/** Minimum ctx shape `isGroupAdmin` reads. `bot` is the running gramio Bot — typed
 *  `unknown` so MenuCtx and every real ctx assign without a cast; its
 *  `api.getChatMember` is asserted at call time. */
export type GroupAdminCtx = {
	bot: unknown;
	chat?: { id?: number };
	from?: { id?: number };
};

// The one Bot API call this module makes, chat/user defaulted from the ctx.
type GetChatMemberApi = {
	getChatMember: (params: {
		chat_id: number;
		user_id: number;
	}) => Promise<{ status?: string }>;
};

// The two chat-member statuses that hold power over a group. Not exported: the
// contract is the question `isGroupAdmin` answers, never status comparison.
const GROUP_ADMIN_STATUSES = new Set(["creator", "administrator"]);

/** True for a group or supergroup chat. */
export const isGroupChat = (ctx: ChatTypeCtx): boolean =>
	ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

/** True for a 1:1 private chat. */
export const isPrivateChat = (ctx: ChatTypeCtx): boolean =>
	ctx.chat?.type === "private";

/**
 * Whether a user is a creator/administrator of a group, per `getChatMember`. Chat and
 * user default to the ctx's own (`ctx.chat.id`, `ctx.from.id` — gramio's own
 * parameter-defaulting idiom); pass `chatId` / `userId` for cross-chat checks. Missing
 * ids (an actor-less service event) or an API rejection answer `false`.
 */
export async function isGroupAdmin(
	ctx: GroupAdminCtx,
	opts: { chatId?: number; userId?: number } = {},
): Promise<boolean> {
	const chatId = opts.chatId ?? ctx.chat?.id;
	const userId = opts.userId ?? ctx.from?.id;
	if (chatId === undefined || userId === undefined) return false;
	const bot = ctx.bot as { api?: Partial<GetChatMemberApi> } | undefined;
	assert(
		typeof bot?.api?.getChatMember === "function",
		"isGroupAdmin: ctx.bot.api.getChatMember missing — not a gramio ctx?",
	);
	try {
		const member = await bot.api.getChatMember({
			chat_id: chatId,
			user_id: userId,
		});
		return GROUP_ADMIN_STATUSES.has(member.status ?? "");
	} catch {
		return false;
	}
}
