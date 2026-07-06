/**
 * Type surface for `bot/payments`. Two layers:
 *
 *   1. **Config shapes** the consumer authors (`BotPaymentsConfig`).
 *   2. **Derived types** the consumer reads through `ctx.payments`
 *      (`TierKey`, `AtLeastKey`, `ProductKey`) — narrowed from their
 *      config so e.g. `atLeast('vip.5')` is a TS error when only 2
 *      rungs are declared.
 *
 * Internal types (the ledger records, the catalog) live below and aren't
 * exported through the package entrypoint.
 *
 * See `CLAUDE.md` in this folder for the design rationale.
 */

import type { Polyglot } from "../../say/index.js";

// ─── primitive building blocks ─────────────────────────────────────

/**
 * The only Telegram-supported subscription period as of 2026 is exactly
 * 2,592,000 seconds (30 days). Modeled as a literal so misconfigurations
 * fail at compile time. See `sendInvoice` /
 * `createInvoiceLink` docs at https://core.telegram.org/bots/api.
 */
export type SubscriptionPeriod = "30d";

/** Internal value Telegram expects on the wire (seconds). */
export const SUBSCRIPTION_PERIOD_SECONDS: Readonly<
	Record<SubscriptionPeriod, number>
> = {
	"30d": 2_592_000,
};

// ─── per-axis config ───────────────────────────────────────────────

/**
 * One rung of the VIP ladder. Position in the array is the rank (1-based
 * id at the call site: `vip.1`, `vip.2`, …). Insert a rung at position 2
 * → existing subscribers on rung 2+ shift by one, plus a trivial storage
 * migration; no string-id churn.
 *
 * `name` is display-only Polyglot — renaming a rung is a config edit; the
 * call sites (`atLeast('vip.2')`) are positional and untouched.
 *
 * `grants.credits` is applied **on every renewal** of this rung (not just
 * the initial purchase). That's the canonical SaaS shape: "VIP gets 1000
 * messages per month."
 */
export type VipRung<L extends string = string> = {
	readonly xtr: number;
	readonly period: SubscriptionPeriod;
	readonly name: Polyglot<L>;
	readonly grants?: {
		readonly credits?: number;
	};
};

/**
 * A consumable credit pack the user buys one-shot to top up their
 * `session.pay.credits` balance. Like VIP rungs, packs are positionally
 * identified (`credits.1`, `credits.2`, …) so the call site doesn't carry
 * a name. Adding/removing packs shifts ids; storage is the charge log
 * (which records the exact productKey at purchase time), so historical
 * charges stay valid even if you remove a pack later.
 */
export type CreditsPack<L extends string = string> = {
	readonly xtr: number;
	readonly grants: {
		readonly credits: number;
	};
	readonly name?: Polyglot<L>;
};

/**
 * Credits axis config. `unit` is the user-facing word for one credit
 * (the menu says e.g. "1234 mensajes"). `packs` is the catalogue of
 * top-up bundles surfaced in the menu and via `invoice('credits.N')`.
 */
export type CreditsConfig<L extends string = string> = {
	readonly unit: Polyglot<L>;
	readonly packs: ReadonlyArray<CreditsPack<L>>;
};

/**
 * Orthogonal one-shot unlock (a "perk"). Named via the user's own key in
 * the config (`perks: { voice_mode: { … } }`), surfaced as
 * `perks.voice_mode` everywhere.
 */
export type Perk<L extends string = string> = {
	readonly xtr: number;
	readonly name: Polyglot<L>;
};

export type PerksConfig<L extends string = string> = Readonly<
	Record<string, Perk<L>>
>;

// ─── legal / waiver ────────────────────────────────────────────────

export type LegalConfig = {
	readonly sellerName: string;
	readonly nif: string;
	/**
	 * Optional terms-of-service URL. When omitted, the consent prompt's
	 * 📖 Terms button is hidden — there's no Telegram-side standard ToS
	 * to default to (unlike `privacyUrl`).
	 */
	readonly termsUrl?: string;
	/**
	 * Optional privacy policy URL. When omitted, defaults to Telegram's
	 * [Standard Bot Privacy Policy](https://telegram.org/privacy-tpa),
	 * which covers what this library's plugins retain (session record,
	 * waiver consent, charge log) under "data necessary to function".
	 * Override only when your bot retains data beyond what the standard
	 * covers.
	 */
	readonly privacyUrl?: string;
};

/**
 * Fallback when `legal.privacyUrl` is omitted. Identical to the menu
 * plugin's default — both surface the same policy text.
 */
export const DEFAULT_PRIVACY_URL = "https://telegram.org/privacy-tpa";

/**
 * Art. 103(m) TRLGDCU waiver text. Versioned so a wording change forces
 * re-consent; the version string is stored alongside each charge for audit.
 *
 * The Polyglot covers every locale the bot supports — the plugin
 * validates this at construction.
 */
