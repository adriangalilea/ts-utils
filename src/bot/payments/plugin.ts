/**
 * `botPayments({...})` — the top-level factory + GramIO plugin
 * assembly.
 *
 * This file is **wiring only** per `bot/CLAUDE.md` § plugin file
 * convention. Every handler body lives in its concern-specific
 * neighbour (`derive.ts` / `handlers.ts` / `callbacks.ts` /
 * `commands.ts` / `refund.ts`); this file's job is to stitch them
 * into a `Plugin` chain.
 *
 * What gets wired:
 *
 *   - `ctx.payments.*` surface via `.derive()`        →  `derive.ts`
 *   - `pre_checkout_query` handler                    →  `handlers.ts`
 *   - `successful_payment` (dedicated event)          →  `handlers.ts`
 *   - Waiver consent / cancel callbacks               →  `callbacks.ts` + `waiver.ts`
 *   - Refund request / approve / deny / close         →  `callbacks.ts` + `refund.ts`
 *   - `/paysupport` slash command                     →  `commands.ts`
 *
 * Returned alongside the plugin: `menuItem` (drop-in for `botMenu`),
 * `payouts` (Fragment ledger), `admin` (read helpers for custom
 * admin commands), and `onFulfilled` (event hook registration).
 *
 * See `CLAUDE.md` in this folder for the design rationale and flows.
 */

import type { session } from "@gramio/session";
import type { Storage } from "@gramio/storage";
import { type DeriveDefinitions, Plugin } from "gramio";

import { panic } from "../../offensive.js";
import { narrow } from "../ctx.js";
import {
	buildRefundCloseHandler,
	buildWaiverCancelHandler,
	buildWaiverConsentHandler,
} from "./callbacks.js";
import { buildPaysupportCommand } from "./commands.js";
import { buildCatalog, validateConfig } from "./config.js";
import { buildPaymentsDerive, type PaymentsDerived } from "./derive.js";
import {
	buildPreCheckoutHandler,
	buildSuccessfulPaymentHandler,
} from "./handlers.js";
import { buildPaymentsMenuItem } from "./menu-item.js";
import { buildPayoutsApi, type PayoutsApi } from "./payouts.js";
import {
	buildRefundApproveHandler,
	buildRefundDenyHandler,
	buildRefundRequestHandler,
	refundApproveCb,
	refundCloseCb,
	refundDenyCb,
	refundRequestCb,
} from "./refund.js";
import { buildStores, type PaymentsStores } from "./stores.js";
import type {
	AtLeastKey,
	BotPaymentsConfig,
	ChargeRecord,
	FulfillmentEvent,
	PaymentsSession,
	ProductKey,
	TierKey,
} from "./types.js";
import { waiverCancelCb, waiverConsentCb } from "./waiver.js";

// ─── session reference ─────────────────────────────────────────────

type SessionLike = { pay?: PaymentsSession; language?: string };
type PaySessionPluginRef = ReturnType<typeof session<SessionLike, "session">>;

// ─── ctx.payments surface (public, generic-narrowed) ──────────────
//
// `derive.ts` builds the runtime impl with the looser `PaymentsDerived`
// type (string everywhere). We re-type the result here at the plugin
// boundary so consumers see the positional-ladder narrowing
// (`AtLeastKey<Cfg>` / `ProductKey<Cfg>` / `TierKey<Cfg>`). At runtime
// it's the same object — TS lacks a way to thread the Cfg generic
// through a derive factory cleanly.

type TierFn<Cfg extends BotPaymentsConfig<string>> = (() => TierKey<Cfg>) & {
	level: () => number;
	/**
	 * Resolved display label of the current rung in `ctx.session.language`,
	 * or `undefined` on free tier. Named `label` (not `name`) because
	 * `Function.prototype.name` is read-only in strict mode and we attach
	 * this onto a callable.
	 */
	label: () => string | undefined;
};

