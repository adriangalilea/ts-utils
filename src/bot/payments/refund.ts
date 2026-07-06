/**
 * Refund flow — user-initiated request, admin-approved, executed via
 * `refundStarPayment` on Telegram's side, reversed in our cache via
 * `derive.ts`'s incremental + full-rebuild helpers.
 *
 * The flow mirrors `access-control.ts`'s admin-DM approval pattern:
 *
 *      user opens /settings → 💎 VIP → 📜 History → tap a charge
 *                       │
 *               "💸 Request refund"  →  confirm overlay  →  tap "✅"
 *                       │
 *      pay:charge.paysupportState = 'opened'
 *      DM admin with charge details + [✅ Approve] [❌ Deny]
 *                       │
 *                  admin taps
 *                       │
 *       Approve  →  refundStarPayment  →  pay:refund + revert state
 *       Deny     →  paysupportState = 'none'
 *                       │
 *               user gets DM with the outcome
 *
 * Callback data carries the chargeId only — everything else is read
 * from the persisted record. Telegram's `telegram_payment_charge_id` is
 * a moderately long string (~40 chars in practice); with our short
 * `payRf*` schema names this stays under the 64-byte callback_data cap.
 */

import type { Storage } from "@gramio/storage";
import { InlineKeyboard } from "gramio";

import { say } from "../../say/index.js";
import { createLogger } from "../../universal/log.js";
import { callbackNs } from "../callbacks.js";
import type { BotCallbackCtx } from "../ctx.js";
import { botStorageKey } from "../ctx.js";
import { rebuildVipAndPerks, revertCreditsForCharge } from "./state.js";
import type { PaymentsStores } from "./stores.js";
import type {
	BotPaymentsConfig,
	ChargeRecord,
	PaymentsSession,
} from "./types.js";

const FALLBACK_LANG = "en";
const log = createLogger("bot/payments");

const cb = callbackNs("pay");

// ─── callback data schemas ─────────────────────────────────────────

/** User tap on a charge entry — opens confirmation overlay then admin DM. */
export const refundRequestCb = cb.data("refund:request", { cid: "string" });
/** Admin tap on the DM notification — approve. */
export const refundApproveCb = cb.data("refund:approve", { cid: "string" });
/** Admin tap on the DM notification — deny. */
export const refundDenyCb = cb.data("refund:deny", { cid: "string" });
/** Admin tap on the DM notification — close (no action). */
export const refundCloseCb = cb.data("refund:close", {});

// ─── shared types ──────────────────────────────────────────────────

/** Strict bot.api surface this module exercises. */
type RefundBotApi = {
	refundStarPayment: (params: {
		user_id: number;
		telegram_payment_charge_id: string;
	}) => Promise<unknown>;
	editUserStarSubscription: (params: {
		user_id: number;
		telegram_payment_charge_id: string;
		is_canceled: boolean;
	}) => Promise<unknown>;
	sendMessage: (params: {
		chat_id: number;
		message_thread_id?: number;
		text: string;
		reply_markup?: unknown;
	}) => Promise<unknown>;
};

type SessionLike = { pay?: PaymentsSession; language?: string };

/**
 * Callback-query ctx shape this module's handlers receive. Composed
 * from the canonical `BotCallbackCtx` with `{ cid: string }` queryData,
 * intersected with the admin-context derives (`adminId`, `isAdmin`)
 * the handlers depend on for the approve/deny/close paths.
 */
type CommonCtx = BotCallbackCtx<SessionLike, { cid: string }, RefundBotApi> & {
	adminId: number;
	isAdmin: boolean;
};

type FullSessionRecord = {
	pay?: PaymentsSession;
	language?: string;
} & Record<string, unknown>;

const ctxLang = (ctx: { session?: { language?: string } }): string =>
	ctx.session?.language ?? FALLBACK_LANG;

// ─── cross-user session mutation ───────────────────────────────────
//
// The user's session record lives in @gramio/session's keyspace
// (`bot-<id>:<userId>` via `botStorageKey`), not in our `pay:*` stores.
// We still hit `storage` directly here because the session record holds
// many fields owned by other plugins (access, language, llm) and we
// must preserve them via read-modify-write.

