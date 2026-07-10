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
	/** Number flags: inclusive write-time bounds. Many writers touch a flag (bot admin
	 *  taps, web consoles, fat fingers) — bounds make an insane value unwritable at the
	 *  shared rule ({@link flagValueError}) instead of trusting every panel separately. */
	min?: number;
	max?: number;
	/**
	 * String flags: the closed set of allowed values — the flag becomes an ENUM. Panels
	 * render a picker instead of free text, and in-bot admin menus can ROTATE through the
	 * values on tap (off → admins → all → off …). The audience-gating convention lives in
	 * {@link audienceAllows}.
	 */
	choices?: readonly string[];
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
	min?: number;
	max?: number;
	choices?: readonly string[];
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
	 * loosely typed (unknown key panics). For generic admin surfaces iterating
	 * `describe()`; call sites use `await flags.<key>(ctx)`.
	 */
	get: (ctx: unknown, key: string) => Promise<unknown>;
	/**
	 * Write a live override (scalar or tier map, kind-checked), or `null`
	 * to clear it back to the code default. Runtime key (unknown panics), so
	 * generic panels can write what `describe()` lists. Panics without a
	 * `write` backend.
	 */
	set: (ctx: unknown, key: string, value: unknown) => Promise<void>;
};

// ─── internals ───────────────────────────────────────────────────────

const RESERVED = new Set(["describe", "overrides", "get", "set"]);

/** Scalars are never objects, so `free` presence is the whole test. Exported so
 *  external panels can render a tier map as per-tier inputs. */
export const isTierMap = (v: unknown): v is TierMap<unknown> =>
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

/**
 * A scalar of the right kind, or a tier map whose every value is. THE shape half
 * of the write rule; see {@link flagValueError} for the full rule with constraints.
 */
export const flagValueOk = (kind: FlagKind, v: unknown): boolean => {
	if (isTierMap(v)) return Object.values(v).every((t) => kindOk(kind, t));
	return kindOk(kind, v);
};

/** The constraint surface {@link flagValueError} checks — a FlagDescriptor satisfies it. */
export type FlagConstraints = {
	kind: FlagKind;
	min?: number;
	max?: number;
	choices?: readonly string[];
};

/**
 * THE write rule, complete: shape (kind, tier maps) plus constraints (bounds, choices).
 * Returns null when the value is writable, else a human-readable reason. `flags.set`
 * enforces it, and it's exported so any external writer (a web console patching the
 * same config record directly, an in-bot input prompt) validates with the SAME function
 * instead of restating it. Constraints apply at WRITE time only — reads keep shape-checking
 * so tightening a bound later never bricks an already-stored value.
 */
export const flagValueError = (spec: FlagConstraints, v: unknown): string | null => {
	if (!flagValueOk(spec.kind, v)) return `not a ${spec.kind} (or a tier map of them)`;
	const scalars = isTierMap(v) ? Object.values(v) : [v];
	for (const s of scalars) {
		if (spec.kind === "number") {
			const n = s as number;
			if (!Number.isFinite(n)) return "not a finite number";
			if (spec.min !== undefined && n < spec.min) return `below the minimum (${spec.min})`;
			if (spec.max !== undefined && n > spec.max) return `above the maximum (${spec.max})`;
		}
		if (spec.choices && !spec.choices.includes(s as string)) {
			return `must be one of: ${spec.choices.join(" · ")}`;
		}
	}
	return null;
};

/**
 * The audience-gating convention for a `choices: ["off", "admins", "all"]` flag:
 * a staged rollout an in-bot menu rotates through on tap. `off` gates everyone,
 * `admins` opens it to operators/testers, `all` ships it.
 */
export const audienceAllows = (value: string, opts: { admin: boolean }): boolean => {
	if (value === "all") return true;
	if (value === "admins") return opts.admin;
	return false;
};

// ─── the factory ─────────────────────────────────────────────────────

export function defineFlags<Spec extends Record<string, FlagSpec>>(
	spec: Spec,
	backend: FlagsBackend,
): Flags<Spec> {
	for (const [key, s] of Object.entries(spec)) {
		if (RESERVED.has(key)) panic(`flags: "${key}" is a reserved name`);
		const reason = flagValueError(s, s.default);
		if (reason !== null) panic(`flags: "${key}" default rejected: ${reason}`, s.default);
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
		if (!flagValueOk(s.kind, declared))
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
				...(s.min !== undefined ? { min: s.min } : {}),
				...(s.max !== undefined ? { max: s.max } : {}),
				...(s.choices !== undefined ? { choices: s.choices } : {}),
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
			const reason = value === null ? null : flagValueError(s, value);
			if (reason !== null)
				throw new SourcedError({
					source: "flags",
					operation: "set",
					message: `value for "${key}" rejected: ${reason}`,
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
