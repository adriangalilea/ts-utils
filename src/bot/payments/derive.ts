/**
 * `ctx.payments` derive — the per-event ctx decoration.
 *
 * Extracted from `plugin.ts` to keep that file pure wiring per the
 * `bot/CLAUDE.md` plugin file convention. Everything that reads or
 * mutates session state inside an event handler goes through one of
 * the methods this module attaches:
 *
 *   - `ctx.payments.atLeast(id)`   — tier gate (lazy expiry)
 *   - `ctx.payments.tier()`        — current rung (`'free' | 'vip.N'`)
 *   - `ctx.payments.tier.level()`  — integer rank
 *   - `ctx.payments.tier.label()`  — resolved Polyglot label
 *   - `ctx.payments.credits.*`     — balance / consume / tryConsume
 *   - `ctx.payments.has(perkId)`   — perk ownership boolean
 *   - `ctx.payments.require(...)`  — gate + localized upgrade prompt
 *   - `ctx.payments.invoice(key)`  — purchase entry (waiver-gated)
 *
 * Returned shape is a function so `plugin.ts` can drop it directly
 * into `.derive(["message", "callback_query"], buildPaymentsDerive({...}))`.
 */

import { say } from "../../say/index.js";
import { type BotCallbackCtx, type BotMessageCtx, narrow } from "../ctx.js";
import { menuNavCb } from "../menu.js";
import { presentInvoice } from "./invoice.js";
import {
	type BotPaymentsConfig,
	InsufficientCredits,
	type PaymentsSession,
	type ProductCatalog,
} from "./types.js";

const FALLBACK_LANG = "en";

type SessionLike = { pay?: PaymentsSession; language?: string };

type TierKey = "free" | `vip.${number}`;

/**
 * Callable `tier` namespace. Matches `PaymentsCtx['tier']` from `plugin.ts`
 * — exported there as the public surface. Repeated minimally here so
 * derive.ts isn't import-cycle dependent on plugin.ts.
 */
export type TierFn = (() => TierKey) & {
	level: () => number;
	label: () => string | undefined;
};

export type CreditsApi = {
	balance: () => number;
	consume: (n: number) => void;
	tryConsume: (n: number) => boolean;
};

export type RequireOpts = {
	feature?: { en: string; es: string } | string;
};

/**
 * What `buildPaymentsDerive` attaches under `ctx.payments`. Plugin.ts
 * casts this to the typed `PaymentsCtx<Cfg>` (with positional ladder
 * narrowing) before exposing it to bot authors — TypeScript can't
 * preserve the generic narrowing through a function-shaped derive
 * factory cleanly, so the strict type lives at the public surface.
 */
export type PaymentsDerived = {
	atLeast: (id: string) => boolean;
	tier: TierFn;
	has: (perkId: string) => boolean;
	credits: CreditsApi;
	require: (id: string, opts?: RequireOpts) => Promise<boolean>;
	invoice: (
		productKey: string,
	) => Promise<"invoice_sent" | "waiver_prompt_sent" | "unknown_product">;
};

export type BuildPaymentsDeriveArgs = {
	/** Resolved product catalogue (rungs, packs, perks). */
	catalog: ProductCatalog;
	/**
	 * Full config — currently only consulted inside `invoice()` for the
	 * waiver wording + product display strings via `presentInvoice`.
	 */
	cfg: BotPaymentsConfig<string>;
};

/**
 * Returns the function you pass to gramio's `.derive([events], fn)`.
 * The returned function takes ctx, returns `{ payments }`.
 */
