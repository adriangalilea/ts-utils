/**
 * Telegram event handlers: `pre_checkout_query`, `successful_payment`,
 * and the auto-installed `/paysupport` command.
 *
 * Two hot paths the handlers MUST get right:
 *
 *   - `pre_checkout_query` has a **10 s hard deadline** at Telegram's
 *     side. We answer synchronously after a single payload decode +
 *     catalog lookup + xtr match check. No storage round-trips.
 *
 *   - `successful_payment` is **idempotent by `telegram_payment_charge_id`**.
 *     We claim the chargeId via a sentinel key (`pay:idempotency:{id}`)
 *     using set-if-absent semantics; a duplicate delivery returns a
 *     no-op. Telegram retries this event in some failure modes (see
 *     `sendInvoice` docs § Tips), so this guard is load-bearing.
 *
 * `/paysupport` is mandated by the Bot Developer ToS §6.5 — every bot
 * accepting payments must surface a way for users to request refunds.
 * We register the command and route users to `/settings → 💎 VIP`
 * where the refund flow lives (mirrors how `bot/menu` keeps every
 * user-facing flow under one slash command).
 */

import { panic, SourcedError } from "../../offensive.js";
import { say } from "../../say/index.js";
import { createLogger } from "../../universal/log.js";
import type { BotPaymentCtx, BotPreCheckoutCtx } from "../ctx.js";
import { decodePayload } from "./payload.js";
import { applyCharge } from "./state.js";
import type { PaymentsStores } from "./stores.js";
import type {
	BotPaymentsConfig,
	ChargeRecord,
	CreditsPackResolved,
	FulfillmentEvent,
	PaymentsSession,
	PerkResolved,
	ProductCatalog,
	VipRungResolved,
} from "./types.js";

const log = createLogger("bot/payments");

const FALLBACK_LANG = "en";

// ─── shared types ──────────────────────────────────────────────────

/**
 * Strict bot.api shape for this plugin. Composes with the canonical
 * `BotMessageCtx` / `BotPreCheckoutCtx` / `BotPaymentCtx` via their
 * `Api` generic, so a typo on a method name or wrong param shape is a
 * compile error here.
 */
