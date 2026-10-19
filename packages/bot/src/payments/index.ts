/**
 * `bot/payments` — public exports.
 *
 * The factory `botPayments({...})` is the only thing most consumers
 * need; everything else is exported for advanced wiring, tests, and
 * type narrowing at consumer side.
 *
 * See `CLAUDE.md` in this folder for the design rationale + compliance
 * memo (Spanish autónomo, Art. 103(m), Telegram Stars seller-of-record
 * analysis, …).
 */

export type {
	ExportInput,
	ExportResult,
	PayoutsApi,
	RecordPayoutInput,
} from "./payouts.js";
export type {
	BotPaymentsOptions,
	BotPaymentsResult,
	PaymentsCtx,
} from "./plugin.js";
export { botPayments } from "./plugin.js";

/**
 * Telegram's developer payout per Star (via Fragment), in USD. THE display-time
 * conversion constant for Stars revenue: store XTR (the truth), convert only when
 * showing dollars — retail prices (~$0.02/⭐) overstate what you actually receive.
 * One home so every dashboard/bot agrees; update here when Telegram moves the rate.
 */
export const XTR_USD_PAYOUT = 0.013;
export type {
	AtLeastKey,
	BotPaymentsConfig,
	ChargeRecord,
	CreditsConfig,
	CreditsPack,
	DerivedPaymentsState,
	FulfillmentEvent,
	LegalConfig,
	PaymentsSession,
	PayoutRecord,
	PaysupportState,
	Perk,
	PerkState,
	PerksConfig,
	ProductKey,
	RefundEvent,
	SubscriptionPeriod,
	TierKey,
	VipRung,
	VipState,
	WaiverConfig,
	WaiverRecord,
} from "./types.js";
export { InsufficientCredits } from "./types.js";
