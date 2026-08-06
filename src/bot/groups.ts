/**
 * Group-chat identity — chat-type predicates, the chat-id resolver, and the group-admin
 * check. Worker-safe (no env, no OS).
 *
 * Telegram's Bot API has no "is this user a group admin?" primitive and neither does
 * gramio. The raw material is `getChatAdministrators` — NOT `getChatMember`: in a group
 * whose member list is hidden, `getChatMember` on another user rejects with
 * `CHAT_ADMIN_REQUIRED` for a non-admin bot, so a gate built on it denies EVERY real
 * admin (creator included) while the admin list itself stays readable. Every bot with an
 * admin-gated group setting re-rolls that check; this module rolls it ONCE, on the call
 * that works everywhere the bot is present.
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
 * assignability (MenuCtx's own choice); a ctx whose bot has no
 * `api.getChatAdministrators` PANICS — a miswire screams, it doesn't read as "not
 * admin".
 *
 * `isGroupAdmin` FAILS CLOSED on the API call itself: a `getChatAdministrators`
 * rejection (the bot removed mid-tap, network) answers `false`, never throws — it is a
 * permission gate, and a gate that throws breaks the surface it guards (a menu tap's
 * single answerCallbackQuery, a command reply). That rejection is the messy real world;
 * denial is the only honest answer to "I couldn't verify".
 *
 * Anonymous admins: a message posted "as the group" carries the chat itself in
 * `sender_chat`, and Telegram offers that identity only to the chat's own admins — so
 * `sender_chat.id === chat.id` IS the proof, no API call (a linked channel's auto-forward
 * wears the CHANNEL's id, so the equality never false-positives). Callback taps always
 * carry the real user, and anonymous admins appear in the admin list under their real
 * user, so inline-button gates resolve them too.
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
 *  `api.getChatAdministrators` is asserted at call time. `senderChat` is the
 *  anonymous-admin identity on message ctxs (callback ctxs have none). */
export type GroupAdminCtx = ChatIdCtx & {
	bot: unknown;
	from?: { id?: number };
	senderChat?: { id?: number };
};

// The one Bot API call this module makes, chat defaulted from the ctx. The list only
// ever contains creators/administrators, so membership IS the answer — no status check.
type GetChatAdministratorsApi = {
	getChatAdministrators: (params: {
		chat_id: number;
	}) => Promise<Array<{ user?: { id?: number } }>>;
};

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
 * Whether a user is a creator/administrator of a group, per `getChatAdministrators`
 * membership. Chat and user default to the ctx's own ({@link chatIdOf}, `ctx.from.id` —
 * gramio's own parameter-defaulting idiom); pass `chatId` / `userId` for cross-chat
 * checks. An anonymous admin's own message (`senderChat` = the chat itself) answers
 * `true` without an API call — unless an explicit `userId` asks about someone else.
 * Missing ids (an actor-less service event) or an API rejection answer `false`.
 */
export async function isGroupAdmin(
	ctx: GroupAdminCtx,
	opts: { chatId?: number; userId?: number } = {},
): Promise<boolean> {
	const chatId = opts.chatId ?? chatIdOf(ctx);
	if (chatId === undefined) return false;
	if (opts.userId === undefined && ctx.senderChat?.id === chatId) return true;
	const userId = opts.userId ?? ctx.from?.id;
	if (userId === undefined) return false;
	const bot = ctx.bot as { api?: Partial<GetChatAdministratorsApi> } | undefined;
	assert(
		typeof bot?.api?.getChatAdministrators === "function",
		"isGroupAdmin: ctx.bot.api.getChatAdministrators missing — not a gramio ctx?",
	);
	try {
		const admins = await bot.api.getChatAdministrators({ chat_id: chatId });
		return admins.some((m) => m.user?.id === userId);
	} catch {
		return false;
	}
}
