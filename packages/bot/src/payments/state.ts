/**
 * Pure state computation over the charge log.
 *
 * This file is `state.ts` (not `derive.ts`) because gramio's `derive`
 * concept is reserved for ctx decoration (see `derive.ts` alongside,
 * which builds `ctx.payments`). The reducers here are bot-id and ctx
 * agnostic — they take `ChargeRecord[]` and a session-shaped object
 * and mutate the session in place.
 *
 * The charge log (`pay:charge:{chargeId}`) is the single source of truth
 * (CLAUDE.md §"Storage layout"). Session state is a cache for O(1)
 * runtime checks. This module owns the function that rebuilds the cache
 * from the log.
 *
 * Two surfaces:
 *
 *   `deriveState(charges)`     — pure, reduces a chronological list of
 *                                NON-refunded charges into the cache
 *                                shape. Used by reconcile and refund
 *                                (after marking the refunded charge).
 *
 *   `applyCharge(session, …)`  — incremental, mutates one session record
 *                                for a single new charge. Used by
 *                                `handlers.ts` on `successful_payment`.
 *
 *   `revertCreditsForCharge(session, charge)` — targeted decrement
 *                                used by refund (vip/perks are full
 *                                re-derive territory; credits is not,
 *                                because consumption isn't in the log).
 *
 * Credits balance is **not fully derivable** from the log alone — the
 * log records grants, not consumption. `deriveState` therefore returns
 * `totalCreditsGranted` (sum) and callers decide whether to use it as
 * the balance (reconcile of fresh state) or to ignore (incremental).
 */

import type {
	ChargeRecord,
	DerivedPaymentsState,
	PaymentsSession,
	PerkState,
	VipState,
} from "./types.js";

/**
 * Result of `deriveState`. `totalCreditsGranted` is informational —
 * subtract consumption (which isn't logged) for the real balance.
 */
export type DeriveResult = DerivedPaymentsState & {
	readonly totalCreditsGranted: number;
};

/**
 * Pure reducer over a chronological list of charges. Caller is
 * responsible for filtering out refunded ones if they want
 * "current state after refunds" semantics.
 */
export const deriveState = (
	charges: ReadonlyArray<ChargeRecord>,
): DeriveResult => {
	let vip: VipState | undefined;
	const perks: Record<string, PerkState> = {};
	let totalCreditsGranted = 0;

	// Charges are oldest-first by convention. Vip latest-wins by
	// receivedAt; perks first-wins (an idempotent unlock — buying twice
	// shouldn't change the unlock date).
	for (const c of charges) {
		if (c.paysupportState === "refunded") continue;

		totalCreditsGranted += c.creditsGranted;

		if (c.vipRung !== undefined && c.subscriptionExpiresAt !== undefined) {
			// Replace the active subscription only when this charge is newer
			// or this is the first vip charge encountered.
			if (!vip || c.receivedAt >= (vip.expiresAt ?? 0) || c.receivedAt > 0) {
				vip = {
					rung: c.vipRung,
					chargeId: c.chargeId,
					expiresAt: c.subscriptionExpiresAt,
					canceled: false,
				};
			}
		}

		if (c.perkKey && !perks[c.perkKey]) {
			perks[c.perkKey] = {
				chargeId: c.chargeId,
				at: c.receivedAt,
			};
		}
	}

	return {
		credits: totalCreditsGranted,
		vip,
		perks,
		totalCreditsGranted,
	};
};

/**
 * Apply a single new charge to a session in place. Idempotent across
 * `chargeId` because the caller (handlers.ts) guards via the
 * `pay:idempotency:{chargeId}` sentinel before this fires; we don't
 * re-check here.
 *
 *   - vip:     replaces `session.pay.vip` (renewals update expiresAt;
 *              tier upgrades replace rung)
 *   - credits: increments `session.pay.credits` by the granted amount
 *              (covers both pack purchases AND vip renewal grants)
 *   - perks:   set-if-absent on `session.pay.perks[key]`
 */
export const applyCharge = (
	session: { pay?: PaymentsSession },
	charge: ChargeRecord,
): void => {
	session.pay ??= {};
	const pay = session.pay;
	if (charge.creditsGranted > 0) {
		pay.credits = (pay.credits ?? 0) + charge.creditsGranted;
	}
	if (
		charge.vipRung !== undefined &&
		charge.subscriptionExpiresAt !== undefined
	) {
		pay.vip = {
			rung: charge.vipRung,
			chargeId: charge.chargeId,
			expiresAt: charge.subscriptionExpiresAt,
			canceled: false,
		};
	}
	if (charge.perkKey) {
		pay.perks ??= {};
		if (!pay.perks[charge.perkKey]) {
			pay.perks[charge.perkKey] = {
				chargeId: charge.chargeId,
				at: charge.receivedAt,
			};
		}
	}
};

/**
 * Subtract a refunded charge's `creditsGranted` from the session
 * balance, clamping at zero. The "clamp at zero" semantics are
 * deliberate: a user may have already consumed credits when the refund
 * arrives, and going negative would let them buy back into a debt — we
 * refuse that and accept the asymmetry (the refunded Stars are already
 * leaving the bot's balance via `refundStarPayment` either way).
 */
export const revertCreditsForCharge = (
	session: { pay?: PaymentsSession },
	charge: ChargeRecord,
): void => {
	if (!charge.creditsGranted) return;
	session.pay ??= {};
	const pay = session.pay;
	const current = pay.credits ?? 0;
	pay.credits = Math.max(0, current - charge.creditsGranted);
};

/**
 * Rebuild vip + perks (the fully-derivable parts of session.pay.*)
 * from a fresh chronological view of the charge log, **after** the
 * caller has marked any newly-refunded charges. Credits balance is
 * NOT touched — caller handles that explicitly via
 * `revertCreditsForCharge` for the targeted decrement semantics.
 *
 * Used by:
 *   - refund.ts after `refundStarPayment` succeeds
 *   - reconcile (admin command) for full state recovery
 */
export const rebuildVipAndPerks = (
	session: { pay?: PaymentsSession },
	charges: ReadonlyArray<ChargeRecord>,
): void => {
	const derived = deriveState(charges);
	session.pay ??= {};
	const pay = session.pay;
	pay.vip = derived.vip;
	pay.perks = derived.perks;
};