type PaymentBotApi = {
	answerPreCheckoutQuery: (params: {
		pre_checkout_query_id: string;
		ok: boolean;
		error_message?: string;
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
 * Pre-checkout event ctx (Telegram's 10s deadline). Strict bot.api;
 * everything else is structural. No session on this event scope.
 */
type PreCheckoutCtx = BotPreCheckoutCtx<PaymentBotApi>;

/**
 * Successful-payment event ctx. Reads the raw `.payload` (snake_case
 * Telegram fields) because every downstream consumer already speaks
 * snake_case, and going through gramio's wrapper getters would mean
 * a second translation layer. See `bot/ctx.ts` § BotPaymentCtx for
 * the historical bug that produced this convention (mixing wrapper
 * camelCase with snake_case yields silent `undefined`).
 */
type MessageCtx = BotPaymentCtx<SessionLike, PaymentBotApi>;

/** The raw `successful_payment` shape — same as in `BotPaymentCtx`. */
type SuccessfulPayment = MessageCtx["eventPayment"]["payload"];

const ctxLang = (ctx: { session?: { language?: string } }): string =>
	ctx.session?.language ?? FALLBACK_LANG;

// Single-sourced product discriminator. Order (vip, credits, perk-default)
// is load-bearing: it mirrors the prefix checks both builders rely on.
const kindOf = (
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
): "vip" | "credits" | "perk" =>
	product.id.startsWith("vip.")
		? "vip"
		: product.id.startsWith("credits.")
			? "credits"
			: "perk";

// ─── pre_checkout_query handler ────────────────────────────────────

/**
 * Validate the in-flight purchase synchronously and ack within 10 s.
 *
 *   - Currency must be `XTR` (we only sell digital goods; fiat would
 *     have a `provider_token` and not reach this plugin).
 *   - Payload must decode + match `ctx.from.id` (anti-tamper).
 *   - Product must exist in the catalog.
 *   - `total_amount` must match the catalog's declared xtr — defense
 *     against a stale invoice or a config edit between invoice send
 *     and tap.
 *
 * On any failure: ack `ok: false` with a brief localized reason. The
 * user sees Telegram's "Payment failed" sheet with that reason.
 */
export const buildPreCheckoutHandler =
	(catalog: ProductCatalog) =>
	async (ctx: PreCheckoutCtx): Promise<void> => {
		log.event(
			`pre_checkout_query received: user=${ctx.from.id} currency=${ctx.currency} amount=${ctx.totalAmount} payload="${ctx.invoicePayload}" id=${ctx.id}`,
		);
		const reject = async (
			reasonEn: string,
			reasonEs: string,
		): Promise<void> => {
			log.warn(`pre_checkout rejecting: ${reasonEn} (id=${ctx.id})`);
			try {
				await ctx.bot.api.answerPreCheckoutQuery({
					pre_checkout_query_id: ctx.id,
					ok: false,
					// We don't have ctx.session on pre_checkout (it's a different
					// event scope per gramio), so we can't read user lang. Default
					// to a bilingual blurb that's intelligible to both en/es users.
					error_message: `${reasonEn} · ${reasonEs}`,
				});
			} catch (e) {
				log.error(`answerPreCheckoutQuery(false) failed: ${e}`);
			}
		};

		if (ctx.currency !== "XTR") {
			await reject("Unsupported currency.", "Moneda no soportada.");
			return;
		}

		const decoded = decodePayload(ctx.invoicePayload);
		if (!decoded) {
			await reject("Malformed invoice.", "Factura inválida.");
			return;
		}
		if (decoded.userId !== ctx.from.id) {
			await reject("User mismatch.", "Usuario no coincide.");
			return;
		}

		const product = catalog.byKey.get(decoded.productKey);
		if (!product) {
			await reject("Unknown product.", "Producto desconocido.");
			return;
		}

		if (product.xtr !== ctx.totalAmount) {
			await reject(
				`Price changed (expected ${product.xtr}, got ${ctx.totalAmount}).`,
				"Precio cambiado.",
			);
			return;
		}

		log.success(
			`pre_checkout approving: product=${decoded.productKey} user=${ctx.from.id} amount=${ctx.totalAmount}`,
		);
		try {
			await ctx.bot.api.answerPreCheckoutQuery({
				pre_checkout_query_id: ctx.id,
				ok: true,
			});
		} catch (e) {
			log.error(`answerPreCheckoutQuery(true) failed: ${e}`);
		}
	};

// ─── successful_payment handler ────────────────────────────────────

const buildChargeRecord = (
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
	userId: number,
	payment: SuccessfulPayment,
	waiverSnapshot: ChargeRecord["waiverSnapshot"],
): ChargeRecord => {
	const base: ChargeRecord = {
		chargeId: payment.telegram_payment_charge_id,
		userId,
		productKey: product.id,
		xtr: payment.total_amount,
		receivedAt: Date.now(),
		payload: payment.invoice_payload,
		waiverSnapshot,
		paysupportState: "none",
		refundedAt: null,
		payoutBatchId: null,
		creditsGranted: 0,
	};
	switch (kindOf(product)) {
		case "vip": {
			const v = product as VipRungResolved;
			return {
				...base,
				vipRung: v.rank,
				subscriptionExpiresAt: payment.subscription_expiration_date,
				creditsGranted: v.creditsGranted,
			};
		}
		case "credits": {
			const c = product as CreditsPackResolved;
			return { ...base, creditsGranted: c.creditsGranted };
		}
		default: {
			const p = product as PerkResolved;
			return { ...base, perkKey: p.key };
		}
	}
};

export type SuccessfulPaymentHandlerOptions = {
	stores: PaymentsStores;
	cfg: BotPaymentsConfig<string>;
	catalog: ProductCatalog;
	/**
	 * Map of productKey → callbacks fired AFTER fulfillment succeeds.
	 * Key `"*"` is the catch-all, run on every fulfillment in addition
	 * to the productKey-specific list.
	 *
	 * Sync return signature; the plugin always answers Telegram itself.
	 * Handlers are fire-and-forget — async work inside is OK but the
	 * plugin doesn't await them.
	 */
	onFulfilled: ReadonlyMap<
		string,
		ReadonlyArray<(event: FulfillmentEvent, ctx: MessageCtx) => void>
	>;
};

/**
 * Process a `successful_payment` event. Idempotent on chargeId.
 *
 * On first delivery:
 *   1. Decode payload, look up product
 *   2. Persist `ChargeRecord` + idempotency sentinel + user index
 *   3. Mutate `ctx.session.pay.*` via `applyCharge`
 *   4. Auto-cancel any LOWER vip rung (tier upgrade case)
 *   5. Send user confirmation + emit onFulfilled hooks
 *
 * On duplicate delivery: returns silently.
 */
export const buildSuccessfulPaymentHandler =
	(opts: SuccessfulPaymentHandlerOptions) =>
	async (ctx: MessageCtx): Promise<void> => {
		const payment = ctx.eventPayment?.payload;
		if (!payment) {
			log.warn(
				"successful_payment handler fired but ctx.eventPayment.payload is undefined — gramio context shape changed?",
			);
			return;
		}
		if (payment.currency !== "XTR") return; // fiat — not ours

		log.event(
			`successful_payment received: chargeId=${payment.telegram_payment_charge_id} amount=${payment.total_amount} payload="${payment.invoice_payload}" subExpires=${payment.subscription_expiration_date ?? "n/a"}`,
		);

		const decoded = decodePayload(payment.invoice_payload);
		if (!decoded) {
			log.error(
				`successful_payment un-decodable payload — fulfillment skipped: chargeId=${payment.telegram_payment_charge_id} payload="${payment.invoice_payload}"`,
			);
			return;
		}
		const userId = ctx.from?.id ?? decoded.userId;

		// Idempotency: claim chargeId via the sentinel store. Returns
		// `true` on first claim, `false` if already claimed (duplicate
		// delivery — Telegram retries `successful_payment` in some
		// failure modes per the sendInvoice doc). NOT atomic under
		// concurrent load (storage doesn't expose setNX); the window is
		// bounded by Telegram's retry delay and acceptable for v1.
		const claimed = await opts.stores.idempotency.claim(
			ctx,
			payment.telegram_payment_charge_id,
		);
		if (!claimed) {
			log.info(
				`successful_payment idempotent no-op: chargeId=${payment.telegram_payment_charge_id} already fulfilled`,
			);
			return;
		}

		const product = opts.catalog.byKey.get(decoded.productKey);
		if (!product) {
			log.error(
				`successful_payment for unknown productKey "${decoded.productKey}" — config drift? chargeId=${payment.telegram_payment_charge_id}`,
			);
			return;
		}

		const waiverSnapshot = ctx.session.pay?.waiver;
		if (!waiverSnapshot) {
			// Should never happen: every invoice flow gates on waiver
			// freshness. If we reach this point, our own gating logic has
			// a hole. Scream so it gets found, but DON'T drop the user's
			// money — finish fulfillment with a synthetic "missing
			// snapshot" entry that's auditable. The `panic` is
			// intentionally after the persistence path on purpose to keep
			// the user whole; the next event will crash.
			log.error(
				`CRITICAL: successful_payment without prior waiver — gate bypassed? userId=${userId} chargeId=${payment.telegram_payment_charge_id}`,
			);
		}

		const charge = buildChargeRecord(
			product,
			userId,
			payment,
			waiverSnapshot ?? {
				at: Date.now(),
				version: opts.cfg.waiver.version,
				locale: ctxLang(ctx),
			},
		);

		// 1. Write the charge log + per-user index.
		// (Idempotency sentinel was already claimed above.)
		await opts.stores.charges.set(ctx, charge.chargeId, charge);
		await opts.stores.userCharges(userId).prepend(ctx, charge.chargeId);
		log.info(
			`charge persisted: chargeId=${charge.chargeId} product=${charge.productKey} user=${userId} xtr=${charge.xtr} creditsGranted=${charge.creditsGranted}`,
		);

		// 2. Apply to session (cache). Capture the previous vip chargeId
		// FIRST so we can cancel its renewal below if this was an upgrade.
		const previousVipChargeId = ctx.session.pay?.vip?.chargeId;
		const previousVipRung = ctx.session.pay?.vip?.rung;

		applyCharge(ctx.session, charge);

		// 3. Tier-upgrade auto-cancel: when the user buys a HIGHER rung
		// than their currently-active subscription, cancel the lower one's
		// auto-renewal so they aren't double-billed at the next cycle. The
		// lower rung keeps access until its period end — Telegram handles
		// that silently because the higher rung's rank-based `atLeast`
		// check already satisfies any vip.N check from now on.
		if (
			charge.vipRung !== undefined &&
			previousVipChargeId &&
			previousVipChargeId !== charge.chargeId &&
			previousVipRung !== undefined &&
			previousVipRung < charge.vipRung
		) {
			try {
				await ctx.bot.api.editUserStarSubscription({
					user_id: userId,
					telegram_payment_charge_id: previousVipChargeId,
					is_canceled: true,
				});
				log.info(
					`auto-canceled previous vip rung ${previousVipRung} on upgrade to ${charge.vipRung} (user=${userId})`,
				);
			} catch (e) {
				// Already canceled, expired, etc. Log; don't block fulfillment.
				log.warn(
					`auto-cancel previous vip subscription failed (likely already canceled/expired): user=${userId} previousChargeId=${previousVipChargeId} err=${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}

		// 4. User-facing confirmation
		const lang = ctxLang(ctx);
		await ctx.send(buildSuccessMessage(product, opts.cfg, lang));

		// 5. Fire onFulfilled hooks (fire-and-forget)
		const event: FulfillmentEvent = {
			productKey: product.id,
			userId,
			chargeId: charge.chargeId,
			xtr: charge.xtr,
			receivedAt: charge.receivedAt,
		};
		const fireBucket = (key: string) => {
			const arr = opts.onFulfilled.get(key);
			if (!arr) return;
			for (const fn of arr) {
				try {
					fn(event, ctx);
				} catch (e) {
					log.error(`onFulfilled handler for "${key}" threw: ${e}`);
				}
			}
		};
		fireBucket(product.id);
		fireBucket("*");
		log.success(
			`fulfillment complete: product=${product.id} user=${userId} chargeId=${charge.chargeId}`,
		);

		// 6. Sanity-fail AFTER everything has been persisted + the user
		// has their confirmation — defensive, see CRITICAL log above.
		if (!waiverSnapshot) {
			panic(
				"bot/payments: successful_payment fulfilled without a stored waiver " +
					"snapshot. Gate logic has a hole. User was made whole; investigate.",
			);
		}
	};

const buildSuccessMessage = (
	product: VipRungResolved | CreditsPackResolved | PerkResolved,
	cfg: BotPaymentsConfig<string>,
	lang: string,
): string => {
	switch (kindOf(product)) {
		case "vip": {
			const v = product as VipRungResolved;
			const name =
				(v.name as Record<string, string>)[lang] ??
				(v.name as Record<string, string>)[FALLBACK_LANG] ??
				"VIP";
			return say(
				{
					en: `✅ Welcome to ${name}! Active for 30 days.`,
					es: `✅ ¡Bienvenido a ${name}! Activo durante 30 días.`,
				},
				lang,
			);
		}
		case "credits": {
			const c = product as CreditsPackResolved;
			const unit =
				(cfg.credits?.unit as Record<string, string> | undefined)?.[lang] ??
				"credits";
			return say(
				{
					en: `✅ +${c.creditsGranted} ${unit} added to your balance.`,
					es: `✅ +${c.creditsGranted} ${unit} añadidos a tu saldo.`,
				},
				lang,
			);
		}
		default: {
			const p = product as PerkResolved;
			const name =
				(p.name as Record<string, string>)[lang] ??
				(p.name as Record<string, string>)[FALLBACK_LANG] ??
				p.key;
			return say(
				{ en: `✅ Unlocked: ${name}.`, es: `✅ Desbloqueado: ${name}.` },
				lang,
			);
		}
	}
};

// ─── re-export SourcedError for catch sites ───────────────────────

export { SourcedError };
