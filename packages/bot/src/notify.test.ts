// bot/notify alertAdminOnErrors contract: every error the process logs reaches
// the admins, one DM per distinct error per window, repeats counted and
// reported with the next DM, never silently dropped; info is not an alert, and
// the module's own failures (a DM that could not be sent) never alert about
// themselves. Run: pnpm test
import assert from "node:assert/strict";
import { log as root, setLogConsole } from "@adriangalilea/utils/log";
import { alertAdminOnErrors } from "./notify.js";

setLogConsole(false);
const sent: { chat_id: number; text: string }[] = [];
const bot = {
	api: {
		sendMessage: async (params: { chat_id: number; text: string }) => {
			sent.push(params);
		},
	},
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const stop = alertAdminOnErrors(bot, [7], { ms: 60_000 });
const log = root.scope("unfurl");

log.info("links seen", { matched: 1 });
await settle();
assert.equal(sent.length, 0, "info is not an alert");

log.error("unfurl", {
	err: new Error("Reddit post failed: 403"),
	url: "https://redd.it/x",
});
await settle();
assert.equal(sent.length, 1);
assert.equal(sent[0].chat_id, 7);
assert.match(
	sent[0].text,
	/^🚨 notify\.test · unfurl: unfurl\nError: Reddit post failed: 403\nurl: https:\/\/redd\.it\/x$/,
);

log.error("unfurl", {
	err: new Error("Reddit post failed: 403"),
	url: "https://redd.it/y",
});
log.error("unfurl", {
	err: new Error("Reddit post failed: 403"),
	url: "https://redd.it/z",
});
await settle();
assert.equal(
	sent.length,
	1,
	"the same error inside the window is counted, not sent",
);

log.error("unfurl", { err: new Error("stalled downloading") });
await settle();
assert.equal(sent.length, 2, "a different error is its own alert");

await log
	.span("unfurl", { url: "https://x.com/a" }, async () => {
		throw new Error("rich post refused");
	})
	.catch(() => undefined);
await settle();
assert.equal(sent.length, 3, "a failed span is an error event");
assert.match(sent[2].text, /Error: rich post refused/);

root.scope("bot").scope("notify").error("admin DM failed", { admin: 7 });
await settle();
assert.equal(
	sent.length,
	3,
	"the module's own failures never alert about themselves",
);

stop();
log.error("after stop", {});
await settle();
assert.equal(sent.length, 3, "unsubscribed");
