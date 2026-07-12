/**
 * Runnable smoke-test for the GramIO plugins shipped with this package.
 *
 * Run:
 *   BOT_TOKEN=… pnpm tsx tests/bot-integration.ts
 *
 * Manual test plan (commands are admin-only unless noted):
 *
 *   /start      — shows you which gate let the request through
 *                 (admin / default / store), plus thread/topic info
 *                 for the chat the command was sent in.
 *   /stream     — exercises streamChatReply: a fake thinking phase in the
 *                 draft preview, then a markdown reply with bullets, code,
 *                 and a blockquote
 *   <any text>  — echoes the message back into the same thread, plus
 *                 exercises coalesceLongMessages. Paste >4096 chars
 *                 and the echo should report the full length, not half.
 *   /access     — opens the persistent admin menu (Aprobados, Pendientes,
 *                 Denegados, Refresh, Cerrar)
 *   /simulate   — fakes "another user just DMed the bot"; you'll receive an
 *                 admin notification with [✅ Aprobar][❌ Denegar]. Tapping
 *                 those buttons hits the real handlers, no second account
 *                 needed.
 *
 *   /me         — current payments state (tier, credits, perks)
 *   /vip        — gated by ctx.payments.atLeast('vip') — runs a "premium
 *                 feature" message if you're VIP, prompts upgrade otherwise
 *   /spend      — consumes 1 credit via ctx.payments.credits.tryConsume()
 *                 — prompts a top-up if you have none
 *   /settings   — opens user menu; /settings → 💎 VIP buys / cancels /
 *                 manages, including credits + perks
 *   /refunds    — admin-only: lists your recent charges with [Refund]
 *                 buttons that hit the real refundStarPayment flow
 *   /paysupport — auto-installed by bot/payments per ToS §6.5
 *
 *   Ctrl-C      — gracefulStart catches SIGINT → bot.stop() → exit 0
 *
 * ## Payments E2E with real Stars
 *
 *   1. /me                                  → free, 0 credits, no perks
 *   2. /vip                                 → upgrade prompt with button
 *   3. /settings → 💎 VIP → tap "💎 Test VIP — 1 ⭐"
 *   4. waiver prompt → tap ✅ Consiento
 *   5. Telegram payment sheet → confirm
 *   6. bot confirms purchase; /me now shows vip.1 + granted credits
 *   7. /vip                                 → "premium feature" message
 *   8. /spend                               → consumes 1 credit
 *   9. /settings → 💎 VIP → "💬 +10 credits — 1 ⭐"  (top up)
 *  10. /settings → 💎 VIP → "🎁 Test perk — 1 ⭐"   (one-shot)
 *  11. /refunds                             → list with [Refund]
 *  12. tap Refund on the VIP charge        → /me now shows free again,
 *                                             credits decremented by grant amount
 *  13. /refunds on the perk charge         → /me hides the perk again
 *
 * ## Threaded Mode demo (BotFather → bot → Bot Settings → Threaded Mode)
 *
 * With Threaded Mode enabled for the bot, your private chat can have
 * multiple parallel topic threads. Each incoming message carries
 * `message_thread_id`, surfaced as `ctx.threadId`. With this repo's
 * pinned fork of `@gramio/contexts`, the SendMixin auto-forwards
 * `message_thread_id` on every `ctx.send` family call — replies stay
 * in their thread automatically. `llmHistory` shards conversation
 * state per thread, so each thread is its own conversation.
 */

import { session } from "@gramio/session";
import { inMemoryStorage } from "@gramio/storage";
import { Bot, InlineKeyboard } from "gramio";
import {
	accessControl,
	simulateAccessRequest,
} from "../src/bot/access-control.js";
import { coalesceLongMessages } from "../src/bot/coalesce.js";
import { adminContext, gracefulStart } from "../src/bot/kit.js";
import { language } from "../src/bot/language.js";
import { llmHistory, streamChatReply } from "../src/bot/llm.js";
import { botMenu } from "../src/bot/menu.js";
import { botPayments } from "../src/bot/payments/index.js";
import { refundApproveCb } from "../src/bot/payments/refund.js";
import type { LlmStreamEvent } from "../src/llm/index.js";
import { kev } from "../src/platform/kev.js";

