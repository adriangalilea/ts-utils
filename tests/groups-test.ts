// bot/groups contract tests: chat-type predicates, group-admin resolution via the
// admin list (getChatAdministrators — the call that works in hidden-member-list
// groups where getChatMember rejects CHAT_ADMIN_REQUIRED), the anonymous-admin
// sender_chat rule, ctx-defaulted and explicit ids, fail-closed on API rejection,
// panic on a miswired ctx. Run: pnpm test:groups
import assert from "node:assert/strict";
import {
	chatIdOf,
	isGroupAdmin,
	isGroupChat,
	isPrivateChat,
} from "../src/bot/groups.js";
import type { MenuCtx } from "../src/bot/menu.js";
import { Panic } from "../src/offensive.js";

// Compile-time contract: a menu action gates with no cast. If MenuCtx and the
// groups shapes ever drift apart, this file stops compiling.
const _menuGate: (ctx: MenuCtx) => Promise<boolean> = isGroupAdmin;
const _menuChat: (ctx: MenuCtx) => boolean = isGroupChat;
void _menuGate;
void _menuChat;

let pass = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
	Promise.resolve(fn()).then(() => {
		pass++;
		console.log("  PASS", name);
	});

// A gramio-shaped ctx: the bot answers getChatAdministrators from a fixture of
// per-chat admin-id lists; an unlisted chat rejects like the real API (bot not in
// the chat). The fixture never exposes getChatMember — the gate must not want it.
const makeCtx = (
	admins: Record<number, number[]>,
	chatId = -100,
	userId = 7,
) => {
	const calls: number[] = [];
	return {
		ctx: {
			chat: { id: chatId, type: "supergroup" },
			from: { id: userId },
			bot: {
				api: {
					getChatAdministrators: async (p: { chat_id: number }) => {
						calls.push(p.chat_id);
						const list = admins[p.chat_id];
						if (!list) throw new Error("Bad Request: chat not found");
						return list.map((id) => ({ user: { id } }));
					},
				},
			},
		},
		calls,
	};
};

await ok("chat-type predicates read ctx.chat.type", () => {
	assert.equal(isGroupChat({ chat: { type: "group" } }), true);
	assert.equal(isGroupChat({ chat: { type: "supergroup" } }), true);
	assert.equal(isGroupChat({ chat: { type: "private" } }), false);
	assert.equal(isPrivateChat({ chat: { type: "private" } }), true);
	assert.equal(isPrivateChat({}), false);
});

// gramio's CallbackQueryContext has NO `chat` — the chat lives at `chatId` and
// `message.chat`. Every reader must resolve that spelling too, or every gate on an
// inline-button tap silently reads `undefined`.
await ok(
	"callback-shaped ctxs (no chat, only chatId/message.chat) resolve too",
	() => {
		const tap = {
			chatId: -100,
			message: { chat: { id: -100, type: "supergroup" } },
		};
		assert.equal(isGroupChat(tap), true);
		assert.equal(isPrivateChat(tap), false);
		assert.equal(chatIdOf(tap), -100);
		assert.equal(chatIdOf({ chat: { id: 5 } }), 5);
		assert.equal(chatIdOf({}), undefined);
	},
);

await ok("isGroupAdmin defaults chat/user from the ctx", async () => {
	const { ctx, calls } = makeCtx({ [-100]: [7, 42] });
	assert.equal(await isGroupAdmin(ctx), true);
	assert.deepEqual(calls, [-100]);
});

await ok(
	"isGroupAdmin resolves the chat from a callback-shaped ctx",
	async () => {
		const { ctx, calls } = makeCtx({ [-100]: [7] });
		const tap = { bot: ctx.bot, from: ctx.from, chatId: -100 };
		assert.equal(await isGroupAdmin(tap), true);
		assert.deepEqual(calls, [-100]);
	},
);

await ok("a plain member is not in the admin list", async () => {
	const { ctx } = makeCtx({ [-100]: [42, 43] });
	assert.equal(await isGroupAdmin(ctx), false);
});

// The anonymous-admin rule: a message posted "as the group" wears the chat itself
// in sender_chat, an identity Telegram grants only to the chat's own admins. No API
// call — and a linked channel's auto-forward (sender_chat = the CHANNEL) stays denied.
await ok(
	"sender_chat = the chat itself proves admin, no API call",
	async () => {
		const { ctx, calls } = makeCtx({ [-100]: [] });
		const anon = { ...ctx, from: { id: 1087968824 }, senderChat: { id: -100 } };
		assert.equal(await isGroupAdmin(anon), true);
		const channelPost = {
			...ctx,
			from: { id: 777000 },
			senderChat: { id: -999 },
		};
		assert.equal(await isGroupAdmin(channelPost), false);
		assert.equal(calls.length, 1); // only the channel post hit the API
	},
);

await ok("explicit ids win over the ctx's own (cross-chat check)", async () => {
	const { ctx, calls } = makeCtx({ [-200]: [42] });
	assert.equal(await isGroupAdmin(ctx, { chatId: -200, userId: 42 }), true);
	assert.deepEqual(calls, [-200]);
	// An explicit userId asks about someone else: the ctx's own anonymous identity
	// must not vouch for them.
	const anon = { ...ctx, senderChat: { id: -200 } };
	assert.equal(await isGroupAdmin(anon, { chatId: -200, userId: 9 }), false);
});

await ok(
	"API rejection fails closed, missing actor short-circuits",
	async () => {
		const { ctx, calls } = makeCtx({});
		assert.equal(await isGroupAdmin(ctx), false); // rejected → deny
		assert.equal(await isGroupAdmin({ ...ctx, from: undefined }), false);
		assert.equal(calls.length, 1); // the actor-less check never called the API
	},
);

await ok("a miswired ctx panics instead of answering 'not admin'", async () => {
	await assert.rejects(
		() => isGroupAdmin({ chat: { id: -100 }, from: { id: 7 }, bot: {} }),
		Panic,
	);
});

console.log(`\n${pass} passed`);
