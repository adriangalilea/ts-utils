// bot/worker isSelfEcho contract: the bot never listens to itself. Its own
// messages and forwards of its messages are echoes; everything else — replies
// TO it, forwards of other people, via_bot inline posts — is conversation.
// Run: pnpm test:self-echo
import assert from "node:assert/strict";
import { isSelfEcho } from "../src/bot/worker.js";

const BOT = 8_012_345_678;
const HUMAN = 190_202_471;

// A message the bot authored (channel/business echo) is an echo.
assert.equal(isSelfEcho({ message: { from: { id: BOT } } }, BOT), true);
assert.equal(isSelfEcho({ channel_post: { from: { id: BOT } } }, BOT), true);
assert.equal(isSelfEcho({ edited_message: { from: { id: BOT } } }, BOT), true);
assert.equal(
	isSelfEcho({ business_message: { from: { id: BOT } } }, BOT),
	true,
);

// A human FORWARDING one of the bot's messages is an echo (the forwarded
// summary still carries live links — reacting to it loops the bot on itself).
assert.equal(
	isSelfEcho(
		{
			message: {
				from: { id: HUMAN },
				forward_origin: { type: "user", sender_user: { id: BOT } },
			},
		},
		BOT,
	),
	true,
);

// Ordinary traffic is NOT an echo: a human message, a human's forward of a
// human, a reply TO the bot (that's the follow-up conversation), a via_bot
// inline post (the consumer handles that nuance itself), non-message updates.
assert.equal(isSelfEcho({ message: { from: { id: HUMAN } } }, BOT), false);
assert.equal(
	isSelfEcho(
		{
			message: {
				from: { id: HUMAN },
				forward_origin: { type: "user", sender_user: { id: HUMAN } },
			},
		},
		BOT,
	),
	false,
);
assert.equal(
	isSelfEcho(
		{
			message: {
				from: { id: HUMAN },
				reply_to_message: { from: { id: BOT } },
			},
		},
		BOT,
	),
	false,
);
assert.equal(
	isSelfEcho({ message: { from: { id: HUMAN }, via_bot: { id: BOT } } }, BOT),
	false,
);
assert.equal(
	isSelfEcho(
		{
			message: { from: { id: HUMAN }, forward_origin: { type: "hidden_user" } },
		},
		BOT,
	),
	false,
);
assert.equal(
	isSelfEcho({ callback_query: { from: { id: HUMAN } } }, BOT),
	false,
);
assert.equal(isSelfEcho(null, BOT), false);

console.log("✓ self-echo: 12 assertions");
