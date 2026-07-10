/**
 * createBot demo — the whole lifecycle story in one runnable file.
 *
 *   pnpm demo:bot                          build only (fake token, no network)
 *   BOT_TOKEN=123:abc pnpm demo:bot        actually long-polls as your bot
 *   BOT_PERSIST=./demo.sqlite …            same file, state survives restarts
 *
 * The same `app` default-exported from a Worker (D1 binding `DB`) serves
 * webhooks — no code change, see the README's lifecycle table.
 */
import { createBot } from "../src/bot/create.js";

type S = { favoriteColor?: string };

const app = createBot<S>({
	name: "demo-bot",
	token: (env) => (env.BOT_TOKEN as string | undefined) ?? "1:fake-build-only",
	language: { supported: ["en", "es"] as const, default: "en" },
	menu: {
		adminContact: "@adriangalilea",
		header: async (ctx) =>
			`⚙️ hi ${(ctx as { from?: { firstName?: string } }).from?.firstName ?? "there"}`,
		items: [
			{
				id: "color",
				label: (ctx) =>
					`🎨 ${app.session(ctx).favoriteColor ?? "pick a color"}`,
				action: (ctx) => {
					app.session(ctx).favoriteColor = "sage";
					return "✓ sage";
				},
			},
		],
	},
	handlers: (bot, { session }) => {
		bot.command("start", (ctx) =>
			ctx.send(
				`hello! favorite color: ${session(ctx).favoriteColor ?? "none yet"}`,
			),
		);
	},
});

export default app; // Worker cap — a D1 binding named DB makes this a prod bot

if (app.isMain(import.meta)) {
	if (process.env.BOT_TOKEN) {
		await app.poll();
	} else {
		// No token: prove the composition builds + narrate it, then exit.
		await app.build();
		console.log("built OK (set BOT_TOKEN to actually poll)");
	}
}
