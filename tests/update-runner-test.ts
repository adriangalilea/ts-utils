// bot/worker durable runner: a timed-out attempt cannot be cancelled, so its
// retry must wait for it instead of handling the update a second time.
// Run: pnpm test:update-runner
import assert from "node:assert/strict";
import {
	telegramUpdateRunner,
	type UpdateRunnerState,
} from "../src/bot/worker.js";

process.env.BOT_UPDATE_RUNNER_LOG_LEVEL = "silent";

function memoryState(): UpdateRunnerState & { alarm: number | null } {
	const data = new Map<string, unknown>();
	const txn = {
		get: async <T>(key: string) =>
			structuredClone(data.get(key)) as T | undefined,
		put: async (key: string, value: unknown) => {
			data.set(key, structuredClone(value));
		},
		delete: async (key: string | string[]) => {
			for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
		},
	};
	const state = {
		alarm: null as number | null,
		storage: {
			...txn,
			getAlarm: async () => state.alarm,
			setAlarm: async (time: number) => {
				state.alarm = time;
			},
			transaction: <T>(fn: (t: typeof txn) => Promise<T>) => fn(txn),
		},
	};
	return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOUND_MS = 50;

// A handler that replies at once, then keeps working past the bound.
let sends = 0;
let handled = 0;
const bot = {
	updates: {
		handleUpdate: async () => {
			handled += 1;
			sends += 1;
			await sleep(BOUND_MS * 3);
		},
	},
	api: {
		setWebhook: async () => ({}),
		deleteWebhook: async () => ({}),
		getWebhookInfo: async () => ({}),
		sendMessage: async () => ({}),
	},
};

const Runner = telegramUpdateRunner(() => ({ bot }), {
	attemptTimeoutMs: BOUND_MS,
	retryMs: [1],
});
const state = memoryState();
const runner = new Runner(state, {});

const enqueued = await runner.fetch(
	new Request("https://runner/enqueue", {
		method: "POST",
		body: JSON.stringify({ update_id: 4242, message: { text: "hi" } }),
	}),
);
assert.equal(enqueued.status, 200);

await runner.alarm(); // times out, schedules the retry
assert.equal(handled, 1);
assert.notEqual(state.alarm, null, "the timed-out attempt schedules a retry");

await runner.alarm(); // the retry: waits for the first attempt, which settles ok
assert.equal(handled, 1, "the retry joined the running attempt");
assert.equal(sends, 1, "the reply went out once");

// A later delivery of the same update is a duplicate, never a new job.
const again = await runner.fetch(
	new Request("https://runner/enqueue", {
		method: "POST",
		body: JSON.stringify({ update_id: 4242, message: { text: "hi" } }),
	}),
);
assert.deepEqual(await again.json(), { enqueued: false, duplicate: true });

// An attempt that settled is gone: a fresh runner instance dispatches anew.
handled = 0;
const fresh = new Runner(memoryState(), {});
await fresh.fetch(
	new Request("https://runner/enqueue", {
		method: "POST",
		body: JSON.stringify({ update_id: 7, message: { text: "x" } }),
	}),
);
bot.updates.handleUpdate = async () => {
	handled += 1;
};
await fresh.alarm();
assert.equal(handled, 1);

console.log("update-runner: ok");
