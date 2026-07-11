// bot/groups contract tests: chat-type predicates, group-admin resolution with
// ctx-defaulted and explicit ids, fail-closed on API rejection, panic on a
// miswired ctx. Run: pnpm test:groups
import assert from "node:assert/strict";
import { isGroupAdmin, isGroupChat, isPrivateChat } from "../src/bot/groups.js";
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

// A gramio-shaped ctx: the bot answers getChatMember from a fixture of
// per-(chat, user) statuses; anything unlisted rejects like the real API.
const makeCtx = (
	statuses: Record<string, string>,
	chatId = -100,
	userId = 7,
) => {
	const calls: Array<{ chat_id: number; user_id: number }> = [];
	return {
		ctx: {
			chat: { id: chatId, type: "supergroup" },
			from: { id: userId },
			bot: {
				api: {
					getChatMember: async (p: { chat_id: number; user_id: number }) => {
						calls.push(p);
						const status = statuses[`${p.chat_id}:${p.user_id}`];
						if (!status) throw new Error("Bad Request: user not found");
						return { status };
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

await ok("isGroupAdmin defaults chat/user from the ctx", async () => {
	const { ctx, calls } = makeCtx({ "-100:7": "administrator" });
	assert.equal(await isGroupAdmin(ctx), true);
	assert.deepEqual(calls, [{ chat_id: -100, user_id: 7 }]);
});

await ok("creator counts, plain member does not", async () => {
	const { ctx } = makeCtx({ "-100:7": "creator" });
	assert.equal(await isGroupAdmin(ctx), true);
	const { ctx: memberCtx } = makeCtx({ "-100:7": "member" });
	assert.equal(await isGroupAdmin(memberCtx), false);
});

await ok("explicit ids win over the ctx's own (cross-chat check)", async () => {
	const { ctx, calls } = makeCtx({ "-200:42": "administrator" });
	assert.equal(await isGroupAdmin(ctx, { chatId: -200, userId: 42 }), true);
	assert.deepEqual(calls, [{ chat_id: -200, user_id: 42 }]);
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
