// bot/update-identity contract: pure Telegram-update identity used by the
// durable webhook ingress — id extraction, callback fields, and the
// one-conversation-one-partition routing that keeps a chat's updates ordered.
// Run: pnpm test:update-identity
import assert from "node:assert/strict";
import {
	telegramCallbackData,
	telegramCallbackUserId,
	telegramUpdateId,
	telegramUpdatePartition,
} from "../src/bot/update-identity.js";

// Malformed input is rejected, never guessed at.
assert.equal(telegramUpdateId(null), null);
assert.equal(telegramUpdatePartition({}), null);
assert.equal(telegramUpdatePartition({ update_id: 1.5 }), null);

// Callback fields are exposed only for callback-query updates.
assert.equal(
	telegramCallbackData({
		update_id: 2,
		callback_query: { data: "button-wire-value" },
	}),
	"button-wire-value",
);
assert.equal(
	telegramCallbackUserId({
		update_id: 2,
		callback_query: { from: { id: 77 } },
	}),
	77,
);
assert.equal(
	telegramCallbackData({
		update_id: 3,
		message: { text: "button-wire-value" },
	}),
	null,
);
assert.equal(
	telegramCallbackUserId({ update_id: 3, message: { from: { id: 77 } } }),
	null,
);

// Messages and callbacks from one chat share a durable partition.
assert.equal(
	telegramUpdatePartition({
		update_id: 10,
		message: { chat: { id: -100123 } },
	}),
	"chat:-100123",
);
assert.equal(
	telegramUpdatePartition({
		update_id: 11,
		callback_query: { from: { id: 7 }, message: { chat: { id: -100123 } } },
	}),
	"chat:-100123",
);

// Chatless updates partition by actor, then update id.
assert.equal(
	telegramUpdatePartition({
		update_id: 12,
		inline_query: { from: { id: 42 } },
	}),
	"user:42",
);
assert.equal(
	telegramUpdatePartition({ update_id: 13, poll: { id: "poll" } }),
	"update:13",
);

console.log("✅ bot/update-identity contract holds");
