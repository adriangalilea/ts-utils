/**
 * Typed storage abstraction for `bot/*` plugins.
 *
 * Replaces the per-plugin `botSubKey + storage.get/set` boilerplate
 * with three small primitives that automatically:
 *
 *   - **Namespace by bot id.** Every key gets `bot-<id>:` prefixed via
 *     `ctx.bot.info.id`, so multiple bots sharing one Redis stay
 *     isolated by construction (see `bot/CLAUDE.md` § Multi-bot
 *     isolation). No plugin has to remember to wrap.
 *
 *   - **Validate on read** (optional). Pass any `{ parse(data:
 *     unknown): T }` validator (zod / valibot / arktype / yours) and a
 *     mis-shaped record from storage throws a clear `SourcedError`
 *     instead of NaN-ing downstream. Omit the validator and you get
 *     the same untyped read as before.
 *
 *   - **Stay typed end-to-end.** `botRecord<ChargeRecord>(...)` returns
 *     a `BotRecord<ChargeRecord>` and `.get()` is `Promise<ChargeRecord
 *     | undefined>`. No casts at the call site.
 *
 * ## Three primitives
 *
 *   - `botRecord<T>(storage, prefix, validator?)` — get/set/delete a
 *     single typed value keyed by an id (`pay:charge:<chargeId>`,
 *     `ac:user:<userId>`, …). Most plugin state.
 *
 *   - `botIndex(storage, prefix, opts?)` — a capped, prepend-friendly
 *     `string[]` stored under a single key. Use for "recent N
 *     charges", "pending access requests", etc.
 *
 *   - `botSentinel(storage, prefix)` — a presence flag (`"1"` / absent)
 *     for idempotency. `claim(ctx, id)` returns `true` only on first
 *     call; subsequent calls return `false` without setting. Note:
 *     read-then-write is NOT atomic under concurrent load; for
 *     production we'd want a storage backend with `setNX` semantics.
 *
 * ## Why not couple to zod?
 *
 * The validator parameter is typed as `{ parse(data: unknown): T }` —
 * a structural shape that zod schemas, valibot, ArkType, and hand-rolled
 * type guards all satisfy. The library has zero zod imports; consumers
 * bring whichever validator they prefer.
 */

import type { Storage } from "@gramio/storage";

import { SourcedError } from "../offensive.js";
import { createLogger } from "../universal/log.js";
import type { BotIdCtx } from "./ctx.js";

const log = createLogger("bot/storage");

// ─── shared ────────────────────────────────────────────────────────

/**
 * Anything with a synchronous `parse(unknown): T`. zod schemas satisfy
 * this natively (`.parse` throws on invalid input). Custom guards work
 * the same way: `{ parse: (d) => { if (!ok(d)) throw new Error(...); return d as T } }`.
 */
export type RecordValidator<T> = { parse: (data: unknown) => T };

const botIdOf = (ctx: BotIdCtx): number => {
	const id = ctx.bot?.info?.id;
	if (typeof id !== "number") {
		throw new SourcedError({
			source: "storage",
			operation: "key",
			message:
				"ctx.bot.info.id is missing — called before bot.start()/bot.init()?",
		});
	}
	return id;
};

/**
 * Build the namespaced key for a record / index / sentinel. Matches
 * the format `botSubKey` / `botStorageKey` in `kit.ts` use, so the
 * abstractions compose with anything that still consumes those.
 */
const buildKey = (ctx: BotIdCtx, prefix: string, id?: string): string => {
	const base = `bot-${botIdOf(ctx)}:${prefix}`;
	return id !== undefined ? `${base}:${id}` : base;
};

const parseOr = <T>(
	raw: unknown,
	validator: RecordValidator<T> | undefined,
	key: string,
): T => {
	if (!validator) return raw as T;
	try {
		return validator.parse(raw);
	} catch (cause) {
		throw new SourcedError({
			source: "storage",
			operation: "validate",
			message:
				cause instanceof Error
					? cause.message
					: "validator threw a non-Error value",
			cause,
			context: { key },
		});
	}
};

// ─── botRecord ────────────────────────────────────────────────────

