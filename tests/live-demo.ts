/**
 * Demo (not a test — it renders, it doesn't assert) of the `live` layer,
 * shaped like a `cmail update`: a spinner phase, then a pinned multi-account
 * backfill table with progress bars and rates, while log lines (via the
 * normal logger) flow ABOVE the region without tearing it. All data is fake.
 *
 *   pnpm tsx tests/live-demo.ts          # animated (TTY)
 *   pnpm tsx tests/live-demo.ts | cat    # inert: final frames only
 */

import {
	bar,
	elapsed,
	live,
	spin,
	spinner,
	table,
	ui,
} from "../src/cli/index.js";
import { createLogger } from "../src/index.js";

const log = createLogger("sync");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = "running" | "cooling" | "done";
type Account = {
	alias: string;
	total: number;
	done: number;
	rate: number;
	state: State;
	coolUntil: number;
};

const accounts: Account[] = [
	{
		alias: "main",
		total: 13,
		done: 0,
		rate: 0,
		state: "running",
		coolUntil: 0,
	},
	{
		alias: "adrigd92",
		total: 39,
		done: 0,
		rate: 0,
		state: "running",
		coolUntil: 0,
	},
	{
		alias: "zapee87",
		total: 3,
		done: 0,
		rate: 0,
		state: "running",
		coolUntil: 0,
	},
	{
		alias: "white0",
		total: 1,
		done: 0,
		rate: 0,
		state: "running",
		coolUntil: 0,
	},
];

function row(a: Account): string[] {
	const icon =
		a.state === "done"
			? ui.ok("✓")
			: a.state === "cooling"
				? ui.warn("◌")
				: spin();
	const detail =
		a.state === "done"
			? ui.muted("bodies complete")
			: a.state === "cooling"
				? ui.warn(
						`cooling ${Math.ceil((a.coolUntil - Date.now()) / 1000)}s (throttled)`,
					)
				: `${ui.ref(`${Math.floor(a.done)}/${a.total}`)}  ${ui.muted(`${a.rate.toFixed(1)}/s`)}`;
	// a cooling account's bar goes amber — style hook on the filled part
	const fill = a.state === "cooling" ? ui.warn : undefined;
	return [icon, a.alias, bar(a.done, a.total, 18, fill), detail];
}

const start = Date.now();

async function main(): Promise<void> {
	// Phase 1 — the one-liner, relabeled mid-flight. TTY: animated; pipe: final ✓ line only.
	await spinner("connecting 0/4 accounts", async (set) => {
		for (let i = 1; i <= 4; i++) {
			await sleep(300);
			set(`connecting ${i}/4 accounts`);
		}
	});
	log.info("main/all: +12 new · 73,202 synced");
	log.info("adrigd92/all: +31 new · 111,056 synced");

	// Phase 2 — the pinned region. The frame is a plain string built with
	// table()/ui/widgets; state mutates outside, render() reads it.
	const region = live(
		() =>
			`${ui.head("backfill")} ${ui.muted(elapsed(start))}\n${table(accounts.map(row), { indent: 2 })}`,
	);

	const tick = setInterval(() => {
		for (const a of accounts) {
			if (a.state === "cooling" && Date.now() >= a.coolUntil)
				a.state = "running";
			if (a.state !== "running") continue;
			a.rate = 0.5 + Math.random() * 3;
			a.done = Math.min(a.total, a.done + Math.random() * 1.5);
			if (a.done >= a.total) {
				a.state = "done";
				log.ready(`${a.alias}: bodies complete`);
			}
		}
	}, 150);

	// Logs above the live region — the normal logger, no special API.
	setTimeout(
		() => log.warn("zapee87: throttled — cooling 3s then auto-retry"),
		1500,
	);
	setTimeout(() => {
		const z = accounts[2];
		if (!z || z.state === "done") return;
		z.state = "cooling";
		z.coolUntil = Date.now() + 3000;
	}, 1500);

	while (accounts.some((a) => a.state !== "done")) await sleep(100);
	clearInterval(tick);

	// Final frame persists into scrollback; everything after is normal output.
	region.done();
	console.log(
		`mirror up to date — ${ui.ok("224,902")} messages · 224,902 bodies (100%)`,
	);
}

await main();