const token = kev.mustGet("BOT_TOKEN");

const storage = inMemoryStorage();

// Shared session — one record per user, with each plugin owning a
// distinct field by convention (`access`, `language`, `llm`).
// All session-using plugins below declare this as a dependency;
// gramio's runtime deduplication ensures the session derive runs
// exactly once per update.
const userSession = session({
	storage,
	key: "session",
	initial: () => ({}),
});

const lang = language({
	session: userSession,
	supported: ["en", "es"] as const,
	default: "en",
});

const chat = llmHistory({
	session: userSession,
	maxTurns: 20,
	retentionDays: 7,
});

// Payments — cheap (1 ⭐) test products so the full pay/refund round-trip
// can be exercised without burning Stars. Sandboxed in inMemoryStorage:
// charges + waiver state live only for this process' lifetime, so a
// restart resets everything (handy during iteration, useless for
// production — but this is integration smoke-test config).
//
// `vip` (subscription) requires Telegram-side bot-revenue export
// (Fragment payout method linked in BotFather → Bot Settings) before
// `sendInvoice` with `subscription_period` succeeds. Without it,
// Telegram replies with `Bad Request: SUBSCRIPTION_EXPORT_MISSING`.
// Set `INCLUDE_VIP=1` once BotFather is set up; otherwise we run the
// test bot with credits + perks only (both one-off, no export needed).
const includeVip = kev.int("INCLUDE_VIP", 0) > 0;
const payments = botPayments({
	session: userSession,
	storage,
	paysupport: "@adriangalilea",
	legal: {
		sellerName: "Adrian Galilea (test)",
		nif: "X1234567Y",
		// termsUrl + privacyUrl omitted on purpose: terms button hides
		// (no Telegram-side default), privacy defaults to Telegram's
		// Standard Bot Privacy Policy via DEFAULT_PRIVACY_URL.
	},
	waiver: {
		version: "2026-05-test",
		text: {
			en:
				"I expressly request immediate delivery of the digital content. " +
				"I understand that under Art. 103(m) TRLGDCU I lose the 14-day " +
				"right of withdrawal once execution begins.",
			es:
				"Solicito expresamente el suministro inmediato del contenido digital. " +
				"Entiendo que conforme al art. 103.m) del TRLGDCU pierdo el derecho " +
				"de desistimiento una vez iniciada la ejecución.",
		},
	},
	...(includeVip && {
		vip: [
			{
				xtr: 1,
				period: "30d" as const,
				name: { en: "Test VIP", es: "Test VIP" },
				grants: { credits: 10 }, // ← renewal grant; bumps balance by 10
			},
		],
	}),
	credits: {
		unit: { en: "credit", es: "crédito" },
		packs: [{ xtr: 1, grants: { credits: 10 } }],
	},
	perks: {
		test_perk: {
			xtr: 1,
			name: { en: "Test perk", es: "Test perk" },
		},
	},
});

// Demo onFulfilled hook — logs every fulfillment so you can correlate
// with the bot's outgoing confirmation message during the E2E test.
payments.onFulfilled("*", (event) => {
	console.log(
		`[payments] fulfilled ${event.productKey} for user ${event.userId} · chargeId=${event.chargeId} · xtr=${event.xtr}`,
	);
});

const menu = botMenu({
	command: "settings",
	description: "Open settings",
	adminContact: "@adriangalilea",
	personalData: { storage }, // ← enables 🗑 Forget · 📥 Export (wipes ctx.llm too)
	items: [
		lang.menuItem,
		payments.menuItem, // ← 💎 VIP — buy / cancel / packs / perks / help
		{
			id: "recent",
			label: "📜 Show last 3 turns (this thread)",
			action: async (ctx) => {
				// ctx.llm is sharded per thread → this shows the current
				// thread's last 3 messages, not the global feed.
				type Helpers = {
					llm?: {
						get: () => ReadonlyArray<{ role: string; content: unknown }>;
					};
					send: (t: string, params?: object) => Promise<unknown>;
				};
				const c = ctx as unknown as Helpers;
				const last = (c.llm?.get() ?? [])
					.slice(-3)
					.map(
						(m, i) =>
							`${i + 1}. [${m.role}] ${
								typeof m.content === "string"
									? m.content
									: JSON.stringify(m.content)
							}`,
					)
					.join("\n");
				await c.send(last || "(no turns in this thread yet)");
			},
		},
	],
});

