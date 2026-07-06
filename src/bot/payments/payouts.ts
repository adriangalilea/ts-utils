/**
 * Fragment payout ledger — the bot author's accounting surface.
 *
 * Fragment Corp redeems your accumulated XTR balance into TON paid to
 * the configured wallet. That payout is the **income event** for
 * Spanish autónomo IRPF purposes (CLAUDE.md §4); the per-charge log on
 * Telegram's side is informational. We persist each payout you receive
 * here, optionally tagged with the Spanish factura number, and provide
 * an `export()` helper that joins charges falling in the payout's time
 * window — that's what your gestor needs.
 *
 * Calling pattern (called by the bot author, NOT from inside an event
 * handler):
 *
 *   import { Bot } from 'gramio'
 *   const bot = new Bot(token); await bot.start()
 *
 *   // After confirming a Fragment payout to your TON wallet:
 *   await payments.payouts.record(bot, {
 *     ton: 12.34,
 *     eurAtReceipt: 47.20,
 *     fromMs: Date.parse('2026-05-01'),
 *     toMs:   Date.parse('2026-06-01'),
 *   })
 *
 *   // For the monthly gestor export:
 *   const data = await payments.payouts.exportForUsers(bot, userIds, {
 *     from: Date.parse('2026-05-01'),
 *     to:   Date.parse('2026-06-01'),
 *   })
 *
 * Fragment doesn't tag payouts with specific charges, so the join is
 * **time-windowed**: payouts get `{ fromMs, toMs }` and the export
 * pulls every `ChargeRecord` whose `receivedAt` falls inside.
 */

import type { AnyBot } from "gramio";

import { panic } from "../../offensive.js";
import type { PaymentsStores } from "./stores.js";
import type { ChargeRecord, PayoutRecord } from "./types.js";

// ─── adapter for the offline-call shape ────────────────────────────

/**
 * Construct the `BotIdCtx` shape `bot/storage` needs when called outside
 * an event (just `{ bot: { info: bot.info } }`). Mirrors the
 * `simulateAccessRequest` pattern in `access-control.ts`.
 *
 * Throws if the bot's `info` isn't populated yet — usually because the
 * caller forgot to `await bot.start()` (or `bot.init()`) first.
 */
const ctxFor = (bot: AnyBot): { bot: { info: { id: number } } } => {
	const info = (bot as unknown as { info?: { id: number } }).info;
	if (!info) {
		panic(
			"bot/payments/payouts: bot.info is undefined — call bot.start() (or bot.init()) first",
		);
	}
	return { bot: { info } };
};

// ─── core record/list/export ───────────────────────────────────────

export type RecordPayoutInput = {
	/** Amount of TON received from Fragment. */
	ton: number;
	/** EUR value at receipt time (snapshot — exchange rates move). */
	eurAtReceipt: number;
	/** Window covered by this payout, lower bound (ms since epoch). */
	fromMs: number;
	/** Window covered by this payout, upper bound (ms since epoch). */
	toMs: number;
	/** Optional Spanish factura number issued for this payout. */
	facturaNumber?: string;
	/** Override the auto-generated batchId. Default: `payout_${toMs}`. */
	batchId?: string;
};

const buildPayoutRecord = (input: RecordPayoutInput): PayoutRecord => {
	if (input.ton <= 0)
		panic(`bot/payments/payouts: ton must be positive (got ${input.ton})`);
	if (input.eurAtReceipt < 0)
		panic(
			`bot/payments/payouts: eurAtReceipt must be >= 0 (got ${input.eurAtReceipt})`,
		);
	if (input.fromMs >= input.toMs)
		panic(
			`bot/payments/payouts: fromMs must be < toMs (got ${input.fromMs} / ${input.toMs})`,
		);
	const batchId = input.batchId ?? `payout_${input.toMs}`;
	return {
		batchId,
		fromMs: input.fromMs,
		toMs: input.toMs,
		tonAmount: input.ton,
		eurAtReceipt: input.eurAtReceipt,
		recordedAt: Date.now(),
		facturaNumber: input.facturaNumber,
	};
};

