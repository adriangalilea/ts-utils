/**
 * Feature flags declared ONCE in code, resolved LIVE from operator config.
 *
 * The whole lifecycle in one move: a bot author adds an entry to their
 * `defineFlags` spec and ships it. From that moment the flag
 *
 *   - resolves at every read site via `await flags.<key>(ctx)` — the stored
 *     override wins, else the code default;
 *   - varies by paid tier when its value is a tier map (`{ free, vip,
 *     "vip.N" }`), resolved off `ctx.payments.tier()` from `bot/payments` —
 *     "free users get this limit, premium users get that model" is one
 *     declaration, zero branching at the call site;
 *   - self-describes via `flags.describe()`, so admin surfaces (an in-bot
 *     /admin tab, a web console) render every flag generically — a new flag
 *     appears in the panels with no panel changes;
 *   - flips live via `flags.set(ctx, key, value)` (or any external writer
 *     patching the same config record): no redeploy, no schema migration —
 *     values live in whatever key-value/JSON config store the bot already
 *     has.
 *
 * Storage-agnostic and Worker-safe: the bot injects `read` (and optionally
 * `write`) over its own config record — a D1 row, a Redis hash, a file. The
 * stored shape is plain JSON: `{ "<key>": <scalar | tier map> }`. An
 * override REPLACES the declared default wholesale (a tiered default
 * overridden with a scalar applies to every tier, and vice versa).
 *
 * ## Tier resolution (the ladder)
 *
 * A tier map holds `free` (required) plus any of `vip` / `"vip.1"` /
 * `"vip.2"` / …. For a user on `vip.N` the lookup walks DOWN the ladder —
 * exact rung, then lower rungs, then bare `vip`, then `free` — so higher
 * tiers inherit everything not explicitly upgraded. Without `bot/payments`
 * wired, every user resolves as `free`.
 *
 * @example
 * import { defineFlags } from '@adriangalilea/utils/bot/flags'
 *
 * export const flags = defineFlags(
 *   {
 *     richText:      { kind: 'bool',   label: 'rich text (global)', default: true },
 *     maxInputChars: { kind: 'number', label: 'input clamp (chars)',
 *                      default: { free: 50_000, vip: 250_000 } },
 *     model:         { kind: 'string', label: 'summary model',
 *                      default: { free: 'google/gemini-3-flash', 'vip.2': 'anthropic/claude-sonnet-5' } },
 *   },
 *   { read: (ctx) => store.readConfig(ctx), write: (ctx, patch) => store.writeConfig(ctx, patch) },
 * )
 *
 * // at any call site — tier-aware, live, one line:
 * const clamp = await flags.maxInputChars(ctx)
 *
 * // in an admin surface — render every flag without naming any:
 * for (const d of flags.describe()) { ... d.key, d.kind, d.label, d.tiered ... }
 * await flags.set(ctx, 'richText', false)   // live override
 * await flags.set(ctx, 'richText', null)    // clear → back to the code default
 */
import { SourcedError, panic } from "../offensive.js";

// ─── spec ────────────────────────────────────────────────────────────

/** Per-tier values: `free` is the floor everyone resolves to. */
export type TierMap<T> = { free: T; vip?: T } & {
	[rung: `vip.${number}`]: T;
};

type KindValue = { bool: boolean; number: number; string: string };

export type FlagKind = keyof KindValue;

export type FlagSpec<K extends FlagKind = FlagKind> = {
	kind: K;
	/** Short human label for admin surfaces ("rich text (global)"). */
	label: string;
	/** One-line operator hint, shown next to the control. */
	help?: string;
	/** Code default — a scalar, or a tier map for per-tier values. */
	default: KindValue[K] | TierMap<KindValue[K]>;
};

/** What `describe()` returns per flag — JSON-safe, for panels/consoles. */
export type FlagDescriptor = {
	key: string;
	kind: FlagKind;
	label: string;
	help?: string;
	default: unknown;
	/** Whether the DECLARED default is per-tier (panels offer tier inputs). */
	tiered: boolean;
};

export type FlagsBackend = {
	/** Read the bot's operator-config record (plain JSON object). */
	read: (ctx: unknown) => Promise<Record<string, unknown>>;
	/**
	 * Merge a patch into that record (RFC 7386 style: a `null` value deletes
	 * the key — SQLite's `json_patch` and most merge-patch writers already
	 * behave this way). Required for `flags.set`.
	 */
	write?: (ctx: unknown, patch: Record<string, unknown>) => Promise<unknown>;
};

// ─── resolved surface ────────────────────────────────────────────────

type Resolver<S extends FlagSpec> = (
	ctx: unknown,
) => Promise<KindValue[S["kind"]]>;

export type Flags<Spec extends Record<string, FlagSpec>> = {
	[K in keyof Spec]: Resolver<Spec[K]>;
} & {
	/** Every flag's declaration, JSON-safe — the schema panels render from. */
	describe: () => FlagDescriptor[];
	/** Raw stored overrides (only keys that are actually overridden). */
	overrides: (ctx: unknown) => Promise<Record<string, unknown>>;
	/**
	 * Resolve a flag by RUNTIME key — same resolution as the typed accessor,
	 * loosely typed. For generic admin surfaces iterating `describe()`; call
	 * sites use `await flags.<key>(ctx)`.
	 */
	get: (ctx: unknown, key: keyof Spec & string) => Promise<unknown>;
	/**
	 * Write a live override (scalar or tier map, kind-checked), or `null`
	 * to clear it back to the code default. Panics without a `write` backend.
	 */
	set: (ctx: unknown, key: keyof Spec & string, value: unknown) => Promise<void>;
};

