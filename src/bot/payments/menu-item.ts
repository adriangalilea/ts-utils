/**
 * `payments.menuItem` — single drop-in entry for `botMenu({ items: […] })`.
 *
 * Label, style, and submenu adapt to the user's current state via live
 * resolvers reading `ctx.session.pay.*` (see `bot/CLAUDE.md` § "Snapshot
 * vs live derives"). The plugin owns the whole submenu — bot author
 * just adds `payments.menuItem` to their items array.
 *
 * Submenu shape (v1):
 *
 *   /settings → 💎 VIP
 *   ├── ── tier cards ──
 *   │   [💎 VIP — 500 ⭐]               buy / current state via style
 *   │   [🌟 VIP Max — 2000 ⭐]
 *   ├── ── credits packs (if axis used) ──
 *   │   [💬 +100 — 100 ⭐]
 *   │   [💬 +500 — 400 ⭐]
 *   ├── ── perks (if axis used) ──
 *   │   [🎁 Voice mode — 1500 ⭐]      hidden when owned
 *   ├── ── manage (when vip active) ──
 *   │   [⛔ Cancel renewal]            or [↩️ Resume renewal] when canceled
 *   ├── 💬 Help / refunds → ctx.send(paysupport blurb)
 *   ├── ⬅️ Back  ✖️ Close             (botMenu auto-renders these in submenus)
 *
 * What's deliberately NOT here yet:
 *
 *   - Per-charge **History** view + in-menu refund request. The compliance
 *     surface (`/paysupport` + admin-mediated refund) is fulfilled by
 *     the admin commands and the message-side flow in `refund.ts`. The
 *     history UI is a v2 follow-up (see CLAUDE.md §"Open follow-ups").
 *
 *   - Deep-link `require()` → exact rung. v1 opens VIP root; deep-linking
 *     needs menu-state encoding in callback data.
 */

import { say } from "../../say/index.js";
import { narrow } from "../ctx.js";
import type { MenuCtx, MenuItem } from "../menu.js";
import { presentInvoice } from "./invoice.js";
import type {
	BotPaymentsConfig,
	PaymentsSession,
	ProductCatalog,
} from "./types.js";

const FALLBACK_LANG = "en";

type Lang = string;

/**
 * `MenuCtx` is deliberately narrow + plugin-agnostic (see `bot/menu.ts`
 * docstring) — it doesn't know about `session.pay` or `session.language`
 * because the menu plugin stays decoupled from any single feature. Each
 * feature's menu items widen ctx structurally via `narrow<...>` to read
 * the fields they own.
 */
type WithPaySession = {
	session?: { pay?: PaymentsSession; language?: string };
};

const ctxLang = (ctx: MenuCtx): Lang =>
	narrow<WithPaySession>(ctx).session?.language ?? FALLBACK_LANG;

const ctxPay = (ctx: MenuCtx): PaymentsSession | undefined =>
	narrow<WithPaySession>(ctx).session?.pay;

const resolveName = (
	value: { [k: string]: string } | undefined,
	lang: Lang,
): string => {
	if (!value) return "";
	return value[lang] ?? value[FALLBACK_LANG] ?? Object.values(value)[0] ?? "";
};

// ─── public factory ────────────────────────────────────────────────

