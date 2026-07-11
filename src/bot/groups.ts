/**
 * Group-chat identity — chat-type predicates, the chat-id resolver, and the group-admin
 * check. Worker-safe (no env, no OS).
 *
 * Telegram's Bot API has no "is this user a group admin?" primitive and neither does
 * gramio: the raw material is `getChatMember` returning a member whose `status` may be
 * `"creator"` or `"administrator"`. Every bot with an admin-gated group setting re-rolls
 * that check; this module rolls it ONCE.
 *
 * ## The two ctx spellings (the trap this module absorbs)
 *
 * gramio spells "which chat" differently per event: message-flavoured contexts carry
 * `ctx.chat`, but `CallbackQueryContext` — every inline-button tap, i.e. the surface most
 * gates live on — has NO `chat` at all, only `ctx.chatId` and `ctx.message.chat`. Because
 * `chat` is optional in the structural types, the mismatch compiles and then reads as
 * `undefined` at runtime: a gate that "works" in a handler silently denies on a tap.
 * Every reader here ({@link chatIdOf}, the predicates, {@link isGroupAdmin}) resolves BOTH
 * spellings, so one call site works on any ctx. Read chat ids through `chatIdOf`, never
 * `ctx.chat?.id`.
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

/** Minimum ctx shape the chat-type predicates read: `chat` on message-flavoured ctxs,
 *  `message.chat` on callback ctxs (which have no `chat`). */
export type ChatTypeCtx = {
	chat?: { type?: string };
	message?: { chat?: { type?: string } };
};

/** Minimum ctx shape {@link chatIdOf} reads: `chat` (message ctxs), or `chatId` /
 *  `message.chat` (callback ctxs). */
export type ChatIdCtx = {
	chat?: { id?: number };
	chatId?: number;
	message?: { chat?: { id?: number } };
};

/** Minimum ctx shape `isGroupAdmin` reads. `bot` is the running gramio Bot — typed
 *  `unknown` so MenuCtx and every real ctx assign without a cast; its
 *  `api.getChatMember` is asserted at call time. */
export type GroupAdminCtx = ChatIdCtx & {
	bot: unknown;
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

/** The ctx's chat id, whatever the event spelling. `undefined` only when the event has
 *  no chat at all (inline queries, some service events). */
export const chatIdOf = (ctx: ChatIdCtx): number | undefined =>
	ctx.chat?.id ?? ctx.chatId ?? ctx.message?.chat?.id;

// The chat type, both spellings (private helper twin of chatIdOf).
const chatTypeOf = (ctx: ChatTypeCtx): string | undefined =>
	ctx.chat?.type ?? ctx.message?.chat?.type;

/** True for a group or supergroup chat. */
export const isGroupChat = (ctx: ChatTypeCtx): boolean => {
	const type = chatTypeOf(ctx);
	return type === "group" || type === "supergroup";
};

/** True for a 1:1 private chat. */
export const isPrivateChat = (ctx: ChatTypeCtx): boolean =>
	chatTypeOf(ctx) === "private";

/**
 * Whether a user is a creator/administrator of a group, per `getChatMember`. Chat and
 * user default to the ctx's own ({@link chatIdOf}, `ctx.from.id` — gramio's own
 * parameter-defaulting idiom); pass `chatId` / `userId` for cross-chat checks. Missing
 * ids (an actor-less service event) or an API rejection answer `false`.
 */
export async function isGroupAdmin(
	ctx: GroupAdminCtx,
	opts: { chatId?: number; userId?: number } = {},
): Promise<boolean> {
	const chatId = opts.chatId ?? chatIdOf(ctx);
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