export type BotRecord<T> = {
	/** Storage key for `id` under this record's prefix. */
	keyFor: (ctx: BotIdCtx, id: string) => string;
	/** `undefined` on miss; throws `SourcedError` on validator failure. */
	get: (ctx: BotIdCtx, id: string) => Promise<T | undefined>;
	/** Overwrites unconditionally. Use `botSentinel` if you need set-if-absent. */
	set: (ctx: BotIdCtx, id: string, value: T) => Promise<void>;
	/** Hard delete. No-op if absent. */
	delete: (ctx: BotIdCtx, id: string) => Promise<void>;
	/** `true` if a record exists at `id` (no read, no validation). */
	has: (ctx: BotIdCtx, id: string) => Promise<boolean>;
};

/**
 * Typed record store, auto-namespaced by bot id.
 *
 * @example  per-charge record with zod validation
 *
 *   const charges = botRecord<ChargeRecord>(
 *     storage,
 *     'pay:charge',
 *     ChargeRecordSchema,   // any zod.ZodType<ChargeRecord>
 *   )
 *   await charges.set(ctx, chargeId, charge)
 *   const c = await charges.get(ctx, chargeId)
 *
 * @example  without a validator (backwards-compatible behaviour)
 *
 *   const charges = botRecord<ChargeRecord>(storage, 'pay:charge')
 *   const c = await charges.get(ctx, chargeId)  // typed but unchecked
 */
export const botRecord = <T>(
	storage: Storage,
	prefix: string,
	validator?: RecordValidator<T>,
): BotRecord<T> => ({
	keyFor: (ctx, id) => buildKey(ctx, prefix, id),
	get: async (ctx, id) => {
		const key = buildKey(ctx, prefix, id);
		const raw = await storage.get(key);
		if (raw === undefined) return undefined;
		return parseOr(raw, validator, key);
	},
	// `@gramio/storage`'s methods return `MaybePromise<T>` (sync- or
	// async-storage agnostic). We normalize to `Promise<T>` via
	// `Promise.resolve` so callers don't have to care which backend
	// they're on.
	set: async (ctx, id, value) =>
		void (await storage.set(buildKey(ctx, prefix, id), value)),
	delete: async (ctx, id) =>
		void (await storage.delete(buildKey(ctx, prefix, id))),
	has: async (ctx, id) =>
		(await storage.has(buildKey(ctx, prefix, id))) === true,
});

// ─── botIndex ─────────────────────────────────────────────────────

export type BotIndexOptions = {
	/**
	 * Maximum number of ids retained. New `prepend` calls past this
	 * limit drop the OLDEST id. Omit for an unbounded index (a
	 * footgun for high-volume bots — set a cap).
	 */
	capacity?: number;
};

export type BotIndex = {
	keyFor: (ctx: BotIdCtx) => string;
	/** Newest-first list of ids, capped to `capacity` if configured. */
	list: (ctx: BotIdCtx) => Promise<string[]>;
	/** Insert `id` at the front. Idempotent: re-prepending an existing
	 *  id moves it to the front. Returns the new length post-cap. */
	prepend: (ctx: BotIdCtx, id: string) => Promise<number>;
	/** Remove `id`. No-op if absent. Returns whether anything was removed. */
	remove: (ctx: BotIdCtx, id: string) => Promise<boolean>;
	/** Wipe the whole index. */
	clear: (ctx: BotIdCtx) => Promise<void>;
};

/**
 * Newest-first capped list of ids stored under a single key. Designed
 * for "user's last N charges", "pending access requests", "recent
 * payouts" — small, ordered, bounded.
 *
 * `prepend(id)` is the only mutator. Re-prepending an existing id moves
 * it to the front (de-duplication). At-cap inserts drop the tail.
 */