export const buildPaymentsMenuItem = (args: {
	cfg: BotPaymentsConfig<string>;
	catalog: ProductCatalog;
}): MenuItem => {
	const { cfg, catalog } = args;

	// Root entry label + style adapt to current tier.
	const rootLabel = (ctx: MenuCtx): string => {
		const lang = ctxLang(ctx);
		const pay = ctxPay(ctx);
		if (!pay?.vip) {
			return say({ en: "💎 VIP", es: "💎 VIP" }, lang);
		}
		// Active subscription — show name + days remaining.
		const rung = catalog.vip[pay.vip.rung - 1];
		const name = rung
			? resolveName(rung.name as { [k: string]: string }, lang)
			: "VIP";
		const daysLeft = Math.max(
			0,
			Math.ceil((pay.vip.expiresAt * 1000 - Date.now()) / 86_400_000),
		);
		// Two visual states: active+renewing → no marker; canceled → "expira".
		if (pay.vip.canceled) {
			return say(
				{
					en: `💎 ${name} · expires in ${daysLeft} d`,
					es: `💎 ${name} · expira en ${daysLeft} d`,
				},
				lang,
			);
		}
		return say(
			{ en: `💎 ${name} · ${daysLeft} d`, es: `💎 ${name} · ${daysLeft} d` },
			lang,
		);
	};

	const rootStyle = (ctx: MenuCtx): "primary" | "danger" | undefined => {
		const pay = ctxPay(ctx);
		if (!pay?.vip) return "primary"; // free → blue, "buy me" affordance
		if (pay.vip.canceled) return "danger"; // about to lapse
		return undefined; // active+renewing → neutral
	};

	// ── submenu items ───────────────────────────────────────────────
	//
	// Menu item ids must not contain `.` — bot/menu joins paths with
	// `.` (`pay.<itemId>`), so a dot in the id collides with the path
	// separator and `itemForPath()` mis-parses the segments → "Item
	// not found" with no logging. We replace dots with `_` for the
	// menu id only; the action closure still uses the canonical
	// `productKey` ("vip.1", "credits.1", "perks.voice_mode") for the
	// catalog lookup and invoice payload.
	const menuId = (productKey: string): string => productKey.replace(/\./g, "_");

	const items: MenuItem[] = [];

	// 1. Tier cards (one per declared rung)
	for (const rung of catalog.vip) {
		items.push({
			id: menuId(rung.id), // e.g. 'vip_1' — path-safe menu id
			label: (ctx) => {
				const lang = ctxLang(ctx);
				const name = resolveName(rung.name as { [k: string]: string }, lang);
				const pay = ctxPay(ctx);
				if (pay?.vip?.rung === rung.rank) {
					return say(
						{
							en: `✓ ${name} — ${rung.xtr} ⭐ (current)`,
							es: `✓ ${name} — ${rung.xtr} ⭐ (actual)`,
						},
						lang,
					);
				}
				const isUpgrade = (pay?.vip?.rung ?? 0) < rung.rank;
				const tag = isUpgrade
					? say({ en: "Upgrade", es: "Subir" }, lang)
					: say({ en: "Switch", es: "Cambiar" }, lang);
				return `💎 ${name} — ${rung.xtr} ⭐ · ${tag}`;
			},
			style: (ctx) => {
				const pay = ctxPay(ctx);
				if (pay?.vip?.rung === rung.rank) return "primary";
				return undefined;
			},
			// Don't re-show the buy card for the currently-active rung —
			// it's already labeled "current" and tapping would re-invoice
			// the same product, which Telegram allows but isn't useful UX.
			visible: (ctx) => ctxPay(ctx)?.vip?.rung !== rung.rank,
			action: async (ctx) => {
				await presentInvoice(
					narrow<Parameters<typeof presentInvoice>[0]>(ctx),
					cfg,
					catalog,
					rung.id,
				);
				// Toast is the only thing the menu plugin will send for this
				// tap; the invoice / waiver prompt itself goes out as a
				// fresh message via ctx.send inside presentInvoice.
				return undefined;
			},
		});
	}

	// 2. Credits packs (if axis configured)
	for (const pack of catalog.creditsPacks) {
		items.push({
			id: menuId(pack.id), // e.g. 'credits_1' — path-safe menu id
			label: (ctx) => {
				const lang = ctxLang(ctx);
				const unit = catalog.creditsUnit
					? resolveName(catalog.creditsUnit as { [k: string]: string }, lang)
					: "credits";
				const explicit = pack.name
					? resolveName(pack.name as { [k: string]: string }, lang)
					: undefined;
				const body = explicit ?? `+${pack.creditsGranted} ${unit}`;
				return `💬 ${body} — ${pack.xtr} ⭐`;
			},
			action: async (ctx) => {
				await presentInvoice(
					narrow<Parameters<typeof presentInvoice>[0]>(ctx),
					cfg,
					catalog,
					pack.id,
				);
				return undefined;
			},
		});
	}

	// 3. Perks — hide when already owned (no "tap to re-buy" UX trap)
	for (const perk of catalog.perks) {
		items.push({
			id: menuId(perk.id), // e.g. 'perks_voice_mode' — path-safe
			label: (ctx) => {
				const lang = ctxLang(ctx);
				const name = resolveName(perk.name as { [k: string]: string }, lang);
				return `🎁 ${name} — ${perk.xtr} ⭐`;
			},
			visible: (ctx) => !ctxPay(ctx)?.perks?.[perk.key],
			action: async (ctx) => {
				await presentInvoice(
					narrow<Parameters<typeof presentInvoice>[0]>(ctx),
					cfg,
					catalog,
					perk.id,
				);
				return undefined;
			},
		});
	}

	// 4. Manage: cancel renewal / resume renewal (single dynamic button)
	items.push({
		id: "manage",
		label: (ctx) => {
			const lang = ctxLang(ctx);
			const pay = ctxPay(ctx);
			if (!pay?.vip) return ""; // hidden when free
			return pay.vip.canceled
				? say({ en: "↩️ Resume renewal", es: "↩️ Reanudar renovación" }, lang)
				: say({ en: "⛔ Cancel renewal", es: "⛔ Cancelar renovación" }, lang);
		},
		style: (ctx) => {
			const pay = ctxPay(ctx);
			return pay?.vip?.canceled ? "primary" : "danger";
		},
		visible: (ctx) => !!ctxPay(ctx)?.vip,
		refresh: true,
		confirm: {
			prompt: {
				en:
					"⚠️ Toggle auto-renewal for your VIP subscription?\n\n" +
					"Canceling: access continues until the current period ends; no renewal charge.\n" +
					"Resuming: auto-renewal turns back on.",
				es:
					"⚠️ ¿Cambiar la renovación automática de tu suscripción VIP?\n\n" +
					"Cancelar: mantienes acceso hasta el fin del periodo actual; no se cobra renovación.\n" +
					"Reanudar: se vuelve a activar la renovación automática.",
			},
		},
		action: async (ctx) => {
			const lang = ctxLang(ctx);
			const pay = ctxPay(ctx);
			if (!pay?.vip) {
				return say({ en: "Nothing to do.", es: "Nada que hacer." }, lang);
			}
			const c = narrow<{
				bot: {
					api: {
						editUserStarSubscription: (p: {
							user_id: number;
							telegram_payment_charge_id: string;
							is_canceled: boolean;
						}) => Promise<unknown>;
					};
				};
				from?: { id: number };
				session: { pay?: PaymentsSession };
			}>(ctx);
			const userId = c.from?.id;
			if (!userId) {
				return say({ en: "No user.", es: "Sin usuario." }, lang);
			}
			const wantCanceled = !pay.vip.canceled;
			try {
				await c.bot.api.editUserStarSubscription({
					user_id: userId,
					telegram_payment_charge_id: pay.vip.chargeId,
					is_canceled: wantCanceled,
				});
			} catch (e) {
				console.error("[bot/payments/menu] editUserStarSubscription failed", e);
				return say(
					{ en: "Failed — try later.", es: "Falló — prueba luego." },
					lang,
				);
			}
			// Reflect the new state in session so the menu re-renders
			// correctly (refresh: true will fire the label/style resolvers
			// again immediately after this returns).
			const session = c.session;
			if (session.pay?.vip) {
				session.pay = {
					...session.pay,
					vip: { ...session.pay.vip, canceled: wantCanceled },
				};
			}
			return wantCanceled
				? say(
						{ en: "⛔ Renewal canceled.", es: "⛔ Renovación cancelada." },
						lang,
					)
				: say(
						{ en: "↩️ Renewal resumed.", es: "↩️ Renovación reanudada." },
						lang,
					);
		},
	});

	// 5. Help / refunds — URL-style action that just sends the paysupport blurb
	items.push({
		id: "help",
		label: (ctx) =>
			say(
				{ en: "💬 Help & refunds", es: "💬 Ayuda y reembolsos" },
				ctxLang(ctx),
			),
		action: async (ctx) => {
			const lang = ctxLang(ctx);
			const c = narrow<{ send: (text: string) => Promise<unknown> }>(ctx);
			await c.send(
				say(
					{
						en:
							`Need help with a payment?\n\n` +
							`• Contact: ${cfg.paysupport}\n` +
							`• Include the chargeId from your purchase confirmation.\n\n` +
							`Refunds are processed by the admin within Telegram.`,
						es:
							`¿Necesitas ayuda con un pago?\n\n` +
							`• Contacto: ${cfg.paysupport}\n` +
							`• Incluye el chargeId de tu confirmación de compra.\n\n` +
							`Los reembolsos los gestiona el admin dentro de Telegram.`,
					},
					lang,
				),
			);
			return undefined;
		},
	});

	return {
		id: "pay",
		label: rootLabel,
		style: rootStyle,
		submenu: items,
	};
};