export type PaymentsCtx<Cfg extends BotPaymentsConfig<string>> = {
	atLeast: (id: AtLeastKey<Cfg>) => boolean;
	tier: TierFn<Cfg>;
	has: (perkId: string) => boolean;
	credits: PaymentsDerived["credits"];
	require: (
		id: AtLeastKey<Cfg>,
		opts?: { feature?: { en: string; es: string } | string },
	) => Promise<boolean>;
	invoice: (
		productKey: ProductKey<Cfg>,
	) => Promise<"invoice_sent" | "waiver_prompt_sent" | "unknown_product">;
};

// ─── factory return shape ──────────────────────────────────────────

/**
 * Admin-side read helpers exposed on `payments.admin.*`. Bot authors
 * use these when writing custom admin commands (e.g. `/refunds`) that
 * bypass the user-initiated refund-request flow. ctx only needs
 * `.bot.info.id` for namespacing — pass any real gramio ctx or a
 * synthetic `{ bot: { info: bot.info } }` for offline scripts.
 */
export type PaymentsAdmin = {
	/** Every non-pruned charge for a user, newest-first. */
	listCharges: (
		ctx: { bot: { info: { id: number } } },
		userId: number,
	) => Promise<ReadonlyArray<ChargeRecord>>;
	/** One charge by id; `undefined` if not found. */
	getCharge: (
		ctx: { bot: { info: { id: number } } },
		chargeId: string,
	) => Promise<ChargeRecord | undefined>;
};

export type BotPaymentsResult<Cfg extends BotPaymentsConfig<string>> = {
	plugin: ReturnType<typeof buildPlugin>;
	menuItem: ReturnType<typeof buildPaymentsMenuItem>;
	payouts: PayoutsApi;
	admin: PaymentsAdmin;
	onFulfilled: (
		productKey: ProductKey<Cfg> | "*",
		handler: (event: FulfillmentEvent, ctx: unknown) => void,
	) => void;
};

// ─── factory options ───────────────────────────────────────────────

export type BotPaymentsOptions<Cfg extends BotPaymentsConfig<string>> = Cfg & {
	/** Shared session plugin. Required — see CLAUDE.md §"Storage layout". */
	session: PaySessionPluginRef;
	/**
	 * Storage backend for the global ledger (charges, payouts, refunds,
	 * idempotency). MUST be the same instance backing `session`.
	 */
	storage: Storage;
};

// ─── plugin assembly ───────────────────────────────────────────────

