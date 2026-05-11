/**
 * Runtime schemas for the persisted ledger records. Wired into
 * `stores.ts` as the optional validator on `botRecord<T>` — every read
 * from storage gets `.parse()`'d, so a corrupted Redis record throws
 * a clear `SourcedError({ source: 'storage', operation: 'validate' })`
 * instead of NaN-ing downstream.
 *
 * Why zod? It's the canonical TS validator with the right API surface
 * (`{ parse(data): T }`). The library's `RecordValidator<T>` type is
 * structural, so swapping to valibot / ArkType / a hand-rolled guard
 * just works — but zod is what we ship the default with.
 *
 * Schemas mirror the TS types in `types.ts` 1:1. Keep them in sync; the
 * type system enforces that via the `z.infer<>` round-trip — if a
 * schema drifts from the type, `satisfies ZodType<X>` on each export
 * blows up. We use `satisfies` (not `as`) so the TS error points at the
 * mismatch, not the assertion.
 */

import { z } from "zod";

import type { ChargeRecord, PayoutRecord, WaiverRecord } from "./types.js";

const waiverRecordSchema = z.object({
	at: z.number(),
	version: z.string(),
	locale: z.string(),
}) satisfies z.ZodType<WaiverRecord>;

/**
 * `ChargeRecord` schema. Mutable fields stay loose-typed (zod doesn't
 * enforce readonly the way TS does) but every field is structurally
 * present.
 */
export const chargeRecordSchema = z.object({
	chargeId: z.string(),
	userId: z.number(),
	productKey: z.string(),
	xtr: z.number(),
	receivedAt: z.number(),
	payload: z.string(),
	waiverSnapshot: waiverRecordSchema,
	subscriptionExpiresAt: z.number().optional(),
	creditsGranted: z.number(),
	vipRung: z.number().optional(),
	perkKey: z.string().optional(),
	paysupportState: z.enum(["none", "opened", "refunded"]),
	refundedAt: z.number().nullable().optional(),
	payoutBatchId: z.string().nullable().optional(),
}) satisfies z.ZodType<ChargeRecord>;

export const payoutRecordSchema = z.object({
	batchId: z.string(),
	fromMs: z.number(),
	toMs: z.number(),
	tonAmount: z.number(),
	eurAtReceipt: z.number(),
	recordedAt: z.number(),
	facturaNumber: z.string().optional(),
}) satisfies z.ZodType<PayoutRecord>;