export type WaiverConfig<L extends string = string> = {
	readonly version: string;
	readonly text: Polyglot<L>;
};

// ─── top-level config ──────────────────────────────────────────────

/**
 * What the bot author passes to `botPayments({...})`. The generic `L`
 * carries the bot's Polyglot language union forward into every nested
 * `Polyglot<L>`, so TS catches a missing locale in any sub-config.
 */
export type BotPaymentsConfig<L extends string = string> = {
	readonly paysupport: string;
	/** Where in THIS bot's UI the user manages charges (the `/paysupport`
	 *  bullet line). Menu command names are app-specific; the default
	 *  names the library's own `/settings → 💎 VIP → 📜 History` path. */
	readonly paysupportHint?: Polyglot<L>;
	readonly legal: LegalConfig;
	readonly waiver: WaiverConfig<L>;
	readonly vip?: ReadonlyArray<VipRung<L>>;
	readonly credits?: CreditsConfig<L>;
	readonly perks?: PerksConfig<L>;
};

// ─── derived: positional id types ──────────────────────────────────
//
// TS doesn't naturally express "1..N" from a tuple length without
// recursive type tricks. The recursive approach hits the recursion-depth
// ceiling at ~40 elements but for ladders that's never reached — even 5
// rungs is exotic. Pragmatic compromise: the recursive trick with no
// safety net, since realistic configs are tiny.

type _Range1To<
	N extends number,
	Acc extends unknown[] = [unknown],
> = Acc["length"] extends N
	? Acc["length"]
	: Acc["length"] | _Range1To<N, [...Acc, unknown]>;

/**
 * Positional 1-based ids for a tuple. `[a,b,c]` → `1 | 2 | 3`.
 *
 * Empty tuple → `never` (no ids exist).
 */
export type Indices1<V extends ReadonlyArray<unknown>> = V["length"] extends 0
	? never
	: V["length"] extends number
		? _Range1To<V["length"]>
		: never;

/**
 * Tier ids derivable from a `vip` config array. Bare `'vip'` is also
 * accepted as "any rung" by `atLeast` (see `AtLeastKey`).
 */
export type VipPositionalKeys<V extends ReadonlyArray<unknown> | undefined> =
	V extends ReadonlyArray<unknown> ? `vip.${Indices1<V>}` : never;

export type CreditsPackKeys<C extends CreditsConfig<string> | undefined> =
	C extends { packs: infer P }
		? P extends ReadonlyArray<unknown>
			? `credits.${Indices1<P>}`
			: never
		: never;

export type PerkKeys<P extends PerksConfig<string> | undefined> =
	P extends PerksConfig<string> ? `perks.${keyof P & string}` : never;

/**
 * Every product the user can purchase. Discriminated by prefix. Note
 * `perks.X` uses the **author-supplied key** verbatim (e.g.
 * `perks.voice_mode`) while `vip.N` / `credits.N` are positional.
 */
export type ProductKey<Cfg extends BotPaymentsConfig<string>> =
	| VipPositionalKeys<Cfg["vip"]>
	| CreditsPackKeys<Cfg["credits"]>
	| PerkKeys<Cfg["perks"]>;

/**
 * What `ctx.payments.tier()` can return. `'free'` is the bottom rung;
 * `vip.N` follows the ladder.
 */
export type TierKey<Cfg extends BotPaymentsConfig<string>> =
	| "free"
	| VipPositionalKeys<Cfg["vip"]>;

/**
 * What `ctx.payments.atLeast(...)` accepts. Same as `TierKey` minus
 * `'free'` (atLeast('free') is trivially always true and unhelpful as a
 * gate) plus the bare `'vip'` synonym for "any rung in the namespace".
 */
export type AtLeastKey<Cfg extends BotPaymentsConfig<string>> =
	| "vip"
	| VipPositionalKeys<Cfg["vip"]>;

// ─── runtime catalog (after construction) ──────────────────────────
//
// The validated, normalized form of the user's config that the plugin
// internals consult. Polyglot stays as Polyglot<string> here because by
// this point we've already type-checked the config against the bot's
// language union; the catalog drops the generic for ergonomics.

export type VipRungResolved = {
	readonly id: `vip.${number}`;
	readonly rank: number;
	readonly xtr: number;
	readonly periodSeconds: number;
	readonly name: Polyglot<string>;
	readonly creditsGranted: number; // 0 if no credits in grants
};

export type CreditsPackResolved = {
	readonly id: `credits.${number}`;
	readonly xtr: number;
	readonly creditsGranted: number;
	readonly name?: Polyglot<string>;
};

export type PerkResolved = {
	readonly id: `perks.${string}`;
	readonly key: string;
	readonly xtr: number;
	readonly name: Polyglot<string>;
};