const loadFullRecord = async (
	storage: Storage,
	ctx: { bot: { info: { id: number } } },
	userId: number,
): Promise<FullSessionRecord> =>
	((await storage.get(botStorageKey(ctx, userId))) as
		| FullSessionRecord
		| undefined) ?? {};

/**
 * Apply the refund's side effect to the target user's session record
 * (which is NOT `ctx.session` when the admin is the actor).
 *
 *   - credits: targeted decrement (clamped at zero — see derive.ts)
 *   - vip + perks: full rebuild from the post-refund charge log
 *
 * Read-modify-write preserves other plugins' fields in the same record.
 */
const applyRefundToUser = async (
	stores: PaymentsStores,
	storage: Storage,
	ctx: { bot: { info: { id: number } } },
	userId: number,
	refundedCharge: ChargeRecord,
): Promise<void> => {
	const full = await loadFullRecord(storage, ctx, userId);
	const session = { pay: full.pay } as { pay?: PaymentsSession };
	revertCreditsForCharge(session, refundedCharge);
	// charges already include the refunded one with state='refunded'
	const chargeIds = await stores.userCharges(userId).list(ctx);
	const charges = (
		await Promise.all(chargeIds.map((id) => stores.charges.get(ctx, id)))
	).filter((c): c is ChargeRecord => c !== undefined);
	// userCharges().list() returns newest-first, but deriveState/rebuildVipAndPerks
	// assume oldest-first (vip is last-write-wins as it iterates). Sort ascending by receivedAt so a
	// refund rebuild restores the newest surviving subscription, not the oldest.
	charges.sort((a, b) => a.receivedAt - b.receivedAt);
	rebuildVipAndPerks(session, charges);
	full.pay = session.pay;
	await storage.set(botStorageKey(ctx, userId), full);
};

// ─── notification rendering ────────────────────────────────────────

