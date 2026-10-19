/**
 * Assert-based checks for `bot/poll`, against a loopback Bot API (gramio's own
 * getMe goes there too, so nothing is stubbed): updates reach the handlers and
 * the offset confirms them; a failing poll backs off and recovers; and the two
 * stalls of gramiojs/gramio#35, a getUpdates that never answers and an answer
 * whose body never finishes, each end at the poll's deadline and the next poll
 * goes out. `timeout: 0` makes the deadline the answer allowance alone (15 s).
 *
 *   pnpm --filter @adriangalilea/bot test
 */
import { strict as assert } from "node:assert";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Bot } from "gramio";
import { longPoll } from "./poll.js";

type Mode = (call: number, res: ServerResponse, destroy: () => void) => void;

const message = (id: number, text: string) => ({
	update_id: id,
	message: {
		message_id: id,
		date: 1,
		chat: { id: 77, type: "private", first_name: "T" },
		from: { id: 77, is_bot: false, first_name: "T" },
		text,
	},
});

const reply = (res: ServerResponse, result: unknown) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true, result }));
};

/** A Bot API on loopback whose getUpdates answers by `mode`; records each poll's offset. */
async function botApi(mode: Mode) {
	const offsets: number[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		if (req.url?.endsWith("/getMe"))
			return reply(res, {
				id: 1,
				is_bot: true,
				first_name: "Poll",
				username: "poll_bot",
			});
		if (!req.url?.endsWith("/getUpdates")) return reply(res, true);
		offsets.push(JSON.parse(body).offset);
		mode(offsets.length, res, () => req.socket.destroy());
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	const seen: string[] = [];
	const bot = new Bot("1:TEST", {
		api: { baseURL: `http://127.0.0.1:${port}/bot` },
	}).on("message", (ctx) => {
		seen.push(ctx.text ?? "");
	});
	return {
		bot,
		seen,
		offsets,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

/** Resolves once `ok()` holds, or fails after `ms`. */
async function until(ok: () => boolean, ms: number, what: string) {
	const end = Date.now() + ms;
	while (!ok()) {
		assert.ok(Date.now() < end, `timed out waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

// Delivery: a batch reaches the handlers, and the next poll confirms it.
{
	const api = await botApi((call, res) =>
		call === 1
			? reply(res, [message(5, "a"), message(6, "b")])
			: reply(res, []),
	);
	const poll = await longPoll(api.bot, { timeout: 0 });
	await until(
		() => api.seen.length === 2 && api.offsets.length >= 2,
		5_000,
		"delivery",
	);
	assert.deepEqual(api.seen, ["a", "b"]);
	assert.equal(api.offsets[0], 0);
	assert.equal(
		api.offsets[1],
		7,
		"the second poll confirms through the last update",
	);
	await poll.stop();
	await api.bot.stop();
	api.close();
}

// Recovery: two dropped connections back off (1 s, then 2 s), then the update lands.
{
	const api = await botApi((call, res, destroy) =>
		call <= 2
			? destroy()
			: call === 3
				? reply(res, [message(1, "late")])
				: reply(res, []),
	);
	const poll = await longPoll(api.bot, { timeout: 0 });
	const started = Date.now();
	await until(() => api.seen.length === 1, 10_000, "recovery");
	assert.ok(
		Date.now() - started >= 3_000,
		"backed off 1 s + 2 s before the third poll",
	);
	await poll.stop();
	await api.bot.stop();
	api.close();
}

// gramio#35: a poll that never answers, and one whose body never finishes. Both end
// at the deadline, the next poll goes out and its update is handled. Run together.
await Promise.all(
	[
		(_res: ServerResponse) => {},
		(res: ServerResponse) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"ok":true,"result":[');
		},
	].map(async (stall) => {
		const api = await botApi((call, res) =>
			call === 1
				? stall(res)
				: call === 2
					? reply(res, [message(1, "after")])
					: reply(res, []),
		);
		const poll = await longPoll(api.bot, { timeout: 0 });
		await until(
			() => api.seen.length === 1,
			25_000,
			"the poll after a stalled one",
		);
		assert.deepEqual(api.seen, ["after"]);
		await poll.stop();
		await api.bot.stop();
		api.close();
	}),
);

// stop() ends a poll that would otherwise wait out its whole deadline.
{
	const api = await botApi(() => {});
	const poll = await longPoll(api.bot, { timeout: 0 });
	await until(() => api.offsets.length === 1, 5_000, "the first poll");
	const started = Date.now();
	await poll.stop();
	assert.ok(Date.now() - started < 1_000, "stop() aborts the poll in flight");
	await api.bot.stop();
	api.close();
}