export const recordPayout = async (
	bot: AnyBot,
	stores: PaymentsStores,
	input: RecordPayoutInput,
): Promise<PayoutRecord> => {
	const ctx = ctxFor(bot);
	const record = buildPayoutRecord(input);
	await stores.payouts.set(ctx, record.batchId, record);
	await stores.payoutsIndex.prepend(ctx, record.batchId);
	return record;
};

export const listPayouts = async (
	bot: AnyBot,
	stores: PaymentsStores,
): Promise<PayoutRecord[]> => {
	const ctx = ctxFor(bot);
	const ids = await stores.payoutsIndex.list(ctx);
	const records = await Promise.all(
		ids.map((id) => stores.payouts.get(ctx, id)),
	);
	return records.filter((r): r is PayoutRecord => r !== undefined);
};

export type ExportInput = {
	/** Window lower bound, ms since epoch. */
	from: number;
	/** Window upper bound, ms since epoch. */
	to: number;
};

export type ExportResult = {
	payouts: PayoutRecord[];
	charges: ChargeRecord[];
};

// Payouts whose [fromMs, toMs] window overlaps [from, to].
const filterPayoutsInWindow = (
	payouts: PayoutRecord[],
	from: number,
	to: number,
): PayoutRecord[] => payouts.filter((p) => !(p.toMs < from || p.fromMs > to));

/**
 * Build the payout-only dataset for a time window. Returns every
 * `PayoutRecord` whose `[fromMs, toMs]` overlaps the requested window.
 *
 * The `charges` field is intentionally empty — without a global charge
 * index (v2 TODO) we can't enumerate every user's charges from one
 * call. Use `exportPayoutsForUsers` with an explicit user-id list.
 */
export const exportPayouts = async (
	bot: AnyBot,
	stores: PaymentsStores,
	input: ExportInput,
): Promise<ExportResult> => {
	if (input.from >= input.to) {
		panic(
			`bot/payments/payouts: export from must be < to (got ${input.from} / ${input.to})`,
		);
	}
	const allPayouts = await listPayouts(bot, stores);
	const payouts = filterPayoutsInWindow(allPayouts, input.from, input.to);
	return { payouts, charges: [] };
};

/**
 * Same as `exportPayouts` but with an explicit user-id list to scan.
 * Pulls every NON-refunded `ChargeRecord` whose `receivedAt` falls in
 * the requested window, joined by time rather than payout identity
 * (Fragment doesn't expose that mapping).
 */
export const exportPayoutsForUsers = async (
	bot: AnyBot,
	stores: PaymentsStores,
	userIds: ReadonlyArray<number>,
	input: ExportInput,
): Promise<ExportResult> => {
	const ctx = ctxFor(bot);
	const allPayouts = await listPayouts(bot, stores);
	const payouts = filterPayoutsInWindow(allPayouts, input.from, input.to);

	const allCharges: ChargeRecord[] = [];
	for (const userId of userIds) {
		const chargeIds = await stores.userCharges(userId).list(ctx);
		for (const cid of chargeIds) {
			const c = await stores.charges.get(ctx, cid);
			if (!c) continue;
			if (c.paysupportState === "refunded") continue;
			if (c.receivedAt >= input.from && c.receivedAt <= input.to) {
				allCharges.push(c);
			}
		}
	}
	allCharges.sort((a, b) => a.receivedAt - b.receivedAt);
	return { payouts, charges: allCharges };
};

// ─── public bag (returned via `payments.payouts`) ──────────────────

export type PayoutsApi = {
	record: (bot: AnyBot, input: RecordPayoutInput) => Promise<PayoutRecord>;
	list: (bot: AnyBot) => Promise<PayoutRecord[]>;
	export: (bot: AnyBot, input: ExportInput) => Promise<ExportResult>;
	exportForUsers: (
		bot: AnyBot,
		userIds: ReadonlyArray<number>,
		input: ExportInput,
	) => Promise<ExportResult>;
};

export const buildPayoutsApi = (stores: PaymentsStores): PayoutsApi => ({
	record: (bot, input) => recordPayout(bot, stores, input),
	list: (bot) => listPayouts(bot, stores),
	export: (bot, input) => exportPayouts(bot, stores, input),
	exportForUsers: (bot, userIds, input) =>
		exportPayoutsForUsers(bot, stores, userIds, input),
});
