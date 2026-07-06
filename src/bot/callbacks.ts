/**
 * Namespaced callback-data registry.
 *
 * gramio's `CallbackData` schemas are dispatched by name (hashed to a
 * 6-char prefix on the wire). When multiple plugins each declare their
 * own short schema names (`payWcs`, `acA`, `mNav`, …) two real risks
 * accumulate:
 *
 *   1. **Cross-plugin name collision.** A future plugin picks a name
 *      another plugin already uses and gramio dispatches to the wrong
 *      handler. Silent.
 *
 *   2. **Drift in name shape.** Each plugin invents its own
 *      abbreviation style. `payWcs` vs `pay_w_consent` vs
 *      `payments:waiver:consent` — no convention.
 *
 * `callbackNs(prefix)` solves both:
 *
 *   - Reserves a prefix per plugin (`pay`, `ac`, `m`, …) so names
 *     can't collide across plugins by construction (`pay:wcs` is
 *     disjoint from `ac:wcs`).
 *
 *   - Maintains a process-wide `Set<string>` of registered fully-
 *     qualified names. A second registration of the same name with
 *     conflicting field shape throws at construction (loud + early);
 *     an identical re-registration is idempotent (HMR / dual-import
 *     safe).
 *
 * The encoded callback_data length is unaffected — gramio hashes the
 * full name to a 6-char prefix regardless of how long the name is. So
 * `pay:waiver:consent` packs as compactly as `pwc`.
 *
 * ## Usage
 *
 * ```ts
 * // src/bot/payments/waiver.ts
 * import { callbackNs } from "../callbacks.js";
 *
 * const cb = callbackNs("pay");
 *
 * export const waiverConsent = cb.data("waiver:consent", { pk: "string" });
 * export const waiverCancel  = cb.data("waiver:cancel",  {});
 *
 * // usage matches gramio's CallbackData verbatim — same .pack / .unpack:
 * waiverConsent.pack({ pk: "vip.1" })
 * bot.callbackQuery(waiverConsent, (ctx) => { ctx.queryData.pk })
 * ```
 */

import { CallbackData } from "gramio";

import { panic } from "../offensive.js";

// ─── global registry ──────────────────────────────────────────────

type FieldType = "string" | "number" | "string?" | "number?";

type FieldDef = Readonly<Record<string, FieldType>>;

// The typed schema a FieldDef declares, so `cb.data(...)` returns a
// CallbackData whose .pack / ctx.queryData are field-typed exactly like
// gramio's chained builder (`new CallbackData(n).number("uid")`) — the
// namespace must not cost the types.
type RequiredFieldKeys<F extends FieldDef> = {
	[K in keyof F]: F[K] extends "string" | "number" ? K : never;
}[keyof F];
type FieldBase<T extends FieldType> = T extends `string${string}`
	? string
	: number;
type SchemaOf<F extends FieldDef> = {
	[K in RequiredFieldKeys<F> & string]: FieldBase<F[K]>;
} & {
	[K in Exclude<keyof F, RequiredFieldKeys<F>> & string]?: FieldBase<F[K]>;
};
type TypedCallbackData<F extends FieldDef> = CallbackData<
	SchemaOf<F>,
	SchemaOf<F>
>;

type Registered = {
	fullName: string;
	fields: FieldDef;
	cb: CallbackData;
};

/** Process-wide registry of every fully-qualified schema name we've seen. */
const registry = new Map<string, Registered>();

const fieldsEqual = (a: FieldDef, b: FieldDef): boolean => {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) if (a[k] !== b[k]) return false;
	return true;
};

const buildCallbackData = (
	fullName: string,
	fields: FieldDef,
): CallbackData => {
	let cb: CallbackData = new CallbackData(fullName);
	for (const [key, type] of Object.entries(fields)) {
		const optional = type.endsWith("?");
		const base = optional ? (type.slice(0, -1) as "string" | "number") : type;
		if (base === "string") {
			cb = cb.string(key, optional ? { optional: true } : undefined);
		} else {
			cb = cb.number(key, optional ? { optional: true } : undefined);
		}
	}
	return cb;
};

// ─── public API ───────────────────────────────────────────────────

export type CallbackNamespace = {
	readonly prefix: string;
	/**
	 * Declare a callback schema under this namespace. `fields` is a
	 * field-type map. Suffix a type with `?` to mark optional (e.g.
	 * `{ uid: 'number', v: 'string?' }`).
	 *
	 * Registering the same `fullName` (prefix:name) twice with matching
	 * field shape returns the cached `CallbackData` (idempotent for
	 * HMR / dual-import). A second registration with different fields
	 * panics — that's a programming error, not a runtime issue.
	 */
	data: <F extends FieldDef>(name: string, fields: F) => TypedCallbackData<F>;
};

/**
 * Reserve a callback-data prefix for a plugin. Returns a namespace
 * with a `data(name, fields)` factory.
 *
 * Prefix must be `[a-z][a-z0-9]*` — lowercased letter + alphanumerics,
 * no separator chars. Names within a namespace can use `:` for
 * sub-grouping (`waiver:consent`, `refund:approve`).
 */
export const callbackNs = (prefix: string): CallbackNamespace => {
	if (!/^[a-z][a-z0-9]*$/.test(prefix)) {
		panic(
			`bot/callbacks: callbackNs prefix "${prefix}" must match /^[a-z][a-z0-9]*$/ — ` +
				`lowercased letter + alphanumerics, no colons or hyphens.`,
		);
	}
	return {
		prefix,
		data: <F extends FieldDef>(
			name: string,
			fields: F,
		): TypedCallbackData<F> => {
			if (!/^[a-zA-Z][a-zA-Z0-9_:]*$/.test(name)) {
				panic(
					`bot/callbacks: callback name "${name}" must match /^[a-zA-Z][a-zA-Z0-9_:]*$/`,
				);
			}
			const fullName = `${prefix}:${name}`;
			const existing = registry.get(fullName);
			if (existing) {
				if (!fieldsEqual(existing.fields, fields)) {
					panic(
						`bot/callbacks: collision — "${fullName}" already registered ` +
							`with different fields ${JSON.stringify(existing.fields)}; ` +
							`re-registration tried ${JSON.stringify(fields)}.`,
					);
				}
				// fieldsEqual just proved the stored schema IS F's schema.
				return existing.cb as TypedCallbackData<F>;
			}
			const cb = buildCallbackData(fullName, fields);
			registry.set(fullName, { fullName, fields, cb });
			// buildCallbackData accumulates exactly F's fields at runtime; the
			// erased builder type is re-asserted here, once, at the boundary.
			return cb as TypedCallbackData<F>;
		},
	};
};

// ─── introspection ────────────────────────────────────────────────

/**
 * Read-only view of every callback schema registered so far. Useful in
 * tests or boot-time sanity checks. Not part of the hot path.
 */
export const registeredCallbacks = (): ReadonlyArray<{
	fullName: string;
	fields: FieldDef;
}> =>
	Array.from(registry.values(), (r) => ({
		fullName: r.fullName,
		fields: r.fields,
	}));

/**
 * Internal — for tests that need a clean slate. Don't call from app code.
 * @internal
 */
export const _resetCallbackRegistry = (): void => {
	registry.clear();
};