const fmtAge = (ms: number): string => {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}min`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
};

const adminNotificationText = (charge: ChargeRecord, lang: string): string =>
	[
		say({ en: "💸 Refund requested", es: "💸 Reembolso solicitado" }, lang),
		"",
		`👤 ${say({ en: "user", es: "usuario" }, lang)}: ${charge.userId}`,
		`📦 ${charge.productKey}`,
		`⭐ ${charge.xtr}`,
		`🆔 ${charge.chargeId}`,
		`⏰ ${say({ en: "purchased", es: "comprado" }, lang)}: ${fmtAge(Date.now() - charge.receivedAt)} ${say({ en: "ago", es: "atrás" }, lang)}`,
	].join("\n");

const adminKeyboard = (chargeId: string, lang: string): InlineKeyboard =>
	new InlineKeyboard()
		.text(
			say({ en: "✅ Approve", es: "✅ Aprobar" }, lang),
			refundApproveCb.pack({ cid: chargeId }),
			{ style: "success" },
		)
		.text(
			say({ en: "❌ Deny", es: "❌ Denegar" }, lang),
			refundDenyCb.pack({ cid: chargeId }),
			{ style: "danger" },
		)
		.row()
		.text(say({ en: "✖️ Close", es: "✖️ Cerrar" }, lang), refundCloseCb.pack({}));

const adminLangOfUser = async (
	storage: Storage,
	ctx: { bot: { info: { id: number } } },
	userId: number,
): Promise<string> => {
	const full = await loadFullRecord(storage, ctx, userId);
	return full.language ?? FALLBACK_LANG;
};

// ─── callback handlers ─────────────────────────────────────────────

// Admin-only guard + charge lookup shared by approve/deny. Answers the
// query and returns undefined on either failure; caller does `if (!charge) return`.
const requireAdminCharge = async (
	ctx: CommonCtx & { queryData: { cid: string } },
	opts: RefundHandlersOptions,
	aLang: string,
): Promise<ChargeRecord | undefined> => {
	if (!ctx.isAdmin) {
		await ctx.answer({
			text: say({ en: "Admin only.", es: "Solo admin." }, aLang),
			show_alert: true,
		});
		return undefined;
	}
	const charge = await opts.stores.charges.get(ctx, ctx.queryData.cid);
	if (!charge) {
		await ctx.answer({
			text: say({ en: "Charge not found.", es: "Cargo no encontrado." }, aLang),
		});
		return undefined;
	}
	return charge;
};

export type RefundHandlersOptions = {
	stores: PaymentsStores;
	/**
	 * Raw storage for cross-user session record reads/writes (the
	 * `@gramio/session` keyspace, outside our `pay:*` stores). Used by
	 * `applyRefundToUser` + `loadFullRecord` to reach a target user's
	 * full session record (preserving fields owned by other plugins).
	 */
	storage: Storage;
	cfg: BotPaymentsConfig<string>;
};

/**
 * User taps "💸 Request refund" on a charge entry inside the menu's
 * History view. The menu plugin's `confirm:` overlay already handled
 * the "Are you sure?" step; this fires on the confirmed tap and:
 *
 *   1. Marks the charge `paysupportState = 'opened'`
 *   2. DMs the admin with [Approve][Deny] buttons
 *   3. Returns a toast acknowledging the request was sent
 *
 * The user's menu remains on the History view (menu's
 * `confirm`-confirmed action returns to root, but the toast confirms
 * the action so the user knows what happened).
 */
export const buildRefundRequestHandler =
	(opts: RefundHandlersOptions) =>
	async (
		ctx: CommonCtx & { queryData: { cid: string } },
	): Promise<string | undefined> => {
		const lang = ctxLang(ctx);
		const userId = ctx.from?.id;
		if (userId === undefined) {
			return say(
				{ en: "Could not identify you.", es: "No se pudo identificarte." },
				lang,
			);
		}

		const charge = await opts.stores.charges.get(ctx, ctx.queryData.cid);
		if (!charge) {
			return say({ en: "Charge not found.", es: "Cargo no encontrado." }, lang);
		}
		if (charge.userId !== userId) {
			// Anti-tamper — never let user A request refund of user B's charge.
			return say({ en: "Not your charge.", es: "No es tu cargo." }, lang);
		}
		if (charge.paysupportState !== "none") {
			return say(
				{
					en: "Refund already in progress or completed.",
					es: "Reembolso ya en curso o completado.",
				},
				lang,
			);
		}

		charge.paysupportState = "opened";
		await opts.stores.charges.set(ctx, charge.chargeId, charge);
		log.event(
			`refund requested by user: chargeId=${charge.chargeId} product=${charge.productKey} xtr=${charge.xtr}`,
		);

		const adminLang = await adminLangOfUser(opts.storage, ctx, ctx.adminId);
		try {
			await ctx.bot.api.sendMessage({
				chat_id: ctx.adminId,
				text: adminNotificationText(charge, adminLang),
				reply_markup: adminKeyboard(charge.chargeId, adminLang),
			});
		} catch (e) {
			log.error(`failed to DM admin: ${e}`);
			// Roll back the open state so the user can try again later.
			charge.paysupportState = "none";
			await opts.stores.charges.set(ctx, charge.chargeId, charge);
			return say(
				{
					en: `Couldn't reach the admin. Contact ${opts.cfg.paysupport}.`,
					es: `No se pudo contactar al admin. Contacta con ${opts.cfg.paysupport}.`,
				},
				lang,
			);
		}

		return say(
			{
				en: "💸 Refund request sent.",
				es: "💸 Solicitud de reembolso enviada.",
			},
			lang,
		);
	};

/**
 * Admin taps "✅ Approve". Calls Telegram's `refundStarPayment`,
 * persists the refund record + flips charge state, applies the refund
 * to the target user's session (cross-user write), and notifies the
 * user.
 */