export const botIndex = (
	storage: Storage,
	prefix: string,
	opts: BotIndexOptions = {},
): BotIndex => {
	const cap = opts.capacity;
	// Single source for the stored shape (string[]) and empty-default.
	const read = async (ctx: BotIdCtx): Promise<string[]> =>
		((await storage.get(buildKey(ctx, prefix))) as string[] | undefined) ?? [];
	return {
		keyFor: (ctx) => buildKey(ctx, prefix),
		list: (ctx) => read(ctx),
		prepend: async (ctx, id) => {
			const key = buildKey(ctx, prefix);
			const existing = await read(ctx);
			// De-dup: remove if present, then unshift. Cap at the end.
			const filtered = existing.filter((x) => x !== id);
			filtered.unshift(id);
			const trimmed =
				cap !== undefined && filtered.length > cap
					? filtered.slice(0, cap)
					: filtered;
			await storage.set(key, trimmed);
			return trimmed.length;
		},
		remove: async (ctx, id) => {
			const key = buildKey(ctx, prefix);
			const existing = await read(ctx);
			const filtered = existing.filter((x) => x !== id);
			if (filtered.length === existing.length) return false;
			await storage.set(key, filtered);
			return true;
		},
		clear: async (ctx) => void (await storage.delete(buildKey(ctx, prefix))),
	};
};

// ─── botSentinel ──────────────────────────────────────────────────

export type BotSentinel = {
	keyFor: (ctx: BotIdCtx, id: string) => string;
	/**
	 * Attempt to claim `id`. Returns `true` on first claim (and
	 * persists), `false` if already claimed (no write).
	 *
	 * NOT atomic under concurrent load — the read and write happen as
	 * two ops. For at-most-once semantics under contention, swap the
	 * storage backend for one with `setNX` (e.g. `@gramio/storage-redis`
	 * with a `setIfNotExists` helper) and override this method. For
	 * single-process polling bots (the v1 target), the race window is
	 * bounded by Telegram's retry delay and acceptable.
	 */
	claim: (ctx: BotIdCtx, id: string) => Promise<boolean>;
	/** `true` if `id` has been claimed. No write. */
	check: (ctx: BotIdCtx, id: string) => Promise<boolean>;
	/** Release a claim. Returns whether anything was released. */
	release: (ctx: BotIdCtx, id: string) => Promise<boolean>;
};

/**
 * Presence-flag store for idempotency. Each id is either claimed
 * (storage has the key) or not (storage doesn't). The stored value is
 * an opaque sentinel string — readers only care about presence.
 *
 * @example  idempotent successful_payment fulfillment
 *
 *   const idem = botSentinel(storage, 'pay:idem')
 *   if (!(await idem.claim(ctx, chargeId))) return  // duplicate, no-op
 *   await fulfill(charge)
 */
export const botSentinel = (storage: Storage, prefix: string): BotSentinel => {
	const SENTINEL = "1";
	return {
		keyFor: (ctx, id) => buildKey(ctx, prefix, id),
		claim: async (ctx, id) => {
			const key = buildKey(ctx, prefix, id);
			const existing = await storage.get(key);
			if (existing !== undefined) return false;
			await storage.set(key, SENTINEL);
			return true;
		},
		check: async (ctx, id) => {
			const key = buildKey(ctx, prefix, id);
			return (await storage.get(key)) !== undefined;
		},
		release: async (ctx, id) => {
			const key = buildKey(ctx, prefix, id);
			if ((await storage.get(key)) === undefined) return false;
			await storage.delete(key);
			return true;
		},
	};
};

// ─── observability hook (opt-in) ──────────────────────────────────

/**
 * Wrap any `BotRecord` with trace-level logging for every read/write.
 * Useful when debugging a specific plugin's storage flow without
 * polluting every other plugin's logs. Defaults off.
 *
 *   const charges = withTracing(botRecord<ChargeRecord>(...), 'pay:charge')
 */
export const withTracing = <T>(
	record: BotRecord<T>,
	label: string,
): BotRecord<T> => ({
	keyFor: record.keyFor,
	get: async (ctx, id) => {
		const result = await record.get(ctx, id);
		log.trace(`${label}.get(${id}) → ${result === undefined ? "miss" : "hit"}`);
		return result;
	},
	set: async (ctx, id, value) => {
		await record.set(ctx, id, value);
		log.trace(`${label}.set(${id})`);
	},
	delete: async (ctx, id) => {
		await record.delete(ctx, id);
		log.trace(`${label}.delete(${id})`);
	},
	has: (ctx, id) => record.has(ctx, id),
});