export const buildPaymentsDerive = ({
	cfg,
	catalog,
}: BuildPaymentsDeriveArgs) => {
	return (ctx: unknown): { payments: PaymentsDerived } => {
		// Single narrow at the top — every subsequent reference uses
		// `c.<field>` and reads cleanly. The structural type is the
		// intersection of message + callback_query event ctxs so this
		// derive works for both event scopes (gramio's runtime dedup
		// guarantees one execution per update).
		const c = narrow<BotMessageCtx<SessionLike> & BotCallbackCtx<SessionLike>>(
			ctx,
		);

		// Lazy expiry — vip is only "active" while its expiresAt is in
		// the future (CLAUDE.md §"sweep" deferred to v2). Pure read; no
		// cleanup of stale `session.pay.vip` records.
		const isVipActive = (): boolean => {
			const v = c.session.pay?.vip;
			if (!v) return false;
			return v.expiresAt * 1000 > Date.now();
		};

		const effectiveRung = (): number => {
			if (!isVipActive()) return 0;
			return c.session.pay?.vip?.rung ?? 0;
		};

		const atLeast = (id: string): boolean => {
			if (id === "free") return true;
			const rung = effectiveRung();
			if (id === "vip") return rung > 0;
			if (id.startsWith("vip.")) {
				const want = Number.parseInt(id.slice(4), 10);
				return rung >= want;
			}
			return false;
		};

		const tierFn = (() => {
			const rung = effectiveRung();
			if (rung === 0) return "free" as const;
			return `vip.${rung}` as const;
		}) as TierFn;
		tierFn.level = () => effectiveRung();
		tierFn.label = () => {
			const rung = effectiveRung();
			if (rung === 0) return undefined;
			const r = catalog.vip[rung - 1];
			if (!r) return undefined;
			const lang = c.session.language ?? FALLBACK_LANG;
			return (
				(r.name as Record<string, string>)[lang] ??
				(r.name as Record<string, string>)[FALLBACK_LANG]
			);
		};

		const credits: CreditsApi = {
			balance: () => c.session.pay?.credits ?? 0,
			consume: (n: number) => {
				const current = c.session.pay?.credits ?? 0;
				if (current < n) throw new InsufficientCredits(n, current);
				c.session.pay ??= {};
				c.session.pay.credits = current - n;
			},
			tryConsume: (n: number) => {
				const current = c.session.pay?.credits ?? 0;
				if (current < n) return false;
				c.session.pay ??= {};
				c.session.pay.credits = current - n;
				return true;
			},
		};

		const has = (perkId: string): boolean => !!c.session.pay?.perks?.[perkId];

		const requireFn = async (
			id: string,
			opts?: RequireOpts,
		): Promise<boolean> => {
			if (atLeast(id)) return true;
			const lang = c.session.language ?? FALLBACK_LANG;
			const featureName =
				opts?.feature === undefined
					? undefined
					: typeof opts.feature === "string"
						? opts.feature
						: ((opts.feature as { en: string; es: string })[
								lang as "en" | "es"
							] ?? (opts.feature as { en: string; es: string }).en);
			const body =
				featureName !== undefined
					? say(
							{
								en: `💎 "${featureName}" needs VIP. Tap below to upgrade.`,
								es: `💎 "${featureName}" necesita VIP. Toca abajo para mejorar.`,
							},
							lang,
						)
					: say(
							{
								en: "💎 This needs VIP. Tap below to upgrade.",
								es: "💎 Esto necesita VIP. Toca abajo para mejorar.",
							},
							lang,
						);
			// Deep-link into our menuItem (id='pay') via botMenu's
			// shared menuNavCb schema. v1 opens VIP root; deep-linking to
			// a specific rung is a v2 TODO (see CLAUDE.md).
			const button = say(
				{ en: "💎 Open VIP plans", es: "💎 Ver planes VIP" },
				lang,
			);
			await c.send(body, {
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: button,
								callback_data: menuNavCb.pack({ path: "pay" }),
							},
						],
					],
				},
			});
			return false;
		};

		const invoiceFn = (productKey: string) =>
			presentInvoice(
				narrow<Parameters<typeof presentInvoice>[0]>(c),
				cfg,
				catalog,
				productKey,
			);

		return {
			payments: {
				atLeast,
				tier: tierFn,
				has,
				credits,
				require: requireFn,
				invoice: invoiceFn,
			},
		};
	};
};