export const buildRefundApproveHandler =
	(opts: RefundHandlersOptions) =>
	async (ctx: CommonCtx & { queryData: { cid: string } }): Promise<void> => {
		const aLang = ctxLang(ctx);
		const charge = await requireAdminCharge(ctx, opts, aLang);
		if (!charge) return;
		if (charge.paysupportState === "refunded") {
			await ctx.answer({
				text: say({ en: "Already refunded.", es: "Ya reembolsado." }, aLang),
			});
			return;
		}

		log.event(
			`admin approving refund: chargeId=${charge.chargeId} user=${charge.userId} xtr=${charge.xtr}`,
		);
		try {
			await ctx.bot.api.refundStarPayment({
				user_id: charge.userId,
				telegram_payment_charge_id: charge.chargeId,
			});
		} catch (e) {
			log.error(`refundStarPayment failed: ${e}`);
			await ctx.answer({
				text: say(
					{
						en: `❌ Refund failed: ${e instanceof Error ? e.message : String(e)}`,
						es: `❌ Reembolso falló: ${e instanceof Error ? e.message : String(e)}`,
					},
					aLang,
				),
				show_alert: true,
			});
			return;
		}

		// If this charge funded a still-active vip subscription, also
		// cancel its auto-renewal so the user isn't charged again at the
		// next period boundary. Best-effort; refund itself already
		// succeeded.
		if (charge.vipRung !== undefined) {
			try {
				await ctx.bot.api.editUserStarSubscription({
					user_id: charge.userId,
					telegram_payment_charge_id: charge.chargeId,
					is_canceled: true,
				});
			} catch (e) {
				log.warn(
					`post-refund cancel renewal failed (probably already canceled): ${e}`,
				);
			}
		}

		charge.paysupportState = "refunded";
		charge.refundedAt = Date.now();
		await opts.stores.charges.set(ctx, charge.chargeId, charge);

		await applyRefundToUser(
			opts.stores,
			opts.storage,
			ctx,
			charge.userId,
			charge,
		);

		// User notification
		const userFull = await loadFullRecord(opts.storage, ctx, charge.userId);
		const uLang = userFull.language ?? FALLBACK_LANG;
		try {
			await ctx.bot.api.sendMessage({
				chat_id: charge.userId,
				text: say(
					{
						en: `✅ Your refund of ${charge.xtr} ⭐ has been approved.`,
						es: `✅ Tu reembolso de ${charge.xtr} ⭐ ha sido aprobado.`,
					},
					uLang,
				),
			});
		} catch (e) {
			log.error(`failed to notify user of approval: ${e}`);
		}

		await ctx.answer({
			text: say(
				{ en: "✅ Refund approved.", es: "✅ Reembolso aprobado." },
				aLang,
			),
		});
		if (ctx.editText) {
			try {
				await ctx.editText(
					`${say({ en: "✅ Refunded", es: "✅ Reembolsado" }, aLang)} · ${charge.chargeId}`,
				);
			} catch {
				/* message too old to edit */
			}
		}
	};

/**
 * Admin taps "❌ Deny". Reverts `paysupportState` to `'none'` so the
 * user can try again or the admin can reconsider later. Notifies the
 * user with the configured paysupport contact for further escalation.
 */
export const buildRefundDenyHandler =
	(opts: RefundHandlersOptions) =>
	async (ctx: CommonCtx & { queryData: { cid: string } }): Promise<void> => {
		const aLang = ctxLang(ctx);
		const charge = await requireAdminCharge(ctx, opts, aLang);
		if (!charge) return;

		charge.paysupportState = "none";
		await opts.stores.charges.set(ctx, charge.chargeId, charge);

		const userFull = await loadFullRecord(opts.storage, ctx, charge.userId);
		const uLang = userFull.language ?? FALLBACK_LANG;
		try {
			await ctx.bot.api.sendMessage({
				chat_id: charge.userId,
				text: say(
					{
						en:
							`❌ Your refund request was denied.\n\n` +
							`For further questions, contact ${opts.cfg.paysupport}.`,
						es:
							`❌ Tu solicitud de reembolso fue denegada.\n\n` +
							`Para más consultas, contacta con ${opts.cfg.paysupport}.`,
					},
					uLang,
				),
			});
		} catch (e) {
			log.error("failed to notify user of denial", e);
		}

		await ctx.answer({
			text: say({ en: "❌ Denied", es: "❌ Denegado" }, aLang),
		});
		if (ctx.editText) {
			try {
				await ctx.editText(
					`${say({ en: "❌ Denied", es: "❌ Denegado" }, aLang)} · ${charge.chargeId}`,
				);
			} catch {
				/* ignore */
			}
		}
	};
