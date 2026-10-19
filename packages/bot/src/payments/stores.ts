/**
 * The plugin's storage layout, in one place.
 *
 * Replaces the scattered `chargeKey` / `userChargesIndexKey` /
 * `idempotencyKey` / `payoutKey` / `payoutsIndexKey` helpers that used
 * to live in `handlers.ts`, `refund.ts`, `payouts.ts`. Every storage
 * operation in the plugin goes through one of these handles.
 *
 * Built once at plugin construction (in `plugin.ts`) and threaded
 * through every concern that needs it.
 */

import type { Storage } from "@gramio/storage";

import { botIndex, botRecord, botSentinel } from "../storage.js";
import { chargeRecordSchema, payoutRecordSchema } from "./schemas.js";
import type { ChargeRecord, PayoutRecord } from "./types.js";

/** Cap on the per-user `pay:user:<id>:charges` index. Older charges
 *  drop off the list but remain in `pay:charge:<id>`. The gestor
 *  export walks this index (`exportPayoutsForUsers`), so capped users
 *  silently drop their oldest charges from the export. */
const USER_CHARGES_CAP = 100;

export type PaymentsStores = {
	/** `pay:charge:<chargeId>` — authoritative per-charge record. */
	readonly charges: ReturnType<typeof botRecord<ChargeRecord>>;
	/** `pay:idem:<chargeId>` — fulfillment idempotency sentinel. */
	readonly idempotency: ReturnType<typeof botSentinel>;
	/**
	 * `pay:user:<userId>:charges` — newest-first capped chargeIds.
	 * Consumed by `/refunds` listing, menu history (v2), the gestor
	 * export (`exportPayoutsForUsers`), and `admin.listCharges`.
	 * Factory because the key is per-user.
	 */
	readonly userCharges: (userId: number) => ReturnType<typeof botIndex>;
	/** `pay:payout:<batchId>` — Fragment payout record. */
	readonly payouts: ReturnType<typeof botRecord<PayoutRecord>>;
	/** `pay:payouts:index` — newest-first batchIds for export. */
	readonly payoutsIndex: ReturnType<typeof botIndex>;
};

/**
 * Construct the plugin's storage handles. Called once at plugin
 * construction; the result is passed into every concern that reads or
 * writes plugin state.
 *
 * Schemas are wired in — every `.get()` on `charges` / `payouts` runs
 * the corresponding zod schema's `.parse()` and throws a clear
 * `SourcedError({ source: 'storage', operation: 'validate' })` on a
 * corrupted record (instead of NaN-ing downstream when the consumer
 * reads a now-missing field). `idempotency` is a presence-only sentinel
 * so no schema applies; `*Index` stores `string[]` so likewise.
 */
export const buildStores = (storage: Storage): PaymentsStores => ({
	charges: botRecord<ChargeRecord>(storage, "pay:charge", chargeRecordSchema),
	idempotency: botSentinel(storage, "pay:idem"),
	userCharges: (userId: number) =>
		botIndex(storage, `pay:user:${userId}:charges`, {
			capacity: USER_CHARGES_CAP,
		}),
	payouts: botRecord<PayoutRecord>(storage, "pay:payout", payoutRecordSchema),
	payoutsIndex: botIndex(storage, "pay:payouts:index"),
});