const bot = new Bot(token)
	.extend(adminContext({ adminId: 190202471 }))
	.extend(userSession) // session first
	.extend(accessControl({ session: userSession, storage, defaults: [] }))
	.extend(coalesceLongMessages({ log: true }))
	.extend(chat.plugin)
	.extend(lang.plugin)
	.extend(payments.plugin)
	.extend(menu.plugin)

	// ─── /start ────────────────────────────────────────────────────
	.command("start", { description: "Show what the bot can do" }, (ctx) => {
		if (!ctx.access.allowed) return;
		const threadLine =
			`🧵 ctx.threadId: ${ctx.threadId ?? "(none)"}\n` +
			`   isTopicMessage: ${ctx.isTopicMessage()}\n` +
			`   directMessagesTopic: ${ctx.directMessagesTopic?.topicId ?? "(none)"}`;
		// Auto-threads via gramio SendMixin (forked, see README).
		return ctx.say.send({
			en:
				`👋 hi\n\n` +
				`🔑 access.source: ${ctx.access.source}\n` +
				`👑 isAdmin: ${ctx.isAdmin}\n` +
				`🆔 adminId: ${ctx.adminId}\n` +
				`🌐 ctx.lang: ${ctx.lang}\n` +
				`${threadLine}\n\n` +
				`Commands:\n` +
				`  /settings — user menu (language + forget/export/privacy)\n` +
				`  /stream   — streaming markdown demo\n` +
				`  /access   — admin menu (admin only)\n` +
				`  /simulate — fake access request (admin only)\n\n` +
				`Paste >4096 chars to test coalesce. Send any text to see the echo + thread routing.`,
			es:
				`👋 hola\n\n` +
				`🔑 access.source: ${ctx.access.source}\n` +
				`👑 isAdmin: ${ctx.isAdmin}\n` +
				`🆔 adminId: ${ctx.adminId}\n` +
				`🌐 ctx.lang: ${ctx.lang}\n` +
				`${threadLine}\n\n` +
				`Comandos:\n` +
				`  /settings — menu user-facing (language + forget/export/privacy)\n` +
				`  /stream   — demo streaming markdown\n` +
				`  /access   — menú admin (sólo admin)\n` +
				`  /simulate — fake access request (sólo admin)\n\n` +
				`Pega texto >4096 chars para coalesce. Manda cualquier texto para ver el echo y el routing de thread.`,
		});
	})

	// ─── /stream — exercises streamChatReply ───────────────────────
	// Draft-native: thinking streams in the ephemeral preview, content
	// finalizes as entity-split message(s). Try `reasoning: 'message'`
	// to persist the thinking as an expandable blockquote.
	.command(
		"stream",
		{ description: "Stream a fake LLM markdown reply" },
		async (ctx) => {
			if (!ctx.access.allowed) return;
			await streamChatReply(ctx, fakeLLM());
		},
	)

	// ─── plain text echo — exercises coalesce + thread routing + ctx.llm ─
	// Any non-command message:
	//   1. records the user turn in ctx.llm (so "Show last 3 turns"
	//      in /settings actually has something to show)
	//   2. echoes back into the same thread with diagnostic info
	//   3. records the echo as the assistant turn in ctx.llm
	//
	// Coalesce: if you paste >4096 chars Telegram splits it client-side;
	// coalesce joins them, this handler sees ONE event with the full
	// length. If coalesce is broken you'd see two events of <4096 each.
	//
	// Threaded Mode demo: send the same text in two different threads —
	// each echo lands in its own thread AND each /settings → Show last
	// 3 turns lists only that thread's exchanges (no bleed).
	.on("message", async (ctx) => {
		if (!ctx.access.allowed) return;
		if (ctx.text?.startsWith("/")) return; // commands handled above

		const len = ctx.text?.length ?? 0;
		const echo = ctx.text ?? "(non-text message)";
		// Cap the echo at 500 chars in the reply text so long pastes don't
		// double-render (coalesce stats are the point, not the content).
		const echoTrimmed = echo.length > 500 ? `${echo.slice(0, 500)}…` : echo;

		const threadInfo =
			ctx.threadId !== undefined
				? `🧵 thread: ${ctx.threadId}` +
					(ctx.directMessagesTopic
						? " (private-chat topic)"
						: ctx.isTopicMessage()
							? " (forum-supergroup topic)"
							: " (raw threadId, no topic flag set)")
				: "🧵 no thread";

		ctx.llm.add({ role: "user", content: echo });

		// Auto-threads via gramio SendMixin (forked, see README).
		await ctx.say.send({
			en: `📏 ${len} chars · ${threadInfo}\n\n🔁 echo:\n${echoTrimmed}`,
			es: `📏 ${len} chars · ${threadInfo}\n\n🔁 echo:\n${echoTrimmed}`,
		});

		ctx.llm.add({ role: "assistant", content: echoTrimmed });
	})

	// ─── /me — show current payments state ─────────────────────────
	.command(
		"me",
		{ description: "Show your current tier, credits, perks" },
		async (ctx) => {
			if (!ctx.access.allowed) return;
			const tier = ctx.payments.tier();
			const level = ctx.payments.tier.level();
			const tierName = ctx.payments.tier.label() ?? "—";
			const credits = ctx.payments.credits.balance();
			const hasPerk = ctx.payments.has("test_perk");
			const atLeastVip = ctx.payments.atLeast("vip");
			await ctx.say.send({
				en:
					`💼 your payments state\n\n` +
					`🏷️ tier: ${tier} · level ${level} · name "${tierName}"\n` +
					`💎 atLeast('vip'): ${atLeastVip}\n` +
					`💬 credits: ${credits}\n` +
					`🎁 test_perk owned: ${hasPerk}`,
				es:
					`💼 tu estado de pagos\n\n` +
					`🏷️ tier: ${tier} · nivel ${level} · nombre "${tierName}"\n` +
					`💎 atLeast('vip'): ${atLeastVip}\n` +
					`💬 créditos: ${credits}\n` +
					`🎁 test_perk desbloqueado: ${hasPerk}`,
			});
		},
	)

	// ─── /vip — gated by atLeast('vip') ────────────────────────────
	.command(
		"vip",
		{ description: "VIP-only feature (exercises require() upgrade prompt)" },
		async (ctx) => {
			if (!ctx.access.allowed) return;
			// `require()` sends a localized upgrade prompt with a button
			// deep-linking to /settings → 💎 VIP when the gate is closed.
			if (!(await ctx.payments.require("vip", { feature: "/vip demo" })))
				return;
			await ctx.say.send({
				en: "🎉 Welcome, VIP. This is the gated feature payload.",
				es: "🎉 Bienvenido, VIP. Este es el payload de la función gated.",
			});
		},
	)

	// ─── /spend — credit consumption demo ──────────────────────────
	.command(
		"spend",
		{ description: "Consume 1 credit (prompts top-up if zero)" },
		async (ctx) => {
			if (!ctx.access.allowed) return;
			const ok = ctx.payments.credits.tryConsume(1);
			if (!ok) {
				// No credits left — prompt the credits pack invoice. This
				// exercises ctx.payments.invoice() which handles waiver +
				// sendInvoice in one call.
				await ctx.say.send({
					en: "⛔ Out of credits — opening top-up invoice…",
					es: "⛔ Sin créditos — abriendo factura de recarga…",
				});
				await ctx.payments.invoice("credits.1");
				return;
			}
			const left = ctx.payments.credits.balance();
			await ctx.say.send({
				en: `✅ Spent 1 credit · ${left} remaining.`,
				es: `✅ Gastado 1 crédito · ${left} restantes.`,
			});
		},
	)

	// ─── /refunds — admin: list your charges with [Refund] buttons ─
	//
	// This is the manual-tester loop for E2E refund. The real refund
	// flow goes user → /paysupport contact → admin DM → approve.
	// Here the tester IS the admin, so we surface a direct admin list.
	// The button packs `refundApproveCb` (from bot/payments/refund) so
	// taps hit the same handler the production admin DM flow uses.
	.command(
		"refunds",
		{
			description: "Admin: list your charges with refund buttons",
			hide: true,
		},
		async (ctx) => {
			if (!ctx.isAdmin) return;
			const charges = await payments.admin.listCharges(ctx, ctx.from.id);
			if (charges.length === 0) {
				await ctx.send("(no charges yet — buy something first)");
				return;
			}
			const lines = [`📜 your last ${charges.length} charge(s)\n`];
			const kb = new InlineKeyboard();
			for (const c of charges.slice(0, 10)) {
				const tag =
					c.paysupportState === "refunded"
						? "↩️ refunded"
						: c.paysupportState === "opened"
							? "⏳ pending"
							: "✅ active";
				lines.push(`• ${c.productKey} · ${c.xtr} ⭐ · ${tag}`);
				if (c.paysupportState !== "refunded") {
					kb.text(
						`💸 Refund ${c.productKey}`,
						refundApproveCb.pack({ cid: c.chargeId }),
						{ style: "danger" },
					).row();
				}
			}
			await ctx.send(lines.join("\n"), { reply_markup: kb });
		},
	)

	// ─── /simulate — fake "stranger DMed the bot" ──────────────────
	.command(
		"simulate",
		{ description: "Admin: inject a fake access request", hide: true },
		async (ctx) => {
			if (!ctx.isAdmin) return;
			const fakeId = 900_000_000 + Math.floor(Math.random() * 99_999);
			await simulateAccessRequest(
				ctx.bot,
				storage,
				ctx.adminId,
				{
					id: fakeId,
					firstName: "Pepe",
					lastName: "Pérez",
					username: "pepe_fake",
				},
				"hola, ¿me dejas usar tu bot?",
			);
			await ctx.say.send({
				en:
					`🧪 simulated request from id ${fakeId}.\n` +
					`Check above — admin notification with ✅/❌ should have arrived.`,
				es:
					`🧪 simulated request from id ${fakeId}.\n` +
					`Mira arriba — debería haber llegado la notificación con ✅/❌.`,
			});
		},
	)

	.onStart(({ info }) => console.log(`[bot] running as @${info.username}`));

await gracefulStart(bot);

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Fakes an LLM event stream (a thinking phase, then markdown content) so we
 * can exercise streamChatReply without a real model. Yields every ~80ms.
 */
async function* fakeLLM(): AsyncGenerator<LlmStreamEvent> {
	const reasoning = `El usuario quiere una demo de streaming. Pienso un momento… listo.`;
	const reply =
		`**Streaming test** — markdown crudo parseado en cliente.\n\n` +
		`Aquí va una respuesta simulada:\n\n` +
		`- *primer* punto en cursiva\n` +
		`- **segundo** en negrita\n` +
		`- tercer punto con \`código inline\`\n\n` +
		`Y un bloque de código:\n\n` +
		`\`\`\`ts\nconst greeting = 'hola'\nconsole.log(greeting)\n\`\`\`\n\n` +
		`> Cita al final para cerrar.`;

	// Tokenize keeping whitespace so the stream "feels" like an LLM.
	for (const t of reasoning.match(/\S+|\s+/g) ?? []) {
		await sleep(40);
		yield { kind: "reasoning", text: t };
	}
	for (const t of reply.match(/\S+|\s+/g) ?? []) {
		await sleep(80);
		yield { kind: "delta", text: t };
	}
	yield { kind: "end", usage: null };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