// ─── internals ───────────────────────────────────────────────────────

const RESERVED = new Set(["describe", "overrides", "get", "set"]);

/** Scalars are never objects, so `free` presence is the whole test. */
const isTierMap = (v: unknown): v is TierMap<unknown> =>
	typeof v === "object" && v !== null && "free" in v;

/** `ctx.payments.tier()` when bot/payments is wired; `free` otherwise. */
const tierOf = (ctx: unknown): string => {
	const payments = (ctx as { payments?: { tier?: () => string } })?.payments;
	try {
		return payments?.tier?.() ?? "free";
	} catch {
		return "free";
	}
};

/** Walk the ladder down: vip.N → … → vip.1 → vip → free. */
const resolveTiered = <T>(value: T | TierMap<T>, tier: string): T => {
	if (!isTierMap(value)) return value;
	if (tier.startsWith("vip.")) {
		const rung = Number.parseInt(tier.slice(4), 10);
		for (let i = rung; i >= 1; i--) {
			const hit = value[`vip.${i}`];
			if (hit !== undefined) return hit;
		}
	}
	if (tier !== "free" && value.vip !== undefined) return value.vip;
	return value.free;
};

const kindOk = (kind: FlagKind, v: unknown): boolean =>
	kind === "bool" ? typeof v === "boolean" : typeof v === kind;

/** A scalar of the right kind, or a tier map whose every value is. */
const valueOk = (kind: FlagKind, v: unknown): boolean => {
	if (isTierMap(v)) return Object.values(v).every((t) => kindOk(kind, t));
	return kindOk(kind, v);
};

// ─── the factory ─────────────────────────────────────────────────────

export function defineFlags<Spec extends Record<string, FlagSpec>>(
	spec: Spec,
	backend: FlagsBackend,
): Flags<Spec> {
	for (const [key, s] of Object.entries(spec)) {
		if (RESERVED.has(key)) panic(`flags: "${key}" is a reserved name`);
		if (!valueOk(s.kind, s.default))
			panic(`flags: "${key}" default doesn't match kind "${s.kind}":`, s.default);
	}

	// One config read per update: multiple flag reads on the same ctx share
	// the same in-flight promise (keyed on ctx object identity).
	const cache = new WeakMap<object, Promise<Record<string, unknown>>>();
	const configFor = (ctx: unknown): Promise<Record<string, unknown>> => {
		if (typeof ctx !== "object" || ctx === null) return backend.read(ctx);
		const hit = cache.get(ctx);
		if (hit) return hit;
		const p = backend.read(ctx);
		cache.set(ctx, p);
		return p;
	};

	const resolve = async (ctx: unknown, key: string): Promise<unknown> => {
		const s = spec[key];
		const stored = (await configFor(ctx))[key];
		const declared = stored !== undefined && stored !== null ? stored : s.default;
		if (!valueOk(s.kind, declared))
			throw new SourcedError({
				source: "flags",
				operation: "resolve",
				message: `stored override for "${key}" doesn't match kind "${s.kind}"`,
				context: { key, stored },
			});
		return resolveTiered(declared as never, tierOf(ctx));
	};

	const flags = {
		describe: (): FlagDescriptor[] =>
			Object.entries(spec).map(([key, s]) => ({
				key,
				kind: s.kind,
				label: s.label,
				...(s.help !== undefined ? { help: s.help } : {}),
				default: s.default,
				tiered: isTierMap(s.default),
			})),
		overrides: async (ctx: unknown): Promise<Record<string, unknown>> => {
			const stored = await configFor(ctx);
			return Object.fromEntries(
				Object.keys(spec)
					.filter((k) => stored[k] !== undefined && stored[k] !== null)
					.map((k) => [k, stored[k]]),
			);
		},
		get: (ctx: unknown, key: string): Promise<unknown> => {
			if (!spec[key]) panic(`flags: unknown flag "${key}"`);
			return resolve(ctx, key);
		},
		set: async (ctx: unknown, key: string, value: unknown): Promise<void> => {
			const s = spec[key] ?? panic(`flags: unknown flag "${key}"`);
			if (!backend.write) panic("flags: set() needs a write backend");
			if (value !== null && !valueOk(s.kind, value))
				throw new SourcedError({
					source: "flags",
					operation: "set",
					message: `value for "${key}" doesn't match kind "${s.kind}"`,
					context: { key, value },
				});
			await backend.write(ctx, { [key]: value });
			// The next read must see the write, even on the same ctx.
			if (typeof ctx === "object" && ctx !== null) cache.delete(ctx);
		},
	} as Flags<Spec>;

	for (const key of Object.keys(spec)) {
		(flags as Record<string, unknown>)[key] = (ctx: unknown) => resolve(ctx, key);
	}

	return flags;
}
