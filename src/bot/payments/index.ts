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