export type ProductCatalog = {
	readonly vip: ReadonlyArray<VipRungResolved>;
	readonly creditsUnit: Polyglot<string> | undefined;
	readonly creditsPacks: ReadonlyArray<CreditsPackResolved>;
	readonly perks: ReadonlyArray<PerkResolved>;
	/** O(1) lookup by ProductKey. */
	readonly byKey: ReadonlyMap<
		string,
		VipRungResolved | CreditsPackResolved | PerkResolved
	>;
};

// ─── per-user session state ────────────────────────────────────────
//
// Lives on the shared session record under `pay`. ALWAYS treat as a
// cache — the charge log is authoritative.

export type WaiverRecord = {
	readonly at: number;
	readonly version: string;
	readonly locale: string;
};

export type VipState = {
	/** 1-based rank — index into the resolved vip ladder + 1. */
	readonly rung: number;
	/** Original `telegram_payment_charge_id` of the active subscription. */
	readonly chargeId: string;
	/** Telegram's `subscription_expiration_date` — unix seconds. */
	readonly expiresAt: number;
	/** True after the user toggled cancel-renewal; access keeps until `expiresAt`. */
	readonly canceled: boolean;
};

export type PerkState = {
	readonly chargeId: string;
	readonly at: number;
};

export type PaymentsSession = {
	waiver?: WaiverRecord;
	credits?: number;
	vip?: VipState;
	perks?: Record<string, PerkState>;
};

/**
 * Structural narrow of the shared session record the payment handlers
 * read: just the `pay` slice plus the recipient's locale. Single-sourced
 * here so derive/callbacks/commands/plugin agree on the shape.
 */
export type SessionLike = { pay?: PaymentsSession; language?: string };

/** Locale used when the recipient's language is unset or unresolved. */
export const FALLBACK_LANG = "en";

// ─── ledger records (authoritative) ────────────────────────────────

export type PaysupportState = "none" | "opened" | "refunded";

export type ChargeRecord = {
	readonly chargeId: string;
	readonly userId: number;
	readonly productKey: string;
	readonly xtr: number;
	readonly receivedAt: number;
	/** Decoded invoice payload echoed back from Telegram. */
	readonly payload: string;
	/**
	 * Waiver snapshot at purchase time. Captured even if the user
	 * already consented earlier — defensive forensics.
	 */
	readonly waiverSnapshot: WaiverRecord;
	/**
	 * Telegram's `subscription_expiration_date` (unix seconds) if this
	 * charge was a subscription purchase. Used to compute tier expiry.
	 */
	readonly subscriptionExpiresAt?: number;
	/**
	 * Credits this charge grants at fulfillment / renewal. Denormalized
	 * onto the record so derivation works even if the catalog config
	 * later changes (rare, but the charge log must remain authoritative
	 * regardless of source-code edits). Zero for products that don't
	 * grant credits.
	 */
	readonly creditsGranted: number;
	/**
	 * 1-based vip rung this charge subscribed to, denormalized for the
	 * same reason as `creditsGranted`. Only set for `vip.*` charges.
	 */
	readonly vipRung?: number;
	/**
	 * Perk key this charge unlocked, denormalized. Only set for
	 * `perks.*` charges.
	 */
	readonly perkKey?: string;
	paysupportState: PaysupportState;
	refundedAt?: number | null;
	/** Set after `record()` claims this charge into a payout batch. */
	payoutBatchId?: string | null;
};

export type PayoutRecord = {
	readonly batchId: string;
	readonly fromMs: number;
	readonly toMs: number;
	readonly tonAmount: number;
	readonly eurAtReceipt: number;
	readonly recordedAt: number;
	/** Optional Spanish factura number issued for this payout. */
	facturaNumber?: string;
};

/**
 * Snapshot returned by `derive.ts` — pure function of the charge log
 * for a given user. The plugin writes this into `session.pay.*` so
 * runtime checks are O(1), but the log is always the truth.
 */
export type DerivedPaymentsState = {
	readonly credits: number;
	readonly vip: VipState | undefined;
	readonly perks: Record<string, PerkState>;
};

// ─── fulfillment event ─────────────────────────────────────────────

/**
 * What `payments.onFulfilled(productKey, handler)` receives. Sync
 * signature on purpose — the plugin always answers the
 * `successful_payment` event itself; the handler does its own async work
 * fire-and-forget.
 */
export type FulfillmentEvent = {
	readonly productKey: string;
	readonly userId: number;
	readonly chargeId: string;
	readonly xtr: number;
	readonly receivedAt: number;
};

// ─── error sentinel ────────────────────────────────────────────────

/**
 * Thrown by `credits.consume(n)` when the balance is below `n`.
 * `tryConsume(n)` returns `false` instead.
 */
export class InsufficientCredits extends Error {
	readonly requested: number;
	readonly available: number;
	constructor(requested: number, available: number) {
		super(
			`InsufficientCredits: requested ${requested}, available ${available}`,
		);
		this.name = "InsufficientCredits";
		this.requested = requested;
		this.available = available;
	}
}