const buildPlugin = (args: {
	cfg: BotPaymentsConfig<string>;
	catalog: ReturnType<typeof buildCatalog>;
	sessionPlugin: PaySessionPluginRef;
	storage: Storage;
	stores: PaymentsStores;
	onFulfilledMap: Map<
		string,
		Array<(event: FulfillmentEvent, ctx: unknown) => void>
	>;
}) => {
	const { cfg, catalog, sessionPlugin, storage, stores, onFulfilledMap } = args;

	// derive: ctx.payments
	type GlobalDerives = { payments: PaymentsCtx<BotPaymentsConfig<string>> };
	const paymentsDerive = buildPaymentsDerive({ cfg, catalog });

	// handler factories (all bodies live in their concern files)
	const successfulPaymentHandler = buildSuccessfulPaymentHandler({
		stores,
		cfg,
		catalog,
		// internals iterate this map per fulfillment, including `"*"` catch-all.
		onFulfilled: onFulfilledMap as ReadonlyMap<
			string,
			ReadonlyArray<(event: FulfillmentEvent, ctx: unknown) => void>
		>,
	});
	const preCheckoutHandler = buildPreCheckoutHandler(catalog);
	const refundApproveHandler = buildRefundApproveHandler({
		stores,
		storage,
		cfg,
	});
	const refundDenyHandler = buildRefundDenyHandler({ stores, storage, cfg });
	const refundRequestHandler = buildRefundRequestHandler({
		stores,
		storage,
		cfg,
	});
	const waiverConsentHandler = buildWaiverConsentHandler({ cfg, catalog });
	const waiverCancelHandler = buildWaiverCancelHandler();
	const refundCloseHandler = buildRefundCloseHandler();
	const paysupportCommand = buildPaysupportCommand(cfg);

	return (
		new Plugin<
			Record<string, never>,
			DeriveDefinitions & { global: GlobalDerives }
		>("@adriangalilea/utils/bot/payments", {
			dependencies: ["@adriangalilea/utils/bot/admin"],
		})
			// Declare the shared session as a dep so types flow + runtime
			// dedup ensures the session derive runs once per update.
			.extend(sessionPlugin)
			// ctx.payments builder — see derive.ts
			.derive(
				["message", "callback_query"],
				paymentsDerive as unknown as (ctx: unknown) => GlobalDerives,
			)
			// pre_checkout_query — synchronous gate, 10s deadline
			.on("pre_checkout_query", async (ctx, next) => {
				await preCheckoutHandler(
					narrow<Parameters<typeof preCheckoutHandler>[0]>(ctx),
				);
				await next();
			})
			// successful_payment — dedicated event (NOT a `message` rider;
			// gramio puts it in `allowed_updates` only via the dedicated
			// subscription, see CLAUDE.md §"foot-guns")
			.on("successful_payment", async (ctx, next) => {
				await successfulPaymentHandler(
					narrow<Parameters<typeof successfulPaymentHandler>[0]>(ctx),
				);
				await next();
			})
			// Waiver consent + cancel callbacks (bodies in callbacks.ts)
			.callbackQuery(waiverConsentCb, waiverConsentHandler)
			.callbackQuery(waiverCancelCb, waiverCancelHandler)
			// Refund flow callbacks (bodies in refund.ts + callbacks.ts)
			.callbackQuery(refundRequestCb, async (ctx) => {
				const c = narrow<Parameters<typeof refundRequestHandler>[0]>(ctx);
				const toast = await refundRequestHandler(c);
				await c.answer(toast !== undefined ? { text: toast } : {});
			})
			.callbackQuery(refundApproveCb, async (ctx) =>
				refundApproveHandler(
					narrow<Parameters<typeof refundApproveHandler>[0]>(ctx),
				),
			)
			.callbackQuery(refundDenyCb, async (ctx) =>
				refundDenyHandler(narrow<Parameters<typeof refundDenyHandler>[0]>(ctx)),
			)
			.callbackQuery(refundCloseCb, refundCloseHandler)
			// /paysupport (ToS §6.5; body in commands.ts)
			.command(
				"paysupport",
				{ description: "Help & refunds for payments" },
				paysupportCommand,
			)
	);
};

// ─── public factory ────────────────────────────────────────────────

export const botPayments = <const Cfg extends BotPaymentsConfig<string>>(
	opts: BotPaymentsOptions<Cfg>,
): BotPaymentsResult<Cfg> => {
	const { session: sessionPlugin, storage, ...rest } = opts;
	const cfg = rest as unknown as Cfg;

	validateConfig(cfg);
	const catalog = buildCatalog(cfg);
	const stores = buildStores(storage);

	const onFulfilledMap = new Map<
		string,
		Array<(event: FulfillmentEvent, ctx: unknown) => void>
	>();

	const plugin = buildPlugin({
		cfg,
		catalog,
		sessionPlugin,
		storage,
		stores,
		onFulfilledMap,
	});

	const menuItem = buildPaymentsMenuItem({ cfg, catalog });
	const payouts = buildPayoutsApi(stores);
	const admin: PaymentsAdmin = {
		listCharges: async (ctx, userId) => {
			const ids = await stores.userCharges(userId).list(ctx);
			const charges = await Promise.all(
				ids.map((id) => stores.charges.get(ctx, id)),
			);
			return charges.filter((c): c is NonNullable<typeof c> => c !== undefined);
		},
		getCharge: (ctx, chargeId) => stores.charges.get(ctx, chargeId),
	};

	const onFulfilled: BotPaymentsResult<Cfg>["onFulfilled"] = (
		productKey,
		handler,
	) => {
		if (typeof productKey !== "string" || productKey.length === 0) {
			panic("bot/payments: onFulfilled productKey must be a non-empty string");
		}
		if (typeof handler !== "function") {
			panic("bot/payments: onFulfilled handler must be a function");
		}
		const arr = onFulfilledMap.get(productKey) ?? [];
		arr.push(handler);
		onFulfilledMap.set(productKey, arr);
	};

	return { plugin, menuItem, payouts, admin, onFulfilled };
};
