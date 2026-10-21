/**
 * Assert-based checks for `bot/token-safe`: a transport failure carrying the
 * request URL, as Bun's fetch errors do (`path`), leaves gramio's API calls,
 * `longPoll`'s start and `updateQueue` as an error that holds no trace of the
 * token in any field, while Telegram's own refusals pass through untouched.
 *
 *   pnpm --filter @adriangalilea/bot test
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inspect } from "node:util";
import { Bot, TelegramError } from "gramio";
import { longPoll } from "./poll.js";
import { guardToken } from "./token-safe.js";
import { updateQueue } from "./updates.js";

const SECRET = "AAH-token-secret-part";
const TOKEN = `123456:${SECRET}`;

/** A fetch that fails the way Bun's does: the URL hangs on the error as `path`. */
const bunLikeFailure: typeof fetch = async (input) => {
	const err = Object.assign(new Error("Unable to connect."), {
		code: "ConnectionRefused",
		path: String(input),
	});
	throw err;
};

/** Every way a runtime or a logger could print the error, and none may hold the token. */
function assertClean(err: unknown) {
	for (const shown of [
		inspect(err, { depth: 10, showHidden: true }),
		JSON.stringify(err),
		String((err as Error).stack),
	]) {
		assert.ok(!shown.includes(SECRET), `token leaked: ${shown}`);
	}
}

async function withFetch<T>(f: typeof fetch, body: () => Promise<T>) {
	const original = globalThis.fetch;
	globalThis.fetch = f;
	try {
		return await body();
	} finally {
		globalThis.fetch = original;
	}
}

test("a gramio API call that fails in transport throws without the token", async () => {
	const bot = new Bot(TOKEN);
	guardToken(bot);
	const err = await withFetch(bunLikeFailure, () =>
		bot.api.getMe().then(
			() => assert.fail("getMe should fail"),
			(e: unknown) => e,
		),
	);
	assert.equal((err as { source?: string }).source, "telegram");
	assert.equal((err as { operation?: string }).operation, "getMe");
	assert.match((err as Error).message, /ConnectionRefused/);
	assertClean(err);
});

test("longPoll's start fails without the token", async () => {
	const bot = new Bot(TOKEN);
	const err = await withFetch(bunLikeFailure, () =>
		longPoll(bot).then(
			() => assert.fail("start should fail"),
			(e: unknown) => e,
		),
	);
	assertClean(err);
});

test("updateQueue fails without the token", async () => {
	const queue = updateQueue({ token: TOKEN, fetch: bunLikeFailure });
	const err = await queue.count().then(
		() => assert.fail("count should fail"),
		(e: unknown) => e,
	);
	assert.equal((err as { operation?: string }).operation, "getWebhookInfo");
	assertClean(err);
});

test("Telegram's own refusal passes through as a TelegramError", async () => {
	const bot = new Bot(TOKEN);
	guardToken(bot);
	const refuse: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				ok: false,
				error_code: 401,
				description: "Unauthorized",
			}),
			{ headers: { "content-type": "application/json" } },
		);
	const err = await withFetch(refuse, () =>
		bot.api.getMe().then(
			() => assert.fail("getMe should be refused"),
			(e: unknown) => e,
		),
	);
	assert.ok(err instanceof TelegramError);
	assert.equal((err as TelegramError<"getMe">).code, 401);
});
