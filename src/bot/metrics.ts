/**
 * Metric registry — self-serve product measurement, the `bot/flags` pattern
 * applied to counting. Declare a metric ONCE in code and it exists
 * everywhere: `metrics.<key>.bump()` / `.record(value)` at the call site,
 * generic day-bucketed storage underneath (no migration per metric), and
 * `metrics.describe()` as the schema admin panels render generically — a new
 * metric reaches every panel with zero panel edits.
 *
 * Built to answer PRODUCT questions, not just count:
 *   volume     how many times           → counter
 *   averages   how long / how big       → timing (count + sum → avg)
 *   uniques    how many distinct users  → perUser: true
 *   repeat     used it again same day?  → per-user day rows with count > 1
 *   retention  came back another day?   → same user on ≥ 2 distinct days
 *   funnels    of those who did A, who did B → declared pairs over the
 *              shared user space; panels render conversion % generically
 *   depth      how far do they go       → per-user daily counts distribute
 *
 * Storage is ONE injected write op; the atomic upserts live with the
 * consumer's database. Contract: always add (count, sum) to the day bucket
 * for `key`; when `user` is present, ALSO to the per-user day bucket, e.g.:
 *
 *   INSERT INTO metric (key, day, count, sum) VALUES (?1, date('now'), ?2, ?3)
 *     ON CONFLICT (key, day) DO UPDATE SET count = count + ?2, sum = sum + ?3;
 *   -- and when user is present:
 *   INSERT INTO metric_user (key, user, day, count, sum) VALUES (?1, ?4, date('now'), ?2, ?3)
 *     ON CONFLICT (key, user, day) DO UPDATE SET count = count + ?2, sum = sum + ?3;
 *
 * Per-user rows are personal data: wipe them in your forget-user path, and
 * prune by age (growth is users × metrics × days). Writes are FIRE-AND-FORGET
 * and never throw — measurement must never break the product. The registry
 * IS the cardinality cap: keys are declared identifiers, never free-form
 * strings. Money stays in ledgers; this is operational/product counting.
 *
 * @example
 * const metrics = defineMetrics({
 *   chapterOpens: { kind: "counter", label: "chapter opens", perUser: true },
 *   chapterPages: { kind: "counter", label: "chapter pages", perUser: true, help: "Back/Next taps" },
 *   chapterLatency: { kind: "timing", label: "chapter latency", unit: "ms" },
 * }, {
 *   write: (key, addCount, addSum, user) => store.metricBump(key, addCount, addSum, user),
 *   funnels: [["chapterOpens", "chapterPages"]],
 * })
 *
 * void metrics.chapterOpens.bump({ user: ctx.from.id })
 * void metrics.chapterLatency.record(Date.now() - startedAt)
 * metrics.describe() // → { metrics: [...], funnels: [...] } — panels iterate this
 */

/** One metric declaration. `perUser: true` unlocks uniques/repeat/retention/funnels for it. */
export type MetricSpec =
	| { kind: "counter"; label: string; help?: string; perUser?: boolean }
	| {
			kind: "timing";
			label: string;
			help?: string;
			unit?: string;
			perUser?: boolean;
	  };

export interface MetricsOptions<Keys extends string = string> {
	/**
	 * The atomic day-bucket upsert(s): add `addCount`/`addSum` to today's row
	 * for `key`, and — when `user` is present — to the per-user day row too
	 * (one batch). Failures are swallowed by the registry; make the op itself
	 * atomic.
	 */
	write: (
		key: string,
		addCount: number,
		addSum: number,
		user?: number,
	) => Promise<unknown>;
	/**
	 * Declared conversion pairs over perUser metrics ("of users who did FROM,
	 * how many did TO"). Panels render these generically; they are queries
	 * over the shared user space, not extra storage.
	 */
	funnels?: ReadonlyArray<readonly [Keys, Keys]>;
}

export interface CounterHandle {
	/** Count `n` events (default 1); pass `user` on perUser metrics. Fire-and-forget, never throws. */
	bump(opts?: { user?: number; n?: number }): Promise<void>;
}
export interface TimingHandle {
	/** Record one sample; pass `user` on perUser metrics. Fire-and-forget, never throws. */
	record(value: number, opts?: { user?: number }): Promise<void>;
}

export interface MetricsSchema {
	metrics: Array<{ key: string } & MetricSpec>;
	funnels: Array<{ from: string; to: string }>;
}

export type Metrics<Spec extends Record<string, MetricSpec>> = {
	[K in keyof Spec]: Spec[K]["kind"] extends "counter"
		? CounterHandle
		: TimingHandle;
} & {
	/** The registry schema, for panels to render generically. */
	describe(): MetricsSchema;
};

export function defineMetrics<const Spec extends Record<string, MetricSpec>>(
	spec: Spec,
	opts: MetricsOptions<Extract<keyof Spec, string>>,
): Metrics<Spec> {
	for (const [key, s] of Object.entries(spec)) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))
			throw new Error(`metrics: invalid key "${key}"`);
		if (!s.label) throw new Error(`metrics: "${key}" needs a label`);
	}
	for (const [from, to] of opts.funnels ?? []) {
		for (const k of [from, to]) {
			if (!spec[k])
				throw new Error(`metrics: funnel references unknown metric "${k}"`);
			if (!spec[k].perUser)
				throw new Error(
					`metrics: funnel metric "${k}" must be perUser (funnels join on user)`,
				);
		}
	}

	const out: Record<string, CounterHandle | TimingHandle> = {};
	for (const [key, s] of Object.entries(spec)) {
		out[key] =
			s.kind === "counter"
				? {
						async bump(o?: { user?: number; n?: number }) {
							await opts
								.write(key, o?.n ?? 1, 0, s.perUser ? o?.user : undefined)
								.catch(() => {});
						},
					}
				: {
						async record(value: number, o?: { user?: number }) {
							await opts
								.write(key, 1, value, s.perUser ? o?.user : undefined)
								.catch(() => {});
						},
					};
	}
	return {
		...out,
		describe: (): MetricsSchema => ({
			metrics: Object.entries(spec).map(([key, s]) => ({ key, ...s })),
			funnels: (opts.funnels ?? []).map(([from, to]) => ({ from, to })),
		}),
	} as Metrics<Spec>;
}
